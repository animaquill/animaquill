/**
 * "fx", the sign of effects: on the tab of effects, and wherever an effect has no picture of its
 * own. Drawn as the lucide icons around it are, 24 across with round strokes of 2, which lucide
 * has no icon for.
 */
export function FxIcon({
  size = 24,
  className,
}: {
  size?: number;
  className?: string | undefined;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      data-icon="fx"
    >
      <path d="M11 4.6A3 3 0 0 0 6.5 7.2V20" />
      <path d="M3.5 11h6" />
      <path d="m13.5 11 7 9" />
      <path d="m20.5 11-7 9" />
    </svg>
  );
}
