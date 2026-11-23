import { OLDEST_EDITOR } from "./sync/hub.ts";

/**
 * The switches of a release that the server goes by: since when projects whose repository cannot
 * be used are taken away (`deletesFrom`, archive/links.ts), which the deployment writes into its
 * release (none unless it does), and the oldest editor it syncs with (`OLDEST_EDITOR`, sync/hub.ts).
 * As they are written there; the environment never says anything else.
 *
 * Only the tests of a whole deployment turn all of them on, with `AQ_TEST_SWITCHES=on`, as the
 * server's own tests pass them as options to what reads them: they run the editor of the code as
 * it is ("dev"), which knows whatever any release knows.
 */
export interface ReleaseSwitches {
  readonly deletesFrom: string | undefined;
  /** The oldest editor the platform syncs with, see `OLDEST_EDITOR`. */
  readonly oldestEditor?: string | undefined;
}

/** What the tests of the whole platform turn on: every editor knows, and nothing waits. */
const ALL_ON: ReleaseSwitches = {
  deletesFrom: "2000-01-01T00:00:00Z",
  oldestEditor: OLDEST_EDITOR,
};

export const switchesOf = (
  env: Readonly<Record<string, string | undefined>>,
  release: { readonly deletesFrom?: string | undefined } = {},
): ReleaseSwitches =>
  env["AQ_TEST_SWITCHES"] === "on"
    ? ALL_ON
    : {
        deletesFrom: release.deletesFrom,
        oldestEditor: OLDEST_EDITOR,
      };

/** Where a database is on this machine only: what the tests of a whole deployment run. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Whether the switches are turned on for tests, see `switchesOf`: only where the database is on
 * the loopback of this machine, as in such tests. On a server that people use (whose database is
 * reached by its name, such as on a Docker network) it throws, which the server does as it starts: every editor would hear codes that older ones take for a line that broke, and
 * projects whose repository cannot be used would be taken away within the week.
 */
export const testSwitchesOn = (
  env: Readonly<Record<string, string | undefined>>,
  databaseHost: string,
): boolean => {
  if (env["AQ_TEST_SWITCHES"] !== "on") return false;
  if (!LOOPBACK.has(databaseHost))
    throw new Error(
      "AQ_TEST_SWITCHES=on is only for the tests of a whole deployment, whose database is on the loopback: take it out",
    );
  return true;
};
