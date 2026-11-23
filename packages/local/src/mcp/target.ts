import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { diskWriter } from "@animaquill/core/disk-folder";
import { MANIFEST_FILE } from "@animaquill/schema";
import { findProject } from "./find.ts";
import { originOf } from "./origins.ts";
import type { Target } from "./relay.ts";

/**
 * What a session of `animaquill mcp` works on (docs/design/online-offline.md of AnimaQuill Cloud,
 * 5.5): the project of the folder it starts in, or that `--project` names, which the page whose
 * folder has the file of a probe is the editor of: copies of a folder have the same id, and not the
 * file. An online project by its address with `--project <address>`. Otherwise whatever project was
 * in front last, and that one from then on.
 */

/** Where the file of a probe goes, in the folder of the project: `.animaquill` is the editor's. */
export const PROBE_FOLDER = ".animaquill/mcp";

export type Found =
  | { readonly kind: "target"; readonly target: Target; readonly cleanup: () => Promise<void> }
  /** Something was named that is no project: every call says so. */
  | { readonly kind: "none"; readonly reason: string };

/** The project of an address of the editor, such as https://editor.example/p/<id>. */
export function linkTarget(address: string): Target | undefined {
  const origin = originOf(address);
  if (!origin) return undefined;
  const { pathname } = new URL(address);
  const match = /^\/p\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return undefined;
  let project: string;
  try {
    project = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return { kind: "link", origin, project };
}

export async function findTarget(
  given: string | undefined,
  session: string,
  start?: string,
  workingIn?: string,
): Promise<Found> {
  if (given !== undefined && /^https?:\/\//i.test(given)) {
    const target = linkTarget(given);
    if (target) return { kind: "target", target, cleanup: async () => {} };
    return {
      kind: "none",
      reason: `error no-project: --project ${JSON.stringify(given)} is no address of a project of the AnimaQuill editor, which looks like https://<editor>/p/<project>.`,
    };
  }
  const place = await findProject(given, start, workingIn);
  if (place.kind === "none") {
    // Nothing named and no folder found: the project in front.
    if (given === undefined && place.home !== true) {
      return { kind: "target", target: { kind: "front" }, cleanup: async () => {} };
    }
    return { kind: "none", reason: place.reason };
  }
  const { root } = place;
  let id: string;
  try {
    const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), "utf8")) as {
      id?: unknown;
    };
    if (typeof manifest.id !== "string" || manifest.id === "") throw new Error("no id");
    id = manifest.id;
  } catch {
    return {
      kind: "none",
      reason: `error no-project: ${join(root, MANIFEST_FILE)} could not be read as the manifest of an AnimaQuill project, so the project in ${root} cannot be found in the editor.`,
    };
  }
  await tidyProbes(root);
  const nonce = randomBytes(24).toString("base64url");
  const path = `${PROBE_FOLDER}/probe-${session}.json`;
  try {
    const writer = await diskWriter(root);
    await writer.write(path, JSON.stringify({ format: 1, nonce }));
    return {
      kind: "target",
      target: { kind: "folder", id, root, probe: { path, nonce } },
      cleanup: () => writer.remove(path).catch(() => {}),
    };
  } catch (error) {
    return {
      kind: "none",
      reason: `error no-project: a file that tells the editor which folder this is could not be written into ${root}: ${(error as Error).message}.`,
    };
  }
}

/** How long the file of a probe of a session that ended without taking it away stays. */
const PROBE_LEFT_MS = 24 * 60 * 60 * 1000;

/**
 * Takes away files of probes that sessions which stopped short left, a day on: only those, and only
 * where `.animaquill/mcp` is a folder of the project and no link.
 */
async function tidyProbes(root: string, now = Date.now()): Promise<void> {
  try {
    const top = await lstat(join(root, ".animaquill"));
    const folder = join(root, PROBE_FOLDER);
    const inside = await lstat(folder);
    if (!top.isDirectory() || !inside.isDirectory()) return;
    for (const name of await readdir(folder)) {
      if (!/^probe-[A-Za-z0-9_-]+\.json$/.test(name)) continue;
      const file = join(folder, name);
      const seen = await lstat(file);
      if (seen.isFile() && now - seen.mtimeMs > PROBE_LEFT_MS) await unlink(file).catch(() => {});
    }
  } catch {
    // Nothing there to tidy.
  }
}
