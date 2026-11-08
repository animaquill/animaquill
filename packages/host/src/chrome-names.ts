/**
 * Which names Chrome does not allow for a file or folder on a disk. Asking for one fails with a
 * TypeError, also where the system would be fine with it, and listing a folder leaves such entries
 * out without a word. The private folder of a site, which is what most browser tests have instead
 * of a dialog, does not have these rules.
 *
 * This follows the source of Chromium, main of 2026-11-08: `IsSafePathComponent` in
 * content/browser/file_system_access/file_system_access_manager_impl.cc, `IsFilenameLegal` in
 * base/i18n/file_util_icu.cc and `IsReservedNameOnWindows` in base/files/file_util.cc. It was
 * measured on Chrome 157 on Linux and Edge 158 on Windows on 2026-11-08.
 *
 * Not covered: extensions that Safe Browsing takes for dangerous downloads, which Chrome refuses as
 * well, apart from ".local". That list comes with Safe Browsing and changes, and neither the names
 * the editor makes nor the files of projects end like that.
 */

/** Anywhere in a name: what Windows does not allow, control and format characters, noncharacters. */
const REFUSED_ANYWHERE = /["*/:<>?\\|\p{Cc}\p{Cf}\p{Noncharacter_Code_Point}]/u;
/** At either end, once a dot at the start is taken off. */
const REFUSED_AT_THE_ENDS = /^[\p{White_Space}.~]|[\p{White_Space}.~]$/u;
/** Extensions that open or run something on Windows, also `{…}`, which hides what a file is. */
const REFUSED_EXTENSION = /^(?:lnk|scf|url|\{.*\})$/i;
/** Devices on Windows: the name, or what comes before its first dot, can be none of them. */
const DEVICES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "clock$",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((number) => [`com${number}`, `lpt${number}`]),
]);
/** Names that mean something else on Windows, but only as a whole: "conin$.txt" is fine. */
const SPECIAL_NAMES = new Set(["desktop.ini", "thumbs.db", "conin$", "conout$"]);
/**
 * Extensions after which Chromium takes the one before as part of the extension too, such as
 * ".tar.gz", as long as that one is short.
 */
const SECOND_EXTENSIONS = new Set(["bz", "bz2", "gz", "lz", "lzma", "lzo", "xz", "z", "zst"]);
/** What a short name of Windows cannot have, so that a name with any of it is not one. */
const NOT_IN_SHORT_NAMES = /[\p{White_Space}"\\/[\]:+|<>=;?,*]/u;

const asciiLowerCase = (text: string) =>
  text.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());

/** The extension as Chromium sees it, without the dot: "gz" of "a.gz", "tar.gz" of "a.tar.gz". */
function extensionOf(name: string): string {
  const last = name === "." || name === ".." ? -1 : name.lastIndexOf(".");
  if (last <= 0) return last === 0 ? name.slice(1) : "";
  const before = name.lastIndexOf(".", last - 1);
  if (before === -1) return name.slice(last + 1);
  if (asciiLowerCase(name.slice(before + 1)) === "user.js") return name.slice(before + 1);
  const isSecond = SECOND_EXTENSIONS.has(asciiLowerCase(name.slice(last + 1)));
  return isSecond && last - before > 1 && last - before <= 5
    ? name.slice(before + 1)
    : name.slice(last + 1);
}

/** Windows strips spaces and dots at the end, and "con.txt" or "nul.tar.gz" are devices still. */
function isReservedOnWindows(name: string): boolean {
  const trimmed = asciiLowerCase(name).replace(/[ .]+$/, "");
  const [beforeDot = ""] = trimmed.split(".", 1);
  return DEVICES.has(trimmed) || DEVICES.has(beforeDot) || SPECIAL_NAMES.has(trimmed);
}

/**
 * Whether a name could be a short name of Windows, as in "PROGRA~1": with a "~", at most 12 UTF-16
 * code units, and with at most 8 before a dot and 3 after it. Such a name may stand for another file
 * there, which is why Chrome refuses it on Windows, whatever the numbers in it: "第1~3集",
 * "a~b.txt" and "草稿~2.txt" are refused, "第1~3集正片完整版" and "草稿~2.json" are fine.
 */
export function mightBeShortName(name: string): boolean {
  if (name.length > 12 || !name.includes("~") || NOT_IN_SHORT_NAMES.test(name)) return false;
  const dot = name.indexOf(".");
  if (dot === -1) return name.length <= 8;
  return dot === name.lastIndexOf(".") && dot > 0 && dot <= 8 && dot + 4 >= name.length;
}

/**
 * Where Chrome refuses a name: on every system, only on Windows, or nowhere. Projects go from one
 * system to another, so what the editor makes has to be fine on all of them.
 */
export function chromeRefuses(name: string): "everywhere" | "windows" | undefined {
  // A name that starts with a dot is fine, such as ".gitignore": the rules start after it.
  const rest = name.startsWith(".") ? name.slice(1) : name;
  const isRefused =
    name === "" ||
    REFUSED_ANYWHERE.test(name) ||
    REFUSED_AT_THE_ENDS.test(rest) ||
    REFUSED_EXTENSION.test(extensionOf(name)) ||
    name.endsWith(".") ||
    isReservedOnWindows(name);
  if (isRefused) return "everywhere";
  return mightBeShortName(rest) ? "windows" : undefined;
}

/** Whether Chrome refuses a name on any system, see `chromeRefuses`. */
export const isRefusedByChrome = (name: string): boolean => chromeRefuses(name) !== undefined;
