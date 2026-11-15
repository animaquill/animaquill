import {
  builtinPacks,
  callChanges,
  checkPack,
  choosePack,
  defaultsOf,
  filesNamedIn,
  isPackPath,
  MANIFEST,
  TOOLSET_VERSION,
  type ModelPack,
  type PackCheck,
  type PackChoice,
  type PackFileTooLarge,
  type PackProblem,
  type CallChange,
  type WordsChange,
  type WordsGroup,
  wordsChanges,
} from "@animaquill/tools";
import type { SettingsStore, WindowMemory } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import {
  asText,
  gitHubPlace,
  isAccount,
  latestOf,
  isCommit,
  isRepository,
  MOST,
  README_BYTES,
  readmeOf,
  type GitHubLatest,
  type GitHubSource,
  type PackInput,
  type PackReadme,
} from "./github-packs.ts";

export {
  gitHubPlace,
  readGitHub,
  type GitHubFailure,
  type GitHubPlace,
  type GitHubRead,
  type PackInput,
  type PackReadme,
} from "./github-packs.ts";

/**
 * Where people installed a pack from, as the editor wrote it when they did: what a pack is labeled
 * with ("名字(来源)", see `originOf`) and where an update is looked for. Nothing in a pack can set it.
 */
export type PackSource =
  /** A folder or a pack.json on this computer. */
  | { readonly kind: "folder"; readonly name: string }
  | { readonly kind: "file"; readonly name: string }
  /** A repository on GitHub, or a folder of one, and the commit it was taken from. */
  | GitHubSource
  /** One of the packs of "发现", at the commit the platform's people looked at (S-P2). */
  | {
      readonly kind: "discover";
      readonly entry: string;
      readonly repo: string;
      readonly commit: string;
    };

/** A pack as this browser keeps it: the files that were checked when it was installed. */
export interface KeptPack {
  readonly files: Readonly<Record<string, string>>;
  readonly source: PackSource;
  /** Milliseconds since 1970: of two packs for the same models, the one installed first goes. */
  readonly installedAt: number;
  /** The version of the tools it was installed with, see `TOOLSET_VERSION`. */
  readonly toolset?: string;
  /**
   * The default words of each key it changes, as hashes, as they were when it was installed: words
   * that replace defaults which changed since may say what is no longer so, see `defaultsOf`.
   */
  readonly defaults?: Readonly<Record<string, string>>;
  /**
   * The versions before an update, latest first, for conversations that began with one of them:
   * a conversation keeps the version it began with. Only the last few are kept.
   */
  readonly previous?: readonly KeptPack[];
  /**
   * What a pack from this computer says of itself for people (its README.md, never sent to models).
   * Of a pack from GitHub it is read from there when its details open, at the commit installed.
   */
  readonly readme?: PackReadme;
}

/** How many versions before an update are kept for conversations that began with them. */
export const PREVIOUS = 2;

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

/** What looking for an update of an installed pack found last, and when. */
export interface PackUpdate {
  readonly at: number;
  /** The commit installed then: an update of it found before says nothing of another one. */
  readonly commit: string;
  readonly latest: GitHubLatest;
}

export interface ModelPacksSnapshot {
  readonly installed: readonly InstalledPack[];
  /** Every pack that can be used: AnimaQuill's own, then those installed, as installed. */
  readonly packs: readonly ModelPack[];
  /** What looking for updates found, by id, for packs from GitHub: see `ModelPacks.lookForUpdates`. */
  readonly updates: ReadonlyMap<string, PackUpdate>;
  /** Packs whose update is being looked for now. */
  readonly looking: ReadonlySet<string>;
}

export interface ModelPacksMessages {
  saveFailed(): void;
}

export interface ModelPacksOptions {
  /** Where what looking for updates found is kept, so that a reload does not ask GitHub again. */
  readonly memory?: WindowMemory;
  /** How GitHub is asked; tests give their own. */
  readonly fetcher?: typeof fetch;
}

/** How long what looking for an update found holds: GitHub answers 60 times an hour. */
export const UPDATE_EVERY = 6 * 60 * 60 * 1000;

const UPDATES_KEY = "packs.updates";

const SETTINGS_KEY = "ai.packs";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const shortText = (value: unknown, most: number) =>
  typeof value === "string" && value.length <= most ? value : undefined;

/**
 * Where a pack was installed from, as kept. The account and repository it says it is from are only
 * kept as GitHub may spell them, so that settings written some other way cannot make a pack say it
 * is from "内置".
 */
