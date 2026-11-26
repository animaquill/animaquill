import type { FastifyInstance } from "fastify";
import {
  MODEL_CATALOG_MAX_AGE_MS,
  MODELS_DEV_URL,
  flattenModelsDev,
  type ModelCatalog,
} from "@animaquill/host/model-catalog";
import type { Accounts } from "../auth/accounts.ts";
import { Limits } from "../auth/limits.ts";
import { signedInWith } from "../auth/signed-in.ts";
import type { SessionCredentials } from "../auth/credentials.ts";

/**
 * The open catalog of models (models.dev) for editors whose browser cannot read it themselves:
 * taken at most once an hour for everyone, flattened as the editor keeps it, and given to people
 * signed in.
 *
 * - `GET /api/ai/model-catalog`: `{fetchedAt, entries}`, see `ModelCatalog`. 401 `signedOut`, 429
 *   `busy`, 503 `unavailable` where none could be taken and none is kept.
 *
 * The request to models.dev says nothing of anyone: no cookie, no name of who asked, only that it
 * is the platform. What is kept is public, and the same for everyone.
 */

/** How long models.dev has to answer, and how much it can answer at most. */
const FETCH_TIMEOUT_MS = 30_000;
const MOST_BYTES = 8 * 1024 * 1024;
/** After a failure, how long before models.dev is asked again. */
const RETRY_MS = 60_000;

/** The body of an answer as text, read as it comes and given up on beyond `most` bytes. */
async function readAtMost(response: Response, most: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > most) {
      await reader.cancel();
      throw new Error("too large");
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export class ModelCatalogCache {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #kept: ModelCatalog | undefined;
  #taking: Promise<ModelCatalog | undefined> | undefined;
  #failedAt: number | undefined;

  constructor(options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  /**
   * The catalog: what is kept while it is younger than an hour; else taken again, one request for
   * all who ask meanwhile. Where that fails, what is kept, however old; undefined with none.
   */
  async get(): Promise<ModelCatalog | undefined> {
    const now = this.#now();
    const kept = this.#kept;
    if (kept && now - kept.fetchedAt < MODEL_CATALOG_MAX_AGE_MS) return kept;
    if (this.#failedAt !== undefined && now - this.#failedAt < RETRY_MS) return kept;
    this.#taking ??= this.#take().finally(() => {
      this.#taking = undefined;
    });
    return this.#taking;
  }

  async #take(): Promise<ModelCatalog | undefined> {
    try {
      const response = await this.#fetch(MODELS_DEV_URL, {
        headers: { accept: "application/json", "user-agent": "AnimaQuill-Platform/1" },
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MOST_BYTES) throw new Error("too large");
      const entries = flattenModelsDev(JSON.parse(await readAtMost(response, MOST_BYTES)));
      if (entries.length === 0) throw new Error("no models");
      this.#kept = { fetchedAt: this.#now(), entries };
      this.#failedAt = undefined;
      return this.#kept;
    } catch {
      this.#failedAt = this.#now();
      return this.#kept;
    }
  }
}

export interface CatalogRoutesOptions {
  readonly accounts: () => Accounts | undefined;
  /** How the browser shows its session, see auth/credentials.ts. */
  readonly credentials: SessionCredentials;
  readonly catalog: ModelCatalogCache;
  readonly now?: (() => number) | undefined;
}

const TEN_MINUTES = 10 * 60_000;

export const catalogRoutes = async (app: FastifyInstance, options: CatalogRoutesOptions) => {
  // Once an hour of each device is all the editor asks; this leaves room and stops a loop.
  const limits = new Limits(
    { perClient: 60, perOwn: 30, ceiling: 3000 },
    TEN_MINUTES,
    options.now ?? Date.now,
  );
  const signedIn = signedInWith(options.credentials, options.accounts, () => true);
  app.get(
    "/api/ai/model-catalog",
    { config: { access: { none: "the open catalog of models, the same for everyone" } } },
    async (request, reply) => {
      const user = await signedIn(request, reply, limits);
      if (!user) return reply;
      const catalog = await options.catalog.get();
      if (!catalog) return reply.code(503).send({ error: "unavailable" });
      reply.header("cache-control", "private, max-age=600");
      return catalog;
    },
  );
};
