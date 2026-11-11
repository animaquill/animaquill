import type { RepositoryUnusable } from "./index.ts";

/**
 * Reading what a platform answered, field by field: a platform of another version can say more, or
 * less, and nothing it says is taken for what it should be before it was looked at.
 */

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const texts = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

/** A field that is only there where it has a value. */
export const optional = <K extends string, T>(key: K, value: T | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: T };

/** A project of the platform as an answer names it: its id there, and what it is called. */
export const projectOf = (
  value: unknown,
): { readonly id: string; readonly name: string } | undefined => {
  if (!isObject(value)) return undefined;
  const id = text(value.id);
  return id === undefined || id === "" ? undefined : { id, name: text(value.name) ?? "" };
};

/** What names a project of a platform, see `newSyncId` and "hello" of the sync protocol. */
export const isProjectId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** How long a platform has to answer a request that only reads, or takes something away. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** ...and one that makes something on GitHub, which the platform waits for in turn. */
export const CHANGE_TIMEOUT_MS = 65_000;

/** A platform did not answer in time. */
export class NoAnswer extends Error {
  override readonly name = "NoAnswer";
}

/**
 * What `ask` comes to, or a `NoAnswer` once it took longer than `ms`: a line that hangs must not
 * keep whoever asked waiting for good. `ask` gets a signal that aborts then, for the request to
 * stop too; whatever it does with it, this is over by then.
 */
export async function withinTime<T>(
  ms: number,
  ask: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new NoAnswer(`No answer within ${ms} ms`));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([ask(controller.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * That the repository of a project cannot be used, as the platform says it, see
 * `RepositoryUnusable`: undefined where it does not, or says it in a way that cannot be read.
 */
export const unusableOf = (value: unknown): RepositoryUnusable | undefined => {
  if (!isObject(value)) return undefined;
  const reason = text(value.reason);
  const since = count(value.since);
  const deleteAt = count(value.deleteAt);
  if (reason === undefined || since === undefined || deleteAt === undefined) return undefined;
  return { reason, since, deleteAt };
};
