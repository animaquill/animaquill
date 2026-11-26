import type { CloudAccess } from "@animaquill/host";
import {
  browserAiSyncAccess,
  browserChatSyncAccess,
  browserCloud,
  browserCloudProjects,
  browserPersonEvents,
  browserCoverAccess,
  browserLfs,
  browserLfsAccount,
  browserModelCatalogAccess,
  browserOrganizerAccess,
  browserRepository,
} from "@animaquill/host/browser";
import { EDITOR_HEADER, REQUEST_HEADER } from "./headers.ts";

/**
 * The backend of the editor's site (`@animaquill/server`), for keeping projects in step with it:
 * the WebSocket at /api/sync (sync/socket.ts there), and its projects at /api/projects: the list of
 * them, taking one without a repository away, and making the working copy of one again from its
 * repository (sync/routes.ts). Saving them to a repository is under /api too (archive/routes.ts),
 * and so is sending files of assets into Git LFS of their repositories (lfs/routes.ts), and the
 * covers of projects for the start page (sync/covers.ts), and how people organise their projects
 * on the start page (sync/organize.ts), and the AI settings, keys and conversations that go with
 * the account, and which of those go with it at all (me/routes.ts), and the open catalog of models
 * for the settings (ai/catalog.ts). The browser brings what shows its session along.
 */

export interface ServerCloudOptions {
  /** The editor's site, which the projects on this backend are said to be on. */
  readonly editor: string;
  /** The version of this page, which the server asks of conversations. */
  readonly version: string;
}

export function serverCloud({ editor, version }: ServerCloudOptions): CloudAccess {
  const api = (path: string) => `/api${path}`;
  const changeHeaders = { [REQUEST_HEADER]: "1" };
  const projects = browserCloudProjects({ api, changeHeaders });
  return browserCloud({
    platform: editor,
    syncUrl: () => {
      const url = new URL("/api/sync", location.href);
      url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
      return url.href;
    },
    list: projects.list,
    remove: projects.remove,
    wake: projects.wake,
    rename: projects.rename,
    // What changed of the person's list on any computer, at once (me/events.ts).
    events: browserPersonEvents({ url: "/api/me/events" }),
    repository: browserRepository({ api, changeHeaders }),
    lfs: browserLfs({ api, changeHeaders }),
    lfsAccount: browserLfsAccount({ api, changeHeaders }),
    cover: browserCoverAccess({ api, changeHeaders }),
    organizer: browserOrganizerAccess({ api, changeHeaders }),
    aiSync: browserAiSyncAccess({ api, changeHeaders }),
    // The server takes conversations only from pages new enough not to lose what newer ones wrote.
    chats: browserChatSyncAccess({
      api,
      changeHeaders: { [REQUEST_HEADER]: "1", [EDITOR_HEADER]: version },
    }),
    modelCatalog: browserModelCatalogAccess({ api }),
  });
}
