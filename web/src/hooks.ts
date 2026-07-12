import { useCallback, useEffect, useRef, useState } from "react";

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Focus management for a modal/drawer: on `active`, move focus inside `ref`, trap
 *  Tab within it, close on Escape, and restore focus to the prior element on close.
 *  Attach the returned ref to the dialog container. */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(active: boolean, onClose?: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    const prev = document.activeElement as HTMLElement | null;
    // Note: no offsetParent/visibility filter — jsdom reports offsetParent as null
    // for everything, and modals rarely contain hidden focusables in practice.
    const items = () => (el ? Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)) : []);
    (items()[0] ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = items();
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const idx = nodes.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && idx <= 0) {
        e.preventDefault();
        nodes[nodes.length - 1].focus();
      } else if (!e.shiftKey && idx === nodes.length - 1) {
        e.preventDefault();
        nodes[0].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [active, onClose]);
  return ref;
}

/** True when the user asks for reduced motion. CSS can't stop SMIL / JS animations,
 *  so the animated Topology + TrafficMap read this to render static instead. */
export function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const get = () => (typeof matchMedia === "function" ? matchMedia(query).matches : false);
  const [reduced, setReduced] = useState<boolean>(get);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** Animate a number from 0 up to `target` on mount / when the target changes (a bit of
 *  character on the dashboard stat tiles). Honors reduced-motion (jumps straight to the
 *  value) and degrades to the final value if requestAnimationFrame is unavailable. */
export function useCountUp(target: number, durationMs = 650): number {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState<number>(() => (reduced ? target : 0));
  useEffect(() => {
    if (reduced || typeof requestAnimationFrame !== "function") {
      setValue(target);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const tick = (t: number) => {
      if (start === null) start = t;
      const p = Math.min(1, (t - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setValue(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs, reduced]);
  return value;
}

export type AsyncStatus = "loading" | "ready" | "error";
export interface AsyncData<T> {
  status: AsyncStatus;
  data: T | null;
  error: string | null;
  reload: () => void;
}

/** Load an async resource into a loading→ready→error machine, so a dropped fetch is
 *  distinguishable from a genuinely empty result (the app-wide bug where a failed
 *  list silently rendered its "you have none" zero-state). `deps` re-run the loader. */
export function useAsyncData<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncData<T> {
  const [state, setState] = useState<{ status: AsyncStatus; data: T | null; error: string | null }>({
    status: "loading",
    data: null,
    error: null,
  });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const aliveRef = useRef(true);
  const run = useCallback(() => {
    aliveRef.current = true;
    setState((s) => ({ ...s, status: "loading" }));
    loaderRef.current()
      .then((d) => aliveRef.current && setState({ status: "ready", data: d, error: null }))
      .catch((e) =>
        aliveRef.current &&
        setState({ status: "error", data: null, error: e instanceof Error ? e.message : "Request failed" }),
      );
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    aliveRef.current = true;
    run();
    return () => {
      aliveRef.current = false;
    };
  }, [run]);
  return { ...state, reload: run };
}
