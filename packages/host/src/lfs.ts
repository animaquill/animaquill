import { CHANGE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, withinTime } from "./answers.ts";
import {
  CloudOtherAccount,
  CloudSignedOut,
  LfsRefused,
  type LfsAccess,
  type LfsAccount,
  type LfsAccountAccess,
  type LfsObjectState,
  type LfsRefusal,
  type LfsRepositoryUse,
  type LfsUpload,
  type LfsUploadState,
} from "./index.ts";

/**
 * Sending files into the large file storage of a project's repository through a platform's HTTP
 * API, as a browser reaches it: the host of a site gives where the API is, and the headers it asks
 * of requests that change something. The platform answers JSON, the upload as it is (see
 * `LfsUpload`), and `{ error: <code> }` for what it refuses, see `LfsRefused`.
 *
 * - `POST   <api>/projects/<project>/lfs/objects` with `{ oid, size }`
 * - `PUT    <api>/lfs/uploads/<upload>` with a piece of the file, from `Upload-Offset`
 * - `GET    <api>/lfs/uploads/<upload>`
 * - `DELETE <api>/lfs/uploads/<upload>`
 * - `POST   <api>/projects/<project>/lfs/lookup` with `{ objects: [{ oid, size }] }`
 * - `GET    <api>/projects/<project>/lfs/objects/<oid>?size=<size>`, with `Range`: a piece of it
 *
 * What comes back is read field by field: a platform of another version can say more, or less.
 * Everything that is not the upload asked for rejects with `LfsRefused`, each with a code that says
 * whether asking again can help: also what no platform says itself, such as a 403 of something in
 * front of it ("forbidden"), or an answer that is no upload at all ("malformed").
 */

