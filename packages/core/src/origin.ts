/** Who a change comes from. Every change in the document carries this. */
export type Origin = string;

/**
 * The person at this editor. Nothing else counts as a person: not an AI task, not a tool that talks
 * to the editor, and not anything without a name of its own.
 */
export const USER: Origin = "user";

export const aiTask = (task: string): Origin => `ai:${task}`;

/** What did not say where it comes from. That is no person either. */
export const NOBODY: Origin = "nobody";
