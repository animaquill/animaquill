import { Cloud, Folder, HardDrive } from "lucide-react";

/** Where a project is: see `CardPlace`. */
export type Place = "folder" | "cloud" | "browser";

/**
 * The sign of where a project is, the same on the start page, in the status bar and in the panel
 * of the platform: a folder for a project of the offline mode, a cloud for one of the platform, a
 * drive for one only in this browser.
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
  const Icon = place === "cloud" ? Cloud : place === "folder" ? Folder : HardDrive;
  return (
    <Icon
      size={size}
      {...(className !== undefined && { className })}
      data-place={place}
      {...(label === undefined
        ? { "aria-hidden": true as const }
        : { role: "img", "aria-label": label })}
    />
  );
}
