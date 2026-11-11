/** Who a change comes from. Every change in the document carries this. */
export type Origin = string;

/**
 * The person at this editor. Nothing else counts as a person: not an AI task, not a tool that talks
 * to the editor, and not anything without a name of its own.
 */
export const USER: Origin = "user";

export const aiTask = (task: string): Origin => `ai:${task}`;

/**
 * One batch of changes that came from the project folder: what Git, another editor or an AI tool
 * on this computer wrote there. It is no person, and each batch is an origin of its own, so that it
 * can be taken back as a whole.
 */
export const folderBatch = (batch: string): Origin => `folder:${batch}`;

/** What did not say where it comes from. That is no person either. */
export const NOBODY: Origin = "nobody";

/**
 * Uploads, as they write down where the file of an asset is kept once it got there and was checked,
 * see `asset.setStorage`. That is no person, and nothing to undo: taking it back would say something
 * about the file that is not so. Only uploads use it, and they write nothing else.
 */
export const STORAGE: Origin = "storage";
