import { CloudSignedOut, type CloudRename, type CloudWake } from "@animaquill/host";
import { describe, expect, test } from "vitest";
import { OnlineNames } from "./online-names.ts";

/** A browser that says whether it has a network, and tells as that changes. */
class Network {
  onLine = true;
  readonly #listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    this.#listeners.set(type, (this.#listeners.get(type) ?? new Set()).add(listener));
  }
  removeEventListener(type: string, listener: () => void) {
    this.#listeners.get(type)?.delete(listener);
  }
  go(onLine: boolean) {
    this.onLine = onLine;
    for (const listener of this.#listeners.get(onLine ? "online" : "offline") ?? []) listener();
  }
}

/** The platform as the start page reaches it: each answer as a test says it. */
const platformOf = (answers: (CloudRename | Error)[], woken: (CloudWake | Error)[] = []) => {
  const asked: string[] = [];
  return {
    asked,
    cloud: {
      rename: async (project: string, name: string) => {
        asked.push(`rename ${project} ${name}`);
        const answer = answers.shift() ?? { kind: "renamed", name };
        if (answer instanceof Error) throw answer;
        return answer;
      },
      wake: async (project: string) => {
        asked.push(`wake ${project}`);
        const answer = woken.shift() ?? { copy: "live" as const };
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
};

const namesWith = (platform: ReturnType<typeof platformOf>, network = new Network()) => {
  const refreshed: number[] = [];
  let time = 0;
  const names = new OnlineNames({
    cloud: () => platform.cloud,
    refresh: async () => {
      refreshed.push(time);
    },
    network,
    sleep: async (ms) => {
      time += ms;
    },
    now: () => time,
    askEveryMs: 1000,
    wakeMs: 10_000,
  });
  return { names, refreshed, network };
};

describe("renaming projects of the platform from the start page", () => {
  test("shows the new name until the platform has it, and the list says it before it stops", async () => {
    const platform = platformOf([]);
    const { names, refreshed } = namesWith(platform);
    const seen: (string | undefined)[] = [];
    names.subscribe(() => seen.push(names.getSnapshot().pending.get("p1")?.name));
    const done = names.rename("p1", "  宣传片 ");
    expect(names.getSnapshot().pending.get("p1")).toEqual({ name: "宣传片", state: "saving" });
    expect(await done).toBe("renamed");
    expect(platform.asked).toEqual(["rename p1 宣传片"]);
    expect(refreshed).toHaveLength(1);
    expect(names.getSnapshot().pending.size).toBe(0);
    expect(seen).toEqual(["宣传片", undefined]);
  });

  test("says why where the platform does not take it, and the old name is back", async () => {
    for (const [answer, outcome] of [
      [{ kind: "refused", why: "locked" }, "locked"],
      [{ kind: "refused", why: "unusable" }, "unusable"],
      [{ kind: "missing" }, "missing"],
      [{ copy: "released", refused: "noRepository" }, "notBack"],
      [new CloudSignedOut("out"), "signedOut"],
      [new Error("500"), "failed"],
    ] as const) {
      const { names, refreshed } = namesWith(platformOf([answer as CloudRename | Error]));
      expect(await names.rename("p1", "宣传片"), JSON.stringify(answer)).toBe(outcome);
      expect(names.getSnapshot().pending.size).toBe(0);
      expect(refreshed).toEqual([]);
    }
  });

  test("a copy that was let go of comes back first, and is renamed then", async () => {
    const platform = platformOf(
      [{ kind: "waking" }],
      [{ copy: "restoring" }, { copy: "restoring" }, { copy: "live" }],
    );
    const { names } = namesWith(platform);
    const states: (string | undefined)[] = [];
    names.subscribe(() => states.push(names.getSnapshot().pending.get("p1")?.state));
    expect(await names.rename("p1", "宣传片")).toBe("renamed");
    expect(platform.asked).toEqual([
      "rename p1 宣传片",
      "wake p1",
      "wake p1",
      "wake p1",
      "rename p1 宣传片",
    ]);
    expect(states).toEqual(["saving", "waking", undefined]);
  });

  test("one that does not come back in time, or cannot, is not renamed", async () => {
    const slow = platformOf(
      [{ kind: "waking" }],
      Array.from({ length: 20 }, () => ({ copy: "restoring" as const })),
    );
    expect(await namesWith(slow).names.rename("p1", "宣传片")).toBe("notBack");
    const never = platformOf([{ kind: "waking" }], [{ copy: "released", refused: "unusable" }]);
    expect(await namesWith(never).names.rename("p1", "宣传片")).toBe("notBack");
  });

  test("without a network nothing is sent, and a request that finds the network gone says so", async () => {
    const network = new Network();
    const platform = platformOf([new Error("Failed to fetch")]);
    const { names } = namesWith(platform, network);
    const online: boolean[] = [];
    names.subscribe(() => online.push(names.getSnapshot().online));
    network.go(false);
    expect(names.getSnapshot().online).toBe(false);
    expect(await names.rename("p1", "宣传片")).toBe("offline");
    expect(platform.asked).toEqual([]);
    network.go(true);
    // It went while the request was on its way.
    const going = names.rename("p1", "宣传片");
    network.onLine = false;
    expect(await going).toBe("offline");
    expect(names.getSnapshot().online).toBe(false);
    expect(online).toContain(true);
  });

  test("of two renames of a project, the later one is what the card shows", async () => {
    let answerFirst: (said: CloudRename) => void = () => {};
    const asked: string[] = [];
    const names = new OnlineNames({
      cloud: () => ({
        rename: (project, name) => {
          asked.push(name);
          return asked.length === 1
            ? new Promise<CloudRename>((resolve) => {
                answerFirst = resolve;
              })
            : Promise.resolve({ kind: "renamed", name });
        },
      }),
      refresh: async () => {},
    });
    const first = names.rename("p1", "一");
    const second = names.rename("p1", "二");
    expect(names.getSnapshot().pending.get("p1")?.name).toBe("二");
    expect(await second).toBe("renamed");
    answerFirst({ kind: "renamed", name: "一" });
    expect(await first).toBe("renamed");
    expect(names.getSnapshot().pending.size).toBe(0);
  });
});
