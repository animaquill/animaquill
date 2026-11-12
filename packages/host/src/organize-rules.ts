/**
 * What the editor and a platform keep alike of how people organise their projects, see
 * `ProjectOrganizer` and `OrganizerAccess`: nothing of a browser, so that a server can use it too.
 */

/** How long the name of a group of projects can be, in characters, see `ProjectGroup`. */
export const MAX_GROUP_NAME = 60;

/** How many groups, and how many marks, one `OrganizerAccess.change` gives at most. */
export const ORGANIZER_BATCH = 200;

/** What two names of groups are the same by: whatever the case and width of their letters. */
export const groupNameKey = (name: string): string =>
  name.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");

/**
 * What no name of a group has: control and format characters, as a tab pasted from a table, or a
 * space of no width that makes two names look the same; and the separators of lines and paragraphs.
 */
const NOT_IN_NAMES = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/**
 * A name of a group as it is kept: what is given, without what no name has, trimmed; undefined
 * where that is nothing, or longer than `MAX_GROUP_NAME` characters.
 */
export const groupNameOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const name = cleanGroupName(value);
  const length = [...name].length;
  return length >= 1 && length <= MAX_GROUP_NAME && name === value.trim() ? name : undefined;
};

/** What a name becomes as it is kept: what no name has becomes a space, and it is trimmed. */
export const cleanGroupName = (name: string): string => name.replace(NOT_IN_NAMES, " ").trim();
