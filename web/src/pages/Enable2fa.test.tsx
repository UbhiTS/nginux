import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Enable2fa } from "./Enable2fa.tsx";
import { api } from "../api.ts";

// Enable2fa touches the backend through api.twofaSetup then api.twofaVerify.
vi.mock("../api.ts", () => ({ api: { twofaSetup: vi.fn(), twofaVerify: vi.fn() } }));

const user = {
  id: "u1",
  username: "admin",
  email: "admin@example.com",
  role: "admin" as const,
  scope: "*",
  twofaEnabled: false,
  mustChangePassword: false,
  createdAt: "2026-01-01T00:00:00Z",
  lastLoginAt: null,
};

const setup = { secret: "JBSWY3DPEHPK3PXP", otpauth: "otpauth://totp/NginUX:admin?secret=JBSWY3DPEHPK3PXP" };
const backupCodes = ["AAAA-1111", "BBBB-2222", "CCCC-3333"];

// Drive the flow to the backup-codes phase (password -> verify -> backup).
async function reachBackupPhase() {
  vi.mocked(api.twofaSetup).mockResolvedValue(setup);
  vi.mocked(api.twofaVerify).mockResolvedValue({ ok: true, backupCodes });
  const onEnabled = vi.fn();
  render(<Enable2fa user={user} onEnabled={onEnabled} onLogout={() => {}} />);

  await userEvent.type(screen.getByLabelText("Confirm your password"), "hunter2");
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));

  const code = await screen.findByLabelText("6-digit code");
  await userEvent.type(code, "123456");
  await userEvent.click(screen.getByRole("button", { name: /verify/i }));

  await screen.findByText("Two-factor is on.");
  return { onEnabled };
}

beforeEach(() => {
  vi.mocked(api.twofaSetup).mockReset();
  vi.mocked(api.twofaVerify).mockReset();
});

describe("Enable2fa", () => {
  it("labels the password field with a current-password autocomplete", () => {
    render(<Enable2fa user={user} onEnabled={() => {}} onLogout={() => {}} />);
    const pw = screen.getByLabelText("Confirm your password");
    expect(pw).toHaveAttribute("type", "password");
    expect(pw).toHaveAttribute("autocomplete", "current-password");
  });

  it("starts setup with the password and advances to the verify step", async () => {
    vi.mocked(api.twofaSetup).mockResolvedValue(setup);
    render(<Enable2fa user={user} onEnabled={() => {}} onLogout={() => {}} />);

    await userEvent.type(screen.getByLabelText("Confirm your password"), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(api.twofaSetup).toHaveBeenCalledWith("hunter2");
    const code = await screen.findByLabelText("6-digit code");
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
  });

  it("announces a setup error via role=alert", async () => {
    vi.mocked(api.twofaSetup).mockRejectedValue(new Error("Wrong password"));
    render(<Enable2fa user={user} onEnabled={() => {}} onLogout={() => {}} />);

    await userEvent.type(screen.getByLabelText("Confirm your password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong password");
  });

  it("verifies the code and shows the backup codes under a role=status banner", async () => {
    await reachBackupPhase();
    expect(api.twofaVerify).toHaveBeenCalledWith("123456");
    expect(screen.getByRole("status")).toHaveTextContent("Two-factor is on.");
    backupCodes.forEach((c) => expect(screen.getByText(new RegExp(c))).toBeInTheDocument());
  });

  it("gates the continue button behind the acknowledgement checkbox", async () => {
    const { onEnabled } = await reachBackupPhase();
    const cont = screen.getByRole("button", { name: /^continue$/i });
    expect(cont).toBeDisabled();

    // Clicking while disabled must not advance.
    await userEvent.click(cont);
    expect(onEnabled).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("checkbox"));
    expect(cont).toBeEnabled();
    await userEvent.click(cont);
    expect(onEnabled).toHaveBeenCalled();
  });

  it("offers a Copy button that writes the codes to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    try {
      await reachBackupPhase();
      await userEvent.click(screen.getByRole("button", { name: /^copy$/i }));
      expect(writeText).toHaveBeenCalledWith(backupCodes.join("\n"));
      expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers a Download button that produces a .txt blob", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:mock");
    const revokeObjectURL = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      await reachBackupPhase();
      await userEvent.click(screen.getByRole("button", { name: /download/i }));
      expect(createObjectURL).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
    }
  });
});
