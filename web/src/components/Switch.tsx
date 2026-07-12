// The custom toggle, made accessible: role=switch + aria-checked + an accessible
// name, replacing bare `<button className="switch">` (empty body, no ARIA) that
// announced as an unnamed, stateless button. Same visual, correct semantics.
export function Switch({
  checked,
  onChange,
  label,
  labelledBy,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. Use `label` for a plain string, or `labelledBy` to point at a visible label's id. */
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    />
  );
}
