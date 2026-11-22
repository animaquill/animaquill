import { scoped } from "./scope.ts";
import type { ProjectPresence } from "./index.ts";

/** One shared lock for each window that has a project open: Web Locks count them across windows. */
const PREFIX = "animaquill.open.";

/**
 * Which windows have which projects open, through Web Locks: each window holds a shared lock for
 * each project it has open, which the browser lets go of when the window goes away, and asking the
 * browser what is held counts them. Without Web Locks nobody can tell, and every window is alone.
 * A browser that has them and does not answer is something else: `others` rejects then.
 */
export function browserPresence(
  locks: () => LockManager | undefined = () => navigator.locks,
): ProjectPresence {
  /** How many times this window has each project open, which its own locks are. */
  const mine = new Map<string, number>();
  return {
    enter(project) {
      mine.set(project, (mine.get(project) ?? 0) + 1);
      let release = () => {};
      let isOver = false;
      locks()
        ?.request(scoped(`${PREFIX}${project}`), { mode: "shared" }, () => {
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
      // A browser that does not say what is held cannot tell: that is no "nobody", which is what
      // people would be told before something of the project is taken away.
      const { held = [] } = await manager.query();
      const all = held.filter(({ name }) => name === scoped(`${PREFIX}${project}`)).length;
      // A lock this window just asked for may not be held yet.
      return Math.max(0, all - (mine.get(project) ?? 0));
    },
  };
}
