import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { samePath, writePrivate } from "./data-dir.ts";
import type { BackendNote } from "./lock.ts";
import { isAlive } from "./postgres.ts";

/**
 * How the browser is opened with a token without the token in any command line, which others of
 * the computer can read (`ps`; Jupyter does it so): a page in the data folder that only its user
 * can read, `open-<random>.html`, which goes on to the address with the token at once
 * (`location.replace`, so that the page is not in the history either). The browser is given the
 * file. It goes once its token was taken or is too old, and at every start what is left of others.
 *
 * And what the command line takes from a backend before it hands anything to the system to open
 * (`checkedOpening`): the address of that backend with a token and nothing else, and its page in
 * the data folder as it writes them. A program in place of the backend, on its port after it was
 * killed, cannot have anything else opened (`file:`, another program).
 */

export const PAGE_NAME = /^open-[A-Za-z0-9_-]{22}\.html$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The page that goes on to `url`, which is only of the characters of an address with a token. */
export const pageFor = (url: string): string =>
  `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>AnimaQuill</title>
<script>location.replace(${JSON.stringify(url)});</script></head>
<body>正在打开 AnimaQuill…</body></html>
`;

export class OpenPages {
  readonly #dir: string;
  readonly #written = new Set<string>();

  constructor(dataDir: string) {
    this.#dir = dataDir;
  }

  /** Writes the page for `url`: its path. */
  async write(url: string): Promise<string> {
    const path = join(this.#dir, `open-${randomBytes(16).toString("base64url")}.html`);
    await writePrivate(path, pageFor(url));
    this.#written.add(path);
    return path;
  }

  async remove(path: string): Promise<void> {
    this.#written.delete(path);
    await rm(path, { force: true });
  }

  /** Takes away every page of the folder: those of this start, and what a start before left. */
  async removeAll(): Promise<void> {
    const names = await readdir(this.#dir).catch(() => [] as string[]);
    for (const name of names)
      if (PAGE_NAME.test(name)) await rm(join(this.#dir, name), { force: true });
    this.#written.clear();
  }
}

/** What the command line opens: the page where there is one, else the address. */
export interface Opening {
  readonly url: string;
  /** The page in the data folder, as a `file:` address. */
  readonly page?: string;
}

/**
 * What `POST /api/local/admin/open` of the backend of `backend.json` answered, once it is sure to
 * be of that backend: its process alive, the address exactly its own with a token, and the page,
 * where there is one, a file of the data folder (not a link) with just that address in it.
 * Undefined for anything else, which is never opened.
 */
export async function checkedOpening(
  backend: BackendNote,
  body: unknown,
  dataDir: string,
): Promise<Opening | undefined> {
  if (!Number.isInteger(backend.pid) || !isAlive(backend.pid)) return undefined;
  const origin = `http://animaquill.localhost:${backend.port}`;
  if (backend.origin !== origin) return undefined;
  const { url, page } = (body ?? {}) as { url?: unknown; page?: unknown };
  if (typeof url !== "string" || !url.startsWith(`${origin}/#aq-token=`)) return undefined;
  if (!TOKEN.test(url.slice(`${origin}/#aq-token=`.length))) return undefined;
  if (page === undefined) return { url };
  if (typeof page !== "string") return undefined;
  const path = resolve(page);
  if (!samePath(dirname(path), dataDir) || !PAGE_NAME.test(basename(path))) return undefined;
  const found = await lstat(path).catch(() => undefined);
  if (!found?.isFile() || (process.getuid && found.uid !== process.getuid())) return undefined;
  if ((await readFile(path, "utf8").catch(() => "")) !== pageFor(url)) return undefined;
  return { url, page: pathToFileURL(path).href };
}
