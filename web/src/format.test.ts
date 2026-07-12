import { describe, it, expect, vi } from "vitest";
import { fmtBytes, statusColor, flag, countryName, days, plural, copyText } from "./format.ts";

describe("fmtBytes", () => {
  it("scales bytes to B/KB/MB/GB with one decimal", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1500)).toBe("1.5 KB");
    expect(fmtBytes(2_500_000)).toBe("2.5 MB");
    expect(fmtBytes(3_200_000_000)).toBe("3.2 GB");
  });
  it("uses the 1000 boundary, not 1024", () => {
    expect(fmtBytes(999)).toBe("999 B");
    expect(fmtBytes(1000)).toBe("1.0 KB");
  });
});

describe("statusColor", () => {
  it("maps each status class to its design-system colour var", () => {
    expect(statusColor(204)).toBe("var(--green)");
    expect(statusColor(301)).toBe("var(--accent)");
    expect(statusColor(404)).toBe("var(--yellow)");
    expect(statusColor(500)).toBe("var(--red)");
    expect(statusColor(503)).toBe("var(--red)");
  });
});

describe("flag", () => {
  it("converts a 2-letter code to its flag emoji, case-insensitively", () => {
    expect(flag("US")).toBe("🇺🇸");
    expect(flag("de")).toBe("🇩🇪");
  });
  it("falls back to the globe for anything that isn't 2 letters", () => {
    expect(flag("")).toBe("🌐");
    expect(flag("USA")).toBe("🌐");
  });
});

describe("countryName", () => {
  it("resolves a code to a full English name", () => {
    expect(countryName("US")).toBe("United States");
    expect(countryName("FR")).toBe("France");
  });
  it("returns an empty string for empty input", () => {
    expect(countryName("")).toBe("");
  });
});

describe("days", () => {
  it("uses the singular only for exactly 1", () => {
    expect(days(0)).toBe("0 days");
    expect(days(1)).toBe("1 day");
    expect(days(5)).toBe("5 days");
  });
});

describe("plural", () => {
  it("adds the suffix unless the count is 1", () => {
    expect(plural("service", 1)).toBe("service");
    expect(plural("service", 2)).toBe("services");
    expect(plural("box", 3, "es")).toBe("boxes");
  });
});

describe("copyText", () => {
  it("writes to the clipboard and resolves true", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await expect(copyText("token-123")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("token-123");
  });
  it("resolves false when the clipboard write rejects", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    await expect(copyText("x")).resolves.toBe(false);
  });
});
