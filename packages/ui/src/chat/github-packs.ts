import {
  filesNamedIn,
  isPackPath,
  MANIFEST,
  MAX_FILE_BYTES,
  type PackFileTooLarge,
} from "@animaquill/tools";

/**
 * Model packs on GitHub: a pack is a repository (docs/model-packs.md), with pack.json at its root
 * and README.md to tell people what it is; a folder of a repository still installs. Everything is
 * read straight from this browser: both GitHub's API and its raw files answer pages of any address
 * (CORS), so this needs no platform and works in the local version too. Without signing in, GitHub
 * answers 60 questions of its API an hour for an address; raw files do not count.
 */

/** The files a pack is made of, for `checkPack`: pack.json and those it names. */
export type PackInput = ReadonlyMap<string, string | Uint8Array | PackFileTooLarge>;

type Read = Map<string, string | Uint8Array | PackFileTooLarge>;

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Text where it is UTF-8, bytes where not, so that the check can tell which files are not. */
export function asText(path: string, bytes: Uint8Array, into: Read): void {
  try {
    into.set(path, decoder.decode(bytes));
  } catch {
    into.set(path, bytes);
  }
}

/** The most of one file that is read: a little more than a pack may have, for the check to say so. */
export const MOST = MAX_FILE_BYTES + 1;

/** How much of a README shows: the rest is on GitHub. Not counted in the size of the pack. */
export const README_BYTES = 64 * 1024;

/** What a pack says of itself for people, its README.md: never sent to models. */
export interface PackReadme {
  readonly text: string;
  /** It is longer: `text` is its first `README_BYTES`. */
  readonly cut?: boolean;
}

/** The README of a pack from its bytes: as much as shows, cut where a character ends. */
export function readmeOf(bytes: Uint8Array, cut: boolean): PackReadme {
  let text = new TextDecoder("utf-8").decode(bytes.subarray(0, README_BYTES));
  // A character cut in two at the end shows as one that is not there.
  if (cut || bytes.length > README_BYTES) text = text.replace(/�+$/u, "");
  return { text, ...((cut || bytes.length > README_BYTES) && { cut: true }) };
}

/** A GitHub account: letters, digits and "-", at most 39, not beginning with "-". */
const ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A repository: letters, digits, ".", "_" and "-". */
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

export const isAccount = (name: string) => ACCOUNT.test(name);
export const isRepository = (name: string) =>
  REPOSITORY.test(name) && name !== "." && name !== "..";

/** A commit, as GitHub writes them in full. */
export const isCommit = (ref: string) => /^[0-9a-f]{40}$/.test(ref);

/** A folder of a repository on GitHub, as people paste its address. */
export interface GitHubPlace {
  readonly owner: string;
  readonly repo: string;
  /** A branch, a tag or a commit; nothing for the latest version. */
  readonly ref: string | undefined;
  /** The folder in the repository, without slashes around it; "" for its root. */
  readonly path: string;
}

/**
 * Where a pack is on GitHub, from an address such as `https://github.com/<owner>/<repo>`, which is
 * what packs are now, `…/tree/<ref>` for a branch, a tag or a commit, `…/tree/<ref>/<folder>` for a
 * folder of it, or the address of its pack.json (`…/blob/<ref>/<folder>/pack.json`). A branch with
 * "/" in its name is not told apart from a folder: the first part after "tree" is the branch.
 */
export function gitHubPlace(address: string): GitHubPlace | undefined {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "github.com" && url.hostname !== "www.github.com") ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return undefined;
  }
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const [owner, repoName, kind, ref, ...rest] = parts;
  if (!owner || !repoName || !isAccount(owner)) return undefined;
  const repo = repoName.replace(/\.git$/, "");
  if (!isRepository(repo)) return undefined;
  if (kind === undefined) return { owner, repo, ref: undefined, path: "" };
  if ((kind !== "tree" && kind !== "blob") || !ref) return undefined;
  let folderParts: string[];
  try {
    folderParts = rest.map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const unsafe = (part: string) =>
    part === ".." || part === "." || part.includes("/") || part.includes("\\");
  if (folderParts.some(unsafe)) return undefined;
  if (kind === "blob" && folderParts.at(-1) !== MANIFEST) return undefined;
  const folder = kind === "blob" ? folderParts.slice(0, -1) : folderParts;
  let branch: string;
  try {
    branch = decodeURIComponent(ref);
  } catch {
    return undefined;
  }
  return { owner, repo, ref: branch, path: folder.join("/") };
}

