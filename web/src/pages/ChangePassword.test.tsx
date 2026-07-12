import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangePassword } from "./ChangePassword.tsx";
import { api } from "../api.ts";

// ChangePassword only touches the backend through api.changePassword (on submit).
vi.mock("../api.ts", () => ({ api: { changePassword: vi.fn() } }));

const user = {
  id: "u1",
  username: "admin",
  email: "admin@example.com",
  role: "admin" as const,
  scope: "*",
  twofaEnabled: false,
  mustChangePassword: true,
  createdAt: "2026-01-01T00:00:00Z",
  lastLoginAt: null,
};

// Three password inputs share type=password; select them positionally.
function passwordInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
}

beforeEach(() => {
  vi.mocked(api.changePassword).mockReset();
});

describe("ChangePassword", () => {
  it("renders the three password fields plus a save button", () => {
    render(<ChangePassword user={user} onChanged={() => {}} />);
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm new password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save and continue/i })).toBeInTheDocument();
  });

  it("wires each field with the right autocomplete token for password managers", () => {
    render(<ChangePassword user={user} onChanged={() => {}} />);
    expect(screen.getByLabelText("Current password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Confirm new password")).toHaveAttribute("autocomplete", "new-password");
  });

  it("includes a hidden username field carrying the account name for password managers", () => {
    render(<ChangePassword user={user} onChanged={() => {}} />);
    const hidden = document.querySelector('input[name="username"]') as HTMLInputElement;
    expect(hidden).toBeTruthy();
    expect(hidden.value).toBe("admin");
    expect(hidden).toHaveAttribute("autocomplete", "username");
  });

  it("rejects a too-short new password without calling the API (announced via role=alert)", async () => {
    render(<ChangePassword user={user} onChanged={() => {}} />);
    const [current, next, confirm] = passwordInputs();
    await userEvent.type(current, "oldpass1");
    await userEvent.type(next, "short");
    await userEvent.type(confirm, "short");
    await userEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("at least 8 characters");
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it("rejects mismatched new passwords without calling the API", async () => {
    render(<ChangePassword user={user} onChanged={() => {}} />);
    const [current, next, confirm] = passwordInputs();
    await userEvent.type(current, "oldpass1");
    await userEvent.type(next, "newpassword1");
    await userEvent.type(confirm, "newpassword2");
    await userEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("don't match");
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it("submits current + new password and calls onChanged on success", async () => {
    vi.mocked(api.changePassword).mockResolvedValue({ ok: true, user: { ...user, mustChangePassword: false } });
    const onChanged = vi.fn();
    render(<ChangePassword user={user} onChanged={onChanged} />);
    const [current, next, confirm] = passwordInputs();
    await userEvent.type(current, "oldpass1");
    await userEvent.type(next, "newpassword1");
    await userEvent.type(confirm, "newpassword1");
    await userEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    expect(api.changePassword).toHaveBeenCalledWith("oldpass1", "newpassword1");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("surfaces an API rejection through the alert banner", async () => {
    vi.mocked(api.changePassword).mockRejectedValue(new Error("Current password is wrong"));
    render(<ChangePassword user={user} onChanged={() => {}} />);
    const [current, next, confirm] = passwordInputs();
    await userEvent.type(current, "badpass1");
    await userEvent.type(next, "newpassword1");
    await userEvent.type(confirm, "newpassword1");
    await userEvent.click(screen.getByRole("button", { name: /save and continue/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Current password is wrong");
  });
});
