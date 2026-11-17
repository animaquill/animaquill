/**
 * The sign of fades, the transitions of sound: the bars of a sound going down, then those of
 * another coming up, as in a cross-fade. On the tab of fades, and wherever a fade has no picture
 * of its own. Drawn as the lucide icons around it are, 24 across with round strokes of 2: five bars
 * of sound, as lucide's `audio-lines` has, going down and up again.
 */
export function FadeIcon({
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
      data-icon="fade"
    >
      <path d="M4 4v16" />
      <path d="M8 7v10" />
      <path d="M12 10v4" />
      <path d="M16 7v10" />
      <path d="M20 4v16" />
    </svg>
  );
}
