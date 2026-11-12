import {
  builtinPacks,
  checkPack,
  choosePack,
  filesNamedIn,
  MANIFEST,
  MAX_FILE_BYTES,
  type ModelPack,
  type PackCheck,
  type PackChoice,
  type PackProblem,
} from "@animaquill/tools";
import type { SettingsStore } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

/** Where people installed a pack from, to tell them and to look for an update. */
export type PackSource =
  | { readonly kind: "folder"; readonly name: string }
  | { readonly kind: "file"; readonly name: string }
  /** A folder of a repository on GitHub, and the commit it was taken from. */
  | { readonly kind: "github"; readonly url: string; readonly commit: string };

/** A pack as this browser keeps it: the files that were checked when it was installed. */
export interface KeptPack {
  readonly files: Readonly<Record<string, string>>;
  readonly source: PackSource;
  /** Milliseconds since 1970: of two packs for the same models, the one installed first goes. */
  readonly installedAt: number;
}

/** A pack installed in this browser, as it reads now. */
export interface InstalledPack {
  readonly id: string;
  readonly kept: KeptPack;
  /** Nothing when it does not pass any more: `problems` says why, and the default goes instead. */
  readonly pack: ModelPack | undefined;
  readonly problems: readonly PackProblem[];
  /** Words for what this version of the tools does not have, which it goes without. */
  readonly dropped: readonly PackProblem[];
}

export interface ModelPacksSnapshot {
  readonly installed: readonly InstalledPack[];
  /** Every pack that can be used: AnimaQuill's own, then those installed, as installed. */
  readonly packs: readonly ModelPack[];
}

export interface ModelPacksMessages {
  saveFailed(): void;
}

const SETTINGS_KEY = "ai.packs";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readSource(value: unknown): PackSource | undefined {
  if (!isRecord(value)) return undefined;
  if ((value.kind === "folder" || value.kind === "file") && typeof value.name === "string") {
    return { kind: value.kind, name: value.name };
  }
  if (
    value.kind === "github" &&
    typeof value.url === "string" &&
    typeof value.commit === "string"
  ) {
    return { kind: "github", url: value.url, commit: value.commit };
  }
  return undefined;
}

function readKept(value: unknown): KeptPack | undefined {
  if (!isRecord(value) || !isRecord(value.files) || typeof value.installedAt !== "number") {
    return undefined;
  }
  const source = readSource(value.source);
  const files = Object.entries(value.files);
  if (!source || files.some(([, text]) => typeof text !== "string")) return undefined;
  return {
    files: Object.fromEntries(files) as Record<string, string>,
    source,
    installedAt: value.installedAt,
  };
}

/** A pack kept before, checked again as it is read: this version of the tools may differ. */
function installedOf(kept: KeptPack): InstalledPack | undefined {
  const check = checkPack(new Map(Object.entries(kept.files)), { mode: "load" });
  const manifest = kept.files[MANIFEST];
  let id = check.pack?.id;
  if (id === undefined && manifest !== undefined) {
    try {
      const parsed = JSON.parse(manifest) as { id?: unknown };
      if (typeof parsed.id === "string") id = parsed.id;
    } catch {
      // Without an id it cannot be told apart, and it was checked when installed: leave it.
    }
  }
  if (id === undefined) return undefined;
  return { id, kept, pack: check.pack, problems: check.problems, dropped: check.dropped };
}

/**
 * The model packs installed in this browser, kept with the settings of AI services and shared by
 * its windows; never in a project, which people share. Each is kept as the files that were checked
 * when it was installed, and checked again whenever it is read.
 */
export class ModelPacks {
  readonly #settings: SettingsStore;
  readonly #messages: ModelPacksMessages;
  readonly #emitter = new Emitter();
  #snapshot: ModelPacksSnapshot = { installed: [], packs: builtinPacks() };

  constructor(settings: SettingsStore, messages: ModelPacksMessages) {
    this.#settings = settings;
    this.#messages = messages;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ModelPacksSnapshot => this.#snapshot;

  async load(): Promise<void> {
    try {
      this.#adopt(await this.#settings.load(SETTINGS_KEY));
    } catch (error) {
      console.warn("The model packs could not be read", error);
    }
    this.#settings.listen(SETTINGS_KEY, (value) => this.#adopt(value));
  }

  #adopt(value: unknown): void {
    const list = isRecord(value) && Array.isArray(value.packs) ? value.packs : [];
    const installed = list
      .map(readKept)
      .filter((kept) => kept !== undefined)
      .toSorted((a, b) => a.installedAt - b.installedAt)
      .map(installedOf)
      .filter((pack) => pack !== undefined);
    this.#set(installed);
  }

