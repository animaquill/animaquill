import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { MANIFEST_FILE } from "@animaquill/schema";
import type { ProjectPlace } from "./host.ts";

/** Whether a folder has animaquill.json at its top, as a file of its own and no link. */
async function hasManifest(folder: string): Promise<boolean> {
  try {
    return (await lstat(resolve(folder, MANIFEST_FILE))).isFile();
  } catch {
    return false;
  }
}

/** The nearest folder from `start` up that has animaquill.json. */
async function above(start: string): Promise<string | undefined> {
  let folder = resolve(start);
  for (;;) {
    if (await hasManifest(folder)) return folder;
    const up = dirname(folder);
    if (up === folder) return undefined;
    folder = up;
  }
}

/**
 * Where the project is: the folder given with `--project` (or its animaquill.json), else the folder
 * the server started in or the nearest one above it with animaquill.json, else the same from the
 * folder that the AI tool says it works in. Codex starts servers in that folder; Claude Code starts
 * some elsewhere, such as servers of plugins or of the user's own scope, and says where it works in
 * `CLAUDE_PROJECT_DIR` (https://code.claude.com/docs/en/mcp).
 */
export async function findProject(
  given: string | undefined,
  start: string = process.cwd(),
  workingIn: string | undefined = process.env["CLAUDE_PROJECT_DIR"],
): Promise<ProjectPlace> {
  if (given !== undefined) {
    const path = resolve(start, given);
    const folder = basename(path) === MANIFEST_FILE ? dirname(path) : path;
    if (await hasManifest(folder)) return { kind: "folder", root: folder };
    return {
      kind: "none",
      reason: `error no-project: --project ${JSON.stringify(given)} names ${folder}, which has no ${MANIFEST_FILE}, so it is no AnimaQuill project. --project takes the folder of a project: the one with ${MANIFEST_FILE} at its top.`,
    };
  }
  const found = (await above(start)) ?? (workingIn ? await above(workingIn) : undefined);
  if (found) return { kind: "folder", root: found };
  const looked = [
    resolve(start),
    ...(workingIn && resolve(workingIn) !== resolve(start) ? [resolve(workingIn)] : []),
  ];
  return {
    kind: "none",
    reason: `error no-project: the AnimaQuill server looked in ${looked.join(" and ")}, and neither there nor in any folder above is there ${MANIFEST_FILE}, so there is no project to work on. The server finds the project from the folder the AI tool runs in: the AI tool started in the project folder, or the server started with --project <folder of the project>, works on that project.`,
  };
}
