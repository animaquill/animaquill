import { compositorFrameSource, scenePolicyHeader } from "@animaquill/scene/policy";

/**
 * The sites the editor runs on. Each is an origin of its own: the editor, the compositor in a frame
 * of the editor, and the scenes in frames of the compositor. Scenes and the compositor run code from
 * projects, which must not get to what the editor keeps, see docs of the scene sandbox. A deployment
 * says which sites it has, and both its server and the page take them from there.
 */
export interface Sites {
  /** The page of the editor, which keeps the projects and the keys. */
  readonly editor: string;
  /** Where the compositor is. It runs in a sandbox, with no origin of its own. */
  readonly compositor: string;
  /** Where scenes run, each on an origin of its own, so that one that hangs takes nothing along. */
  readonly scenes: readonly string[];
}

/** As many scenes as run at a time without waiting for each other. */
export const SCENE_SITES = 8;

/**
 * The port the editor has on this computer unless people say otherwise. What the browser keeps for
 * a site belongs to its origin, port and all: on another port the projects kept in the browser and
 * the keys of AI services are not there. That is why it is fixed, and why it is one few programs use.
 */
export const LOCAL_PORT = 7651;

/**
 * The names of the sites on this computer. Chrome and Edge take every name under `localhost` to be
 * this computer, without asking anybody, and count it as secure like `localhost` itself, so these
 * are as good as real sites. Each name is a site of its own, the way the deployed ones are.
 */
export const LOCAL_NAMES = {
  editor: "animaquill.localhost",
  compositor: "animaquill-sandbox.localhost",
  scene: (index: number) => `animaquill-scene-${index}.localhost`,
} as const;

/** The sites on this computer, at a port. */
export function localSites(port: number = LOCAL_PORT): Sites {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`Not a port: ${port}`);
  }
  // Without the port when it is the one of http anyway, as the browser writes the origin.
  const at = (name: string) => new URL(`http://${name}:${port}`).origin;
  return {
    editor: at(LOCAL_NAMES.editor),
    compositor: at(LOCAL_NAMES.compositor),
    scenes: Array.from({ length: SCENE_SITES }, (_, index) => at(LOCAL_NAMES.scene(index))),
  };
}

/** Says what is wrong with sites that would not keep the editor apart from what projects run. */
export function checkSites(sites: Sites): void {
  const all = [sites.editor, sites.compositor, ...sites.scenes];
  for (const site of all) {
    let url: URL;
    try {
      url = new URL(site);
    } catch {
      throw new Error(`Not an origin: ${site}`);
    }
    if (url.origin !== site) throw new Error(`Not an origin: ${site}`);
  }
  if (sites.scenes.length === 0) throw new Error("Scenes need at least one site");
  if (new Set(all).size !== all.length) {
    throw new Error("The editor, the compositor and every scene need a site of their own");
  }
}

export interface PolicyOptions {
  /**
   * Where else the editor may show pictures from, such as the pictures of accounts where the
   * deployment has accounts.
   */
  readonly images?: readonly string[];
}

/**
 * The policy of the editor's page. It runs only its own scripts, and shows only the compositor in a
 * frame. It talks to any https address, and to services on this computer, because the browser agent
 * talks to the AI services people set up themselves (2026-11-10, user's decision).
 *
 * The code editor (Monaco) writes `<style>` elements and `style=""` attributes and does not work
 * without `'unsafe-inline'` for styles. A style can still reach nothing outside, because `img-src`
 * and `font-src` stay with this site. Workers are files of this site, never blobs.
 */
export function editorPolicy(sites: Sites, options: PolicyOptions = {}): string {
  const images = ["'self'", "data:", "blob:", ...(options.images ?? [])];
  return [
    "default-src 'none'",
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${images.join(" ")}`,
    "font-src 'self'",
    "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
    "manifest-src 'self'",
    `frame-src ${sites.compositor}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The policy of the compositor: no network, no storage, only its own code, and only scenes in
 * frames. It runs with an opaque origin, so `'self'` means nothing to it, and its modules need CORS.
 * Without `frame-src` a scene could navigate itself anywhere.
 */
export const compositorPolicy = (sites: Sites): string =>
  [
    "default-src 'none'",
    `script-src ${sites.compositor}`,
    "img-src blob:",
    "media-src blob:",
    compositorFrameSource(sites.scenes),
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${sites.editor}`,
  ].join("; ");

/** The page each site has besides the editor's, which has all of them. */
export const COMPOSITOR_PAGE = "/compositor.html";

/**
 * What every site sends with its pages, by site. Where the sites are served from has to send exactly
 * this: the deployment checks its server's configuration against it, and the server on this computer
 * sends it as it is.
 */
export interface SiteHeaders {
  readonly editor: Readonly<Record<string, string>>;
  /** For the compositor's page and its code. */
  readonly compositor: Readonly<Record<string, string>>;
  /** For the scene page, which is all the scene sites have. */
  readonly scene: Readonly<Record<string, string>>;
}

export function siteHeaders(sites: Sites, options: PolicyOptions = {}): SiteHeaders {
  checkSites(sites);
  return {
    editor: { "Content-Security-Policy": editorPolicy(sites, options) },
    compositor: {
      "Access-Control-Allow-Origin": "*",
      "Content-Security-Policy": compositorPolicy(sites),
    },
    scene: { "Content-Security-Policy": scenePolicyHeader() },
  };
}

/** Files under `/assets/` have a hash of their content in their name, so they never change. */
export const CACHE = {
  hashed: "public, max-age=31536000, immutable",
  plain: "no-cache",
} as const;
