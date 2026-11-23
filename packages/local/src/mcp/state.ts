import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { originOf } from "./origins.ts";

/**
 * What the relays of this user remember between runs: the site of the editor that connected last,
 * which an editor for a folder opens on, as nothing else says which site that is
 * (docs/design/online-offline.md of AnimaQuill Cloud, 5.5).
 */

export const STATE_FILE = "mcp-state.json";

/** The origin of the editor that connected last, where one did. */
export async function lastOrigin(home: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(join(home, STATE_FILE), "utf8")) as {
      lastOrigin?: unknown;
    };
    const origin = typeof value.lastOrigin === "string" ? value.lastOrigin : undefined;
    return origin !== undefined && originOf(origin) === origin ? origin : undefined;
  } catch {
    return undefined;
  }
}

/** Notes the origin of an editor that connected now. */
export async function rememberOrigin(home: string, origin: string): Promise<void> {
  if ((await lastOrigin(home)) === origin) return;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, STATE_FILE);
  const part = `${path}.${process.pid}.tmp`;
  await writeFile(part, `${JSON.stringify({ lastOrigin: origin }, null, 2)}\n`, { mode: 0o600 });
  await rename(part, path);
}
