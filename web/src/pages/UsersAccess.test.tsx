import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthUser, Session } from "../api.ts";

// The page fetches its two lists on mount (api.users + api.sessions) and calls
// the mutating endpoints from its modals; mock the whole api surface it touches.
vi.mock("../api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.ts")>();
  return {
    ...actual,
    api: {
      users: vi.fn(),
      sessions: vi.fn(),
      revokeSession: vi.fn(),
      updateUserRole: vi.fn(),
      createUser: vi.fn(),
      deleteUser: vi.fn(),
      adminSetUserPassword: vi.fn(),
      changePassword: vi.fn(),
      twofaSetup: vi.fn(),
      twofaVerify: vi.fn(),
    },
  };
});

import { UsersAccess } from "./UsersAccess.tsx";
import { api } from "../api.ts";

function makeUser(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "u1",
    username: "alice",
    email: "alice@example.com",
    role: "admin",
    scope: "",
    twofaEnabled: true,
    mustChangePassword: false,
    createdAt: "2026-01-01T00:00:00Z",
    lastLoginAt: "2026-01-02T09:30:00Z",
    ...over,
  };
}

function makeSession(over: Partial<Session> = {}): Session {
  return {
    sid: "s1",
    current: false,
    userId: "u1",
    username: "alice",
    device: "Firefox on Linux",
    ip: "192.168.1.10",
    lastActive: "2026-01-02T09:30:00Z",
    ...over,
  };
}

function renderPage(opts: { currentUser?: AuthUser; tab?: string } = {}) {
  const currentUser = opts.currentUser ?? makeUser();
  const refreshMe = vi.fn().mockResolvedValue(undefined);
  const setTab = vi.fn();
  render(<UsersAccess currentUser={currentUser} refreshMe={refreshMe} tab={opts.tab ?? "users"} setTab={setTab} />);
  return { currentUser, refreshMe, setTab };
}

beforeEach(() => {
  vi.mocked(api.users).mockResolvedValue([makeUser()]);
  vi.mocked(api.sessions).mockResolvedValue([makeSession()]);
  vi.mocked(api.createUser).mockResolvedValue(makeUser() as never);
  vi.mocked(api.deleteUser).mockResolvedValue({ ok: true } as never);
  vi.mocked(api.revokeSession).mockResolvedValue({ ok: true } as never);
  vi.mocked(api.updateUserRole).mockResolvedValue(makeUser() as never);
  vi.mocked(api.adminSetUserPassword).mockResolvedValue({ ok: true } as never);
  vi.mocked(api.changePassword).mockResolvedValue({ ok: true } as never);
  vi.mocked(api.twofaSetup).mockResolvedValue({ secret: "ABCD", otpauth: "otpauth://x" } as never);
  vi.mocked(api.twofaVerify).mockResolvedValue({ ok: true, backupCodes: ["code-1", "code-2"] } as never);
});

describe("UsersAccess — list state", () => {
  it("shows a skeleton while users load, then the rows (no false rows during load)", async () => {
    let resolve!: (u: AuthUser[]) => void;
    vi.mocked(api.users).mockReturnValue(new Promise<AuthUser[]>((r) => { resolve = r; }));
    renderPage();

    // during load: the row for the current user must NOT be shown yet
    expect(screen.queryByText("alice@example.com")).not.toBeInTheDocument();

    resolve([makeUser()]);
    await waitFor(() => expect(screen.getByText("alice@example.com")).toBeInTheDocument());
  });

  it("surfaces an error state with a Retry that refetches the users list", async () => {
    vi.mocked(api.users).mockRejectedValueOnce(new Error("boom"));
    renderPage();

    const note = await screen.findByRole("alert");
    expect(note).toHaveTextContent(/couldn't load users/i);
    expect(note).toHaveTextContent("boom");

    vi.mocked(api.users).mockResolvedValueOnce([makeUser()]);
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText("alice@example.com")).toBeInTheDocument());
  });

  it("shows a zero-state for the sessions tab when there are none", async () => {
    vi.mocked(api.sessions).mockResolvedValue([]);
    renderPage({ tab: "sessions" });

    expect(await screen.findByText("No active sessions.")).toBeInTheDocument();
  });

  it("renders session rows once loaded", async () => {
    renderPage({ tab: "sessions" });
    expect(await screen.findByText("Firefox on Linux")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.10")).toBeInTheDocument();
  });
});

