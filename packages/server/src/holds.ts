import type { Executor } from "./database.ts";

/**
 * What else may still change a project, which the server does not know of itself: on the platform,
 * a task of cloud AI that has not ended. While one does, the working copy
 * of the project is not let go of (`SyncHub.release`). Asked in the transaction that holds the
 * project's row, so that what it says holds until that ends.
 */
export interface ProjectHolds {
  busy(tx: Executor, projectId: string): Promise<boolean>;
}

/** Nothing else changes projects. */
export const NO_HOLDS: ProjectHolds = { busy: async () => false };
