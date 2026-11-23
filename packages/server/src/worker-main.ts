import { describeConfig, forgetSecrets, loadConfig } from "./config.ts";
import { jsonLogger, runUntilStopped, startWorker } from "./worker.ts";

/**
 * The worker of the open-source server on its own: `node src/worker-main.ts`, next to the API
 * (main.ts), with the same settings. A deployment with more of its own starts `startWorker`
 * (worker.ts) itself, with its parts.
 */

const log = jsonLogger("worker");
const config = loadConfig(process.env);
forgetSecrets(process.env);
log.info(describeConfig(config), "starting");
for (const problem of config.library.problems) log.warn({}, `Library: ${problem}`);
const worker = startWorker(config, { log });
runUntilStopped(log, () => worker.stop());
