import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTheme } from "./theme.ts";

const KEY = "nginux-theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  localStorage.clear();
});

describe("useTheme", () => {
  it("defaults to dark when nothing is stored", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("reads an existing stored value on init", () => {
    localStorage.setItem(KEY, "medium");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("medium");
  });

  it("writes localStorage and data-theme on mount", () => {
    localStorage.setItem(KEY, "less-light");
    renderHook(() => useTheme());
    expect(localStorage.getItem(KEY)).toBe("less-light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("less-light");
  });

  it("setTheme sets a theme directly", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("light"));
    expect(result.current.theme).toBe("light");
  });

  it("setTheme persists to localStorage and the document element", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("less-dark"));
    expect(localStorage.getItem(KEY)).toBe("less-dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("less-dark");
  });

  it("cycleTheme rotates dark -> less-dark -> medium -> less-light -> light", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");

    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe("less-dark");

    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe("medium");

    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe("less-light");

    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe("light");
  });

  it("cycleTheme wraps from light back to dark", () => {
    localStorage.setItem(KEY, "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("cycleTheme persists each change to localStorage and data-theme", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe("less-dark");
    expect(localStorage.getItem(KEY)).toBe("less-dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("less-dark");
  });
});
