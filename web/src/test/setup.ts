import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount anything a test rendered so tests don't leak DOM into each other.
afterEach(() => cleanup());

// --- jsdom gaps: browser APIs the components use that jsdom doesn't implement ---

// Server-Sent Events (live logs / traffic / agent activity). A controllable stub so
// tests can assert a stream is opened/closed and can push events at the component.
// Grab the last instance via (EventSource as unknown as { instances: MockEventSource[] }).
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  closed = false;
  private listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = !!init?.withCredentials;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    (this.listeners[type] ||= []).push(cb);
  }
  removeEventListener(type: string, cb: (e: MessageEvent) => void) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== cb);
  }
  close() {
    this.closed = true;
  }
  /** Test helper: deliver an event to registered listeners (data is JSON-stringified). */
  emit(type: string, data: unknown) {
    (this.listeners[type] || []).forEach((cb) => cb({ data: JSON.stringify(data) } as MessageEvent));
  }
}
vi.stubGlobal("EventSource", MockEventSource);

// ResizeObserver / IntersectionObserver (Topology measures/observes its container).
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
vi.stubGlobal("ResizeObserver", NoopObserver);
vi.stubGlobal("IntersectionObserver", NoopObserver);

// jsdom doesn't implement scrollIntoView; Logs calls it when an IP is picked.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom doesn't implement matchMedia; usePrefersReducedMotion + any media query read it.
// Default to "no reduced motion" (matches: false). Override per-test via vi.stubGlobal.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
