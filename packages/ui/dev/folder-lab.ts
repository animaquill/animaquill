import { ProjectStore, readFolder } from "@animaquill/core";
import type { Host, LocalFolder } from "@animaquill/host";
import { FolderSession } from "../src/folder/session.ts";
import { ProjectSession, type SessionMessages } from "../src/workbench/session.ts";

const quiet: SessionMessages = {
  createFailed() {},
  notFound() {},
  openFailed() {},
  tooNew() {},
  damaged() {},
  saveFailed() {},
  saveRecovered() {},
};

/**
 * For the browser tests: a project folder kept in step with its project the way the editor does it,
 * with the log, the bases and the turn to write of this browser, and without the editor around it.
 * The project comes from the log of `id`, or from the folder when there is none yet.
 */
export async function keepFolder(host: Host, folder: LocalFolder, id: string) {
  const local = host.localFolders;
  if (!local) throw new Error("This browser cannot write to folders");
  const { projects } = host;
  const log = await projects.open(id);
  const isNew = (await log.load()).length === 0;
  log.close();
  if (isNew) {
    const reading = await readFolder(folder);
    const read = ProjectStore.create(reading.project, reading.sources);
    const { name } = reading.project.manifest;
    await projects.create({ id, name }, read.encodeState());
    read.destroy();
    const project = reading.project.manifest.id;
    await local.records.put({ id, folder, project, name, openedAt: Date.now() });
  }
  let address: string | undefined;
  const session = new ProjectSession(
    projects,
    {
      read: () => address,
      write: (next) => {
        address = next;
      },
    },
    quiet,
  );
  if (!(await session.open(id))) throw new Error("The project did not open");
  const store = session.store as ProjectStore;
  const folderSession = new FolderSession({
    store,
    folder,
    id,
    bases: local.bases,
    writer: local.writer(id),
    log: { saved: () => session.trySave(), caughtUp: () => session.readLog() },
  });
  await folderSession.start();
  return { session, folderSession, store };
}