  #set(installed: readonly InstalledPack[]): void {
    const usable = installed.flatMap(({ pack }) => (pack ? [pack] : []));
    this.#snapshot = { installed, packs: [...builtinPacks(), ...usable] };
    this.#emitter.emit();
  }

  #save(installed: readonly InstalledPack[]): void {
    this.#set(installed);
    const packs = installed.map(({ kept }) => kept);
    this.#settings.save(SETTINGS_KEY, { packs }).catch((error) => {
      console.warn("The model packs could not be saved", error);
      this.#messages.saveFailed();
    });
  }

  /** The pack installed under an id. */
  installedOf(id: string): InstalledPack | undefined {
    return this.#snapshot.installed.find((each) => each.id === id);
  }

  /** A pack by id, of those that can be used. */
  packOf(id: string): ModelPack | undefined {
    return this.#snapshot.packs.find((pack) => pack.id === id);
  }

  /** The pack for a model, with people's choice for it, see `choosePack`. */
  choose(model: string, chosen: string | undefined): PackChoice {
    return choosePack(model, this.#snapshot.packs, chosen);
  }

  /**
   * Puts a pack in, or a new version in place of the one with its id, once people saw it. It is
   * checked again here: only what passes is kept.
   */
  install(files: ReadonlyMap<string, string>, source: PackSource): PackCheck {
    const check = checkPack(files);
    const pack = check.pack;
    if (!pack) return check;
    const before = this.installedOf(pack.id);
    const kept: KeptPack = {
      files: Object.fromEntries(files),
      source,
      // An update keeps its place among packs for the same models.
      installedAt: before?.kept.installedAt ?? Date.now(),
    };
    const installed: InstalledPack = { id: pack.id, kept, pack, problems: [], dropped: [] };
    const others = this.#snapshot.installed.filter(({ id }) => id !== pack.id);
    this.#save([...others, installed].toSorted((a, b) => a.kept.installedAt - b.kept.installedAt));
    return check;
  }

  remove(id: string): void {
    this.#save(this.#snapshot.installed.filter((each) => each.id !== id));
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Text where it is UTF-8, bytes where not, so that the check can tell which files are not. */
function asText(path: string, bytes: Uint8Array, into: Map<string, string | Uint8Array>): void {
  try {
    into.set(path, decoder.decode(bytes));
  } catch {
    into.set(path, bytes);
  }
}

/** The files a pack is made of, for `checkPack`: pack.json and those it names. */
export type PackInput = ReadonlyMap<string, string | Uint8Array>;

/** Only files a pack may have are read, and none much larger than a pack may have. */
const tooLarge = (size: number) => size > MAX_FILE_BYTES * 2;

/**
 * A pack from a folder people picked: its pack.json and the files that names, as the folder has
 * them under its own name (`webkitRelativePath`).
 */
export async function readFolder(files: readonly File[]): Promise<PackInput> {
  const byPath = new Map<string, File>();
  for (const file of files) {
    const relative =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = relative.split("/");
    byPath.set(parts.length > 1 ? parts.slice(1).join("/") : relative, file);
  }
  const read = new Map<string, string | Uint8Array>();
  const manifest = byPath.get(MANIFEST);
  if (!manifest || tooLarge(manifest.size)) return read;
  asText(MANIFEST, new Uint8Array(await manifest.arrayBuffer()), read);
  const text = read.get(MANIFEST);
  if (typeof text !== "string") return read;
  for (const path of filesNamedIn(text)) {
    const file = byPath.get(path);
    if (!file || tooLarge(file.size)) continue;
    asText(path, new Uint8Array(await file.arrayBuffer()), read);
  }
  return read;
}

/** A pack that is one pack.json people picked. */
export async function readManifestFile(file: File): Promise<PackInput> {
  const read = new Map<string, string | Uint8Array>();
  if (!tooLarge(file.size)) asText(MANIFEST, new Uint8Array(await file.arrayBuffer()), read);
  return read;
}

/** Text of a pack that passed, to keep: every file it uses is text by then. */
export function textFiles(input: PackInput): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const [path, value] of input) if (typeof value === "string") files.set(path, value);
  return files;
}

