import { entryOf, type ProjectState } from "@animaquill/core";
import { z } from "zod";
import { describeChanges } from "../changes.ts";
import { answer, failed, type Call } from "../context.ts";
import { failureText } from "../failures-en.ts";
import { mostLike } from "../similar.ts";
import { syntaxOf } from "../syntax.ts";
import type { ToolDefinition } from "../tool.ts";
import type { ToolResult } from "../types.ts";
import { isNoCodeFile, textHash } from "./read.ts";

/** How many changed lines a result shows, with what is around them. */
const MAX_SHOWN = 30;
const AROUND = 2;

const RUNTIME =
  "Runtime errors of this code show in aq_check_run once the editor has run it again.";

const request = z
  .string()
  .max(64)
  .optional()
  .describe(
    "Any string of yours: a call sent again with the same one is not run again and gets the same result.",
  );

const missing = (state: ProjectState, path: string): ToolResult => {
  if (isNoCodeFile(state, path)) {
    return failed(
      `error not-a-code-file: ${path} is a document of the project or a file of an asset, not code. Nothing was written.`,
    );
  }
  const similar = mostLike(path, Object.keys(state.files));
  const hint = similar.length > 0 ? `\nsimilar: ${similar.join(" | ")}` : "";
  return failed(
    `error not-found: no code file ${JSON.stringify(path)}; create it with aq_file_write${hint}`,
  );
};

/** Writes a file as one step, and what the result says about it. */
function write(call: Call, path: string, text: string, base?: string): ToolResult | undefined {
  const { store, host } = call;
  const result = store.execute(
    { type: "file.write", params: { path, text } },
    { origin: host.origin(), ...(base !== undefined && { baseRevision: base }) },
  );
  if (result.ok) {
    call.caller.files.set(path, { revision: store.revisionId, hash: textHash(text) });
    call.caller.saw({ kind: "file", id: path }, store.revisionId);
    return undefined;
  }
  return failed(`error ${failureText(result.error)} Nothing was written.`);
}

/** The lines that changed, with some around them, numbered as aq_file_read numbers them. */
function changedLines(before: string, after: string): readonly string[] {
  const old = before.split("\n");
  const lines = after.split("\n");
  let first = 0;
  while (first < old.length && first < lines.length && old[first] === lines[first]) first += 1;
  let fromEnd = 0;
  while (
    fromEnd < old.length - first &&
    fromEnd < lines.length - first &&
    old[old.length - 1 - fromEnd] === lines[lines.length - 1 - fromEnd]
  ) {
    fromEnd += 1;
  }
  const start = Math.max(0, first - AROUND);
  const end = Math.min(lines.length, lines.length - fromEnd + AROUND);
  const shown = lines.slice(start, Math.min(end, start + MAX_SHOWN));
  const numbered = shown.map((line, index) => `${String(start + index + 1).padStart(6)}→${line}`);
  return end - start > MAX_SHOWN
    ? [...numbered, `  … ${end - start - MAX_SHOWN} more changed lines`]
    : numbered;
}

