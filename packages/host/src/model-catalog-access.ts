import { REQUEST_TIMEOUT_MS, withinTime } from "./answers.ts";
import { CloudSignedOut } from "./index.ts";
import { readModelCatalog, type ModelCatalog } from "./model-catalog.ts";

/**
 * The open catalog of models as a platform keeps it for the browser (`CloudAccess.modelCatalog`):
 * `GET <api>/ai/model-catalog`, `{fetchedAt, entries}`. Only for people signed in.
 */
export function browserModelCatalogAccess(options: {
  readonly api: (path: string) => string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): () => Promise<ModelCatalog> {
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  return () =>
    withinTime(options.timeoutMs ?? REQUEST_TIMEOUT_MS, async (signal) => {
      const response = await request(options.api("/ai/model-catalog"), { signal });
      if (response.status === 401) throw new CloudSignedOut("Nobody is signed in");
      if (!response.ok) throw new Error(`The platform answered ${response.status}`);
      const catalog = readModelCatalog(await response.json());
      if (!catalog) throw new Error("The platform answered something that cannot be read");
      return catalog;
    });
}
