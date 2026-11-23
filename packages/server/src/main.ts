import { describeConfig, forgetSecrets, loadConfig } from "./config.ts";
import { startServer } from "./server.ts";
import { switchesOf, testSwitchesOn } from "./switches.ts";
import { runUntilStopped } from "./worker.ts";

/**
 * The API of the open-source server on its own: `node src/main.ts`, next to the worker
 * (worker-main.ts), with the settings of config.ts in the environment. A deployment with more of
 * its own starts `startServer` (server.ts) itself, with its parts.
 */

const config = loadConfig(process.env);
// Only for the tests of a whole deployment: one that people use does not start with it.
const testSwitches = testSwitchesOn(process.env, config.database.host);
const switches = switchesOf(process.env);
forgetSecrets(process.env);

const server = startServer(config, { switches });
if (testSwitches)
  server.log.warn(
    {},
    "AQ_TEST_SWITCHES=on: every switch is on, for the tests of a whole deployment only",
  );
server.log.info(describeConfig(config), "starting");
runUntilStopped(server.log, () => server.stop());
await server.listen();
