/**
 * The sites of the test, as close to real ones as a test gets: every part has its own origin, and
 * `*.localhost` counts as secure, like the real sites on https.
 */
export const PORT = 5199;

const site = (name: string) => `http://${name}.localhost:${PORT}`;

export const EDITOR = site("editor");
export const COMPOSITOR = site("box");
export const SCENES = [
  site("scene-0"),
  site("scene-1"),
  site("scene-2"),
  site("scene-3"),
  site("scene-4"),
  site("scene-5"),
  site("scene-6"),
  site("scene-7"),
] as const;
/** What a scene must never reach. It logs everything it gets. */
export const OUTSIDE = site("outside");
export const HEALTH = `http://localhost:${PORT}/health`;
export const LEAKS = `http://localhost:${PORT}/leaks`;
