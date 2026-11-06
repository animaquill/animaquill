/**
 * Splits a path inside a project. Paths come from projects, which can come from anybody, and this
 * is the last place to stop one that leads somewhere else.
 */
export function partsOf(path: string): readonly [string, ...string[]] {
  const parts = path.split("/");
  const safe = parts.every((part) => part !== "" && part !== "." && part !== "..");
  if (!safe || /[\\\0]/.test(path) || /^[A-Za-z]:/.test(path)) {
    throw new TypeError(`Not a path inside a project: ${path}`);
  }
  return parts as [string, ...string[]];
}

const MAX_NAME_LENGTH = 80;
const FALLBACK_NAME = "AnimaQuill";
/** Windows refuses these whatever comes after them. */
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
/** Browsers refuse names with these endings, because on Windows such files run things. */
const REFUSED_ENDING = /\.(local|lnk|scf|url)$/i;

/**
 * A folder name for any project name. People name projects whatever they like, and the folder may
 * end up on a system that refuses some of it.
 */
export function folderNameFor(name: string): string {
  const cleaned = [...name.replaceAll(/[<>:"/\\|?*\p{Cc}]/gu, "_")]
    .slice(0, MAX_NAME_LENGTH)
    .join("")
    .replace(/^[. ]+/, "")
    .replace(/[. ]+$/, "");
  if (cleaned === "") return FALLBACK_NAME;
  const allowed = cleaned.replace(REFUSED_ENDING, "_$1");
  return RESERVED_NAME.test(allowed) ? `_${allowed}` : allowed;
}
