import { Cloud, Folder, HardDrive } from "lucide-react";
import { useId } from "react";

/** Where a project is: see `CardPlace`. */
export type Place = "folder" | "cloud" | "cloudFolder" | "browser";

/** The shapes of lucide's folder and cloud, which the other icons are drawn with. */
const FOLDER =
  "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";
const CLOUD = "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z";
/** The small cloud, at the lower right: its scale, and where it goes. */
const SMALL = 0.58;
const AT = "translate(10.6 11.2)";
/** The lines of every icon, in the units of the icon: as lucide draws them. */
const LINE = 2;
/** The room around the small cloud, which keeps it apart from the folder. */
const GAP = 2.2;

/**
 * A folder with a small cloud at its lower right, apart from it by a gap: a project of the
 * platform that this computer has a folder of too. The folder takes the colour of projects of
 * this computer and the cloud that of the platform (`--place-folder`, `--place-cloud`), as the
 * other two icons have them; the gap is cut out of the folder, so that it is the background
 * whatever that is. As lucide draws: 24 units, lines of 2.
 */
export function FolderCloudIcon({
  size = 16,
  className,
  label,
  ...rest
}: {
  readonly size?: number;
  readonly className?: string | undefined;
  /** What it says to whatever reads the page: none where the words next to it say it. */
  readonly label?: string;
  readonly "data-place"?: string;
}) {
  const mask = `aq-folder-cloud-${useId().replace(/:/g, "")}`;
  const transform = `${AT} scale(${SMALL})`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      data-folder-cloud=""
      {...rest}
    >
      <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="white" />
        <path
          d={CLOUD}
          transform={transform}
          fill="black"
          stroke="black"
          strokeWidth={(LINE + 2 * GAP) / SMALL}
        />
      </mask>
      <path
        d={FOLDER}
        stroke="var(--place-folder, currentColor)"
        strokeWidth={LINE}
        mask={`url(#${mask})`}
      />
      <path
        d={CLOUD}
        transform={transform}
        stroke="var(--place-cloud, currentColor)"
        strokeWidth={LINE / SMALL}
      />
    </svg>
  );
}

/**
 * The sign of where a project is, the same on the start page, in the status bar and in the panel
 * of the platform: a folder for a project of this computer, a cloud for one of the platform, both
 * for one of the platform with a folder here too, a drive for one only in this browser.
 */
export function PlaceIcon({
  place,
  size = 14,
  className,
  label,
}: {
  readonly place: Place;
  readonly size?: number;
  readonly className?: string | undefined;
  /** What it says to whatever reads the page: none where the words next to it say it. */
  readonly label?: string;
}) {
  const common = {
    size,
    ...(className !== undefined && { className }),
    "data-place": place,
    ...(label === undefined
      ? { "aria-hidden": true as const }
      : { role: "img", "aria-label": label }),
  };
  if (place === "cloudFolder")
    return (
      <FolderCloudIcon
        size={size}
        {...(className !== undefined && { className })}
        {...(label !== undefined && { label })}
        data-place={place}
      />
    );
  const Icon = place === "cloud" ? Cloud : place === "folder" ? Folder : HardDrive;
  return <Icon {...common} />;
}
