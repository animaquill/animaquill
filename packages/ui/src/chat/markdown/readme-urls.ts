/**
 * Where the links and pictures of a README of a model pack go (docs/design/settings-and-properties.md
 * of AnimaQuill Cloud, 8.3). A README is what someone else wrote: links go only to the web and mail,
 * pictures of the repository come from the commit installed, and pictures from anywhere else load
 * only when people ask, as they tell that place who is looking.
 */

/** Where a pack's files are on GitHub: the commit installed, and the folder of the pack. */
export interface ReadmePlace {
  readonly owner: string;
  readonly repo: string;
  readonly commit: string;
  /** The folder of the pack in the repository; "" for its root. */
  readonly path: string;
}

/** A scheme, such as "https:", "javascript:" or "data:". */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** An address relative to the folder of the pack, under a root it may not leave. */
function within(address: string, root: string, place: ReadmePlace): string | undefined {
  const folder = `${root}${place.path === "" ? "" : `${place.path.split("/").map(encodeURIComponent).join("/")}/`}`;
  let url: URL;
  try {
    // "/x" is the root of the repository, as GitHub reads a README.
    url = address.startsWith("/") ? new URL(address.slice(1), root) : new URL(address, folder);
  } catch {
    return undefined;
  }
  return url.href.startsWith(root) ? url.href : undefined;
}

/**
 * Where a link of a README goes: the web and mail as they are, a file of the repository on GitHub at
 * the commit installed; nothing (the link shows as its text) for any other scheme, a place in the
 * page, or a file of a pack not from GitHub.
 */
export function readmeLink(href: string, place: ReadmePlace | undefined): string | undefined {
  const address = href.trim();
  if (address === "" || address.startsWith("#") || address.startsWith("//")) return undefined;
  if (SCHEME.test(address)) {
    if (/^mailto:/i.test(address)) return address;
    if (!/^https?:/i.test(address)) return undefined;
    try {
      return new URL(address).href;
    } catch {
      return undefined;
    }
  }
  if (!place) return undefined;
  const root = `https://github.com/${place.owner}/${place.repo}/blob/${place.commit}/`;
  return within(address, root, place);
}

/** A picture of a README: of the repository, from elsewhere, or none at all. */
export type ReadmeImage =
  | { readonly kind: "repository"; readonly url: string }
  | { readonly kind: "elsewhere"; readonly url: string; readonly host: string }
  | { readonly kind: "none" };

/**
 * A picture of a README: one of the repository is a raw file of the commit installed, which shows
 * (GitHub's, where the pack's files came from: it learns nothing new); one from anywhere else waits
 * to be asked for; `data:` and any other scheme, and pictures of packs not from GitHub, show none.
 */
export function readmeImage(src: string, place: ReadmePlace | undefined): ReadmeImage {
  const address = src.trim();
  if (address === "" || address.startsWith("//")) return { kind: "none" };
  if (SCHEME.test(address)) {
    if (!/^https?:/i.test(address)) return { kind: "none" };
    try {
      const url = new URL(address);
      return { kind: "elsewhere", url: url.href, host: url.host };
    } catch {
      return { kind: "none" };
    }
  }
  if (!place) return { kind: "none" };
  const root = `https://raw.githubusercontent.com/${place.owner}/${place.repo}/${place.commit}/`;
  const url = within(address, root, place);
  return url ? { kind: "repository", url } : { kind: "none" };
}
