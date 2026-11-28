import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";
import {
  LIMIT_KEY_LIST,
  LIMIT_KEYS,
  NO_LIMITS,
  allOf,
  fixedLimits,
  parseLimits,
} from "./limits.ts";

/** The registry of limits (limits.ts), and AQ_LIMITS, which a server of its own goes by. */

const GIB = 1024 ** 3;
const db = undefined as never;

describe("the registry of limits", () => {
  test("each limit says where it is checked, and that file asks for it", () => {
    for (const key of LIMIT_KEY_LIST) {
      const { checks } = LIMIT_KEYS[key];
      expect(checks.length, key).toBeGreaterThan(0);
      for (const check of checks) {
        expect(check, key).toMatch(/^(server|platform):[\w/.-]+\.ts$/);
        if (!check.startsWith("server:")) continue;
        const text = readFileSync(new URL(check.slice("server:".length), import.meta.url), "utf8");
        expect(text.includes(`"${key}"`), `${check} asks for ${key}`).toBe(true);
      }
    }
  });

  test("what is not given is not limited; all of them at once are what each one is", async () => {
    expect(await NO_LIMITS.of(db, "u", "storage.platform")).toBeNull();
    expect(NO_LIMITS.scope).toBe("server");
    const limits = fixedLimits({ "storage.platform": 5 * GIB, "ai.workspaces": 0 });
    expect(limits.scope).toBe("person");
    expect(await limits.of(db, "u", "storage.platform")).toBe(5 * GIB);
    expect(await limits.of(db, "u", "ai.workspaces")).toBe(0);
    expect(await limits.of(db, "u", "chat.images")).toBeNull();
    const all = await limits.all(db, "u");
    expect(Object.keys(all).toSorted()).toEqual([...LIMIT_KEY_LIST].toSorted());
    expect(await allOf(limits, db, "u")).toEqual(all);
  });
});

describe("AQ_LIMITS", () => {
  test("numbers, bytes with units, and null", () => {
    expect(parseLimits(undefined)).toEqual({ values: {}, problems: [] });
    expect(parseLimits("  ")).toEqual({ values: {}, problems: [] });
    expect(
      parseLimits(
        JSON.stringify({
          "storage.platform": "20GB",
          "chat.images": "500 MiB",
          "chat.history": "1.5kb",
          "storage.cloud": 1024,
          "lfs.downloads.daily": "2tb",
          "ai.workspaces": 2,
          "ai.minutes.monthly": 0,
          "ai.memory": null,
        }),
      ),
    ).toEqual({
      values: {
        "storage.platform": 20 * GIB,
        "chat.images": 500 * 1024 ** 2,
        "chat.history": 1536,
        "storage.cloud": 1024,
        "lfs.downloads.daily": 2 * 1024 * GIB,
        "ai.workspaces": 2,
        "ai.minutes.monthly": 0,
        "ai.memory": null,
      },
      problems: [],
    });
  });

  test("anything wrong is said, every one of it, by name", () => {
    expect(parseLimits("{").problems).toEqual(["AQ_LIMITS has to be a JSON object"]);
    expect(parseLimits("[1]").problems).toEqual(["AQ_LIMITS has to be a JSON object"]);
    expect(parseLimits("5").problems).toEqual(["AQ_LIMITS has to be a JSON object"]);
    const { values, problems } = parseLimits(
      JSON.stringify({
        "storage.plat": "1GB",
        "storage.platform": "20 parsecs",
        "projects.count": "500",
        "ai.workspaces": 1.5,
        "chat.images": -1,
        "chat.history": true,
        "ai.memory": "4GB",
      }),
    );
    expect(values).toEqual({ "ai.memory": 4 * GIB });
    expect(problems).toHaveLength(6);
    expect(problems[0]).toMatch(/^AQ_LIMITS: storage\.plat is no limit/);
    expect(problems.slice(1)).toEqual([
      "AQ_LIMITS: storage.platform has to be bytes, like 20GB, 500MB or 1048576",
      "AQ_LIMITS: projects.count has to be a whole number, 0 or more",
      "AQ_LIMITS: ai.workspaces has to be a whole number, 0 or more",
      "AQ_LIMITS: chat.images has to be bytes, like 20GB, 500MB or 1048576",
      "AQ_LIMITS: chat.history has to be bytes, like 20GB, 500MB or 1048576",
    ]);
  });

  test("the server does not start with one written wrong, and goes by one written right", () => {
    const load = (AQ_LIMITS: string) => loadConfig({ AQ_LIMITS }, () => undefined);
    expect(() => load('{"storage.platform":"lots"}')).toThrow(ConfigError);
    expect(() => load('{"nothing":1}')).toThrow(/AQ_LIMITS: nothing is no limit/);
    expect(load('{"storage.platform":"20GB","ai.workspaces":2}').limits).toEqual({
      "storage.platform": 20 * GIB,
      "ai.workspaces": 2,
    });
    expect(loadConfig({}, () => undefined).limits).toEqual({});
  });
});
