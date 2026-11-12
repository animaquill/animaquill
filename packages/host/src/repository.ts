import {
  CHANGE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  copyProblemOf,
  count,
  isObject,
  optional,
  projectOf,
  text,
  texts,
  unusableOf,
  withinTime,
} from "./answers.ts";
import {
  CloudSignedOut,
  RepositoryRefused,
  type RepositoryAccess,
  type RepositoryCheck,
  type RepositoryChoice,
  type RepositoryList,
  type RepositoryRefusal,
  type RepositoryRestored,
  type RepositoryStatus,
} from "./index.ts";

/**
 * Saving projects to repositories through a platform's HTTP API, as a browser reaches it: the host
 * of a site gives where the API is, and the headers it asks of requests that change something. The
 * platform answers JSON, and `{ error: <code> }` for what it refuses, see `RepositoryRefused`.
 *
 * - `GET  <api>/github/repositories?page=`
 * - `POST <api>/github/repositories/check` with a `RepositoryLink`: always answers 200 where it
 *   could look, with a `RepositoryCheck`
 * - `POST <api>/projects/<project>/repository` with a `RepositoryLink`
 * - `GET  <api>/projects/<project>/repository`
 * - `POST <api>/projects/<project>/archive`, with `{ replace }` or nothing
 * - `POST <api>/projects/restore` with `{ existing: { id }, confirmPublic? }`: 201 or 202 with
 *   `{ project: { id, name }, copy }`
 *
 * What comes back is read field by field: a platform of another version can say more, or less.
 * A platform that does not answer for a while is "unavailable", like one that is not there: what
 * was asked for may have happened all the same, which asking again finds out.
 */

export interface BrowserRepositoryOptions {
  /** The address of a path of the platform's API, such as `/github/repositories`. */
  readonly api: (path: string) => string;
  /** Headers the platform asks of requests that change something. */
  readonly changeHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  /** How long the platform has to answer what only looks, see `REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** ...and what links a repository or archives, see `CHANGE_TIMEOUT_MS`. */
  readonly changeTimeoutMs?: number;
}

const choiceOf = (value: unknown): RepositoryChoice | undefined => {
  if (!isObject(value)) return undefined;
  const id = count(value.id);
  const owner = text(value.owner);
  const name = text(value.name);
  if (id === undefined || owner === undefined || name === undefined) return undefined;
  return {
    id,
    owner,
    name,
    fullName: text(value.fullName) ?? `${owner}/${name}`,
    private: value.private === true,
    pushable: value.pushable === true,
    empty: value.empty === true,
    archived: value.archived === true,
    linked: value.linked === true,
    ...optional("linkedProject", projectOf(value.linkedProject)),
  };
};

/**
 * What a check came to, as the platform said it. Only `ok: true` is a yes: an answer that is not
 * one says nothing either way, which is no reason to keep people from trying.
 */
export const checkOf = (value: unknown): RepositoryCheck | undefined => {
  if (!isObject(value)) return undefined;
  if (value.ok === true) return { ok: true };
  const reason = text(value.reason);
  if (value.ok !== false || reason === undefined) return undefined;
  return {
    ok: false,
    reason,
    ...optional("files", texts(value.files)),
    ...optional("project", projectOf(value.project)),
  };
};

const divergedOf = (value: unknown): RepositoryStatus["diverged"] => {
  if (!isObject(value)) return undefined;
  const sha = text(value.sha);
  if (sha === undefined) return undefined;
  const files = texts(value.files) ?? [];
  // Only what is among the files: an older platform says nothing about it.
  const deleted = (texts(value.deleted) ?? []).filter((path) => files.includes(path));
  return { sha, files, deleted };
};

/** How a repository is gone, only where the platform can tell, and in the words the editor knows. */
const goneOf = (value: unknown): RepositoryStatus["gone"] =>
  value === "deleted" || value === "unauthorized" ? value : undefined;

/** A status as the platform said it. Throws where it is not one at all. */
export const statusOf = (value: unknown): RepositoryStatus => {
  if (!isObject(value)) throw new Error("The platform's answer is not a status");
  const state = value.state === "ready" || value.state === "paused" ? value.state : "none";
  const repository = isObject(value.repository) ? value.repository : undefined;
  const id = count(repository?.id);
  const owner = text(repository?.owner);
  const name = text(repository?.name);
  const last = isObject(value.lastArchive) ? value.lastArchive : undefined;
  const sha = text(last?.sha);
  return {
    ...(repository &&
      id !== undefined &&
      owner !== undefined &&
      name !== undefined && {
        repository: {
          id,
          owner,
          name,
          fullName: text(repository.fullName) ?? `${owner}/${name}`,
          private: repository.private === true,
          branch: text(repository.branch) ?? "main",
          url: text(repository.url) ?? "",
          createdHere: repository.createdHere === true,
          linkedAt: count(repository.linkedAt) ?? 0,
        },
      }),
    state,
    ...optional("reason", text(value.reason)),
    ...optional("gone", goneOf(value.gone)),
    ...optional("unusable", unusableOf(value.unusable)),
    ...optional("detail", text(value.detail)),
    archiving: value.archiving === true,
    ...(last &&
      sha !== undefined && {
        lastArchive: {
          sha,
          seq: count(last.seq) ?? 0,
          at: count(last.at) ?? 0,
          kind: text(last.kind) ?? "auto",
          changed: count(last.changed) ?? 0,
          removed: count(last.removed) ?? 0,
          url: text(last.url) ?? "",
        },
      }),
    ...optional("kept", texts(value.kept)),
    ...optional("dirtySince", count(value.dirtySince)),
    ...optional("nextAt", count(value.nextAt)),
    ...optional("retryAt", count(value.retryAt)),
    ...optional("failures", count(value.failures)),
    ...optional("diverged", divergedOf(value.diverged)),
    head: count(value.head) ?? 0,
    archivedSeq: count(value.archivedSeq) ?? 0,
    ...optional("copy", text(value.copy)),
    ...optional("generation", count(value.generation)),
    ...optional("copyProblem", copyProblemOf(value.copyProblem)),
    ...optional("rebuiltFrom", rebuiltFromOf(value.rebuiltFrom)),
  };
};

