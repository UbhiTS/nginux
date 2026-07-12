import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Login } from "./Login.tsx";
import { api } from "../api.ts";

// Login only touches the backend through api.login (on submit); nothing on mount.
vi.mock("../api.ts", () => ({ api: { login: vi.fn() } }));

const sampleUser = {
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

// The username field is the only textbox (the password input, type=password,
// has no textbox role); grab the password field by its type.
function passwordInput(): HTMLInputElement {
  const el = document.querySelector('input[type="password"]');
  if (!el) throw new Error("password input not found");
  return el as HTMLInputElement;
}

beforeEach(() => {
  vi.mocked(api.login).mockReset();
});

describe("Login", () => {
  it("renders username and password fields plus a Sign in button", () => {
    render(<Login onSignedIn={() => {}} />);
    expect(screen.getByText("Username")).toBeInTheDocument();
    expect(screen.getByText("Password")).toBeInTheDocument();
    // username = the sole textbox; password = the type=password input
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(passwordInput()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("submits the entered username and password to api.login (no 2FA token)", async () => {
    vi.mocked(api.login).mockResolvedValue({ user: sampleUser });
    render(<Login onSignedIn={() => {}} />);

    await userEvent.type(screen.getByRole("textbox"), "admin");
    await userEvent.type(passwordInput(), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(api.login).toHaveBeenCalledWith("admin", "hunter2", undefined);
  });

  it("calls onSignedIn with the returned user on a successful login", async () => {
    vi.mocked(api.login).mockResolvedValue({ user: sampleUser });
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByRole("textbox"), "admin");
    await userEvent.type(passwordInput(), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(sampleUser));
  });

  it("shows the error message when the login is rejected", async () => {
    vi.mocked(api.login).mockRejectedValue(new Error("Invalid credentials"));
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByRole("textbox"), "admin");
    await userEvent.type(passwordInput(), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("Invalid credentials")).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("announces the rejection through a role=alert banner", async () => {
    vi.mocked(api.login).mockRejectedValue(new Error("Invalid credentials"));
    render(<Login onSignedIn={() => {}} />);

    await userEvent.type(screen.getByRole("textbox"), "admin");
    await userEvent.type(passwordInput(), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid credentials");
  });

  it("wires the credential fields with autocomplete tokens for password managers", () => {
    render(<Login onSignedIn={() => {}} />);
    const username = screen.getByRole("textbox") as HTMLInputElement;
    expect(username).toHaveAttribute("name", "username");
    expect(username).toHaveAttribute("autocomplete", "username");
    // The label is tied to the control via htmlFor/id (Field primitive).
    expect(username).toHaveAccessibleName("Username");
    const password = passwordInput();
    expect(password).toHaveAttribute("name", "password");
    expect(password).toHaveAttribute("autocomplete", "current-password");
  });

  it("labels the 2FA code input with a one-time-code autocomplete", async () => {
    vi.mocked(api.login).mockResolvedValue({ twofaRequired: true });
    render(<Login onSignedIn={() => {}} />);

    await userEvent.type(screen.getByRole("textbox"), "admin");
    await userEvent.type(passwordInput(), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    const code = (await screen.findByLabelText("6-digit code")) as HTMLInputElement;
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
  });

  it("submits the form when Enter is pressed in a field", async () => {
    vi.mocked(api.login).mockResolvedValue({ user: sampleUser });
    render(<Login onSignedIn={() => {}} />);

    await userEvent.type(screen.getByRole("textbox"), "admin");
    // Trailing {Enter} triggers implicit form submission.
    await userEvent.type(passwordInput(), "hunter2{Enter}");

    await waitFor(() => expect(api.login).toHaveBeenCalledWith("admin", "hunter2", undefined));
  });

  it("switches to the 2FA code step when the server requires a token", async () => {
    vi.mocked(api.login).mockResolvedValue({ twofaRequired: true });
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByRole("textbox"), "admin");
    await userEvent.type(passwordInput(), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    // The step swaps to 2FA entry: heading, code label, and a Verify button.
    expect(await screen.findByText("Enter your 2FA code")).toBeInTheDocument();
    expect(screen.getByText("6-digit code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /verify/i })).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