/** A pack on GitHub as installed: the repository by GitHub's own spelling, and the commit. */
export interface GitHubSource {
  readonly kind: "github";
  /** The address people gave: what looking for an update goes by. */
  readonly url: string;
  readonly commit: string;
  /** The account of the repository, as GitHub spells it: where the pack says it is from. */
  readonly owner?: string;
  readonly repo?: string;
  /** The folder of the repository; "" or nothing for its root. */
  readonly path?: string;
  /** The branch, tag or commit it was taken at. */
  readonly ref?: string;
  /** `ref` is a tag. */
  readonly tag?: boolean;
}

/** Why a pack could not be taken from GitHub. */
export type GitHubFailure =
  | "address"
  | "notFound"
  | "rate"
  | "network"
  /** The commit of the address is not in the history of the repository: a fork's, say. */
  | "notInRepository"
  /** The tag says one version and pack.json another. */
  | "tagMismatch";

export type GitHubRead =
  | {
      readonly ok: true;
      readonly files: PackInput;
      readonly source: GitHubSource;
      /** Nothing when the pack has no README.md. */
      readonly readme?: PackReadme;
    }
  | {
      readonly ok: false;
      readonly failure: GitHubFailure;
      readonly detail?: Readonly<Record<string, string>>;
    };

/**
 * The body of a response, up to a size: what says it is larger is not read, and what turns out
 * larger stops being read there, so that a large file never sits in memory whole.
 */
async function upTo(
  response: Response,
  max: number,
): Promise<Uint8Array | PackFileTooLarge | "network"> {
  const length = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(length) && length > max) {
    await response.body?.cancel().catch(() => undefined);
    return { tooLarge: length };
  }
  const read = await firstOf(response, max);
  if (read === "network") return read;
  return read.more ? { tooLarge: read.bytes.length + 1 } : read.bytes;
}