/** Where the copy before was, see `RepositoryStatus.rebuiltFrom`. */
const rebuiltFromOf = (value: unknown): RepositoryStatus["rebuiltFrom"] => {
  if (!isObject(value)) return undefined;
  const generation = count(value.generation);
  const archivedSeq = count(value.archivedSeq);
  if (generation === undefined || archivedSeq === undefined) return undefined;
  // Only a yes is one: what says nothing is nothing in common, which merges nothing by itself.
  return { generation, archivedSeq, commonBase: value.commonBase === true };
};

/** A project made from a repository, as the platform said it, or undefined for what is none. */
const restoredOf = (value: unknown): RepositoryRestored | undefined => {
  if (!isObject(value)) return undefined;
  const project = projectOf(value.project);
  if (!project) return undefined;
  return { project, copy: value.copy === "live" ? "live" : "restoring" };
};

/** The codes a platform says, see `RepositoryRefusal`. */
const CODES: ReadonlySet<string> = new Set<RepositoryRefusal>([
  "notInstalled",
  "nameTaken",
  "hasProject",
  "linkedElsewhere",
  "notPushable",
  "public",
  "notFound",
  "invalidName",
  "alreadyLinked",
  "notLinked",
  "diverged",
  "busy",
  "invalid",
  "unavailable",
  "noProject",
  "unreadable",
  "tooLarge",
  "tooNew",
  "quota",
]);

/**
 * The code of a refusal: what the platform said where it is one of ours, and otherwise what the
 * status says, as from a gateway or an older platform.
 */
const codeOf = (status: number, said: unknown): RepositoryRefusal => {
  if (typeof said === "string" && CODES.has(said)) return said as RepositoryRefusal;
  if (status === 429) return "busy";
  if (status === 400 || status === 413 || status === 415 || status === 422) return "invalid";
  return "unavailable";
};

export function browserRepository(options: BrowserRepositoryOptions): RepositoryAccess {
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const lookMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const changeMs = options.changeTimeoutMs ?? CHANGE_TIMEOUT_MS;

  const call = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = lookMs,
  ): Promise<unknown> => {
    let response: Response;
    let json: unknown;
    try {
      [response, json] = await withinTime(timeoutMs, async (signal) => {
        const answered = await request(options.api(path), {
          method,
          cache: "no-store",
          ...(method === "POST" && {
            headers: { ...options.changeHeaders, "content-type": "application/json" },
            body: JSON.stringify(body ?? {}),
          }),
          signal,
        });
        return [answered, await answered.json().catch(() => undefined)] as const;
      });
    } catch {
      // No answer at all: the network, the platform not there now, or a line that hangs.
      throw new RepositoryRefused("unavailable");
    }
    if (response.ok) return json;
    const answer = isObject(json) ? json : {};
    if (response.status === 401 || answer.error === "signedOut")
      throw new CloudSignedOut("Nobody is signed in");
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new RepositoryRefused(codeOf(response.status, answer.error), {
      ...optional("files", texts(answer.files)),
      ...optional("project", projectOf(answer.project)),
      ...optional("diverged", divergedOf(answer.diverged)),
      ...optional(
        "retryAfter",
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      ),
    });
  };

  const projectPath = (project: string, rest: string) =>
    `/projects/${encodeURIComponent(project)}/${rest}`;

  return {
    async list(page = 1): Promise<RepositoryList> {
      const answer = await call(
        "GET",
        `/github/repositories?page=${Math.max(1, Math.floor(page))}`,
      );
      const list = isObject(answer) ? answer : {};
      return {
        repositories: Array.isArray(list.repositories)
          ? list.repositories.flatMap((item) => choiceOf(item) ?? [])
          : [],
        page: count(list.page) ?? page,
        more: list.more === true,
        manageUrl: text(list.manageUrl) ?? "",
      };
    },
    async check(choice) {
      const said = checkOf(await call("POST", "/github/repositories/check", choice));
      // An answer that is no check at all, as from a gateway: the platform could not say.
      if (!said) throw new RepositoryRefused("unavailable");
      return said;
    },
    async link(project, choice) {
      return statusOf(await call("POST", projectPath(project, "repository"), choice, changeMs));
    },
    async status(project) {
      return statusOf(await call("GET", projectPath(project, "repository")));
    },
    async recheck(project) {
      return statusOf(await call("POST", projectPath(project, "repository/check"), {}, changeMs));
    },
    async restore(choice) {
      const said = restoredOf(await call("POST", "/projects/restore", choice, changeMs));
      // An answer that is no project, as from a gateway: the platform did not say it made one.
      if (!said) throw new RepositoryRefused("unavailable");
      return said;
    },
    async archiveNow(project, archive = {}) {
      return statusOf(
        await call(
          "POST",
          projectPath(project, "archive"),
          archive.replace === undefined ? {} : { replace: archive.replace },
          changeMs,
        ),
      );
    },
  };
}
