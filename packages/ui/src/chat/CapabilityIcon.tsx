import { useTranslation } from "react-i18next";

/** What a model can do besides text, as one icon shows it. */
export type Capability = "thinking" | "image" | "both";

/** The icon a model shows: none where it can do neither. */
export const capabilityOf = (model: {
  readonly reasoning?: boolean | undefined;
  readonly image?: boolean | undefined;
}): Capability | undefined =>
  model.reasoning && model.image
    ? "both"
    : model.reasoning
      ? "thinking"
      : model.image
        ? "image"
        : undefined;

/** The drawings, on a grid of 16 with strokes of 1.4, as lucide draws (lucide has none of these). */
const PATHS: Readonly<Record<Capability, readonly string[]>> = {
  thinking: [
    "M8 1.75a4.25 4.25 0 0 0-2.55 7.65c.6.45.95 1.05.95 1.7v.65h3.2v-.65c0-.65.35-1.25.95-1.7A4.25 4.25 0 0 0 8 1.75z",
    "M6.6 14.25h2.8",
  ],
  image: ["M1.25 8S3.75 3.5 8 3.5 14.75 8 14.75 8 12.25 12.5 8 12.5 1.25 8 1.25 8z"],
  // An eye, and a small bulb at its top right: both of the others, as one.
  both: [
    "M1 10.75S3 7.25 6.5 7.25 12 10.75 12 10.75 10 14.25 6.5 14.25 1 10.75 1 10.75z",
    "M12.5 1.25a2.4 2.4 0 0 0-1.45 4.3c.3.25.45.55.45.9v.3h2v-.3c0-.35.15-.65.45-.9a2.4 2.4 0 0 0-1.45-4.3z",
    "M11.8 8.1h1.4",
  ],
};

/**
 * What a model can do, as one icon (docs/design/settings-and-properties.md of AnimaQuill Cloud,
 * 7.4): a bulb where it thinks, an eye where it takes pictures, an eye with a small bulb at its
 * top right where it does both. Never two side by side. Its full name shows on hovering, and is what a reader says.
 */
export function CapabilityIcon(props: {
  readonly capability: Capability | undefined;
  readonly size?: number;
  readonly className?: string | undefined;
}) {
  const { t } = useTranslation();
  const { capability, size = 16 } = props;
  if (!capability) return null;
  const label = t(`ai.capability.${capability}`);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      role="img"
      aria-label={label}
      data-capability={capability}
    >
      <title>{label}</title>
      {PATHS[capability].map((d) => (
        <path key={d} d={d} />
      ))}
      {capability === "image" && <circle cx="8" cy="8" r="2" />}
      {capability === "both" && <circle cx="6.5" cy="10.75" r="1.5" />}
    </svg>
  );
}
