import { isRefusedByChrome, mightBeShortName } from "./chrome-names.ts";

/**
 * The parts of a path inside a project, or undefined for one that leads somewhere else. Paths come
 * from projects, which can come from anybody, and this is the last place to stop them.
 */
export function partsOf(path: string): readonly [string, ...string[]] | undefined {
  const parts = path.split("/");
  const safe = parts.every((part) => part !== "" && part !== "." && part !== "..");
  if (!safe || /[\\\0]/.test(path) || /^[A-Za-z]:/.test(path)) return undefined;
  return parts as [string, ...string[]];
}

/**
 * Windows allows 260 characters for a whole path, also to a browser, and a page never gets to know
 * how deep its folder is on the disk. So the names the editor makes stay well within that, on every
 * system, because projects go from one system to another. Counted in UTF-16 code units, as Windows
 * counts them, which also keeps a name far from the 255 bytes that other systems allow.
 */
export const MAX_NAME_LENGTH = 64;
/** The same for a path inside of a project, from its top. */
export const MAX_PATH_LENGTH = 120;
/** What a name may get added to keep it apart from others: " (1000)" at most, or ".zip". */
const ROOM_FOR_MORE = 8;
/** A path that leaves less than this for a name is too deep already, and a name needs some room. */
const LEAST_ROOM = 16;
/** A new name gets a number when it is taken, within reason. */
const MAX_NUMBER = 10_000;
export const FALLBACK_NAME = "AnimaQuill";

/** Folders that belong to tools, with nothing of a project in them. A project can be a repository. */
const TOOL_FOLDERS = new Set([".git", ".animaquill", "node_modules"]);
export const isToolFolder = (name: string): boolean => TOOL_FOLDERS.has(name);

/** Nothing to see of these, so nothing is lost without them. Chrome refuses them in names. */
const INVISIBLE = /[\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}]/gu;
const REFUSED_ANYWHERE = /[<>:"/\\|?*\p{Cc}]/gu;
const REFUSED_AT_THE_ENDS = /^[\p{White_Space}.~]+|[\p{White_Space}.~]+$/gu;
/** On Windows these open or run something, or are devices, whatever comes after them. */
const REFUSED_ENDING = /\.(?=(?:local|lnk|scf|url|\{.*\})$)/i;
/**
 * Devices and other names that mean something on Windows. A little more than what Chrome refuses:
 * Windows also takes "COM¹" for a device.
 */
const RESERVED_NAME =
  /^(?:(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|clock\$)(?:\.|$)|(?:desktop\.ini|thumbs\.db|conin\$|conout\$)$)/i;
/** What looks like an extension, which stays at the end of a name: ".mp4", not ". my notes". */
const EXTENSION = /\.[\p{L}\p{N}_-]{1,16}$/u;

/** At most this many UTF-16 code units, without cutting a character in two. */
function cut(name: string, length: number): string {
  let result = "";
  for (const character of name) {
    if (result.length + character.length > length) break;
    result += character;
  }
  return result;
}

const trimmed = (name: string) => name.replaceAll(REFUSED_AT_THE_ENDS, "");

/** Windows may take a name with a "~" for the short name of another file. */
const avoidingShortName = (name: string) =>
  mightBeShortName(name) ? name.replaceAll("~", "-") : name;

/**
 * A name every system takes, of at most `length` UTF-16 code units, from whatever people typed. Each
 * step leaves what the steps before it made sure of as it is.
 */
function cleanName(name: string, length: number): string {
  const visible = trimmed(name.replaceAll(INVISIBLE, "").replaceAll(REFUSED_ANYWHERE, "_"));
  const named = RESERVED_NAME.test(visible) ? `_${visible}` : visible;
  // What a cut leaves at the end can be what may not be there.
  const result = avoidingShortName(trimmed(cut(named, length)).replace(REFUSED_ENDING, "_"));
  // Nothing is left of some names, and a very short cut can make a device of one, such as "con".
  return result !== "" && isSafeName(result) ? result : cut(FALLBACK_NAME, length);
}

/**
 * A folder name for any project name. People name projects whatever they like, and browsers refuse
 * quite a lot for a folder on a disk, also where the system would take it: what a project is called
 * must not be what keeps it from being saved. It leaves room for a number or an ending.
 */
export const folderNameFor = (name: string): string =>
  cleanName(name, MAX_NAME_LENGTH - ROOM_FOR_MORE);

/** A file name for anything: what is after the dot is what opens it, and it stays. */
export function fileNameFor(name: string): string {
  const [, stem = name, extension = ""] = /^(.*)(\.[^.]*)$/su.exec(name) ?? [];
  return avoidingShortName(`${folderNameFor(stem)}${extension}`);
}

/**
 * Whether the editor may make a file or folder of this name: every system takes it, Chrome on
 * Windows too, and it is short enough, see `MAX_NAME_LENGTH`.
 */
export const isSafeName = (name: string): boolean =>
  name.length <= MAX_NAME_LENGTH &&
  !isRefusedByChrome(name) &&
  !RESERVED_NAME.test(name) &&
  !/\p{Cs}/u.test(name);

/** Whether the editor may make this path in a project, see `isSafeName` and `MAX_PATH_LENGTH`. */
export const isSafePath = (path: string): boolean =>
  path.length <= MAX_PATH_LENGTH && (partsOf(path)?.every(isSafeName) ?? false);

/**
 * What names are the same file as on some system: Windows does not tell case apart, and a Mac does
 * not tell apart the ways to write "é". A little more than that does no harm: it only keeps names
 * further apart.
 */
export const sameNameKey = (name: string): string => name.normalize("NFC").toLowerCase();

/**
 * A name for a new file or folder of a project, from what people called it, such as a video they
 * brought in: it stays what it was as far as it can, every system takes it, and the whole path stays
 * within `MAX_PATH_LENGTH`. `taken` are the names in the folder it goes to, and `folder` is the path
 * of that folder in the project. A name that is taken, also in another case, gets a number before
 * the extension, as in "红色 (2).webm".
 */
export function newNameFor(wanted: string, taken: Iterable<string>, folder = ""): string {
  const keys = new Set([...taken].map(sameNameKey));
  const room = Math.max(
    LEAST_ROOM,
    Math.min(MAX_NAME_LENGTH, MAX_PATH_LENGTH - (folder === "" ? 0 : folder.length + 1)),
  );
  const ending = EXTENSION.exec(wanted)?.[0] ?? "";
  const stem = wanted.slice(0, wanted.length - ending.length);
  // An extension that opens or runs something is no extension for a file the editor makes.
  const extension = isSafeName(`a${ending}`) ? ending : ending.replace(".", "_");
  for (let number = 1; number <= MAX_NUMBER; number++) {
    const suffix = number === 1 ? "" : ` (${number})`;
    const length = Math.max(1, room - suffix.length - extension.length);
    for (const base of [stem, FALLBACK_NAME]) {
      const name = avoidingShortName(`${cleanName(base, length)}${suffix}${extension}`);
      if (!isSafeName(name)) continue;
      if (!keys.has(sameNameKey(name))) return name;
      break;
    }
  }
  throw new Error(`No free name for ${wanted}`);
}
