import type { Failure } from "./failures.ts";
import { documentAt, type ProjectState, type StateDocument } from "./model.ts";
import type { Patch } from "./patch.ts";

/**
 * The first document that a change breaks: one it touches that was valid before and is not any
 * more. What was not valid before is not the change's doing, and must not stop anybody from fixing
 * it. Only the documents that the change touches are read, see `documentAt`.
 */
/** What a change breaks of a document, by reading all of it before and after. */
function wholly(document: StateDocument, before: ProjectState, after: ProjectState) {
  const issue = document.issue(after);
  return issue && document.issue(before) === undefined ? issue : undefined;
}

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
    const issue = document.breaks
      ? document.breaks(before, after, patches)
      : wholly(document, before, after);
    if (issue) {
      return { code: "would-break-document", params: { file: document.file, ...issue } };
    }
  }
  return undefined;
}
