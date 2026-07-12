import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigDiffModal } from "./ConfigDiffModal.tsx";
import { CertDetailModal } from "./CertDetailModal.tsx";
import { api } from "../api.ts";

vi.mock("../api.ts", () => ({
  api: {
    previewConfig: vi.fn(),
    certDetails: vi.fn(),
    setCertAutoRenew: vi.fn(),
    renewCert: vi.fn(),
  },
}));

// A realistic ConfigPreview: one modified file whose diff has added, removed
// and context lines (shapes from web/src/types.ts).
const preview = {
  changed: true,
  files: [
    {
      name: "conf.d/app.example.com.conf",
      status: "modified" as const,
      additions: 5,
      deletions: 2,
      diff: [
        "+listen 443 ssl;",
        "-listen 80;",
        " server_name app.example.com;",
      ].join("\n"),
    },
  ],
};

describe("ConfigDiffModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.previewConfig).mockResolvedValue(preview);
  });

  it("shows a loading placeholder while the diff is being generated", () => {
    // Never-resolving promise so we can observe the pending state.
    vi.mocked(api.previewConfig).mockReturnValue(new Promise(() => {}) as never);
    render(<ConfigDiffModal mode="update" onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText(/Generating diff/)).toBeInTheDocument();
    // Apply is disabled until the preview lands.
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeDisabled();
  });

  it("renders the colour-coded added/removed diff lines with the file's status and counts", async () => {
    render(<ConfigDiffModal mode="update" id="h1" onClose={() => {}} onConfirm={() => {}} />);

    const added = await screen.findByText("+listen 443 ssl;");
    const removed = screen.getByText("-listen 80;");
    expect(added).toBeInTheDocument();
    expect(removed).toBeInTheDocument();
    // Added lines are green, removed lines are red.
    expect(added).toHaveStyle({ color: "var(--green)" });
    expect(removed).toHaveStyle({ color: "var(--red)" });

    // The file's status pill + name + +/- summary.
    expect(screen.getByText("modified")).toHaveClass("pill");
    expect(screen.getByText("conf.d/app.example.com.conf")).toBeInTheDocument();
    expect(screen.getByText("+5")).toBeInTheDocument();
    expect(screen.getByText("−2")).toBeInTheDocument();
  });

  it("passes the mode/id/host through to previewConfig", async () => {
    render(<ConfigDiffModal mode="delete" id="host-9" onClose={() => {}} />);
    await waitFor(() =>
      expect(api.previewConfig).toHaveBeenCalledWith({ mode: "delete", id: "host-9", host: undefined }),
    );
  });

  it("shows a no-change message when the edit doesn't alter the config", async () => {
    vi.mocked(api.previewConfig).mockResolvedValue({ changed: false, files: [] });
    render(<ConfigDiffModal mode="update" onClose={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByText(/No configuration change/)).toBeInTheDocument();
  });

  it("surfaces an error and keeps Apply disabled when the preview fails", async () => {
    vi.mocked(api.previewConfig).mockRejectedValue(new Error("nginx -t exploded"));
    render(<ConfigDiffModal mode="create" onClose={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByText("nginx -t exploded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeDisabled();
  });

  it("fires onConfirm from the primary button once the preview has loaded", async () => {
    const onConfirm = vi.fn();
    render(<ConfigDiffModal mode="update" onClose={() => {}} onConfirm={onConfirm} confirmLabel="Create service" />);
    const apply = await screen.findByRole("button", { name: "Create service" });
    expect(apply).toBeEnabled();
    await userEvent.click(apply);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("labels the ghost button Cancel (with onConfirm) or Close (without), and fires onClose", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<ConfigDiffModal mode="update" onClose={onClose} onConfirm={() => {}} />);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await userEvent.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);

    // No onConfirm -> read-only preview, ghost button reads "Close".
    rerender(<ConfigDiffModal mode="update" onClose={onClose} />);
    expect(await screen.findByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply changes" })).not.toBeInTheDocument();
  });

  it("closes on the Escape key", async () => {
    const onClose = vi.fn();
    render(<ConfigDiffModal mode="update" onClose={onClose} onConfirm={() => {}} />);
    await screen.findByText("+listen 443 ssl;");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("labels the dialog with a .modal-title heading and moves focus inside", async () => {
    render(<ConfigDiffModal mode="update" onClose={() => {}} onConfirm={() => {}} />);
    const dialog = screen.getByRole("dialog");
    const heading = screen.getByText("Configuration changes");
    expect(heading).toHaveClass("modal-title");
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
    // Focus trap pulls focus into the dialog on open (was left on the page behind).
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });
});

// ---------------------------------------------------------------------------

const cert = {
  domain: "app.example.com",
  status: "valid" as const,
  issuer: "Let's Encrypt Authority X3",
  method: "http-01" as const,
  notBefore: "2026-01-01T00:00:00Z",
  notAfter: "2026-06-01T00:00:00Z",
  sans: ["app.example.com"],
  wildcard: false,
  autoRenew: false,
  lastError: null,
  daysRemaining: 42,
  updatedAt: "2026-01-01T00:00:00Z",
};

const details = {
  subject: "CN=app.example.com",
  issuer: "Let's Encrypt Authority X3",
  serialNumber: "03:AB:CD:EF",
  fingerprintSha256: "AA:BB:CC:DD:EE",
  sans: ["app.example.com", "www.app.example.com"],
  notBefore: "2026-01-01T00:00:00Z",
  notAfter: "2026-06-01T00:00:00Z",
  signatureAlgorithm: "SHA256-RSA",
  publicKey: "RSA 2048",
  selfSigned: false,
};

describe("CertDetailModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.certDetails).mockResolvedValue(details);
    vi.mocked(api.setCertAutoRenew).mockResolvedValue(cert as never);
    vi.mocked(api.renewCert).mockResolvedValue(cert as never);
  });

  it("shows a loading placeholder then the parsed certificate fields", async () => {
    vi.mocked(api.certDetails).mockReturnValue(new Promise(() => {}) as never);
    const { unmount } = render(<CertDetailModal cert={cert} onClose={() => {}} />);
    expect(screen.getByText(/Reading certificate/)).toBeInTheDocument();
    unmount();

    vi.mocked(api.certDetails).mockResolvedValue(details);
    render(<CertDetailModal cert={cert} onClose={() => {}} />);
    expect(await screen.findByText("CN=app.example.com")).toBeInTheDocument();
    expect(screen.getByText("RSA 2048")).toBeInTheDocument();
    expect(screen.getByText("03:AB:CD:EF")).toBeInTheDocument();
    expect(screen.getByText("AA:BB:CC:DD:EE")).toBeInTheDocument();
    // "Covers" joins the SANs.
    expect(screen.getByText("app.example.com, www.app.example.com")).toBeInTheDocument();
  });

  it("renders the domain heading and the status pill", () => {
    render(<CertDetailModal cert={cert} onClose={() => {}} />);
    expect(screen.getByText("app.example.com")).toBeInTheDocument();
    expect(screen.getByText("valid")).toHaveClass("pill");
  });

  it("toggles auto-renew through the API when the switch is clicked", async () => {
    const { container } = render(<CertDetailModal cert={cert} onClose={() => {}} />);
    const sw = container.querySelector("button.switch") as HTMLButtonElement;
    expect(sw).not.toHaveClass("on"); // cert.autoRenew === false
    await userEvent.click(sw);
    expect(api.setCertAutoRenew).toHaveBeenCalledWith("app.example.com", true);
  });

  it("renews the cert and closes the modal from Renew now", async () => {
    const onClose = vi.fn();
    render(<CertDetailModal cert={cert} onClose={onClose} />);
    const renew = await screen.findByRole("button", { name: /Renew now/ });
    await userEvent.click(renew);
    expect(api.renewCert).toHaveBeenCalledWith("app.example.com");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows the empty state and hides Renew now when there's no cert file on disk", async () => {
    vi.mocked(api.certDetails).mockRejectedValue(new Error("nope"));
    render(<CertDetailModal cert={cert} onClose={() => {}} />);
    expect(await screen.findByText(/No certificate file on disk yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Renew now/ })).not.toBeInTheDocument();
  });

  it("fires onClose from the Close button", async () => {
    const onClose = vi.fn();
    render(<CertDetailModal cert={cert} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("labels the dialog with the domain as a .modal-title heading and moves focus inside", async () => {
    render(<CertDetailModal cert={cert} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    const heading = screen.getByText("app.example.com");
    expect(heading).toHaveClass("modal-title");
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("closes on Escape via the focus trap", async () => {
    const onClose = vi.fn();
    render(<CertDetailModal cert={cert} onClose={onClose} />);
    await screen.findByText("CN=app.example.com");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
