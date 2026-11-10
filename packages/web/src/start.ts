import type { Host } from "@animaquill/host";
import { createBrowserHost } from "@animaquill/host/browser";
import { mountEditor } from "@animaquill/ui";
import { COMPOSITOR_PAGE, type Sites } from "./sites.ts";

/** What a deployment of the editor as a web app is made of. */
export interface EditorSite {
  /** Where the editor goes in the page. */
  readonly root: HTMLElement;
  readonly sites: Sites;
  /** Shown in the status bar, so that a report can say which build it is about. */
  readonly version: string;
  /**
   * What the deployment adds to the browser's host, such as an account, a place for reports, or a
   * platform to keep projects in step with. Without them there is nothing to sign in to, reports are
   * files people pass on themselves, and projects stay in the browser and its folders: everything on
   * this computer works the same.
   */
  readonly host?: Pick<Host, "account" | "diagnostics" | "cloud">;
}

/** Starts the editor as the page of a web app. */
export async function startEditor({ root, sites, version, host }: EditorSite): Promise<void> {
  // Installed as an app, the browser keeps the folders people opened allowed, see the design of
  // local projects, question 4. Nothing depends on it: a page that cannot have it works the same.
  navigator.serviceWorker?.register("/sw.js").catch((error: unknown) => {
    console.warn("The editor cannot be installed as an app here", error);
  });
  await mountEditor(root, {
    host: { ...createBrowserHost(), ...host },
    version,
    compositorUrl: `${sites.compositor}${COMPOSITOR_PAGE}`,
    sceneOrigins: sites.scenes,
  });
}
