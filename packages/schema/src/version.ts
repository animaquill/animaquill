/**
 * The format of a whole project. Every change to it raises this number and comes with a migration.
 * Unknown fields are errors, so a mistake in a hand-written file is found at once, and an older
 * editor refuses a newer project instead of silently dropping what it does not understand.
 */
export const CURRENT_FORMAT_VERSION = 1;

/**
 * The newest interface for the code of scenes that this editor can run, which is what `runtime` in
 * `scene.json` names. New editors keep running the old ones, so this only goes up.
 */
export const CURRENT_SCENE_RUNTIME = 1;