export function readSource(value: unknown): PackSource | undefined {
  if (!isRecord(value)) return undefined;
  if ((value.kind === "folder" || value.kind === "file") && typeof value.name === "string") {
    return { kind: value.kind, name: value.name };
  }
  if (
    value.kind === "github" &&
    typeof value.url === "string" &&
    typeof value.commit === "string"
  ) {
    const owner = shortText(value.owner, 39);
    const repo = shortText(value.repo, 100);
    const path = shortText(value.path, 1000);
    const ref = shortText(value.ref, 255);
    return {
      kind: "github",
      url: value.url,
      commit: value.commit,
      ...(owner !== undefined && isAccount(owner) && { owner }),
      ...(repo !== undefined && isRepository(repo) && { repo }),
      ...(path !== undefined && { path }),
      ...(ref !== undefined && { ref }),
      ...(value.tag === true && { tag: true }),
    };
  }
  if (
    value.kind === "discover" &&
    typeof value.entry === "string" &&
    typeof value.repo === "string" &&
    typeof value.commit === "string" &&
    isCommit(value.commit)
  ) {
    return { kind: "discover", entry: value.entry, repo: value.repo, commit: value.commit };
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
  const defaults =
    isRecord(value.defaults) &&
    Object.values(value.defaults).every((hash) => typeof hash === "string")
      ? (value.defaults as Record<string, string>)
      : undefined;
  const previous = Array.isArray(value.previous)
    ? value.previous
        .slice(0, PREVIOUS)
        .map((each: unknown) =>
          isRecord(each) ? readKept({ ...each, previous: undefined }) : undefined,
        )
        .filter((each) => each !== undefined)
    : [];
  const readme =
    isRecord(value.readme) && typeof value.readme.text === "string"
      ? {
          text: value.readme.text.slice(0, README_BYTES),
          ...(value.readme.cut === true && { cut: true }),
        }
      : undefined;
  return {
    files: Object.fromEntries(files) as Record<string, string>,
    source,
    installedAt: value.installedAt,
    ...(readme && { readme }),
    ...(typeof value.toolset === "string" && { toolset: value.toolset }),
    ...(defaults && { defaults }),
    ...(previous.length > 0 && { previous }),
  };
}

/**
 * A pack kept before, checked again as it is read: this version of the tools may differ. Words of a
 * pack installed with another version of the tools that replace defaults which changed since go.
 */
function checkKept(kept: KeptPack) {
  return checkPack(new Map(Object.entries(kept.files)), {
    mode: "load",
    ...(kept.defaults && kept.toolset !== TOOLSET_VERSION && { defaults: kept.defaults }),
  });
}

function installedOf(kept: KeptPack): InstalledPack | undefined {
  const check = checkKept(kept);
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
  readonly #options: ModelPacksOptions;
  #snapshot: ModelPacksSnapshot = {
    installed: [],
    packs: builtinPacks(),
    updates: new Map(),
    looking: new Set(),
  };
  /** Versions before an update, checked when a conversation asks for one, by id and hash. */
  readonly #before = new Map<string, ModelPack | null>();

  constructor(
    settings: SettingsStore,
    messages: ModelPacksMessages,
    options: ModelPacksOptions = {},
  ) {
    this.#settings = settings;
    this.#messages = messages;
    this.#options = options;
    this.#snapshot = { ...this.#snapshot, updates: this.#keptUpdates() };
  }

  /** What looking for updates found before a reload, as this window kept it. */
  #keptUpdates(): ReadonlyMap<string, PackUpdate> {
    try {
      const kept: unknown = JSON.parse(this.#options.memory?.read(UPDATES_KEY) ?? "{}");
      if (!isRecord(kept)) return new Map();
      return new Map(
        Object.entries(kept).flatMap(([id, value]): [string, PackUpdate][] => {
          if (!isRecord(value) || typeof value.at !== "number" || typeof value.commit !== "string")
            return [];
          const latest = value.latest;
          if (!isRecord(latest)) return [];
          if (latest.state === "update" && typeof latest.commit === "string") {
            const version = typeof latest.version === "string" ? latest.version : undefined;
            return [
              [
                id,
                {
                  at: value.at,
                  commit: value.commit,
                  latest: { state: "update", commit: latest.commit, ...(version && { version }) },
                } satisfies PackUpdate,
              ],
            ];
          }
          if (latest.state === "latest" || latest.state === "pinned") {
            return [[id, { at: value.at, commit: value.commit, latest: { state: latest.state } }]];
          }
          return [];
        }),
      );
    } catch {
      return new Map();
    }
  }

  /**
   * Looks for updates of the packs from GitHub, each at most every `UPDATE_EVERY` unless `force`,
   * one after the other: GitHub answers 60 times an hour without signing in. Installs nothing; an
   * update shows where packs are listed, for people to look at. `only` looks for one pack.
   */
  async lookForUpdates(options: { readonly force?: boolean; readonly only?: string } = {}) {
    const now = Date.now();
    const due = this.#snapshot.installed.filter(({ id, kept }) => {
      if (kept.source.kind !== "github") return false;
      if (options.only !== undefined && id !== options.only) return false;
      if (this.#snapshot.looking.has(id)) return false;
      const found = this.#snapshot.updates.get(id);
      return (
        options.force === true ||
        !found ||
        found.commit !== kept.source.commit ||
        found.latest.state === "failed" ||
        now - found.at > UPDATE_EVERY
      );
    });
    for (const { id, kept } of due) {
      if (kept.source.kind !== "github") continue;
      this.#snapshot = { ...this.#snapshot, looking: new Set([...this.#snapshot.looking, id]) };
      this.#emitter.emit();
      let latest: GitHubLatest;
      try {
        latest = await latestOf(kept.source, this.#options.fetcher);
      } catch {
        latest = { state: "failed", failure: "network" };
      }
      const updates = new Map(this.#snapshot.updates);
      updates.set(id, { at: Date.now(), commit: kept.source.commit, latest });
      const looking = new Set(this.#snapshot.looking);
      looking.delete(id);
      this.#snapshot = { ...this.#snapshot, updates, looking };
      this.#keepUpdates();
      this.#emitter.emit();
      // Too many questions: the rest wait.
      if (latest.state === "failed" && latest.failure === "rate") break;
    }
  }

  #keepUpdates(): void {
    const kept = Object.fromEntries(
      [...this.#snapshot.updates].filter(([, found]) => found.latest.state !== "failed"),
    );
    try {
      this.#options.memory?.write(UPDATES_KEY, JSON.stringify(kept));
    } catch {
      // Then the next reload asks again.
    }
  }

  /** The update found of an installed pack, where there is one for the version installed now. */
  updateOf(id: string): (GitHubLatest & { readonly state: "update" }) | undefined {
    const installed = this.installedOf(id);
    const found = this.#snapshot.updates.get(id);
    if (installed?.kept.source.kind !== "github" || !found) return undefined;
    if (found.commit !== installed.kept.source.commit) return undefined;
    return found.latest.state === "update" ? found.latest : undefined;
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
    this.#snapshot = { ...this.#snapshot, installed, packs: [...builtinPacks(), ...usable] };
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

  /**
   * A pack at the version a conversation began with, by id and hash: the one installed, one of the
   * versions kept from before an update, or one that comes with AnimaQuill. Nothing when that
   * version is not here any more.
   */
  versionOf(id: string, hash: string): ModelPack | undefined {
    const now = this.#snapshot.packs.find((pack) => pack.id === id);
    if (now?.hash === hash) return now;
    const installed = this.installedOf(id);
    for (const kept of installed?.kept.previous ?? []) {
      const key = `${id}\n${JSON.stringify(kept.files)}`;
      let pack = this.#before.get(key);
      if (pack === undefined) {
        pack = checkKept(kept).pack ?? null;
        this.#before.set(key, pack);
      }
      if (pack?.id === id && pack.hash === hash) return pack;
    }
    return undefined;
  }

  /** The pack for a model, with people's choice for it, see `choosePack`. */
  choose(model: string, chosen: string | undefined): PackChoice {
    return choosePack(model, this.#snapshot.packs, chosen);
  }

  /**
   * Puts a pack in, or a new version in place of the one with its id, once people saw it. It is
   * checked again here: only what passes is kept.
   */
  install(files: ReadonlyMap<string, string>, source: PackSource, readme?: PackReadme): PackCheck {
    const check = checkPack(files);
    const pack = check.pack;
    if (!pack) return check;
    const before = this.installedOf(pack.id);
    // Versions kept for conversations need no README.
    const { previous: older = [], readme: _readme, ...last } = before?.kept ?? {};
    const previous =
      before && before.pack?.hash !== pack.hash
        ? [last as KeptPack, ...older].slice(0, PREVIOUS)
        : older;
    const kept: KeptPack = {
      files: Object.fromEntries(files),
      source,
      // An update keeps its place among packs for the same models.
      installedAt: before?.kept.installedAt ?? Date.now(),
      toolset: TOOLSET_VERSION,
      defaults: defaultsOf(pack),
      ...(previous.length > 0 && { previous }),
      // From GitHub it is read again where it is, at the commit: the settings stay small.
      ...(readme && source.kind !== "github" && source.kind !== "discover" && { readme }),
    };
    const installed: InstalledPack = { id: pack.id, kept, pack, problems: [], dropped: [] };
    const others = this.#snapshot.installed.filter(({ id }) => id !== pack.id);
    // Just taken from GitHub: the newest there is, for now.
    const updates = new Map(this.#snapshot.updates);
    if (source.kind === "github") {
      const pinned = isCommit(gitHubPlace(source.url)?.ref ?? "");
      updates.set(pack.id, {
        at: Date.now(),
        commit: source.commit,
        latest: { state: pinned ? "pinned" : "latest" },
      });
    } else updates.delete(pack.id);
    this.#snapshot = { ...this.#snapshot, updates };
    this.#keepUpdates();
    this.#save([...others, installed].toSorted((a, b) => a.kept.installedAt - b.kept.installedAt));
    return check;
  }

  remove(id: string): void {
    this.#save(this.#snapshot.installed.filter((each) => each.id !== id));
  }
}

type Read = Map<string, string | Uint8Array | PackFileTooLarge>;

/** A file people picked, unless it is larger than a pack may have: then only its size. */
async function readPicked(path: string, file: File, into: Read): Promise<void> {
  if (file.size > MOST) into.set(path, { tooLarge: file.size });
  else asText(path, new Uint8Array(await file.arrayBuffer()), into);
}

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
  const read: Read = new Map();
  const manifest = byPath.get(MANIFEST);
  if (!manifest) return read;
  await readPicked(MANIFEST, manifest, read);
  const text = read.get(MANIFEST);
  if (typeof text !== "string") return read;
  for (const path of filesNamedIn(text).filter(isPackPath)) {
    const file = byPath.get(path);
    if (file) await readPicked(path, file, read);
  }
  return read;
}

/**
 * The README.md of a folder people picked, as much as shows, to read in the install dialog and in
 * the details of the pack; nothing where it has none. Its case does not matter, as on most
 * computers.
 */
export async function readFolderReadme(files: readonly File[]): Promise<PackReadme | undefined> {
  const file = files.find((each) => {
    const relative =
      (each as File & { webkitRelativePath?: string }).webkitRelativePath || each.name;
    const parts = relative.split("/");
    const path = parts.length > 1 ? parts.slice(1).join("/") : relative;
    return path.toLowerCase() === "readme.md";
  });
  if (!file) return undefined;
  const bytes = new Uint8Array(await file.slice(0, README_BYTES + 1).arrayBuffer());
  return readmeOf(bytes, false);
}

/** A pack that is one pack.json people picked. */
export async function readManifestFile(file: File): Promise<PackInput> {
  const read: Read = new Map();
  await readPicked(MANIFEST, file, read);
  return read;
}

/** Text of a pack that passed, to keep: every file it uses is text by then. */
export function textFiles(input: PackInput): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const [path, value] of input) if (typeof value === "string") files.set(path, value);
  return files;
}

/** All there is to say of a pack, for its page of details. */
export interface PackDetails {
  readonly id: string;
  /** Nothing when it does not pass any more: `problems` says why. */
  readonly pack: ModelPack | undefined;
  /** Where it came from: with AnimaQuill, or as people installed it. */
  readonly source: PackSource | "builtin";
  /** The version of the tools it was installed with; nothing for those that come with AnimaQuill. */
  readonly toolset?: string;
  /** How it calls models, its variants included, against the editor's defaults. */
  readonly call: readonly CallChange[];
  /** The words it changes, by group, in the order of the groups, with what they replace. */
  readonly words: readonly {
    readonly group: WordsGroup;
    readonly changes: readonly WordsChange[];
  }[];
  /** Why it is not used, where it is not. */
  readonly problems: readonly PackProblem[];
  /** What of it this version of the tools goes without, and why. */
  readonly dropped: readonly PackProblem[];
}

/** The groups of words, in the order people read them. */
export const WORDS_GROUPS: readonly WordsGroup[] = ["system", "tools", "params", "ops", "examples"];

/** The details of a pack that comes with AnimaQuill, or of one installed here. */
export function detailsOf(pack: ModelPack | InstalledPack): PackDetails {
  const installed = "kept" in pack ? pack : undefined;
  const used = installed ? installed.pack : (pack as ModelPack);
  const changes = used ? wordsChanges(used) : [];
  return {
    id: installed?.id ?? (pack as ModelPack).id,
    pack: used,
    source: installed ? installed.kept.source : "builtin",
    ...(installed?.kept.toolset !== undefined && { toolset: installed.kept.toolset }),
    call: used ? callChanges(used) : [],
    words: WORDS_GROUPS.flatMap((group) => {
      const inGroup = changes.filter((change) => change.group === group);
      return inGroup.length > 0 ? [{ group, changes: inGroup }] : [];
    }),
    problems: installed?.problems ?? [],
    dropped: installed?.dropped ?? [],
  };
}
