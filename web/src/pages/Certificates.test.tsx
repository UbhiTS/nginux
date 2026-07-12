import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Certificates } from "./Certificates.tsx";
import { api, type Certificate } from "../api.ts";

// Mock only the api methods the page touches (on mount + interactions). The page
// reads api.certificates + api.settings + api.acmeLog on mount, so all three must
// resolve or the render throws.
vi.mock("../api.ts", () => ({
  api: {
    certificates: vi.fn(),
    settings: vi.fn(),
    acmeLog: vi.fn(),
    certDetails: vi.fn(),
    renewCert: vi.fn(),
    issueCert: vi.fn(),
    deleteCert: vi.fn(),
    setCertAutoRenew: vi.fn(),
    importCerts: vi.fn(),
  },
}));

const makeCert = (over: Partial<Certificate> = {}): Certificate => ({
  domain: "app.example.com",
  status: "valid",
  issuer: "Let's Encrypt",
  method: "http-01",
  notBefore: "2026-05-01T00:00:00Z",
  notAfter: "2026-09-01T00:00:00Z",
  sans: [],
  wildcard: false,
  autoRenew: true,
  lastError: null,
  daysRemaining: 60,
  updatedAt: "2026-07-01T00:00:00Z",
  ...over,
});

const trusted = makeCert({ domain: "app.example.com", status: "valid", method: "http-01" });
const selfsigned = makeCert({
  domain: "lan.example.com",
  status: "expiring",
  method: "selfsigned",
  issuer: "self-signed",
  autoRenew: false,
  daysRemaining: 5,
});

beforeEach(() => {
  // Mount-time calls: give every one a benign resolved value.
  vi.mocked(api.certificates).mockResolvedValue([]);
  vi.mocked(api.settings).mockResolvedValue({ dnsProvider: "none" } as never);
  vi.mocked(api.acmeLog).mockResolvedValue({ entries: [], lastSeq: 0, busy: false });
  // Interaction calls.
  vi.mocked(api.certDetails).mockResolvedValue({
    subject: "CN=app.example.com",
    issuer: "Let's Encrypt",
    serialNumber: "01ab",
    fingerprintSha256: "aa:bb",
    sans: ["app.example.com"],
    notBefore: "2026-05-01T00:00:00Z",
    notAfter: "2026-09-01T00:00:00Z",
    signatureAlgorithm: "sha256WithRSA",
    publicKey: "RSA 2048",
    selfSigned: false,
  });
  vi.mocked(api.renewCert).mockResolvedValue(trusted);
  vi.mocked(api.issueCert).mockResolvedValue(trusted);
  vi.mocked(api.deleteCert).mockResolvedValue({ ok: true });
  vi.mocked(api.setCertAutoRenew).mockResolvedValue(trusted);
});

describe("Certificates page", () => {
  it("renders a row per certificate with its domain and status", async () => {
    vi.mocked(api.certificates).mockResolvedValue([trusted, selfsigned]);
    render(<Certificates />);

    expect(await screen.findByText("app.example.com")).toBeInTheDocument();
    expect(screen.getByText("lan.example.com")).toBeInTheDocument();
    // Status pills carry the raw status text.
    expect(screen.getByText("valid")).toBeInTheDocument();
    expect(screen.getByText("expiring")).toBeInTheDocument();
  });

  it("renders the table header columns", async () => {
    vi.mocked(api.certificates).mockResolvedValue([trusted]);
    render(<Certificates />);
    await screen.findByText("app.example.com");

    for (const col of ["Domain", "Status", "Type", "Expires", "Auto-renew"]) {
      expect(screen.getByText(col)).toBeInTheDocument();
    }
  });

  it("shows the empty state when there are no certificates", async () => {
    vi.mocked(api.certificates).mockResolvedValue([]);
    render(<Certificates />);

    expect(
      await screen.findByText(/No certificates yet\./i),
    ).toBeInTheDocument();
  });

  it("fires api.renewCert when 'Renew now' is clicked on a trusted cert", async () => {
    vi.mocked(api.certificates).mockResolvedValue([trusted]);
    render(<Certificates />);
    await screen.findByText("app.example.com");

    await userEvent.click(screen.getByRole("button", { name: "Renew now" }));

    await waitFor(() => expect(api.renewCert).toHaveBeenCalledWith("app.example.com"));
  });

  it("opens the issue dialog for a self-signed cert and requests a certificate", async () => {
    vi.mocked(api.certificates).mockResolvedValue([selfsigned]);
    render(<Certificates />);
    await screen.findByText("lan.example.com");

    // Self-signed rows offer an upgrade to a trusted (Let's Encrypt) cert.
    await userEvent.click(screen.getByRole("button", { name: "Get trusted cert" }));

    // The issue modal appears; confirm the request.
    const request = await screen.findByRole("button", { name: /Request certificate/i });
    await userEvent.click(request);

    await waitFor(() => expect(api.issueCert).toHaveBeenCalledWith("lan.example.com", "http-01"));
  });

  it("deletes a certificate after confirming in the dialog", async () => {
    vi.mocked(api.certificates).mockResolvedValue([trusted]);
    render(<Certificates />);
    await screen.findByText("app.example.com");

    await userEvent.click(screen.getByTitle("Delete certificate"));

    // Confirm inside the dialog (scope to it so the trash icon-button's own
    // title-derived name doesn't collide with the confirm button).
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Delete certificate for app\.example\.com/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete certificate" }));

    await waitFor(() => expect(api.deleteCert).toHaveBeenCalledWith("app.example.com"));
  });

  it("loads certificate details when a row is clicked", async () => {
    vi.mocked(api.certificates).mockResolvedValue([trusted]);
    render(<Certificates />);
    await screen.findByText("app.example.com");

    await userEvent.click(screen.getByText("app.example.com"));

    await waitFor(() => expect(api.certDetails).toHaveBeenCalledWith("app.example.com"));
    // The detail modal surfaces data pulled back from certDetails.
    expect(await screen.findByText("CN=app.example.com")).toBeInTheDocument();
  });

  it("summarises valid vs expiring counts in the stat cards", async () => {
    vi.mocked(api.certificates).mockResolvedValue([trusted, selfsigned]);
    render(<Certificates />);
    await screen.findByText("app.example.com");

    // Valid stat card.
    const validLabel = screen.getByText("Valid");
    expect(within(validLabel.closest(".stat") as HTMLElement).getByText("1")).toBeInTheDocument();
    // Expiring / expired stat card (the one expiring cert).
    const expLabel = screen.getByText("Expiring / expired");
    expect(within(expLabel.closest(".stat") as HTMLElement).getByText("1")).toBeInTheDocument();
  });
});
