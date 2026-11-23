import { PgBoss } from "pg-boss";
import type { Config } from "./config.ts";
import { connectionOptions, describeError, type Logger } from "./database.ts";

/**
 * The job queue, pg-boss in the same database, in its own schema. Starting it makes or updates its
 * tables. The only job so far tidies up accounts; saving to GitHub brings more (phase 5, step 14).
 */
export const startJobs = async (config: Config["database"], log: Logger) => {
  const boss = new PgBoss({
    ...connectionOptions(config, "animaquill-jobs"),
    schema: "pgboss",
    max: 4,
  });
  boss.on("error", (error) => {
    log.warn({ err: describeError(error) }, "job queue error");
  });
  try {
    await boss.start();
  } catch (error) {
    await boss.stop({ graceful: false }).catch(() => {});
    throw error;
  }
  return boss;
};

export type Jobs = Awaited<ReturnType<typeof startJobs>>;

/** Every hour, see `Accounts.cleanUp`. The schedule is pg-boss's: one run an hour, however many APIs. */
export const CLEANUP_QUEUE = "accounts-cleanup";

export const scheduleCleanup = async (
  boss: Jobs,
  cleanUp: () => Promise<Record<string, number>>,
  log: Logger,
) => {
  await boss.createQueue(CLEANUP_QUEUE);
  await boss.schedule(CLEANUP_QUEUE, "17 * * * *");
  await boss.work(CLEANUP_QUEUE, async () => {
    const removed = await cleanUp();
    log.info({ removed }, "accounts tidied up");
  });
};
