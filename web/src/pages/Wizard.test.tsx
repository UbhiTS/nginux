import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Wizard } from "./Wizard.tsx";
import { api } from "../api.ts";
import type { Preset } from "../types.ts";

// Wizard talks to the backend through the `api` object. On mount it calls
// api.presets() (to build the catalog) and api.certificates() (to reuse an
// existing cert). Mock just those; later-step methods are stubbed so the module
// is complete but they aren't exercised here.
vi.mock("../api.ts", () => ({
  api: {
    presets: vi.fn(),
    certificates: vi.fn(),
    listHosts: vi.fn(),
    testConnection: vi.fn(),
    createHost: vi.fn(),
    issueCert: vi.fn(),
  },
}));

const preset = (over: Partial<Preset>): Preset => ({
  id: "x",
  label: "X",
  icon: "",
  category: "Other",
  desc: "",
  defaultPort: 80,
  websockets: false,
  http2: false,
  extraDirectives: [],
  notes: "",
  ...over,
});

const PRESETS: Preset[] = [
  preset({ id: "plex", label: "Plex", category: "Media", desc: "Stream your media library.", defaultPort: 32400 }),
  preset({ id: "immich", label: "Immich", category: "Media", desc: "Self-hosted photo backup.", defaultPort: 2283 }),
  preset({ id: "homeassistant", label: "Home Assistant", category: "Home", desc: "Home automation hub.", defaultPort: 8123 }),
  preset({ id: "custom", label: "Custom", category: "Other", desc: "A blank generic service." }),
];

function renderWizard(nav = vi.fn()) {
  return {
    navigate: nav,
    ...render(<Wizard settings={null} navigate={nav} reload={vi.fn()} />),
  };
}

beforeEach(() => {
  vi.resetAllMocks(); // keep create/test mocks from leaking across tests
  vi.mocked(api.presets).mockResolvedValue(PRESETS);
  vi.mocked(api.certificates).mockResolvedValue([]);
  vi.mocked(api.listHosts).mockResolvedValue([]);
});

// Walk the wizard from step 1 (What) to step 4 (Secure), leaving Plex selected and
// the auto-suggested "plex" subdomain in place, so create()-focused tests start there.
async function advanceToSecure(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText("Home Assistant"); // presets loaded
  await user.click(screen.getByRole("button", { name: /Continue/i })); // What -> Where
  await screen.findByText("Where does it live?");
  await user.click(screen.getByRole("button", { name: /Continue/i })); // Where -> Address
  await screen.findByText("What address should it have?");
  await user.click(screen.getByRole("button", { name: /Continue/i })); // Address -> Secure
  await screen.findByText("Secure it");
}

describe("Wizard - step 1 (What)", () => {
  it("renders the 5-step stepper", async () => {
    renderWizard();
    for (const label of ["What", "Where", "Address", "Secure", "Done"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("renders the app catalog and the Custom / Generic option once presets load", async () => {
    renderWizard();
    // Plex is preselected, so its label shows in both a card and the details
    // line - the others appear once, in their catalog card.
    expect((await screen.findAllByText("Plex")).length).toBeGreaterThan(0);
    expect(screen.getByText("Immich")).toBeInTheDocument();
    expect(screen.getByText("Home Assistant")).toBeInTheDocument();
    // The pinned "start blank" row.
    expect(screen.getByText("Custom / Generic")).toBeInTheDocument();
  });

  it("filters the catalog as you type in the search box", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByText("Home Assistant");

    await user.type(screen.getByPlaceholderText(/Search apps/i), "immich");

    expect(screen.getByText("Immich")).toBeInTheDocument();
    expect(screen.queryByText("Plex")).not.toBeInTheDocument();
    expect(screen.queryByText("Home Assistant")).not.toBeInTheDocument();
  });

  it("shows a guidance message when the search matches nothing", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByText("Home Assistant");

    await user.type(screen.getByPlaceholderText(/Search apps/i), "zzzzz");

    expect(screen.getByText(/No match for/)).toBeInTheDocument();
    expect(screen.queryByText("Plex")).not.toBeInTheDocument();
  });

  it("selecting a different app updates the details line", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByText("Home Assistant");

    // Plex is preselected on load, so its description is shown.
    expect(screen.getByText("Stream your media library.")).toBeInTheDocument();

    await user.click(screen.getByText("Immich"));

    expect(screen.getByText("Self-hosted photo backup.")).toBeInTheDocument();
    expect(screen.queryByText("Stream your media library.")).not.toBeInTheDocument();
  });

  it("the Custom / Generic option is selectable", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByText("Home Assistant");

    await user.click(screen.getByText("Custom / Generic"));

    // Its details line replaces the previously selected app's.
    expect(screen.getByText("A blank generic service.")).toBeInTheDocument();
    expect(screen.queryByText("Stream your media library.")).not.toBeInTheDocument();
  });

  it("Continue advances from What to Where", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByText("Home Assistant");

    await user.click(screen.getByRole("button", { name: /Continue/i }));

    expect(await screen.findByText("Where does it live?")).toBeInTheDocument();
  });

  it("Cancel navigates back to the dashboard", async () => {
    const user = userEvent.setup();
    const { navigate } = renderWizard();
    await screen.findByText("Home Assistant");

    await user.click(screen.getByRole("button", { name: /Cancel/i }));

    expect(navigate).toHaveBeenCalledWith({ name: "dashboard" });
  });
});

