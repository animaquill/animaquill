import type { AccountAccess, AccountSnapshot, PlatformSpace } from "@animaquill/host";
import { CloudSignedOut } from "@animaquill/host";
import { describe, expect, it } from "vitest";
import { t as i18n } from "../cloud/projects-support.ts";

const t = i18n.t.bind(i18n);
import {
  PlatformSpaceState,
  formatPlatformBytes,
  fullBy,
  fullTitle,
  hasRoom,
  isNearlyFull,
  isOver,
  releaseBlockText,
} from "./platform-space.ts";

/**
 * What the person keeps on the platform, as the storage page, the side bar, the menus of the cards
 * and the dialog that says it is full read it (docs/design/online-offline.md of AnimaQuill Cloud,
 * 3.6).
 */

const GB = 1024 ** 3;
const spaceOf = (used: number, limit: number | null, count = 1, most: number | null = 500) =>
  ({
    limit,
    used,
    count: { limit: most, used: count },
    projects: [],
  }) satisfies PlatformSpace;

describe("what is kept on the platform", () => {
  it("says bytes by 1024, as limits are set, and what is used with its decimal", () => {
    expect(formatPlatformBytes(5 * GB)).toBe("5 GB");
    expect(formatPlatformBytes(5 * GB, { exact: true })).toBe("5.0 GB");
    expect(formatPlatformBytes(3.2 * GB)).toBe("3.2 GB");
    expect(formatPlatformBytes(512)).toBe("512 B");
    expect(formatPlatformBytes(1536 * 1024)).toBe("1.5 MB");
    expect(fullTitle("storage", spaceOf(5 * GB, 5 * GB), t)).toBe("平台存储满了（5.0 GB / 5 GB）");
    expect(fullTitle("count", spaceOf(0, 5 * GB, 500), t)).toBe("在线项目数满了（500 / 500）");
  });

  it("is nearly full from 90% of the bytes or of the projects, and over only beyond", () => {
    expect(isNearlyFull(spaceOf(4.4 * GB, 5 * GB))).toBe(false);
    expect(isNearlyFull(spaceOf(4.5 * GB, 5 * GB))).toBe(true);
    expect(isNearlyFull(spaceOf(0, 5 * GB, 450))).toBe(true);
    // No limit, as on a server of one's own: never.
    expect(isNearlyFull(spaceOf(100 * GB, null, 10_000, null))).toBe(false);
    expect(isOver(spaceOf(5 * GB, 5 * GB))).toBe(false);
    expect(isOver(spaceOf(5 * GB + 1, 5 * GB))).toBe(true);
    expect(isOver(spaceOf(0, 5 * GB, 501))).toBe(true);
    expect(isOver(undefined)).toBe(false);
  });

  it("tells what keeps one more project out, the platform's word first", () => {
    expect(fullBy(spaceOf(5 * GB, 5 * GB, 500))).toBe("count");
    expect(fullBy(spaceOf(5 * GB, 5 * GB, 10))).toBe("storage");
    expect(fullBy(spaceOf(0, 5 * GB, 500), "storage")).toBe("storage");
    expect(hasRoom(spaceOf(4 * GB, 5 * GB, 10))).toBe(true);
    expect(hasRoom(spaceOf(4 * GB, 5 * GB, 10), 2 * GB)).toBe(false);
    expect(hasRoom(spaceOf(0, 5 * GB, 500))).toBe(false);
    expect(hasRoom(undefined)).toBe(true);
  });

  it("says why a copy is not let go of, and what helps", () => {
    expect(releaseBlockText({ code: "conflicts", count: 2 }, t)).toEqual({
      text: "有 2 处冲突没处理",
      fix: "open",
    });
    expect(releaseBlockText({ code: "failing", failures: 3, detail: "502" }, t)).toEqual({
      text: "存进 GitHub 失败：502",
      fix: "open",
    });
    expect(releaseBlockText({ code: "noRepository" }, t).fix).toBe("saveToFolder");
    expect(releaseBlockText({ code: "pending" }, t).fix).toBeUndefined();
    expect(releaseBlockText({ code: "repository", reason: "gone" }, t)).toMatchObject({
      fix: "open",
    });
    expect(releaseBlockText({ code: "repository", reason: "unreachable" }, t).fix).toBeUndefined();
    expect(releaseBlockText({ code: "paused", reason: "archived" }, t).text).toMatch(
      /^存进 GitHub 停了：/,
    );
    // Of a newer platform: said as it is.
    expect(releaseBlockText({ code: "later" }, t).text).toBe("现在不能释放（later）。");
  });

  it("reads it from the account, for whoever is signed in only", async () => {
    let snapshot: AccountSnapshot = {
      status: "signedIn",
      id: "a",
      name: "ada",
      appInstalled: true,
    };
    const listeners = new Set<() => void>();
    let said: PlatformSpace | Error = spaceOf(1, 10);
    let now = 0;
    const account: AccountAccess = {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
      refresh: async () => {},
      takeOutcome: () => undefined,
      signIn: () => {},
      installApp: () => {},
      signOut: async () => {},
      space: async () => {
        if (said instanceof Error) throw said;
        return { mode: "off", limit: 0, used: 0, platform: said };
      },
    };
    const state = new PlatformSpaceState(account, () => now);
    expect(state.getSnapshot().status).toBe("loading");
    await state.refresh();
    expect(state.getSnapshot()).toEqual({ status: "ready", space: spaceOf(1, 10) });
    // Asked again only after a while, where that is enough.
    said = spaceOf(2, 10);
    await state.refresh({ fresh: true });
    expect(state.getSnapshot().space?.used).toBe(1);
    now = 60_000;
    await state.refresh({ fresh: true });
    expect(state.getSnapshot().space?.used).toBe(2);
    // Somebody else: nothing of the one before.
    snapshot = { status: "signedIn", id: "b", name: "bob", appInstalled: true };
    for (const listener of listeners) listener();
    expect(state.getSnapshot()).toEqual({ status: "loading", space: undefined });
    said = new CloudSignedOut("gone");
    await state.refresh();
    expect(state.getSnapshot().status).toBe("signedOut");
  });
});