/** Up to `max` bytes of a body, and whether there was more. */
async function firstOf(
  response: Response,
  max: number,
): Promise<{ readonly bytes: Uint8Array; readonly more: boolean } | "network"> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), more: false };
  const parts: Uint8Array[] = [];
  let size = 0;
  let more = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > max) {
        parts.push(value.subarray(0, max - size));
        size = max;
        more = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      size += value.length;
      parts.push(value);
    }
  } catch {
    return "network";
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return { bytes, more };
}

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** A tag of a version: "v" and three numbers. Tags of versions before a release do not count. */
const VERSION_TAG = /^v(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

/** The newest of the tags of versions, by their numbers; nothing when there is none. */
export function newestTag(names: readonly string[]): string | undefined {
  let best: { readonly name: string; readonly numbers: readonly number[] } | undefined;
  const newer = (a: readonly number[], b: readonly number[]) => {
    for (const [index, value] of a.entries()) {
      const other = b[index] ?? 0;
      if (value !== other) return value > other;
    }
    return false;
  };
  for (const name of names) {
    const match = VERSION_TAG.exec(name);
    if (!match) continue;
    const numbers = match.slice(1).map(Number);
    if (!best || newer(numbers, best.numbers)) best = { name, numbers };
  }
  return best?.name;
}

/** Asks GitHub, as a page that is no one: no cookies, no referrer. */
type Ask = (url: string) => Promise<Response | GitHubFailure>;

function askerOf(fetcher: typeof fetch): Ask {
  return async (url) => {
    try {
      const response = await fetcher(url, { credentials: "omit", referrerPolicy: "no-referrer" });
      if (response.status === 404 || response.status === 422) return "notFound";
      if (response.status === 403 || response.status === 429) return "rate";
      if (!response.ok) return "network";
      return response;
    } catch {
      return "network";
    }
  };
}

async function json(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Where a version of a pack is: its repository as GitHub spells it, and a commit of it. */
interface Resolved {
  readonly owner: string;
  readonly repo: string;
  readonly commit: string;
  readonly ref: string;
  readonly tag: boolean;
  /** The version pack.json has to say: that of the tag it was taken at. */
  readonly version?: string;
}

/**
 * The commit of a place: of the newest tag of a version where the address names none and there are
 * such tags, else of the default branch; of the branch or tag it names; or the commit it names,
 * which has to be in the history of the default branch. GitHub answers for a commit pushed to any
 * fork under the name of the repository it was forked from, so a commit outside that history may
 * be anyone's.
 */
async function resolve(
  place: GitHubPlace,
  ask: Ask,
): Promise<Resolved | { readonly failure: GitHubFailure }> {
  const named = `${encodeURIComponent(place.owner)}/${encodeURIComponent(place.repo)}`;
  const info = await ask(`${API}/repos/${named}`);
  if (typeof info === "string") return { failure: info };
  const about = await json(info);
  const fullName = typeof about?.full_name === "string" ? about.full_name : "";
  const [owner = "", repo = ""] = fullName.split("/");
  const branch = about?.default_branch;
  if (!isAccount(owner) || !isRepository(repo) || typeof branch !== "string") {
    return { failure: "notFound" };
  }
  const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const commitOf = async (ref: string): Promise<string | GitHubFailure> => {
    const answer = await ask(`${base}/commits/${encodeURIComponent(ref)}`);
    if (typeof answer === "string") return answer;
    const sha = (await json(answer))?.sha;
    return typeof sha === "string" && isCommit(sha) ? sha : "notFound";
  };
  const ref = place.ref;
  if (ref !== undefined && isCommit(ref)) {
    const answer = await ask(
      `${base}/compare/${encodeURIComponent(branch)}...${encodeURIComponent(ref)}`,
    );
    if (typeof answer === "string") return { failure: answer };
    const status = (await json(answer))?.status;
    if (status !== "behind" && status !== "identical") return { failure: "notInRepository" };
    return { owner, repo, commit: ref, ref, tag: false };
  }
  if (ref !== undefined) {
    const commit = await commitOf(ref);
    if (!isCommit(commit)) return { failure: commit as GitHubFailure };
    const version = VERSION_TAG.test(ref) ? ref.slice(1) : undefined;
    return { owner, repo, commit, ref, tag: version !== undefined, ...(version && { version }) };
  }
  const tags = await ask(`${base}/tags?per_page=100`);
  if (typeof tags === "string") return { failure: tags };
  let list: unknown;
  try {
    list = await tags.json();
  } catch {
    list = [];
  }
  const entries = (Array.isArray(list) ? list : []).flatMap((each: unknown) => {
    const tag = each as { name?: unknown; commit?: { sha?: unknown } };
    return typeof tag?.name === "string" && typeof tag.commit?.sha === "string"
      ? [{ name: tag.name, sha: tag.commit.sha }]
      : [];
  });
  const newest = newestTag(entries.map(({ name }) => name));
  const tagged = entries.find(({ name }) => name === newest);
  if (newest && tagged && isCommit(tagged.sha)) {
    return { owner, repo, commit: tagged.sha, ref: newest, tag: true, version: newest.slice(1) };
  }
  const commit = await commitOf(branch);
  if (!isCommit(commit)) return { failure: commit as GitHubFailure };
  return { owner, repo, commit, ref: branch, tag: false };
}

/** The address of a file of a pack at a commit, among GitHub's raw files. */
function rawOf(where: Resolved, folder: string, path: string): string {
  const parts = [...(folder === "" ? [] : folder.split("/")), ...path.split("/")];
  return `${RAW}/${encodeURIComponent(where.owner)}/${encodeURIComponent(where.repo)}/${where.commit}/${parts
    .map(encodeURIComponent)
    .join("/")}`;
}

/** The README of a pack at a commit, as much as shows; nothing where it has none. */
async function readmeAt(
  where: Resolved,
  folder: string,
  ask: Ask,
): Promise<PackReadme | undefined | GitHubFailure> {
  const answer = await ask(rawOf(where, folder, "README.md"));
  if (answer === "notFound") return undefined;
  if (typeof answer === "string") return answer;
  const read = await firstOf(answer, README_BYTES);
  if (read === "network") return read;
  return readmeOf(read.bytes, read.more);
}

/**
 * A pack from a public repository on GitHub, straight from this browser. The version is pinned to
 * its commit first, so that all files come from the same one and an update can be told by it; a
 * version taken at a tag has to say the version of the tag.
 */
export async function readGitHub(
  address: string,
  fetcher: typeof fetch = fetch,
): Promise<GitHubRead> {
  const place = gitHubPlace(address);
  if (!place) return { ok: false, failure: "address" };
  const ask = askerOf(fetcher);
  const where = await resolve(place, ask);
  if ("failure" in where) return { ok: false, failure: where.failure };
  const read: Read = new Map();
  const take = async (path: string): Promise<GitHubFailure | undefined> => {
    const file = await ask(rawOf(where, place.path, path));
    if (typeof file === "string") return file === "notFound" ? undefined : file;
    const bytes = await upTo(file, MOST);
    if (bytes === "network") return bytes;
    if (bytes instanceof Uint8Array) asText(path, bytes, read);
    else read.set(path, bytes);
    return undefined;
  };
  const failed = await take(MANIFEST);
  if (failed) return { ok: false, failure: failed };
  const manifest = read.get(MANIFEST);
  // A pack.json too large is for the check to say, as of any file.
  if (manifest === undefined) return { ok: false, failure: "notFound" };
  if (typeof manifest === "string") {
    if (where.version !== undefined) {
      let version: unknown;
      try {
        version = (JSON.parse(manifest) as { version?: unknown }).version;
      } catch {
        // Not JSON: for the check to say.
      }
      if (typeof version === "string" && version !== where.version) {
        return {
          ok: false,
          failure: "tagMismatch",
          detail: { tag: where.ref, version },
        };
      }
    }
    // Only files a pack may name: in it, of the kinds it may have, and not many of them.
    const named = filesNamedIn(manifest).filter(isPackPath).slice(0, 64);
    for (const path of named) {
      const error = await take(path);
      if (error) return { ok: false, failure: error };
    }
  }
  const readme = await readmeAt(where, place.path, ask);
  return {
    ok: true,
    files: read,
    source: {
      kind: "github",
      url: address.trim(),
      commit: where.commit,
      owner: where.owner,
      repo: where.repo,
      ...(place.path !== "" && { path: place.path }),
      ref: where.ref,
      ...(where.tag && { tag: true }),
    },
    ...(readme && typeof readme !== "string" && { readme }),
  };
}

/** What looking for an update of a pack from GitHub found. */
export type GitHubLatest =
  | { readonly state: "latest" }
  /** Another commit, with the version its pack.json says where it says one. */
  | { readonly state: "update"; readonly commit: string; readonly version?: string }
  /** Installed at a commit people named: it has no updates. */
  | { readonly state: "pinned" }
  | { readonly state: "failed"; readonly failure: GitHubFailure };

/**
 * Whether there is a newer version of a pack from GitHub than the one installed: the newest tag of
 * a version, or the latest commit of the branch, as installing it now would take. Asks GitHub's API
 * once or twice and reads one raw file; installs nothing.
 */
export async function latestOf(
  source: GitHubSource,
  fetcher: typeof fetch = fetch,
): Promise<GitHubLatest> {
  const place = gitHubPlace(source.url);
  if (!place) return { state: "failed", failure: "address" };
  if (place.ref !== undefined && isCommit(place.ref)) return { state: "pinned" };
  const ask = askerOf(fetcher);
  const where = await resolve(place, ask);
  if ("failure" in where) return { state: "failed", failure: where.failure };
  if (where.commit === source.commit) return { state: "latest" };
  if (where.version !== undefined) {
    return { state: "update", commit: where.commit, version: where.version };
  }
  const manifest = await ask(rawOf(where, place.path, MANIFEST));
  let version: unknown;
  if (typeof manifest !== "string") {
    const bytes = await upTo(manifest, MOST);
    if (bytes instanceof Uint8Array) {
      try {
        version = (JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown }).version;
      } catch {
        // Then it only says there is a newer commit.
      }
    }
  }
  return {
    state: "update",
    commit: where.commit,
    ...(typeof version === "string" && version.length <= 40 && { version }),
  };
}

/** Where the README and the files of a pack on GitHub are, at the commit it was installed at. */
export interface PackPlace {
  readonly owner: string;
  readonly repo: string;
  readonly commit: string;
  /** The folder of the pack in the repository; "" for its root. */
  readonly path: string;
}

/** The place of a pack installed from GitHub; nothing for an old record that cannot say. */
export function placeOf(source: GitHubSource): PackPlace | undefined {
  const parsed = gitHubPlace(source.url);
  const owner = source.owner ?? parsed?.owner;
  const repo = source.repo ?? parsed?.repo;
  if (!owner || !repo || !isAccount(owner) || !isRepository(repo) || !isCommit(source.commit)) {
    return undefined;
  }
  return { owner, repo, commit: source.commit, path: source.path ?? parsed?.path ?? "" };
}

/** READMEs read for the details of packs, by place: a commit's never changes. */
const readmes = new Map<string, Promise<PackReadme | undefined | GitHubFailure>>();

/**
 * The README of a pack installed from GitHub, at the commit it was installed at: read when its
 * details open, not kept with the settings, so that they stay small. Nothing where it has none.
 */
export function readmeFromGitHub(
  place: PackPlace,
  fetcher: typeof fetch = fetch,
): Promise<PackReadme | undefined | GitHubFailure> {
  const key = `${place.owner}/${place.repo}/${place.commit}/${place.path}`;
  let read = readmes.get(key);
  if (!read) {
    const where: Resolved = { ...place, ref: place.commit, tag: false };
    read = readmeAt(where, place.path, askerOf(fetcher));
    readmes.set(key, read);
    // Failing may be for now only: asked again next time.
    void read.then((value) => {
      if (typeof value === "string") readmes.delete(key);
    });
  }
  return read;
}
