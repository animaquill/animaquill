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
