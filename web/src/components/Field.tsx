import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

// A labeled form field that ties the <label> to its control (htmlFor/id) and wires
// the hint as aria-describedby — the codebase had ZERO htmlFor, so screen readers
// announced every input as "edit text, blank" and label clicks didn't focus. Wrap a
// single control child; the id is injected onto it (or reuses the child's own id).
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const genId = useId();
  const child = isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : null;
  const id = (child?.props.id as string | undefined) ?? genId;
  const hintId = hint ? `${id}-hint` : undefined;
  const describedBy = [child?.props["aria-describedby"], hintId].filter(Boolean).join(" ") || undefined;
  const control = child ? cloneElement(child, { id, "aria-describedby": describedBy }) : children;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {hint && (
        <div className="hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}
