import {
  CloudSignedOut,
  RepositoryRefused,
  type RepositoryAccess,
  type RepositoryChoice,
  type RepositoryList,
  type RepositoryRefusal,
  type RepositoryStatus,
} from "./index.ts";

/**
 * Saving projects to repositories through a platform's HTTP API, as a browser reaches it: the host
 * of a site gives where the API is, and the headers it asks of requests that change something. The
 * platform answers JSON, and `{ error: <code> }` for what it refuses, see `RepositoryRefused`.
 *
 * - `GET  <api>/github/repositories?page=`
 * - `POST <api>/projects/<project>/repository` with a `RepositoryLink`
 * - `GET  <api>/projects/<project>/repository`
 * - `POST <api>/projects/<project>/archive`, with `{ replace }` or nothing
 *
 * What comes back is read field by field: a platform of another version can say more, or less.
 */

export interface BrowserRepositoryOptions {
  /** The address of a path of the platform's API, such as `/github/repositories`. */
  readonly api: (path: string) => string;
  /** Headers the platform asks of requests that change something. */
  readonly changeHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const texts = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
const optional = <K extends string, T>(key: K, value: T | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: T };

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
  };
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

  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(options.api(path), {
        method,
        cache: "no-store",
        ...(method === "POST" && {
          headers: { ...options.changeHeaders, "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        }),
      });
    } catch {
      // No answer at all: the network, or the platform not there now.
      throw new RepositoryRefused("unavailable");
    }
    const json: unknown = await response.json().catch(() => undefined);
    if (response.ok) return json;
    const answer = isObject(json) ? json : {};
    if (response.status === 401 || answer.error === "signedOut")
      throw new CloudSignedOut("Nobody is signed in");
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new RepositoryRefused(codeOf(response.status, answer.error), {
      ...optional("files", texts(answer.files)),
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
    async link(project, choice) {
      return statusOf(await call("POST", projectPath(project, "repository"), choice));
    },
    async status(project) {
      return statusOf(await call("GET", projectPath(project, "repository")));
    },
    async archiveNow(project, archive = {}) {
      return statusOf(
        await call(
          "POST",
          projectPath(project, "archive"),
          archive.replace === undefined ? {} : { replace: archive.replace },
        ),
      );
    },
  };
}
