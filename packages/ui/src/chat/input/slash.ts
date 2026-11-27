/**
 * `/` and `@` in the input box (docs/design/chat-panel.md of AnimaQuill Cloud, 3.3): a command at
 * the start of what is written, a block of the project anywhere after a space. Pure, for the box to
 * ask where the caret is.
 */

/** What starts a command: `/`, the wide `／`, and `、`, which `/` types in Chinese input. */
export const SLASHES = ["/", "／", "、"] as const;
/** What starts a block of the project. */
export const ATS = ["@", "＠"] as const;

export type SlashId = "plan" | "new" | "compact" | "frame" | "rename";

export interface SlashCommand {
  readonly id: SlashId;
  /** As people see and type it, after the slash. */
  readonly name: string;
  /** Other words it is found by: English, pinyin, the first letters of the pinyin. */
  readonly also: readonly string[];
}

/** Only these: each one has its button too, they are for hands on the keys. */
export const COMMANDS: readonly SlashCommand[] = [
  { id: "plan", name: "方案", also: ["plan", "fangan", "fa"] },
  { id: "new", name: "新对话", also: ["new", "xinduihua", "xdh"] },
  { id: "compact", name: "压缩", also: ["compact", "yasuo", "ys"] },
  { id: "frame", name: "画面", also: ["frame", "huamian", "hm"] },
  { id: "rename", name: "重命名", also: ["rename", "chongmingming", "cmm"] },
];

/** The commands that start with what was typed after the slash, by name or by another word. */
export function commandsFor(query: string): readonly SlashCommand[] {
  const wanted = query.toLocaleLowerCase();
  return COMMANDS.filter((command) =>
    [command.name, ...command.also].some((word) => word.startsWith(wanted)),
  );
}

/** Where the caret is in something `/` or `@` started, which a menu completes. */
export interface Trigger {
  readonly kind: "slash" | "at";
  /** What was typed after the slash or `@`. */
  readonly query: string;
  /** How long it is with the slash or `@`, back from the caret. */
  readonly length: number;
}

/** Longer than this after `@`, it is words and not a name to find. */
const LONGEST = 32;

/**
 * What the caret is in, from what comes before it: `whole` is all of the box up to it (blocks as
 * their links), `here` the part of it in the same run of text, which the menu can replace. A command
 * is all there is before the caret, with no space; a block of the project starts at `@` after the
 * start, a space or a line break.
 */
export function triggerAt(whole: string, here: string): Trigger | undefined {
  const slash = /^[/／、](\S*)$/u.exec(whole);
  if (slash && here === whole) {
    return { kind: "slash", query: slash[1] ?? "", length: whole.length };
  }
  const at = /(?:^|\s)[@＠]([^\s@＠]*)$/u.exec(here);
  if (!at) return undefined;
  const query = at[1] ?? "";
  const length = query.length + 1;
  if ([...query].length > LONGEST) return undefined;
  // `@` at the start of this run of text: what comes before it in the box is a space, or nothing.
  if (here.length === length) {
    const before = whole.slice(0, whole.length - length);
    if (before !== "" && !/\s$/u.test(before)) return undefined;
  }
  return { kind: "at", query, length };
}

/**
 * A command written out in full at the start of a message, as it is sent ("/新对话 做个片头"): the
 * command, and what comes after it.
 */
export function commandOf(
  text: string,
): { readonly command: SlashCommand; readonly rest: string } | undefined {
  const match = /^[/／、](\S+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return undefined;
  const word = (match[1] ?? "").toLocaleLowerCase();
  const command = COMMANDS.find(
    (each) => each.name === word || each.also.slice(0, 1).includes(word),
  );
  return command ? { command, rest: match[2] ?? "" } : undefined;
}
