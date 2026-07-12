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
  vi.mocked(api.presets).mockResolvedValue(PRESETS);
  vi.mocked(api.certificates).mockResolvedValue([]);
});

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
