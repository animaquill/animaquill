import { answer, failed, MAX_RESULT, type Call } from "./context.ts";
import type { ToolResult } from "./types.ts";

/** What a list asks for: how many at most, and where to go on from. */
export interface Paging {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/** The parameters of a call without its cursor, the same way each time, to know a cursor is for it. */
const argsKey = (args: object): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(args)
        .filter(([key]) => key !== "cursor")
        .toSorted(),
    ),
  );

/** Where a list goes on, or an error when its cursor is not for this call or is out of date. */
export function offsetOf(call: Call, tool: string, args: object & Paging): number | ToolResult {
  if (args.cursor === undefined) return 0;
  const cursor = call.caller.cursorOf(args.cursor);
  const fits = cursor && cursor.tool === tool && cursor.args === argsKey(args);
  if (!cursor || !fits || cursor.revision !== call.store.revisionId) {
    return failed(
      "error cursor-expired: this cursor is out of date (the project changed, 10 minutes passed, or the other parameters differ); without cursor the list starts again from the top.",
    );
  }
  return cursor.offset;
}

/**
 * A list as one result: the lines before it, `limit` items from `offset`, and a line that says how
 * to get the rest, also when the result would be too long.
 */
export function paged(
  call: Call,
  tool: string,
  args: object & Paging,
  options: {
    readonly head: readonly string[];
    readonly items: readonly string[];
    readonly offset: number;
    readonly limit: number;
    /** Says which items these are, such as "clips 1-38 of 38, by start:". */
    readonly title: (from: number, to: number, total: number) => string;
    readonly tail?: readonly string[];
    readonly data?: Readonly<Record<string, unknown>>;
    /** Hears which items the result has, from `from` up to before `to`: only those were read. */
    readonly shown?: (from: number, to: number) => void;
  },
): ToolResult {
  const { head, items, offset, limit, title, tail = [], data } = options;
  let room = MAX_RESULT - 500 - [...head, ...tail].reduce((sum, line) => sum + line.length + 1, 0);
  const shown: string[] = [];
  for (const item of items.slice(offset, offset + limit)) {
    room -= item.length + 1;
    if (room < 0) break;
    shown.push(item);
  }
  // A list always goes on: an item too long for the room left comes cut, rather than none.
  const first = items[offset];
  if (shown.length === 0 && first !== undefined && limit > 0) {
    shown.push(`${first.slice(0, Math.max(200, room + first.length))}…`);
  }
  const end = offset + shown.length;
  options.shown?.(offset, end);
  const lines = [...head];
  if (items.length > 0) lines.push(title(offset + 1, end, items.length), ...shown);
  if (end < items.length) {
    const name = call.caller.cursor({
      tool,
      args: argsKey(args),
      revision: call.store.revisionId,
      offset: end,
    });
    lines.push(`${items.length - end} more; cursor "${name}" gives the next ones.`);
  }
  return answer(call, [...lines, ...tail], data);
}
