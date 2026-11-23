import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_NAMES } from "@animaquill/web/sites";

/**
 * Which pages may take the calls of AI tools on this computer (docs/design/online-offline.md of
 * AnimaQuill Cloud, 5.2): the editor of `npx animaquill`, and editors people add, with
 * `--allow-origin` or `animaquill mcp allow-origin <address>`, which keeps it in `mcp.json`. The
 * browser sends `Origin` and no page can make it say another. Only the editor itself: scenes run on
 * sites of their own next to it (`animaquill-scene-0.localhost`), and their code is the project's.
 */

export const CONFIG_FILE = "mcp.json";

/** The origin of an address, or undefined for one that is no http(s) site. */
export function originOf(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return url.origin;
}

/** The editor of `npx animaquill`, at whatever port it was started on. */
function isLocalEditor(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === "http:" && url.hostname === LOCAL_NAMES.editor;
}

export interface AllowedOrigins {
  has(origin: string | undefined): boolean;
  /** What people added, as given. */
  readonly added: readonly string[];
}

/** What `mcp.json` says, where it says anything that can be read. */
async function readConfig(home: string): Promise<{ allowOrigins: string[] }> {
  try {
    const value = JSON.parse(await readFile(join(home, CONFIG_FILE), "utf8")) as unknown;
    const list = (value as { allowOrigins?: unknown }).allowOrigins;
    return {
      allowOrigins: Array.isArray(list) ? list.filter((each) => typeof each === "string") : [],
    };
  } catch {
    return { allowOrigins: [] };
  }
}

export async function allowedOrigins(
  home: string,
  given: readonly string[] = [],
): Promise<AllowedOrigins> {
  const { allowOrigins } = await readConfig(home);
  const added = [...new Set([...given, ...allowOrigins].flatMap((each) => originOf(each) ?? []))];
  const set = new Set(added);
  return {
    added,
    has: (origin) => {
      if (origin === undefined || originOf(origin) !== origin) return false;
      return set.has(origin) || isLocalEditor(origin);
    },
  };
}

/** Keeps an origin in `mcp.json`, for every `animaquill mcp` of this user from now on. */
export async function allowOrigin(home: string, address: string): Promise<string> {
  const origin = originOf(address);
  if (!origin) throw new Error(`${address} is no address of a site (https://… or http://…).`);
  const config = await readConfig(home);
  if (!config.allowOrigins.includes(origin)) config.allowOrigins.push(origin);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, CONFIG_FILE);
  await writeFile(`${path}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  return origin;
}
