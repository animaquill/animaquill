import { count, isObject, optional, text } from "./answers.ts";
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
 */

export interface BrowserCloudProjectsOptions {
  /** The address of a path of the platform's API, such as `/projects`. */
  readonly api: (path: string) => string;
  /** Headers the platform asks of requests that change something. */
  readonly changeHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
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

/** A project as the platform listed it, or undefined for what is none: it needs an id, a name and a time. */
export const projectSummaryOf = (value: unknown): CloudProjectSummary | undefined => {
  if (!isObject(value)) return undefined;
  const id = text(value.id);
  const name = text(value.name);
  const updatedAt = count(value.updatedAt);
  if (id === undefined || id === "" || name === undefined || updatedAt === undefined)
    return undefined;
  return {
    id,
    name,
    updatedAt,
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
  return {
    async list() {
      const response = await request(options.api("/projects"), { cache: "no-store" });
      if (response.status === 401) throw new CloudSignedOut("Nobody is signed in");
      if (!response.ok) throw new Error(`The platform answered ${response.status}`);
      const answer: unknown = await response.json();
      const projects = isObject(answer) ? answer.projects : undefined;
      return Array.isArray(projects)
        ? projects.flatMap((each) => projectSummaryOf(each) ?? [])
        : [];
    },
    async remove(project) {
      const response = await request(options.api(`/projects/${encodeURIComponent(project)}`), {
        method: "DELETE",
        cache: "no-store",
        headers: { ...options.changeHeaders },
      });
      if (response.ok) return "removed";
      const answer: unknown = await response.json().catch(() => undefined);
      const said = isObject(answer) ? answer.error : undefined;
      if (response.status === 401 || said === "signedOut")
        throw new CloudSignedOut("Nobody is signed in");
      // Only in the platform's own words: a gateway says 404 too, and so does a platform that takes
      // no projects away, where the project is still there.
      if (response.status === 404 && said === "notFound") return "missing";
      if (response.status === 409 && said === "hasRepository") return "hasRepository";
      throw new Error(`The platform answered ${response.status}`);
    },
  };
}