/** Where a text that is not found exactly is most like: the line most like its first line. */
function closest(text: string, wanted: string): string {
  const first =
    wanted
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? "";
  if (first === "") return "";
  const lines = text.split("\n");
  let best = -1;
  let bestScore = 0;
  const words = new Set(first.split(/\W+/).filter(Boolean));
  lines.forEach((line, index) => {
    const score = line.split(/\W+/).filter((word) => words.has(word)).length;
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best < 0
    ? ""
    : `\nmost like line ${best + 1}: ${JSON.stringify(lines[best]?.trim().slice(0, 160))}`;
}

const FileEditParams = z.strictObject({
  path: z.string().describe('Path of the code file, such as "scenes/title/index.html".'),
  edits: z
    .array(
      z.strictObject({
        old_text: z
          .string()
          .describe(
            "Text of the file as it is now, exactly, without the line numbers of aq_file_read; enough of it to be found once.",
          ),
        new_text: z.string().describe("What replaces it."),
        replace_all: z
          .boolean()
          .optional()
          .describe("true replaces every place old_text is found, at least one."),
      }),
    )
    .min(1)
    .max(20)
    .describe("Replacements, applied in order, 1 to 20."),
  request_id: request,
});

export const fileEdit: ToolDefinition<z.output<typeof FileEditParams>> = {
  name: "aq_file_edit",
  title: "Edit a code file",
  description:
    "Change part of a code file by replacing exact text: for each edit, old_text must appear exactly once in the file as it is now (copy it from aq_file_read without the line numbers, with enough surrounding lines to be unique), and it is replaced with new_text. Set replace_all to replace every occurrence instead. All edits of one call are applied in order and succeed together, or nothing is written. This is the way to change scene, sound and shared code; it does not need the file's revision, so the user may edit other parts of the same file meanwhile. If old_text is not found, the user may have just changed that part: read the file again. The result shows the changed lines and a syntax check. To create a file or rewrite most of one, use aq_file_write.",
  params: FileEditParams,
  writes: true,
  run: async (call, args) => {
    const state = call.store.getState();
    const before = entryOf(state.files, args.path);
    if (before === undefined) return missing(state, args.path);
    let text = before;
    let count = 0;
    for (const [
      index,
      { old_text: wanted, new_text: replacement, replace_all: all },
    ] of args.edits.entries()) {
      const where = `edits[${index}]`;
      if (wanted === replacement) {
        return failed(
          `error no-change in ${where}: old_text and new_text are the same. Nothing was written.`,
        );
      }
      const places: number[] = [];
      let found = wanted === "" ? -1 : text.indexOf(wanted);
      while (found >= 0) {
        places.push(found);
        found = text.indexOf(wanted, found + wanted.length);
      }
      if (places.length === 0) {
        return failed(
          `error text-not-found in ${where}: old_text is not in ${args.path} as it is now; the file may have changed since you read it: read it again with aq_file_read.${closest(text, wanted)}\nnothing was written`,
        );
      }
      if (places.length > 1 && !all) {
        const lines = places.map((at) => text.slice(0, at).split("\n").length);
        return failed(
          `error text-not-unique in ${where}: old_text is there ${places.length} times, on lines ${lines.join(", ")}. Add lines around it to make it unique, or set replace_all. Nothing was written.`,
        );
      }
      count += places.length;
      text = all ? text.split(wanted).join(replacement) : text.replace(wanted, () => replacement);
    }
    const refused = write(call, args.path, text);
    if (refused) return refused;
    const changes = describeChanges(state, call.store.getState(), [["files", args.path]]);
    return answer(
      call,
      [
        `edited ${args.path}: ${count} replacement${count === 1 ? "" : "s"}, now ${text.split("\n").length} lines`,
        ...changedLines(before, text),
        `syntax: ${await syntaxOf(args.path, text)}`,
        RUNTIME,
      ],
      { changes },
    );
  },
};

const FileWriteParams = z.strictObject({
  path: z
    .string()
    .describe(
      'Path of the file, under scenes/<scene id>/, sounds/<sound id>/ or code/, such as "code/ease.js".',
    ),
  text: z.string().describe("All of its text."),
  base_revision: z
    .string()
    .optional()
    .describe(
      "Hardly ever needed: the revision a result began with, instead of having read the file in this conversation.",
    ),
  request_id: request,
});

/** Why a path cannot be written here, or undefined. */
function pathProblem(state: ProjectState, path: string): ToolResult | undefined {
  const [top, owner, ...rest] = path.split("/");
  const name = rest.join("/");
  const refuse = (why: string) =>
    failed(`error path-not-allowed: ${path}: ${why} Nothing was written.`);
  if (top === "code") return owner ? undefined : refuse("a file under code/ needs a name.");
  if (top !== "scenes" && top !== "sounds") {
    return refuse("code files go under scenes/<scene id>/, sounds/<sound id>/ or code/.");
  }
  const manifests = top === "scenes" ? state.scenes : state.sounds;
  if (name === "" || name === "scene.json" || name === "sound.json") {
    return refuse(
      `that is the manifest of the ${top.slice(0, -1)}: change it with ${top.slice(0, -1)}.update in aq_edit.`,
    );
  }
  if (owner === undefined || !entryOf(manifests, owner)) {
    return failed(
      `error not-found: there is no ${top.slice(0, -1)} ${JSON.stringify(owner ?? "")}: create it with ${top.slice(0, -1)}.add in aq_edit, which takes its first files too. Nothing was written.`,
    );
  }
  return undefined;
}

export const fileWrite: ToolDefinition<z.output<typeof FileWriteParams>> = {
  name: "aq_file_write",
  title: "Write a code file",
  description:
    "Create a code file, or replace all of one: a new file of a scene, sound or shared code, or a rewrite of most of a file. Paths go under scenes/<scene id>/, sounds/<sound id>/ or code/; the scene or sound must exist (create it with scene.add or sound.add in aq_edit, which takes its first files too). To replace an existing file you must have read it with aq_file_read in this conversation, and the call fails with file-changed if somebody changed it since: read it again, then write. For small changes use aq_file_edit, which keeps the user's edits elsewhere in the file. The result includes a syntax check.",
  params: FileWriteParams,
  writes: true,
  run: async (call, args) => {
    const state = call.store.getState();
    const { path, text } = args;
    if (isNoCodeFile(state, path)) {
      return failed(
        `error path-not-allowed: ${path} is a document of the project or a file of an asset, not code. Nothing was written.`,
      );
    }
    const refused = pathProblem(state, path);
    if (refused) return refused;
    const before = entryOf(state.files, path);
    if (before !== undefined && args.base_revision === undefined) {
      const seen = call.caller.files.get(path);
      if (!seen) {
        return failed(
          `error file-not-read: ${path} exists, and you have not read it in this conversation: read it with aq_file_read first, or change parts of it with aq_file_edit. Nothing was written.`,
        );
      }
      if (seen.hash !== textHash(before)) {
        return failed(
          `error file-changed: ${path} changed since you read it, maybe by the user: read it again with aq_file_read, then decide. Nothing was written.`,
        );
      }
    }
    const failedWrite = write(call, path, text, args.base_revision);
    if (failedWrite) return failedWrite;
    const lines = text.split("\n").length;
    const what =
      before === undefined
        ? `new, ${lines} lines`
        : `replaced, ${before.split("\n").length} → ${lines} lines`;
    const changes = describeChanges(state, call.store.getState(), [["files", path]]);
    return answer(
      call,
      [`wrote ${path} (${what})`, `syntax: ${await syntaxOf(path, text)}`, RUNTIME],
      { changes },
    );
  },
};
