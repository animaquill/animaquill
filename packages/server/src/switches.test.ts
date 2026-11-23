import { describe, expect, test } from "vitest";
import { checkUnusableSwitches } from "./archive/links.ts";
import { OLDEST_EDITOR } from "./sync/hub.ts";
import { switchesOf, testSwitchesOn } from "./switches.ts";

describe("the switches of a release, as the platform goes by them", () => {
  test("are as they are written, whatever else the environment says", () => {
    const release = { deletesFrom: "2026-01-02T03:04:00Z" };
    const written = { ...release, oldestEditor: OLDEST_EDITOR };
    expect(switchesOf({}, release)).toEqual(written);
    expect(switchesOf({ AQ_TEST_SWITCHES: "1" }, release)).toEqual(written);
    expect(switchesOf({ AQ_TEST_SWITCHES: "true" }, release)).toEqual(written);
    // A deployment that writes none takes no project away.
    expect(switchesOf({})).toEqual({ deletesFrom: undefined, oldestEditor: OLDEST_EDITOR });
  });

  test("are all on for the tests of the whole platform, which run the editor of the code as it is", () => {
    const on = switchesOf({ AQ_TEST_SWITCHES: "on" });
    expect(() => checkUnusableSwitches({ deletesFrom: on.deletesFrom })).not.toThrow();
    expect(on.deletesFrom).toBeDefined();
  });
});

describe("turning the switches on for tests", () => {
  test("is refused where the database is not on this machine, as on the server", () => {
    expect(testSwitchesOn({}, "db")).toBe(false);
    expect(testSwitchesOn({ AQ_TEST_SWITCHES: "on" }, "127.0.0.1")).toBe(true);
    expect(testSwitchesOn({ AQ_TEST_SWITCHES: "on" }, "localhost")).toBe(true);
    expect(() => testSwitchesOn({ AQ_TEST_SWITCHES: "on" }, "db")).toThrow(/AQ_TEST_SWITCHES/);
    expect(() => testSwitchesOn({ AQ_TEST_SWITCHES: "on" }, "postgres.example.com")).toThrow();
  });
});
