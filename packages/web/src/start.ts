import type { AccountAccess, Host } from "@animaquill/host";
import { startApp } from "@animaquill/ui";
import { COMPOSITOR_PAGE, type Sites } from "./sites.ts";

/** What a deployment of the editor as a web app is made of. */
export interface EditorSite {
  /** Where the editor goes in the page. */
  readonly root: HTMLElement;
  readonly sites: Sites;
  /** Shown in the status bar, so that a report can say which build it is about. */
  readonly version: string;
  /**
   * The backend of the site, for the online mode (docs/design/online-offline.md of AnimaQuill
   * Cloud): the account on it, and what it adds to the browser's host once somebody is signed in,
   * such as keeping projects, a place for reports and its relay of AI services. Without it the
   * site has only the offline mode, which connects to nothing.
   */
  readonly online?: {
    readonly account: () => AccountAccess;
    readonly parts: () => Pick<Host, "diagnostics" | "cloud" | "aiRelay" | "localServer">;
  };
}

/** Starts the editor as the page of a web app, in the mode its address says. */
export async function startEditor({ root, sites, version, online }: EditorSite): Promise<void> {
  // Installed as an app, the browser keeps the folders people opened allowed, see the design of
  // local projects, question 4. Nothing depends on it: a page that cannot have it works the same.
  navigator.serviceWorker?.register("/sw.js").catch((error: unknown) => {
    console.warn("The editor cannot be installed as an app here", error);
  });
  await startApp(root, {
    version,
    compositorUrl: `${sites.compositor}${COMPOSITOR_PAGE}`,
    sceneOrigins: sites.scenes,
    ...(online && { online: { backend: location.host, ...online } }),
  });
}
