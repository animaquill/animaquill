import { coverEtag, type CoverAccess, type CoverStore, type ProjectCover } from "@animaquill/host";
import { canvasEncoder, encodeCover, type CoverUploads } from "../export/cover.ts";
import { autoOf } from "./covers.ts";

/**
 * A cover people choose themselves, from the menu of a card, see the design of the start page
 * (docs/design/start-and-cloud.md of AnimaQuill Cloud), 6.4: a picture of theirs, made small in the
 * browser as covers the editor makes are, kept in this browser as one people chose
 * (`ProjectCover.chosen`), which the editor's covers do not take the place of, and for a project of
 * the platform sent there as such. Going back to the editor's takes it away again, here and there.
 * Who of the people editing a project together may do this is for when projects are edited
 * together; now it is whoever has the project.
 */

/** A picture larger than this is not even read: no picture for a card needs it. */
export const MOST_PICTURE_BYTES = 40 * 1024 * 1024;

/** The project a cover is chosen for. */
export interface CoverTarget {
  /** What this browser keeps its cover by, see `CoverStore`. */
  readonly key: string;
  /** Its id on the platform, where the cover goes there too. */
  readonly project: string | undefined;
  /** How long its main timeline is, where that is known. */
  readonly durationMs: number | undefined;
}

export type CoverChoice =
  | "chosen"
  /** It says it is no picture. */
  | "notPicture"
  | "tooLarge"
  /** It could not be read as a picture. */
  | "unreadable"
  /** Not even at the lowest quality is it small enough. */
  | "notSmall"
  | "failed";

export interface CoverChoiceOptions {
  readonly covers: CoverStore;
  /** Sends it to the platform, where the editor is hosted on one. */
  readonly uploads?: CoverUploads;
  /** Takes the platform's cover away, see `CoverAccess.remove`. */
  readonly cloud?: Pick<CoverAccess, "remove">;
  /** For tests: a picture of a file. */
  readonly decode?: (file: Blob) => Promise<ImageBitmap>;
  /** For tests: a cover of a picture, see `encodeCover`. */
  readonly encode?: (image: ImageBitmap) => Promise<Blob | undefined>;
  readonly now?: () => number;
}

const decodeFile = (file: Blob) => createImageBitmap(file);
const encodeImage = (image: ImageBitmap) => encodeCover(canvasEncoder(image));

/** Makes `file` the cover of `target`, as one people chose. */
export async function chooseCover(
  target: CoverTarget,
  file: Blob,
  options: CoverChoiceOptions,
): Promise<CoverChoice> {
  // A file without a type can still be a picture: decoding says.
  if (file.type !== "" && !file.type.startsWith("image/")) return "notPicture";
  if (file.size > MOST_PICTURE_BYTES) return "tooLarge";
  let image: ImageBitmap;
  try {
    image = await (options.decode ?? decodeFile)(file);
  } catch {
    return "unreadable";
  }
  let picture: Blob | undefined;
  try {
    picture = await (options.encode ?? encodeImage)(image);
  } catch (error) {
    console.warn("A chosen cover could not be made small", error);
    return "unreadable";
  } finally {
    image.close();
  }
  if (!picture) return "notSmall";
  try {
    const { covers } = options;
    const [etag, before] = await Promise.all([
      coverEtag(picture),
      covers.read([target.key]).then((found) => found.get(target.key)),
    ]);
    // What the editor made stays, to go back to.
    const auto =
      before?.chosen === true
        ? before.auto
        : before && { picture: before.picture, at: before.at, etag: before.etag };
    const durationMs = before?.durationMs ?? target.durationMs;
    const cover: ProjectCover = {
      picture,
      at: (options.now ?? Date.now)(),
      etag,
      chosen: true,
      ...(durationMs !== undefined && { durationMs }),
      ...(before?.made !== undefined && { made: before.made }),
      ...(auto && { auto }),
    };
    await covers.put(target.key, cover);
    if (target.project !== undefined) options.uploads?.offer(target.key, target.project, "chosen");
    return "chosen";
  } catch (error) {
    console.warn("A chosen cover could not be kept", error);
    return "failed";
  }
}

/**
 * Goes back to the cover the editor makes: the platform's goes first, so that no computer keeps
 * the chosen one; then the one the editor made last here, or none, until it makes one. Resolves to
 * false where the platform could not take it away, and nothing changed.
 */
export async function restoreAutoCover(
  target: CoverTarget,
  options: CoverChoiceOptions,
): Promise<boolean> {
  const { covers, cloud } = options;
  try {
    if (target.project !== undefined && cloud) {
      const removed = await cloud.remove(target.project);
      if (removed === "busy") return false;
    }
    const before = (await covers.read([target.key])).get(target.key);
    if (before?.chosen !== true) return true;
    const auto = autoOf(before);
    if (!auto) {
      await covers.forget(target.key);
      return true;
    }
    await covers.put(target.key, auto);
    if (target.project !== undefined) options.uploads?.offer(target.key, target.project, "chosen");
    return true;
  } catch (error) {
    console.warn("The cover the editor makes could not come back", error);
    return false;
  }
}
