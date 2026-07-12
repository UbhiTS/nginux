import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Settings } from "../types.ts";

// Mock only the api methods the page + its child sections touch. SettingsPage and
// its children fetch a fistful of resources on mount (settings, geoip, channels,
// config versions, git log, health) - every one must resolve or a render throws.
vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return {
    ...actual,
    api: {
      settings: vi.fn(),
      saveSettings: vi.fn(),
      detectPublicIp: vi.fn(),
      geoipStatus: vi.fn(),
      downloadGeoip: vi.fn(),
      deleteGeoip: vi.fn(),
      channels: vi.fn(),
      createChannel: vi.fn(),
      testChannel: vi.fn(),
      setChannelEnabled: vi.fn(),
      setChannelRouting: vi.fn(),
      deleteChannel: vi.fn(),
      configVersions: vi.fn(),
      gitLog: vi.fn(),
      snapshotConfig: vi.fn(),
      backupConfig: vi.fn(),
      restoreConfig: vi.fn(),
      restoreVersion: vi.fn(),
      previewImportConfig: vi.fn(),
      importConfig: vi.fn(),
      health: vi.fn(),
    },
  };
});

import { SettingsPage } from "./SettingsPage.tsx";
import { api } from "../api.ts";

function makeSettings(over: Partial<Settings> = {}): Settings {
  return {
    instanceName: "NginUX",
    baseDomain: "example.com",
    theme: "dark",
    letsEncryptEmail: "you@example.com",
    homeCountry: "",
    allowedCountries: "",
    publicIp: "",
    gatewayIp: "192.168.1.1",
    dnsProvider: "none",
    godaddyApiKey: "",
    godaddySecret: "",
    cloudflareApiToken: "",
    maxmindLicenseKey: "",
    acmeStaging: false,
    updateCheckEnabled: true,
    agentAutoApprove: false,
    require2faForManagers: false,
    gitOpsEnabled: false,
    ssoLoginUrl: "",
    ssoCookieDomain: "",
    ssoRealms: "",
    ssoForwardSecret: "",
    logMaxMb: 10,
    logKeepFiles: 3,
    ...over,
  };
}

const geoipInstalled = {
  present: true,
  active: false,
  countries: [] as string[],
  sizeBytes: 60000,
  updatedAt: null as string | null,
};

const reload = () => Promise.resolve();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.settings).mockResolvedValue(makeSettings());
  vi.mocked(api.saveSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.detectPublicIp).mockResolvedValue({ ip: null, country: null });
  vi.mocked(api.geoipStatus).mockResolvedValue({ present: false, active: false, countries: [] } as never);
  vi.mocked(api.downloadGeoip).mockResolvedValue({ ok: true, status: geoipInstalled as never });
  vi.mocked(api.channels).mockResolvedValue([]);
  vi.mocked(api.configVersions).mockResolvedValue([]);
  vi.mocked(api.gitLog).mockResolvedValue([]);
  vi.mocked(api.health).mockResolvedValue({ version: "0.1.3" } as never);
  vi.mocked(api.backupConfig).mockResolvedValue({ encrypted: true, blob: { magic: "nginux-encrypted" } });
});

/** Wait for the initial async settings() fetch to land (Instance name input shows). */
async function renderReady() {
  render(<SettingsPage reload={reload} />);
  return await screen.findByDisplayValue("NginUX");
}

describe("SettingsPage - dirty state (fix 1)", () => {
  it("disables Save until an edit makes the form dirty, then enables it", async () => {
    await renderReady();
    const save = screen.getByRole("button", { name: /Save changes/i });
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByDisplayValue("NginUX"), "!");

    await waitFor(() => expect(save).toBeEnabled());
  });

  it("shows an 'Unsaved changes' indicator only while dirty", async () => {
    await renderReady();
    expect(screen.queryByText(/Unsaved changes/i)).not.toBeInTheDocument();

    await userEvent.type(screen.getByDisplayValue("NginUX"), "X");

    expect(await screen.findByText(/Unsaved changes/i)).toBeInTheDocument();
  });

  it("re-disables Save and clears the indicator after a successful save", async () => {
    await renderReady();
    await userEvent.type(screen.getByDisplayValue("NginUX"), "X");
    const save = screen.getByRole("button", { name: /Save changes/i });
    await waitFor(() => expect(save).toBeEnabled());

    await userEvent.click(save);

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/Unsaved changes/i)).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: /Saved|Save changes/i })).toBeDisabled());
  });
});

describe("SettingsPage - save feedback (fix 2)", () => {
  it("surfaces an error alert when saveSettings rejects", async () => {
    vi.mocked(api.saveSettings).mockRejectedValueOnce(new Error("Server exploded"));
    await renderReady();
    await userEvent.type(screen.getByDisplayValue("NginUX"), "X");

    await userEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Server exploded/i);
  });
});