export interface BrowserLfsOptions {
  /** The address of a path of the platform's API, such as `/lfs/uploads/<id>`. */
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
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const optional = <K extends string, T>(key: K, value: T | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: T };

const STATES: ReadonlySet<string> = new Set<LfsUploadState>([
  "present",
  "receiving",
  "received",
  "pushing",
  "done",
  "failed",
  "expired",
]);

/**
 * An upload as the platform said it. Where it is not one at all, rejects with `LfsRefused`
 * "malformed": an answer nobody can go on with, however often it is asked for.
 */
export const uploadOf = (value: unknown): LfsUpload => {
  if (!isObject(value)) throw new LfsRefused("malformed");
  const state = text(value.state);
  const repo = text(value.repo);
  const oid = text(value.oid);
  const size = count(value.size);
  const id = text(value.id);
  if (state === undefined || !STATES.has(state) || repo === undefined || oid === undefined)
    throw new LfsRefused("malformed");
  if (size === undefined || (state !== "present" && id === undefined))
    throw new LfsRefused("malformed");
  return {
    ...optional("id", id),
    state: state as LfsUploadState,
    repo,
    oid,
    size,
    received: Math.min(count(value.received) ?? 0, size),
    chunk: count(value.chunk) ?? 0,
    minChunk: count(value.minChunk) ?? 0,
    ...optional("error", text(value.error)),
    ...optional("detail", text(value.detail)),
  };
};

/** The codes a platform says, see `LfsRefusal`. */
const CODES: ReadonlySet<string> = new Set<LfsRefusal>([
  "tooLarge",
  "busy",
  "notLinked",
  "gone",
  "githubQuota",
  "offset",
  "slow",
  "forbidden",
  "notFound",
  "invalid",
  "missing",
  "changed",
  "unavailable",
]);

/**
 * The code of a refusal: what the platform said where it is one of ours, and otherwise what the
 * status says, as from a gateway or an older platform. Only what may go well the next time is
 * "unavailable": a 403 is "forbidden" whoever says it, and a 408 a piece that took too long.
 */
const codeOf = (status: number, said: unknown): LfsRefusal => {
  if (typeof said === "string" && CODES.has(said)) return said as LfsRefusal;
  if (status === 403) return "forbidden";
  if (status === 408) return "slow";
  if (status === 413) return "tooLarge";
  if (status === 429) return "busy";
  if (status === 404) return "notFound";
  if (status === 410) return "missing";
  if (status === 400 || status === 415 || status === 422) return "invalid";
  return "unavailable";
};

export function browserLfs(options: BrowserLfsOptions): LfsAccess {
  const request = options.fetch ?? ((input, init) => fetch(input, init));

  const call = async (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    send: { readonly json?: unknown; readonly piece?: Blob; readonly offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(options.api(path), {
        method,
        cache: "no-store",
        ...(method === "DELETE" && { headers: { ...options.changeHeaders } }),
        ...((method === "POST" || method === "PUT") && {
          headers: {
            ...options.changeHeaders,
            ...(send.piece
              ? {
                  "content-type": "application/octet-stream",
                  "upload-offset": String(send.offset ?? 0),
                }
              : { "content-type": "application/json" }),
          },
          body: send.piece ?? JSON.stringify(send.json ?? {}),
        }),
        ...(signal && { signal }),
      });
    } catch (error) {
      // Given up on purpose is not the platform's doing.
      if (signal?.aborted) throw error;
      // No answer at all: the network, or the platform not there now.
      throw new LfsRefused("unavailable");
    }
    if (response.status === 204) return undefined;
    const json: unknown = await response.json().catch(() => undefined);
    if (response.ok) return json;
    const answer = isObject(json) ? json : {};
    if (response.status === 401 || answer.error === "signedOut")
      throw new CloudSignedOut("Nobody is signed in");
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new LfsRefused(codeOf(response.status, answer.error), {
      ...optional("received", count(answer.received)),
      ...optional(
        "retryAfter",
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      ),
      ...optional("detail", text(answer.detail)),
    });
  };

  const uploadPath = (upload: string) => `/lfs/uploads/${encodeURIComponent(upload)}`;

  return {
    async begin(project, file) {
      return uploadOf(
        await call("POST", `/projects/${encodeURIComponent(project)}/lfs/objects`, {
          json: { oid: file.oid, size: file.size },
        }),
      );
    },
    async send(upload, offset, piece, { signal } = {}) {
      return uploadOf(await call("PUT", uploadPath(upload), { piece, offset }, signal));
    },
    async state(upload) {
      return uploadOf(await call("GET", uploadPath(upload)));
    },
    async cancel(upload) {
      await call("DELETE", uploadPath(upload));
    },
    async lookup(project, objects, { signal } = {}) {
      const answer = await call(
        "POST",
        `/projects/${encodeURIComponent(project)}/lfs/lookup`,
        { json: { objects: objects.map(({ oid, size }) => ({ oid, size })) } },
        signal,
      );
      const said = isObject(answer) && Array.isArray(answer.objects) ? answer.objects : undefined;
      if (!said || said.length !== objects.length) throw new LfsRefused("malformed");
      return said.map(objectStateOf);
    },
    async piece(project, { oid, size }, start, end, { signal, onBytes } = {}) {
      const path = `/projects/${encodeURIComponent(project)}/lfs/objects/${encodeURIComponent(oid)}?size=${size}`;
      let response: Response;
      try {
        response = await request(options.api(path), {
          method: "GET",
          cache: "no-store",
          headers: { ...options.changeHeaders, range: `bytes=${start}-${end}` },
          ...(signal && { signal }),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new LfsRefused("unavailable");
      }
      if (response.status !== 206) {
        const json: unknown = await response.json().catch(() => undefined);
        const said = isObject(json) ? json : {};
        if (response.status === 401 || said.error === "signedOut")
          throw new CloudSignedOut("Nobody is signed in");
        const retryAfter = Number(response.headers.get("retry-after"));
        throw new LfsRefused(response.ok ? "malformed" : codeOf(response.status, said.error), {
          ...optional(
            "retryAfter",
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
          ),
          ...optional("detail", text(said.detail)),
        });
      }
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
      if (!range || Number(range[1]) !== start || Number(range[3]) !== size || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new LfsRefused("malformed");
      }
      const length = Number(range[2]) - start + 1;
      const parts: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const read = await reader.read();
          if (read.done) break;
          parts.push(read.value);
          bytes += read.value.byteLength;
          onBytes?.(bytes);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        // What came before the connection went is kept: the next piece goes on from there.
        if (bytes === 0) throw new LfsRefused("unavailable");
      } finally {
        reader.releaseLock();
      }
      if (bytes > length) throw new LfsRefused("malformed");
      return { start, bytes: new Blob(parts as BlobPart[]) };
    },
  };
}

/** What the platform said of an object it was looked up for. */
const objectStateOf = (value: unknown): LfsObjectState => {
  if (!isObject(value)) return { state: "unavailable" };
  const state = text(value.state);
  if (state === "uploading") {
    const received = count(value.received);
    const size = count(value.size);
    return received !== undefined && size !== undefined
      ? { state, received: Math.min(received, size), size }
      : { state: "unavailable" };
  }
  return state === "ready" || state === "missing" || state === "changed"
    ? { state }
    : { state: "unavailable" };
};

const repositoryOf = (value: unknown): LfsRepositoryUse | undefined => {
  if (!isObject(value) || !isObject(value.project)) return undefined;
  const repo = count(value.repo);
  const fullName = text(value.fullName);
  const url = text(value.url);
  const id = text(value.project.id);
  const name = text(value.project.name);
  const files = count(value.files);
  const bytes = count(value.bytes);
  if (
    repo === undefined ||
    fullName === undefined ||
    url === undefined ||
    !url.startsWith("https://") ||
    id === undefined ||
    name === undefined ||
    files === undefined ||
    bytes === undefined
  )
    return undefined;
  return { repo, fullName, url, project: { id, name }, files, bytes };
};

/** What the platform said, or undefined where it is not that. Repositories it cannot read are left out. */
export const lfsAccountOf = (value: unknown): LfsAccount | undefined => {
  if (!isObject(value)) return undefined;
  const account = text(value.account);
  if (account === undefined || !Array.isArray(value.auto) || !Array.isArray(value.repositories))
    return undefined;
  const acknowledgedAt = count(value.acknowledgedAt);
  return {
    account,
    ...optional("acknowledgedAt", acknowledgedAt),
    auto: value.auto.filter((id): id is string => typeof id === "string"),
    repositories: value.repositories.flatMap((each) => repositoryOf(each) ?? []),
  };
};

/**
 * What people have in the large file storage through a platform, over its HTTP API, see
 * `LfsAccountAccess`:
 *
 * - `GET <api>/me/lfs`: `{account, acknowledgedAt?, auto, repositories}`.
 * - `POST <api>/me/lfs` `{account, acknowledged?: true, auto?: {project, on}}`: the same.
 */
export function browserLfsAccount(options: BrowserLfsOptions): LfsAccountAccess {
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const ask = async (init: RequestInit, signal: AbortSignal): Promise<LfsAccount> => {
    const response = await request(options.api("/me/lfs"), { cache: "no-store", ...init, signal });
    const answer: unknown = await response.json().catch(() => undefined);
    const said = isObject(answer) ? answer.error : undefined;
    if (response.status === 401 || said === "signedOut")
      throw new CloudSignedOut("Nobody is signed in");
    if (response.status === 409 && said === "otherAccount")
      throw new CloudOtherAccount("Somebody else is signed in");
    if (!response.ok) throw new Error(`The platform answered ${response.status}`);
    const found = lfsAccountOf(answer);
    if (!found) throw new Error("The platform answered something that cannot be read");
    return found;
  };
  return {
    read: () => withinTime(REQUEST_TIMEOUT_MS, (signal) => ask({}, signal)),
    change: (account, changes) =>
      withinTime(CHANGE_TIMEOUT_MS, (signal) =>
        ask(
          {
            method: "POST",
            headers: { ...options.changeHeaders, "content-type": "application/json" },
            body: JSON.stringify({ account, ...changes }),
          },
          signal,
        ),
      ),
  };
}