describe("UsersAccess — roles", () => {
  it("prefixes a scoped user's role cell with 'scoped:' and its scope", async () => {
    vi.mocked(api.users).mockResolvedValue([
      makeUser(),
      makeUser({ id: "u2", username: "bob", email: "bob@example.com", role: "scoped", scope: "plex, ha" }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("bob@example.com")).toBeInTheDocument());
    expect(screen.getByText("scoped: plex, ha")).toBeInTheDocument();
  });

  it("shows a capability legend on the Users tab", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("alice@example.com")).toBeInTheDocument());
    expect(screen.getByText("What each role can do")).toBeInTheDocument();
    expect(screen.getByText(/manage services/i)).toBeInTheDocument();
  });

  it("lets an admin change a user's role in place via the role select", async () => {
    vi.mocked(api.users).mockResolvedValue([
      makeUser(),
      makeUser({ id: "u2", username: "bob", email: "bob@example.com", role: "readonly" }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("bob@example.com")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Role for bob"), "editor");
    expect(api.updateUserRole).toHaveBeenCalledWith("u2", "editor", "");
  });

  it("disables the role select for the last remaining admin", async () => {
    renderPage(); // alice is the only admin
    await waitFor(() => expect(screen.getByText("alice@example.com")).toBeInTheDocument());
    expect(screen.getByLabelText("Role for alice")).toBeDisabled();
  });
});

describe("UsersAccess — session revoke", () => {
  it("marks the caller's own session as 'This device'", async () => {
    vi.mocked(api.sessions).mockResolvedValue([makeSession({ sid: "sme", current: true })]);
    renderPage({ tab: "sessions" });
    expect(await screen.findByText("This device")).toBeInTheDocument();
  });

  it("revokes a session through the confirm dialog", async () => {
    vi.mocked(api.sessions).mockResolvedValue([
      makeSession({ sid: "s9", username: "bob", device: "Safari on iPhone", ip: "10.0.0.9" }),
    ]);
    renderPage({ tab: "sessions" });
    await waitFor(() => expect(screen.getByText("Safari on iPhone")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke session" }));
    expect(api.revokeSession).toHaveBeenCalledWith("s9");
  });
});

describe("UsersAccess — forms & feedback", () => {
  it("labels the change-password fields (htmlFor wiring via Field)", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("alice@example.com")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    // labels are tied to their inputs, so getByLabelText resolves them
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
  });

  it("reports a mismatch as role=alert without calling the API", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("alice@example.com")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await userEvent.type(screen.getByLabelText("Current password"), "oldpassword");
    await userEvent.type(screen.getByLabelText("New password"), "newpassword1");
    await userEvent.type(screen.getByLabelText("Confirm new password"), "different123");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/don't match/i);
    expect(api.changePassword).not.toHaveBeenCalled();
  });
});

describe("UsersAccess — destructive actions", () => {
  it("deletes a user through the confirm dialog and reloads", async () => {
    vi.mocked(api.users).mockResolvedValue([
      makeUser(),
      makeUser({ id: "u2", username: "bob", email: "bob@example.com", role: "editor" }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("bob@example.com")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Delete bob?");

    await userEvent.click(within(dialog).getByRole("button", { name: "Delete user" }));
    expect(api.deleteUser).toHaveBeenCalledWith("u2");
    await waitFor(() => expect(api.users).toHaveBeenCalledTimes(2));
  });

  it("keeps Delete enabled for a second admin (two admins present) and for non-admins", async () => {
    vi.mocked(api.users).mockResolvedValue([
      makeUser(), // alice, admin (current user — no delete button of her own)
      makeUser({ id: "u2", username: "bob", email: "bob@example.com", role: "admin" }),
      makeUser({ id: "u3", username: "carol", email: "carol@example.com", role: "editor" }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("bob@example.com")).toBeInTheDocument());

    // With ≥2 admins present the last-admin guard does not fire — both deletes enabled.
    for (const btn of screen.getAllByRole("button", { name: "Delete" })) {
      expect(btn).toBeEnabled();
    }
  });

  it("routes an admin password reset through a confirm dialog before calling the API", async () => {
    vi.mocked(api.users).mockResolvedValue([
      makeUser(),
      makeUser({ id: "u2", username: "bob", email: "bob@example.com", role: "editor", twofaEnabled: false }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("bob@example.com")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));

    // scope to the reset modal — the row also has a "Reset password" button
    const modal = screen.getByText("Reset password - bob").closest(".modal-card") as HTMLElement;
    await userEvent.type(within(modal).getByLabelText("New password"), "temp-pass-123");
    await userEvent.type(within(modal).getByLabelText("Confirm new password"), "temp-pass-123");
    await userEvent.click(within(modal).getByRole("button", { name: "Reset password" }));

    // the form submit opens a confirm dialog — API not called yet
    expect(api.adminSetUserPassword).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/reset bob's password/i);

    await userEvent.click(within(dialog).getByRole("button", { name: "Reset password" }));
    expect(api.adminSetUserPassword).toHaveBeenCalledWith("u2", "temp-pass-123");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/password reset for bob/i));
  });
});
