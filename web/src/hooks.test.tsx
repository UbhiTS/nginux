import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAsyncData, usePrefersReducedMotion, useCountUp } from "./hooks.ts";

describe("useAsyncData", () => {
  it("starts loading, then resolves to ready with data", async () => {
    const { result } = renderHook(() => useAsyncData(() => Promise.resolve([1, 2, 3]), []));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toEqual([1, 2, 3]);
    expect(result.current.error).toBeNull();
  });

  it("captures a rejection as an error state (not a silent empty)", async () => {
    const { result } = renderHook(() => useAsyncData(() => Promise.reject(new Error("boom")), []));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("boom");
    expect(result.current.data).toBeNull();
  });

  it("reload() re-runs the loader", async () => {
    let n = 0;
    const { result } = renderHook(() => useAsyncData(() => Promise.resolve(++n), []));
    await waitFor(() => expect(result.current.data).toBe(1));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toBe(2));
  });
});

describe("usePrefersReducedMotion", () => {
  it("returns false when the user has no reduced-motion preference", () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it("returns true when the media query matches", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("useCountUp", () => {
  it("jumps straight to the target under reduced motion (no animation)", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    const { result } = renderHook(() => useCountUp(4200));
    expect(result.current).toBe(4200);
    vi.unstubAllGlobals();
  });

  it("eventually reaches the target when animating", async () => {
    const { result } = renderHook(() => useCountUp(50, 20));
    await waitFor(() => expect(result.current).toBe(50));
  });
});