describe("SettingsPage - GeoIP config grouped under Country lock (fix 3)", () => {
  it("renders the home-country and allowed-countries pickers inside the Country lock card", async () => {
    await renderReady();

    const homeSelect = await screen.findByLabelText(/Home country/i);
    const lockHeading = screen.getByText("Country lock (GeoIP)");
    const card = lockHeading.nextElementSibling as HTMLElement;
    // Both GeoIP pickers now live in the Country lock card, not Network & SSL.
    expect(card.contains(homeSelect)).toBe(true);
    expect(within(card).getByLabelText(/Also allow these countries/i)).toBeInTheDocument();
    expect(within(card).getByLabelText(/MaxMind license key/i)).toBeInTheDocument();
  });
});

describe("SettingsPage - encrypted backup passphrase modal (fix 4)", () => {
  it("opens a modal with passphrase + confirm fields instead of a native prompt", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    await renderReady();

    await userEvent.click(screen.getByRole("button", { name: "Backup" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/Passphrase \(/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Confirm passphrase/i)).toBeInTheDocument();
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("blocks the encrypted download until both passphrases match", async () => {
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: "Backup" }));
    const dialog = await screen.findByRole("dialog");

    const encrypt = within(dialog).getByRole("button", { name: /Download encrypted/i });
    expect(encrypt).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText(/Passphrase \(/i), "supersecret");
    // Still disabled while the confirm field is empty / mismatched.
    expect(encrypt).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText(/Confirm passphrase/i), "supersecret");
    await waitFor(() => expect(encrypt).toBeEnabled());

    await userEvent.click(encrypt);
    await waitFor(() => expect(api.backupConfig).toHaveBeenCalledWith("supersecret", true));
  });

  it("toggling reveal switches the passphrase inputs to text", async () => {
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: "Backup" }));
    const dialog = await screen.findByRole("dialog");
    const pass = within(dialog).getByLabelText(/Passphrase \(/i) as HTMLInputElement;
    expect(pass.type).toBe("password");

    await userEvent.click(within(dialog).getByRole("switch", { name: /Reveal passphrase/i }));

    expect(pass.type).toBe("text");
  });
});

describe("SettingsPage - scoped GeoIP download (fix 5)", () => {
  it("persists only the license key + countries, not every pending edit", async () => {
    await renderReady();
    // Make an UNRELATED pending edit that should NOT be flushed by the download.
    await userEvent.type(screen.getByDisplayValue("NginUX"), "-edited");
    // And a GeoIP-relevant edit that SHOULD be persisted.
    await userEvent.type(screen.getByLabelText(/MaxMind license key/i), "abc123");

    await userEvent.click(screen.getByRole("button", { name: /Download database/i }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    const patch = vi.mocked(api.saveSettings).mock.calls[0][0];
    expect(patch).toHaveProperty("maxmindLicenseKey", "abc123");
    // The unrelated instanceName edit must be absent from the scoped patch.
    expect(patch).not.toHaveProperty("instanceName");
    // The instance name stays dirty afterwards (its own Save still required).
    expect(await screen.findByText(/Unsaved changes/i)).toBeInTheDocument();
  });
});

describe("SettingsPage - accessible controls & microcopy (fix 6)", () => {
  it("renders toggles as role=switch with accessible names", async () => {
    await renderReady();
    expect(screen.getByRole("switch", { name: /Check for updates/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Require 2FA/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Let's Encrypt staging/i })).toBeInTheDocument();
  });

  it("ties labels to inputs so they are addressable by accessible name", async () => {
    await renderReady();
    expect(screen.getByLabelText("Instance name")).toBeInTheDocument();
    expect(screen.getByLabelText("Base domain")).toBeInTheDocument();
    expect(screen.getByLabelText(/Forward-auth secret/i)).toBeInTheDocument();
  });

  it("flips the update-check switch through the Switch onChange", async () => {
    await renderReady();
    const sw = screen.getByRole("switch", { name: /Check for updates/i });
    expect(sw).toHaveAttribute("aria-checked", "true");

    await userEvent.click(sw);

    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    // Flipping a setting makes the form dirty.
    expect(screen.getByText(/Unsaved changes/i)).toBeInTheDocument();
  });

  it("maps a channel test 'ok' status to a readable sentence", async () => {
    vi.mocked(api.channels).mockResolvedValue([
      { id: "c1", type: "ntfy", name: "Pager", enabled: true, minSeverity: "info", lastStatus: "untested" } as never,
    ]);
    vi.mocked(api.testChannel).mockResolvedValue({ ok: true, status: "ok" });
    await renderReady();

    await userEvent.click(await screen.findByRole("button", { name: "Test" }));

    expect(await screen.findByText(/Test notification sent successfully/i)).toBeInTheDocument();
    // The raw "Test: ok" wording is gone.
    expect(screen.queryByText(/Test: ok/i)).not.toBeInTheDocument();
  });
});
