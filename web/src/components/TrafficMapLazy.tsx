import { lazy, Suspense, type ComponentProps } from "react";

// Lazy boundary for TrafficMap so the ~41 KB world-map geometry (worldland.ts) is
// code-split into its own chunk, fetched only when a map is actually shown (the Logs
// page, or a service's Geography section) instead of shipped in the main bundle that
// gates the login screen. Consumers import { TrafficMap } from here instead of the
// component directly — same props, same name.
const Inner = lazy(() => import("./TrafficMap.tsx").then((m) => ({ default: m.TrafficMap })));

export function TrafficMap(props: ComponentProps<typeof Inner>) {
  return (
    <Suspense fallback={<div className="skeleton" style={{ height: 280, borderRadius: "var(--radius)" }} />}>
      <Inner {...props} />
    </Suspense>
  );
}
