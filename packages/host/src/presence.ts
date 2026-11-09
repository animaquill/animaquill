import type { ProjectPresence } from "./index.ts";

/** One shared lock for each window that has a project open: Web Locks count them across windows. */
const PREFIX = "animaquill.open.";
/** Where windows hear that a project moved into a folder. */
const CHANNEL = "animaquill.moved";

interface Moved {
  readonly project: string;
}

const isMoved = (data: unknown): data is Moved =>
  typeof data === "object" && data !== null && typeof (data as Partial<Moved>).project === "string";

/**
 * Which windows have which projects open, through Web Locks: each window holds a shared lock for
 * each project it has open, which the browser lets go of when the window goes away, and asking the
 * browser what is held counts them. Without Web Locks nobody can tell, and every window is alone.
 */
export function browserPresence(
  locks: () => LockManager | undefined = () => navigator.locks,
  channel: () => BroadcastChannel | undefined = () =>
    typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(CHANNEL),
): ProjectPresence {
  /** How many times this window has each project open, which its own locks are. */
  const mine = new Map<string, number>();
  const listeners = new Set<(project: string) => void>();
  let line: BroadcastChannel | undefined;
  const lineOf = () => {
    if (line) return line;
    line = channel();
    line?.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
      if (!isMoved(data)) return;
      for (const listener of listeners) listener(data.project);
    });
    return line;
  };
  return {
    enter(project) {
      mine.set(project, (mine.get(project) ?? 0) + 1);
      let release = () => {};
      let isOver = false;
      locks()
        ?.request(`${PREFIX}${project}`, { mode: "shared" }, () => {
          if (isOver) return undefined;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(() => {});
      return () => {
        if (isOver) return;
        isOver = true;
        const left = (mine.get(project) ?? 1) - 1;
        if (left > 0) mine.set(project, left);
        else mine.delete(project);
        release();
      };
    },
    async others(project) {
      const manager = locks();
      if (!manager) return 0;
      const { held = [] } = await manager.query().catch(() => ({ held: undefined }));
      const all = held.filter(({ name }) => name === `${PREFIX}${project}`).length;
      // A lock this window just asked for may not be held yet.
      return Math.max(0, all - (mine.get(project) ?? 0));
    },
    moved(project) {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
      lineOf()?.postMessage({ project } satisfies Moved);
    },
    onMoved(listener) {
      lineOf();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
