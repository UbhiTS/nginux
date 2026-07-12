import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ServiceIcon, iconUrlForSlug } from "./ServiceIcon.tsx";

// Avatar talks to the backend through api.ts; mock only the methods it touches.
vi.mock("../api.ts", () => ({
  api: {
    avatarUrl: vi.fn((id: string, v = 0) => `/api/users/${encodeURIComponent(id)}/avatar${v ? `?v=${v}` : ""}`),
    uploadAvatar: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

import { api } from "../api.ts";
import { Avatar } from "./Avatar.tsx";

describe("ServiceIcon", () => {
  it("renders the logo <img> with the given URL when one is set", () => {
    const { container } = render(<ServiceIcon iconUrl="https://example.com/logo.svg" />);
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "https://example.com/logo.svg");
  });

  it("renders the generic glyph as an always-present underlay so the box is never blank while loading", () => {
    // On a firewalled homelab the CDN request can hang forever without firing
    // onError; the underlay glyph guarantees something is always painted.
    const { container } = render(<ServiceIcon iconUrl="https://example.com/logo.svg" />);
    expect(container.querySelector("img")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("marks the image lazy-loading and async-decoding so a hanging CDN never blocks", () => {
    const { container } = render(<ServiceIcon iconUrl="https://example.com/logo.svg" />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
  });

  it("applies the size prop to the image dimensions", () => {
    const { container } = render(<ServiceIcon iconUrl="https://example.com/logo.svg" size={40} />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("width", "40");
    expect(img).toHaveAttribute("height", "40");
  });

  it("falls back to the generic glyph (an <svg>, no <img>) when no URL is given", () => {
    const { container } = render(<ServiceIcon />);
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("falls back to the generic glyph if the image fails to load", () => {
    const { container } = render(<ServiceIcon iconUrl="https://example.com/broken.svg" />);
    const img = container.querySelector("img")!;
    expect(img).toBeInTheDocument();
    fireEvent.error(img); // simulate a broken image
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

describe("iconUrlForSlug", () => {
  it("builds a dashboard-icons CDN URL from a slug", () => {
    expect(iconUrlForSlug("plex")).toBe("https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/plex.svg");
  });

  it("returns an empty string when there is no slug", () => {
    expect(iconUrlForSlug("")).toBe("");
    expect(iconUrlForSlug()).toBe("");
  });
});

describe("Avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the uploaded photo <img> on mount, sourced from api.avatarUrl", () => {
    const { container } = render(<Avatar userId="user-1" name="Alice" />);
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(api.avatarUrl).toHaveBeenCalledWith("user-1", 0);
    expect(img).toHaveAttribute("src", "/api/users/user-1/avatar");
  });

  it("shows the initials underlay even while the image is still loading", () => {
    // The initial is rendered up-front (not only on error), so the avatar is
    // never blank while the photo loads or if it never resolves.
    render(<Avatar userId="user-1" name="Alice" />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("marks the avatar image lazy-loading", () => {
    const { container } = render(<Avatar userId="user-1" name="Alice" />);
    expect(container.querySelector("img")).toHaveAttribute("loading", "lazy");
  });

  it("falls back to the uppercased initial when the image fails to load", () => {
    const { container } = render(<Avatar userId="user-1" name="alice" />);
    fireEvent.error(container.querySelector("img")!); // no uploaded photo -> broken
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("uses '?' as the fallback initial when the name is empty", () => {
    const { container } = render(<Avatar userId="user-1" name="" />);
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("?")).toBeInTheDocument();
  });

  it("exposes a button and a hidden file input when editable", () => {
    const { container } = render(<Avatar userId="user-1" name="Bob" editable />);
    expect(screen.getByRole("button")).toHaveAttribute("title", "Change photo");
    expect(container.querySelector('input[type="file"]')).toBeInTheDocument();
  });

  it("is a plain avatar with no button or file input when not editable", () => {
    const { container } = render(<Avatar userId="user-1" name="Bob" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).not.toBeInTheDocument();
  });
});