/** A folder of a repository on GitHub, as people paste its address. */
export interface GitHubPlace {
  readonly owner: string;
  readonly repo: string;
  /** A branch, a tag or a commit; nothing for the default branch. */
  readonly ref: string | undefined;
  /** The folder in the repository, without slashes around it; "" for its root. */
  readonly path: string;
}

/**
 * Where a pack is on GitHub, from an address such as
 * `https://github.com/<owner>/<repo>/tree/<branch>/<folder>`, `https://github.com/<owner>/<repo>`,
 * or the address of its pack.json (`…/blob/<branch>/<folder>/pack.json`). A branch with "/" in its
 * name is not told apart from a folder: the first part after "tree" is the branch.
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
    (url.hostname !== "github.com" && url.hostname !== "www.github.com")
  ) {
    return undefined;
  }
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const [owner, repoName, kind, ref, ...rest] = parts;
  const name = /^[A-Za-z0-9_.-]+$/;
  if (!owner || !repoName || !name.test(owner) || !name.test(repoName)) return undefined;
  const repo = repoName.replace(/\.git$/, "");
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
  return { owner, repo, ref: decodeURIComponent(ref), path: folder.join("/") };
}

/** Why a pack could not be taken from GitHub. */
export type GitHubFailure = "address" | "notFound" | "rate" | "network";

export type GitHubRead =
  | {
      readonly ok: true;
      readonly files: PackInput;
      readonly source: PackSource & { kind: "github" };
    }
  | { readonly ok: false; readonly failure: GitHubFailure };

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/**
 * A pack from a public repository on GitHub, straight from this browser: both GitHub's API and its
 * raw files answer pages of any address (CORS), so this needs no platform and works in the local
 * version too. The branch or tag is pinned to its commit first, so that all files come from the
 * same one and an update can be told by it. Without signing in, GitHub answers 60 such questions an
 * hour for an address.
 */
export async function readGitHub(
  address: string,
  fetcher: typeof fetch = fetch,
): Promise<GitHubRead> {
  const place = gitHubPlace(address);
  if (!place) return { ok: false, failure: "address" };
  const repo = `${encodeURIComponent(place.owner)}/${encodeURIComponent(place.repo)}`;
  const get = async (url: string): Promise<Response | GitHubFailure> => {
    try {
      const response = await fetcher(url, { credentials: "omit", referrerPolicy: "no-referrer" });
      if (response.status === 404) return "notFound";
      if (response.status === 403 || response.status === 429) return "rate";
      if (!response.ok) return "network";
      return response;
    } catch {
      return "network";
    }
  };
  let ref = place.ref;
  if (ref === undefined) {
    const info = await get(`${API}/repos/${repo}`);
    if (typeof info === "string") return { ok: false, failure: info };
    const branch = ((await info.json()) as { default_branch?: unknown }).default_branch;
    if (typeof branch !== "string") return { ok: false, failure: "notFound" };
    ref = branch;
  }
  const commitAnswer = await get(`${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`);
  if (typeof commitAnswer === "string") return { ok: false, failure: commitAnswer };
  const commit = ((await commitAnswer.json()) as { sha?: unknown }).sha;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    return { ok: false, failure: "notFound" };
  }
  const folder =
    place.path === "" ? "" : `${place.path.split("/").map(encodeURIComponent).join("/")}/`;
  const read = new Map<string, string | Uint8Array>();
  const take = async (path: string): Promise<GitHubFailure | undefined> => {
    const file = await get(
      `${RAW}/${repo}/${commit}/${folder}${path.split("/").map(encodeURIComponent).join("/")}`,
    );
    if (typeof file === "string") return file === "notFound" ? undefined : file;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!tooLarge(bytes.length)) asText(path, bytes, read);
    return undefined;
  };
  const failed = await take(MANIFEST);
  if (failed) return { ok: false, failure: failed };
  const manifest = read.get(MANIFEST);
  if (manifest === undefined) return { ok: false, failure: "notFound" };
  if (typeof manifest === "string") {
    // Only files a pack may name: in it, of the kinds it may have, and not many of them.
    const named = filesNamedIn(manifest)
      .filter(
        (path) => /^[^/\\:][^\\:]*\.(md|txt|json)$/i.test(path) && !path.split("/").includes(".."),
      )
      .slice(0, 64);
    for (const path of named) {
      const error = await take(path);
      if (error) return { ok: false, failure: error };
    }
  }
  return {
    ok: true,
    files: read,
    source: { kind: "github", url: address.trim(), commit },
  };
}
