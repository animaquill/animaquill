// Adapted from pi-web (https://github.com/agegr/pi-web), lib/tool-call-expansion.ts, commit 57cea50.
// Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.
import { useState } from "react";

/**
 * What people opened in the chat, by the id of what they opened: a call of a tool, the process of
 * a turn, a thought. A turn moves from running to done and its parts are drawn again; plain state
 * of a component would close what people just opened. Kept outside React for that, as long as the
 * page is open.
 */
const opened = new Map<string, boolean>();

/** Whether people opened or closed something, or undefined when they left it as it came. */
export function openedOf(id: string | undefined): boolean | undefined {
  return id === undefined ? undefined : opened.get(id);
}

export function setOpened(id: string | undefined, open: boolean): void {
  if (id) opened.set(id, open);
}

/** Open or closed as people left it, else as it comes: a failed call comes open. */
export function useOpened(id: string, byDefault: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => openedOf(id) ?? byDefault);
  // What comes open may change once, such as a call that fails after it showed.
  const shown = openedOf(id) ?? (byDefault || open);
  return [
    shown,
    (next: boolean) => {
      setOpened(id, next);
      setOpen(next);
    },
  ];
}
