/**
 * Every operation that the tests run keeps to what the registry says of it: it fails only with the
 * codes it declares (`failures`, besides `GENERAL_FAILURES`, which the store checks for all of them),
 * and gives back what its `result` says. Run with `pnpm test:platform`, see
 * vitest.platform.config.ts: the tests of all packages, each with this in front, so that every
 * command any test gives counts.
 */
import { afterAll, expect } from "vitest";
import { operationOf } from "./commands.ts";
import { GENERAL_FAILURES } from "./failures.ts";
import { ProjectStore, type CommandCall } from "./store.ts";

const faults = new Set<string>();
const general: ReadonlySet<string> = new Set(GENERAL_FAILURES);

const run = ProjectStore.prototype.executeBatch;
ProjectStore.prototype.executeBatch = function (calls, options) {
  const result = run.call(this, calls, options);
  const named = (index: number) => (calls as readonly CommandCall[])[index]?.type ?? "";
  if (!result.ok) {
    const { code, index } = result.error;
    const op = index === undefined ? undefined : operationOf(named(index));
    if (op && !general.has(code) && !op.failures.includes(code)) {
      faults.add(`${op.name} fails with ${code}, which it does not declare`);
    }
    return result;
  }
  result.results.forEach((value, index) => {
    const op = operationOf(named(index));
    if (op && !op.result.safeParse(value).success) {
      faults.add(`${op.name} gives back ${JSON.stringify(value)}, which is not its result`);
    }
  });
  return result;
};

afterAll(() => {
  expect([...faults]).toEqual([]);
});
