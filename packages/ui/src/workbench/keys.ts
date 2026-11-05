/**
 * A key combination such as "mod+shift+p". "mod" is Ctrl, or Command on a Mac, so that saved
 * bindings work on both. Keys are physical keys: a Chinese input method reports letters as
 * "Process" in event.key, which would break every single-letter shortcut while it is on.
 */
export type KeyCombo = string;

export type Platform = "mac" | "other";

export type KeyEventFacts = Pick<
  KeyboardEvent,
  "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

const SYMBOLS: Readonly<Record<string, string>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

const LABELS: Readonly<Record<string, string>> = {
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
  escape: "Esc",
  pageup: "PageUp",
  pagedown: "PageDown",
};

function keyName(code: string): string | undefined {
  if (!code || /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code)) return undefined;
  const symbol = SYMBOLS[code];
  if (symbol) return symbol;
  const match = /^(?:Key|Digit)(.)$/.exec(code);
  return (match?.[1] ?? code).toLowerCase();
}

/** The combination of a key press, or undefined while only modifiers are held. */
export function comboOf(event: KeyEventFacts, platform: Platform): KeyCombo | undefined {
  const key = keyName(event.code);
  if (!key) return undefined;
  const mac = platform === "mac";
  const parts: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push("mod");
  if (mac && event.ctrlKey) parts.push("ctrl");
  if (!mac && event.metaKey) parts.push("meta");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** How a combination is written on this platform. */
export function formatCombo(combo: KeyCombo, platform: Platform): string {
  const mac = platform === "mac";
  const names: Readonly<Record<string, string>> = mac
    ? { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" }
    : { mod: "Ctrl", meta: "Win", alt: "Alt", shift: "Shift" };
  const parts = combo.split("+").map((part) => names[part] ?? LABELS[part] ?? capitalize(part));
  return parts.join(mac ? "" : "+");
}

/** Needed to move around with the keyboard, so they cannot become shortcuts on their own. */
const RESERVED = new Set(["tab", "shift+tab", "escape", "enter"]);

export const isBindable = (combo: KeyCombo): boolean => !RESERVED.has(combo);

/** Text boxes need these for themselves, whatever they are bound to. */
const TEXT_EDITING = new Set(["mod+a", "mod+c", "mod+v", "mod+x", "mod+y", "mod+z", "mod+shift+z"]);

/** Whether a combination still means a shortcut while the focus is in a text box. */
export function worksWhileTyping(combo: KeyCombo): boolean {
  if (TEXT_EDITING.has(combo)) return false;
  return /(^|\+)(mod|ctrl|meta|alt)\+/.test(combo) || /(^|\+)f\d+$/.test(combo);
}
