import type { Failure } from "./failures.ts";
import { documentAt, type ProjectState } from "./model.ts";
import type { Patch } from "./patch.ts";

/**
 * The first document that a change breaks: one it touches that was valid before and is not any
 * more. What was not valid before is not the change's doing, and must not stop anybody from fixing
 * it. Only the documents that the change touches are read, see `documentAt`.
 */
export function brokenDocument(
  before: ProjectState,
  after: ProjectState,
  patches: readonly Patch[],
): Failure | undefined {
  const seen = new Set<string>();
  for (const { path } of patches) {
    const document = documentAt(path);
    if (!document || seen.has(document.file)) continue;
    seen.add(document.file);
    const issue = document.issue(after);
    if (issue && document.issue(before) === undefined) {
      return { code: "would-break-document", params: { file: document.file, ...issue } };
    }
  }
  return undefined;
}
