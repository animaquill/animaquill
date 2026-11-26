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
import { bindingFetch, fetchEventSource, syncProtocols } from "./local.ts";

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
  /**
   * The key of binding of this page, for the backend of `npx animaquill` (see local.ts): every
   * request has it, and the WebSocket of syncing. None unless said.
   */
  readonly binding?: string | undefined;
}

export function serverCloud({ editor, version, binding }: ServerCloudOptions): CloudAccess {
  const api = (path: string) => `/api${path}`;
  const changeHeaders = { [REQUEST_HEADER]: "1" };
  const request = binding === undefined ? undefined : bindingFetch(binding);
  /** What every access is given besides: how requests go, where they need the key. */
  const shared = request ? { fetch: request } : {};
  const projects = browserCloudProjects({ api, changeHeaders, ...shared });
  return browserCloud({
    platform: editor,
    syncUrl: () => {
      const url = new URL("/api/sync", location.href);
      url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
      return url.href;
    },
    ...(binding !== undefined && { syncProtocols: () => syncProtocols(binding) }),
    list: projects.list,
    remove: projects.remove,
    wake: projects.wake,
    rename: projects.rename,
    // What changed of the person's list on any computer, at once (me/events.ts).
    events: browserPersonEvents({
      url: "/api/me/events",
      ...(request && { open: (url: string) => fetchEventSource(url, request) }),
    }),
    repository: browserRepository({ api, changeHeaders, ...shared }),
    lfs: browserLfs({ api, changeHeaders, ...shared }),
    lfsAccount: browserLfsAccount({ api, changeHeaders, ...shared }),
    cover: browserCoverAccess({ api, changeHeaders, ...shared }),
    organizer: browserOrganizerAccess({ api, changeHeaders, ...shared }),
    aiSync: browserAiSyncAccess({ api, changeHeaders, ...shared }),
    // The server takes conversations only from pages new enough not to lose what newer ones wrote.
    chats: browserChatSyncAccess({
      api,
      changeHeaders: { [REQUEST_HEADER]: "1", [EDITOR_HEADER]: version },
      ...shared,
    }),
    modelCatalog: browserModelCatalogAccess({ api, ...shared }),
  });
}
