import {
  REQUEST_TIMEOUT_MS,
  count,
  isObject,
  isProjectId,
  optional,
  text,
  unusableOf,
  withinTime,
} from "./answers.ts";
import { CloudSignedOut, type CloudAccess, type CloudProjectSummary } from "./index.ts";

/**
 * The projects of a platform over its HTTP API, as a browser reaches it: the list people open one
 * from, and taking away one that has no repository. The host of a site gives where the API is, and
 * the headers it asks of requests that change something, as for `browserRepository`.
 *
 * - `GET    <api>/projects` answers `{ projects: [...] }`, each a `CloudProjectSummary`
 * - `DELETE <api>/projects/<project>` answers 204, or `{ error }` with 404 "notFound" or 409
 *   "hasRepository"
 *
 * What comes back is read field by field: a platform of another version can say more, or less.
 * But only what the platform said in these words counts as an answer: whether a project is still
 * there, and whether one is gone, is what people are told before they take away the last copy of
 * something. An answer that is no list is no empty list, and one that is not the 204 is no "gone";
 * neither is no answer for a while, see `timeoutMs`.
 */

export interface BrowserCloudProjectsOptions {
  /** The address of a path of the platform's API, such as `/projects`. */
  readonly api: (path: string) => string;
  /** Headers the platform asks of requests that change something. */
  readonly changeHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  /** How long the platform has to answer, see `REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

type Repository = NonNullable<CloudProjectSummary["repository"]>;

const repositoryOf = (value: unknown): Repository | undefined => {
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
    url: text(value.url) ?? "",
    state: value.state === "paused" ? "paused" : "ready",
    ...optional("reason", text(value.reason)),
    ...optional("checkedAt", count(value.checkedAt)),
    ...optional("unusable", unusableOf(value.unusable)),
  };
};

const sizeOf = (value: unknown): CloudProjectSummary["size"] => {
  if (!isObject(value)) return undefined;
  const documents = count(value.documents);
  if (documents === undefined) return undefined;
  const assets = isObject(value.assets) ? value.assets : undefined;
  const files = count(assets?.count);
  const bytes = count(assets?.bytes);
  return {
    documents,
    ...(files !== undefined &&
      bytes !== undefined && {
        assets: { count: files, bytes, elsewhere: count(assets?.elsewhere) ?? 0 },
      }),
  };
};

const archiveOf = (value: unknown): CloudProjectSummary["archive"] => {
  if (!isObject(value)) return undefined;
  return {
    ...optional("at", count(value.at)),
    seq: count(value.seq) ?? 0,
    behind: value.behind === true,
  };
};

/**
 * A project as the platform listed it, or undefined for what is none: it needs an id that names a
 * project of a platform, see `isProjectId`. One whose name or time cannot be read is there all the
 * same, without a name and at no time: that the platform has the project is what counts most.
 */
export const projectSummaryOf = (value: unknown): CloudProjectSummary | undefined => {
  if (!isObject(value) || !isProjectId(value.id)) return undefined;
  return {
    id: value.id,
    name: text(value.name) ?? "",
    updatedAt: count(value.updatedAt) ?? 0,
    ...optional("createdAt", count(value.createdAt)),
    ...optional("copy", text(value.copy)),
    ...optional("size", sizeOf(value.size)),
    ...optional("repository", repositoryOf(value.repository)),
    ...optional("archive", archiveOf(value.archive)),
    ...optional("attention", text(value.attention)),
  };
};

export function browserCloudProjects(
  options: BrowserCloudProjectsOptions,
): Pick<CloudAccess, "list"> & { readonly remove: NonNullable<CloudAccess["remove"]> } {
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    list: () =>
      withinTime(timeoutMs, async (signal) => {
        const response = await request(options.api("/projects"), { cache: "no-store", signal });
        if (response.status === 401) throw new CloudSignedOut("Nobody is signed in");
        if (!response.ok) throw new Error(`The platform answered ${response.status}`);
        const answer: unknown = await response.json();
        const projects = isObject(answer) ? answer.projects : undefined;
        // As from a gateway, or a page that asks people to sign in: not "no projects".
        if (!Array.isArray(projects)) throw new Error("The platform's answer is not a list");
        const listed = new Map<string, CloudProjectSummary>();
        for (const each of projects) {
          const project = projectSummaryOf(each);
          // Each once: the first, as the list is in the order people see it in.
          if (project && !listed.has(project.id)) listed.set(project.id, project);
        }
        return [...listed.values()];
      }),
    remove: (project) =>
      withinTime(timeoutMs, async (signal) => {
        const response = await request(options.api(`/projects/${encodeURIComponent(project)}`), {
          method: "DELETE",
          cache: "no-store",
          headers: { ...options.changeHeaders },
          signal,
        });
        // Only the platform's own yes: a gateway, or a page to sign in on, says 200 to anything.
        if (response.status === 204) return "removed";
        const answer: unknown = await response.json().catch(() => undefined);
        const said = isObject(answer) ? answer.error : undefined;
        if (response.status === 401 || said === "signedOut")
          throw new CloudSignedOut("Nobody is signed in");
        // Only in the platform's own words: a gateway says 404 too, and so does a platform that
        // takes no projects away, where the project is still there.
        if (response.status === 404 && said === "notFound") return "missing";
        if (response.status === 409 && said === "hasRepository") return "hasRepository";
        throw new Error(`The platform answered ${response.status}`);
      }),
  };
}
