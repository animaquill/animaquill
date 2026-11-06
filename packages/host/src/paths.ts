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

/** Takes the longest number after it, and an ending for a zip file. Most systems stop at 255. */
const MAX_NAME_BYTES = 200;
export const FALLBACK_NAME = "AnimaQuill";

/** Nothing to see of these, so nothing is lost without them. Chrome refuses them in names. */
const INVISIBLE = /[\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}]/gu;
const REFUSED_ANYWHERE = /[<>:"/\\|?*\p{Cc}]/gu;
const REFUSED_AT_THE_ENDS = /^[\p{White_Space}.~]+|[\p{White_Space}.~]+$/gu;
/** On Windows these open or run something, or are devices, whatever comes after them. */
const REFUSED_ENDING = /\.(?=(?:local|lnk|scf|url|\{.*\})$)/i;
const RESERVED_NAME =
  /^(?:(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|clock\$)(?:\.|$)|desktop\.ini$|thumbs\.db$)/i;

const encoder = new TextEncoder();

function cut(name: string): string {
  let bytes = 0;
  let result = "";
  for (const character of name) {
    bytes += encoder.encode(character).length;
    if (bytes > MAX_NAME_BYTES) break;
    result += character;
  }
  return result;
}

/**
 * A folder name for any project name. People name projects whatever they like, and browsers refuse
 * quite a lot for a folder on a disk, also where the system would take it: what a project is called
 * must not be what keeps it from being saved.
 */
export function folderNameFor(name: string): string {
  const cleaned = cut(name.replaceAll(INVISIBLE, "").replaceAll(REFUSED_ANYWHERE, "_")).replaceAll(
    REFUSED_AT_THE_ENDS,
    "",
  );
  if (cleaned === "") return FALLBACK_NAME;
  const allowed = cleaned.replace(REFUSED_ENDING, "_");
  return RESERVED_NAME.test(allowed) ? `_${allowed}` : allowed;
}
