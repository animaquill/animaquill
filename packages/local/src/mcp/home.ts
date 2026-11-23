import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where AnimaQuill keeps what is this computer user's own: the identity of the relay, the origins it
 * lets connect. `ANIMAQUILL_HOME` moves it, for tests.
 */
export const animaquillHome = (): string =>
  process.env["ANIMAQUILL_HOME"] ?? join(homedir(), ".animaquill");
