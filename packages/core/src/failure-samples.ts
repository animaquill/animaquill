import type { CommandFailure, FailureCode, InvalidValue } from "./failures.ts";

/**
 * One failure of every code, and of every rule of `invalid-value`, as commands give them: for tests
 * that check that whoever tells about failures has words for each one. `failures.test.ts` holds
 * them to `FAILURES`, so that a new code or rule cannot be left out.
 */

const RULES: { readonly [R in InvalidValue["rule"]]: Extract<InvalidValue, { rule: R }> } = {
  format: { rule: "format", path: "changes.name", message: "Too small" },
  "retired-property": { rule: "retired-property", path: "crop.left" },
  type: { rule: "type", path: "opacity", expects: "number" },
  min: { rule: "min", path: "opacity", min: 0 },
  max: { rule: "max", path: "opacity", max: 1 },
  choice: { rule: "choice", path: "direction", options: ["left", "right"] },
  "unknown-property": { rule: "unknown-property", path: "angle", transition: "wipe" },
  "no-keys": { rule: "no-keys", path: "direction" },
  "not-a-path": { rule: "not-a-path", path: "a..b" },
  "rename-same": { rule: "rename-same", path: "object.a.x" },
  "renamed-twice": { rule: "renamed-twice", path: "object.a.x" },
  "rename-into-one": { rule: "rename-into-one", path: "object.a.y" },
  "scale-numbers-only": { rule: "scale-numbers-only" },
  "track-settings": { rule: "track-settings", trackKind: "video" },
  "moved-twice": { rule: "moved-twice", clip: "c1" },
  "end-before-start": { rule: "end-before-start", clip: "c1" },
  "cut-outside": { rule: "cut-outside", clip: "c1", at: "9" },
  "key-taken": { rule: "key-taken", time: "1" },
  "key-moved-twice": { rule: "key-moved-twice", time: "1" },
  "effect-outside": { rule: "effect-outside" },
  "effect-backwards": { rule: "effect-backwards" },
  "replace-same": { rule: "replace-same", kind: "asset", id: "a1" },
  "source-kind": { rule: "source-kind", clip: "c1", sourceKind: "image", asset: "a1" },
  "join-one-clip": { rule: "join-one-clip", clip: "c1" },
  "join-incomplete": { rule: "join-incomplete", join: "j1" },
  "sound-entry": { rule: "sound-entry", entry: "index.html" },
  "size-unknown": { rule: "size-unknown", asset: "a1" },
};

const CODES: { readonly [C in FailureCode]: CommandFailure & { readonly code: C } } = {
  "invalid-params": {
    code: "invalid-params",
    params: {
      issues: [
        { path: "clips.0.start", issue: "invalid_type", message: "Invalid input" },
        { path: "", issue: "unrecognized_keys", message: "Unrecognized key", keys: ["clip"] },
      ],
    },
  },
  "unknown-command": { code: "unknown-command", params: { command: "clip.fly" } },
  "user-only": { code: "user-only", params: { command: "clip.add", param: "movedFrom" } },
  "storage-only": { code: "storage-only", params: { command: "clip.add" } },
  "project-locked": { code: "project-locked", params: {} },
  "read-only": { code: "read-only", params: {} },
  "missing-updates": { code: "missing-updates", params: {} },
  conflict: { code: "conflict", params: {}, conflicts: [["timelines", "main", "clips", "c1"]] },
  "stale-revision": { code: "stale-revision", params: { given: "ab12:5", current: "cd34:2" } },
  "would-break-document": {
    code: "would-break-document",
    params: { file: "timelines/main/timeline.json", path: "tracks.0.id", message: "ID 重复：a" },
  },
  "not-found": { code: "not-found", params: { kind: "clip", id: "c9" } },
  "id-taken": { code: "id-taken", params: { kind: "track", id: "intro", by: "section" } },
  "wrong-track": {
    code: "wrong-track",
    params: { trackKind: "audio", holds: "clip", sourceKind: "image" },
  },
  overlap: { code: "overlap", params: { clips: [{ id: "c2", name: "片头" }] } },
  "not-adjacent": { code: "not-adjacent", params: { from: "c1", to: "c2", why: "gap" } },
  "last-section": { code: "last-section", params: { timeline: "main" } },
  "source-start": { code: "source-start", params: { clip: "c1", name: "片头" } },
  "source-end": { code: "source-end", params: { clip: "c1" } },
  "transition-missing": {
    code: "transition-missing",
    params: { why: { reason: "unknown", type: "spin" } },
  },
  "transition-unsupported": {
    code: "transition-unsupported",
    params: { type: "fade", media: "sound", use: "enter" },
  },
  "transition-too-long": {
    code: "transition-too-long",
    params: { why: "longest", longest: "0.4" },
  },
  "not-animatable": { code: "not-animatable", params: { path: "blend" } },
  "join-taken": { code: "join-taken", params: { join: "j1" } },
  "asset-in-use": {
    code: "asset-in-use",
    params: { asset: "a1", by: "code", file: "scenes/title/index.html" },
  },
  "scene-in-use": { code: "scene-in-use", params: { scene: "title" } },
  "sound-in-use": { code: "sound-in-use", params: { sound: "bell" } },
  "entry-in-use": {
    code: "entry-in-use",
    params: { path: "scenes/title/index.html", why: "move" },
  },
  "missing-entry": { code: "missing-entry", params: { kind: "scene", entry: "index.html" } },
  "path-taken": { code: "path-taken", params: { path: "scenes/title/a.js", by: "file" } },
  "file-too-large": {
    code: "file-too-large",
    params: { path: "code/big.js", limit: 8 * 1024 ** 2 },
  },
  "runtime-too-new": { code: "runtime-too-new", params: { runtime: 9, current: 1 } },
  "invalid-value": { code: "invalid-value", params: RULES["end-before-start"] },
  "not-moved": { code: "not-moved", params: { clip: "c1" } },
  "not-in-use": { code: "not-in-use", params: { kind: "scene", id: "title" } },
  "upload-only": { code: "upload-only", params: {} },
  "asset-file-changed": { code: "asset-file-changed", params: { asset: "a1" } },
  "nothing-to-undo": { code: "nothing-to-undo", params: {} },
  "undo-one-by-one": { code: "undo-one-by-one", params: {} },
  "undo-blocked": { code: "undo-blocked", params: {}, obstacle: "changed", conflicts: [] },
  "invalid-file": { code: "invalid-file", params: { path: "timelines/main/timeline.json" } },
  "format-mismatch": { code: "format-mismatch", params: {} },
  "invalid-batch": { code: "invalid-batch", params: { path: "notes.json" } },
  "merge-failed": { code: "merge-failed", params: { detail: "boom" } },
  "manifest-deleted": { code: "manifest-deleted", params: {} },
  "merge-unsettled": { code: "merge-unsettled", params: {} },
  "merge-would-break": { code: "merge-would-break", params: { why: "breaks" } },
  "copy-too-large": {
    code: "copy-too-large",
    params: { bytes: 80 * 1024 ** 2, limit: 64 * 1024 ** 2 },
  },
  "copy-discarded": { code: "copy-discarded", params: {} },
  "not-in-copy": { code: "not-in-copy", params: { command: "asset.add" } },
};

/** One failure of every code. */
export const FAILURE_SAMPLES: readonly CommandFailure[] = Object.values(CODES);

/** One `invalid-value` of every rule. */
export const INVALID_VALUE_SAMPLES: readonly CommandFailure[] = Object.values(RULES).map(
  (params) => ({ code: "invalid-value", params }),
);