describe("Wizard - app catalog accessibility", () => {
  it("exposes the catalog as a radiogroup of radio tiles with the selection announced", async () => {
    renderWizard();
    await screen.findByText("Home Assistant");

    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    // Plex is preselected on load, so its tile is aria-checked; others aren't.
    expect(screen.getByRole("radio", { name: /Plex/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Immich/i })).toHaveAttribute("aria-checked", "false");
  });

  it("only one tile is Tab-reachable (roving tabindex)", async () => {
    renderWizard();
    await screen.findByText("Home Assistant");

    const tabbable = screen.getAllByRole("radio").filter((el) => el.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName(/Plex/i);
  });

  it("clicking a tile moves the aria-checked selection", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByText("Home Assistant");

    await user.click(screen.getByRole("radio", { name: /Immich/i }));

    expect(screen.getByRole("radio", { name: /Immich/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Plex/i })).toHaveAttribute("aria-checked", "false");
  });

  it("arrow keys move the selection (selection follows focus)", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByText("Home Assistant");

    screen.getByRole("radio", { name: /Plex/i }).focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("radio", { name: /Immich/i })).toHaveAttribute("aria-checked", "true");
  });

  it("Space selects the focused tile", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByText("Home Assistant");

    const immich = screen.getByRole("radio", { name: /Immich/i });
    immich.focus();
    await user.keyboard(" ");

    expect(immich).toHaveAttribute("aria-checked", "true");
  });
});

describe("Wizard - step 2 (Where)", () => {
  it("editing the address clears a stale Test connection result", async () => {
    const user = userEvent.setup();
    vi.mocked(api.testConnection).mockResolvedValue({ reachable: true, message: "It's reachable." });
    renderWizard();
    await screen.findByText("Home Assistant");
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    await screen.findByText("Where does it live?");

    await user.click(screen.getByRole("button", { name: /Test connection/i }));
    expect(await screen.findByText("It's reachable.")).toBeInTheDocument();

    // The banner vouched for the OLD address; editing it must drop the endorsement.
    await user.type(screen.getByLabelText("Your internal service"), "0");

    expect(screen.queryByText("It's reachable.")).not.toBeInTheDocument();
  });
});

describe("Wizard - subdomain conflict", () => {
  it("client-side: blocks Continue onto Secure when the address is already taken", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listHosts).mockResolvedValue([{ domain: "plex.example.com" } as never]);
    renderWizard();
    await screen.findByText("Home Assistant");
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    await screen.findByText("Where does it live?");
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    await screen.findByText("What address should it have?");

    await user.click(screen.getByRole("button", { name: /Continue/i }));

    expect(screen.getByText(/already in use/i)).toBeInTheDocument();
    expect(screen.queryByText("Secure it")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Subdomain")).toHaveFocus();
  });

  it("server 409: recovers to the address step and focuses the subdomain (not step 4)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createHost).mockRejectedValue(new Error("subdomain already in use"));
    renderWizard();
    await advanceToSecure(user);

    await user.click(screen.getByRole("button", { name: /Create service/i }));

    expect(await screen.findByText(/already in use/i)).toBeInTheDocument();
    // Back on the Address step - NOT stranded on a domain error on the Secure step.
    expect(screen.getByText("What address should it have?")).toBeInTheDocument();
    expect(screen.getByLabelText("Subdomain")).toHaveFocus();
  });
});

describe("Wizard - success screen", () => {
  const okHost = { id: "h1", domain: "plex.example.com" } as never;
  beforeEach(() => {
    vi.mocked(api.createHost).mockResolvedValue({
      host: okHost,
      apply: { ok: true, nginxAvailable: true, message: "Your service is live." },
    } as never);
  });

  it("shows the address as a real external link plus protection/expose actions", async () => {
    const user = userEvent.setup();
    renderWizard();
    await advanceToSecure(user);

    await user.click(screen.getByRole("button", { name: /Create service/i }));
    await screen.findByText(/You did it/);

    const link = screen.getByRole("link", { name: /plex\.example\.com/i });
    expect(link).toHaveAttribute("href", "https://plex.example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("button", { name: /Set up protection/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Expose another/i })).toBeInTheDocument();
  });

  it("Set up protection deep-links to the new host's page", async () => {
    const user = userEvent.setup();
    const { navigate } = renderWizard();
    await advanceToSecure(user);
    await user.click(screen.getByRole("button", { name: /Create service/i }));
    await screen.findByText(/You did it/);

    await user.click(screen.getByRole("button", { name: /Set up protection/i }));

    expect(navigate).toHaveBeenCalledWith({ name: "host", hostId: "h1" });
  });

  it("Expose another resets the wizard back to step 1", async () => {
    const user = userEvent.setup();
    renderWizard();
    await advanceToSecure(user);
    await user.click(screen.getByRole("button", { name: /Create service/i }));
    await screen.findByText(/You did it/);

    await user.click(screen.getByRole("button", { name: /Expose another/i }));

    expect(await screen.findByText("What do you want to expose?")).toBeInTheDocument();
  });
});

describe("Wizard - stepper", () => {
  it("marks the active step with aria-current", async () => {
    renderWizard();
    await screen.findByText("Home Assistant");

    const active = document.querySelector('.step[aria-current="step"]');
    expect(active).not.toBeNull();
    expect(active).toHaveTextContent("What");
  });

  it("lets you click a completed step to jump back", async () => {
    const user = userEvent.setup();
    renderWizard();
    await screen.findByText("Home Assistant");
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    await screen.findByText("Where does it live?");

    // Step 1 (What) is completed, so it's a real button that navigates back.
    await user.click(screen.getByRole("button", { name: /Back to step 1: What/i }));

    expect(await screen.findByText("What do you want to expose?")).toBeInTheDocument();
  });
});
