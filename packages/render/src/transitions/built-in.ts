import type { TransitionCode } from "./code.ts";
import dip from "./dip.ts";
import fade from "./fade.ts";
import push from "./push.ts";
import wipe from "./wipe.ts";

/**
 * The code of the transitions that come with the editor, by name, as the project format has them.
 * What cannot be found is drawn as a fade, which the plan says already: see `PlannedTransition`.
 */
export const BUILT_IN_CODE: Readonly<Record<string, TransitionCode>> = { fade, dip, wipe, push };

export const codeOf = (type: string): TransitionCode =>
  (Object.hasOwn(BUILT_IN_CODE, type) ? BUILT_IN_CODE[type] : undefined) ?? fade;
