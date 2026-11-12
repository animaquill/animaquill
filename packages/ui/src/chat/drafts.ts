// Adapted from pi-web (https://github.com/agegr/pi-web), lib/draft-store.ts and
// lib/quoted-selection.ts, commit 57cea50.
// Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.
import type { WindowMemory } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

/**
 * What people wrote and did not send yet, a draft for each conversation: kept in the memory of the
 * window (`Host.windowMemory`), so that it is there again after another conversation, another
 * project or a reload, and not in the settings every window shares. Sending clears it.
 */

/** Where the draft of a conversation of a project is kept in the memory of the window. */
export const draftKey = (project: string, chat: string): string =>
  `chat.draft\n${project}\n${chat}`;

/**
 * What goes back in the input box when words did not go out: they come first, then what people
 * typed since, a blank line between them. Either alone stays as it is.
 */
export function mergeRestored(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  if (current.startsWith(submitted)) return current;
  return `${submitted}\n\n${current}`;
}

/** Selected text as a Markdown quote, then a blank line to type after. */
export function quoteOf(text: string): string {
  const quote = text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quote}\n\n`;
}

/** What goes before a quote put after `before`, so that the quote starts a paragraph of its own. */
export function quoteSeparator(before: string): string {
  if (!before.trim() || before.endsWith("\n\n")) return "";
  return before.endsWith("\n") ? "\n" : "\n\n";
}

/** The drafts of this window, by project and conversation. */
export class Drafts {
  readonly #memory: WindowMemory | undefined;
  /** What was read or written, so that typing does not read the memory again. */
  readonly #known = new Map<string, string>();
  readonly #emitter = new Emitter();

  constructor(memory: WindowMemory | undefined) {
    this.#memory = memory;
  }

  subscribe = this.#emitter.subscribe;

  read(project: string, chat: string): string {
    const key = draftKey(project, chat);
    const known = this.#known.get(key);
    if (known !== undefined) return known;
    const kept = this.#memory?.read(key) ?? "";
    this.#known.set(key, kept);
    return kept;
  }

  /** Keeps a draft; an empty one is none. */
  write(project: string, chat: string, text: string): void {
    const key = draftKey(project, chat);
    if (this.read(project, chat) === text) return;
    this.#known.set(key, text);
    this.#memory?.write(key, text);
    this.#emitter.emit();
  }

  clear(project: string, chat: string): void {
    this.write(project, chat, "");
  }

  /** Words that did not go out go back, ahead of what people typed since, see `mergeRestored`. */
  restore(project: string, chat: string, submitted: string): void {
    this.write(project, chat, mergeRestored(submitted, this.read(project, chat)));
  }

  /** Puts a quote at the end of a draft, as a paragraph of its own. */
  quote(project: string, chat: string, text: string): void {
    if (!text.trim()) return;
    const before = this.read(project, chat);
    this.write(project, chat, `${before}${quoteSeparator(before)}${quoteOf(text)}`);
  }
}
