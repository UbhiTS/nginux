import { afterEach, describe, expect, it, vi } from "vitest";
import { api, AUTH_REQUIRED_EVENT } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("expired session handling", () => {
  it("notifies the app when an authenticated API request returns 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({ error: "Authentication required" }),
    }));
    const onAuthRequired = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired, { once: true });

    await expect(api.certificates()).rejects.toThrow("Authentication required");
    expect(onAuthRequired).toHaveBeenCalledOnce();
  });

  it("does not treat rejected login credentials as an expired live session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({ error: "Invalid username or password" }),
    }));
    const onAuthRequired = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired, { once: true });

    await expect(api.login("admin", "wrong")).rejects.toThrow("Invalid username or password");
    expect(onAuthRequired).not.toHaveBeenCalled();
  });
});
