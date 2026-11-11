import { mergeUpdates, ProjectStore } from "@animaquill/core";
import type { CloudLinks, FolderRecords, ProjectLibrary } from "@animaquill/host";
import { CURRENT_FORMAT_VERSION } from "@animaquill/schema";

/**
 * Renames a project from the start page, without opening it, see the design of the start page
 * (docs/design/start-and-cloud.md of AnimaQuill Cloud), 6.6: the same "project.rename" as in the
 * project, made on what its log has, and written into the log as a change of people, the way a
 * window writes one. A window that has the project open hears it through the log, as any change of
 * another window. A folder gets the name in its file the next time it opens, from the log: only the
 * window that writes a folder writes it, see `FolderSession`. A project of the platform gets it the
 * next time it syncs; until then its link counts one change more that the platform does not have,
 * which its card says.
 */

export type RenameOutcome =
  | "renamed"
  /** It is called that already. */
  | "unchanged"
  /** Nothing usable is in its log. */
  | "unreadable"
  /** It is of a newer editor, which this one must not write to. */
  | "tooNew"
  /** It is locked, see the tags of a project: nothing about it changes until it is unlocked. */
  | "locked"
  /** The name is not one a project can have, or the log could not be written. */
  | "failed";

export interface RenameOptions {
  readonly projects: Pick<ProjectLibrary, "open">;
  /** The folders this browser knows, which say what each is called, see `FolderRecord.name`. */
  readonly records?: Pick<FolderRecords, "get" | "put">;
  /** The links to the platform, see `CloudLink.name` and `CloudLink.pending`. */
  readonly links?: Pick<CloudLinks, "get" | "update">;
  /** Which window makes the change, see `ChangeSource.window`. */
  readonly window?: string;
  readonly now?: () => number;
}

/** Renames what this browser keeps by `key`. Never rejects. */
export async function renameUnopened(
  key: string,
  name: string,
  { projects, records, links, window, now = Date.now }: RenameOptions,
): Promise<RenameOutcome> {
  const wanted = name.trim();
  if (wanted === "") return "failed";
  let log;
  try {
    log = await projects.open(key);
  } catch (error) {
    console.warn("The project to rename could not be opened", error);
    return "unreadable";
  }
  let store: ProjectStore | undefined;
  try {
    const updates = await log.load();
    store = ProjectStore.fromUpdates(updates).store;
    if (!store) return "unreadable";
    const { manifest } = store.getState();
    if (manifest.formatVersion > CURRENT_FORMAT_VERSION) return "tooNew";
    if (manifest.name === wanted) return "unchanged";
    const made: Uint8Array[] = [];
    const stop = store.onLocalUpdate((update) => made.push(update));
    const result = store.execute({ type: "project.rename", params: { name: wanted } });
    stop();
    if (!result.ok && result.error.code === "project-locked") return "locked";
    if (!result.ok || made.length === 0) return "failed";
    // As a window that had every update of the platform the link says the log has, see
    // `ChangeSource.seq`.
    const link = await links?.get(key).catch(() => undefined);
    const update = made.length === 1 ? (made[0] as Uint8Array) : mergeUpdates(made);
    await log.append(update, wanted, {
      kind: "user",
      ...(window !== undefined && { window }),
      at: now(),
      ...(link && { seq: link.seq }),
    });
    // What lists show it by: the log says it already for itself.
    const record = await records?.get(key).catch(() => undefined);
    if (record) await records?.put({ ...record, name: wanted }).catch(() => {});
    if (link) {
      await links
        ?.update(key, link.project, { name: wanted, pending: (link.pending ?? 0) + 1 })
        .catch(() => false);
    }
    return "renamed";
  } catch (error) {
    console.warn("The project could not be renamed", error);
    return "failed";
  } finally {
    store?.destroy();
    log.close();
  }
}
