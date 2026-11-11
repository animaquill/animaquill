import {
  CloudSignedOut,
  MemoryCloudLinks,
  type AccountAccess,
  type AccountSnapshot,
  type CloudLink,
  type CloudProjectSummary,
  type FolderRecord,
  type LocalFolder,
  type ProjectSummary,
} from "@animaquill/host";
import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import {
  StartList,
  cloudRowNotes,
  composeStartList,
  markHint,
  markText,
  type StartInput,
} from "./start-list.ts";

/** What the start page lists, see the design of the start page, 2. */

const t = createInstance();
await t.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } } });

const PLATFORM = "https://platform.test";

const folder = (id: string, name: string, openedAt = 1): FolderRecord => ({
  id,
  folder: { name: `文件夹 ${id}` } as LocalFolder,
  project: `project-of-${id}`,
  name,
  openedAt,
});
const kept = (id: string, name: string, more: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id,
  name,
  updatedAt: 10,
  ...more,
});
const link = (key: string, project: string, more: Partial<CloudLink> = {}): CloudLink => ({
  key,
  platform: PLATFORM,
  project,
  seq: 1,
  pushed: 1,
  linkedAt: 1,
  ...more,
});
const repository = (name: string, more: object = {}) => ({
  id: 7,
  owner: "ada",
  name,
  fullName: `ada/${name}`,
  private: true,
  url: `https://github.com/ada/${name}`,
  state: "ready" as const,
  ...more,
});
const listed = (
  id: string,
  name: string,
  more: Partial<CloudProjectSummary> = {},
): CloudProjectSummary => ({ id, name, updatedAt: 100, copy: "live", ...more });

const input = (more: Partial<StartInput>): StartInput => ({
  records: [],
  projects: [],
  platform: PLATFORM,
  links: [],
  listed: [],
  account: "user-ada",
  canDelete: true,
  ...more,
});

/** The lines as people read them: the name, the mark, and what else the line says. */
const read = (lists: ReturnType<typeof composeStartList>) => ({
  local: lists.local.map((row) => [row.name, row.mark ? markText(row.mark, t.t) : ""].join(" | ")),
  cloud: lists.cloud.map((row) =>
    [
      row.name,
      row.repository?.fullName ?? "",
      markText(row.mark, t.t),
      ...cloudRowNotes(row, t.t),
    ].join(" | "),
  ),
  browser: lists.browser.map((project) => project.name),
});

describe("the lists of the start page", () => {
  it("shows every project once: a folder, a project of the platform, or one of the browser", () => {
    const lists = composeStartList(
      input({
        records: [folder("f1", "原子是什么", 3), folder("f2", "产品介绍", 2)],
        projects: [
          // The logs of the folders are in the browser too, and are no projects of it.
          kept("f1", "原子是什么", { folder: true }),
          kept("f2", "产品介绍", { folder: true }),
          kept("p-annual", "年会视频"),
          kept("old", "旧项目"),
        ],
        links: [link("f1", "p-atom"), link("p-annual", "p-annual")],
        listed: [
          listed("p-opening", "片头动画", { repository: repository("opening") }),
          listed("p-atom", "原子是什么", { repository: repository("atom") }),
          listed("p-annual", "年会视频", { repository: repository("annual") }),
        ],
      }),
    );
    expect(read(lists)).toEqual({
      local: ["原子是什么 | ☁ 已连云端 · ada/atom", "产品介绍 | 仅本机"],
      cloud: [
        "片头动画 | ada/opening | ☁ 已连云端 · ada/opening",
        "年会视频 | ada/annual | ☁ 已连云端 · ada/annual | 在这个浏览器里打开过",
      ],
      browser: ["旧项目"],
    });
    // The folder is where its project of the platform is; the copy is where its project is.
    expect(lists.local[0]).toMatchObject({ key: "f1", project: "p-atom", folder: "文件夹 f1" });
    expect(lists.cloud[1]).toMatchObject({ project: "p-annual", key: "p-annual", listed: true });
    expect(lists.cloud[0]).toMatchObject({ key: undefined, updatedAt: 100, copy: "live" });
    // Nothing is in two places.
    const everything = [
      ...lists.local.map((row) => row.project ?? row.key),
      ...lists.cloud.map((row) => row.project),
      ...lists.browser.map((project) => project.id),
    ];
    expect(new Set(everything).size).toBe(everything.length);
  });

  it("says what this browser remembers where the platform's list cannot be read", () => {
    const base = {
      records: [folder("f1", "原子是什么"), folder("f2", "旧的云端项目"), folder("f3", "没问过")],
      projects: [
        kept("p-annual", "年会视频", { updatedAt: 5 }),
        kept("p-other", "片尾", { updatedAt: 9 }),
      ],
      links: [
        link("f1", "p-atom", { repository: { id: 7, fullName: "ada/atom" } }),
        link("f2", "p-legacy", { repository: null }),
        link("f3", "p-unasked"),
        link("p-annual", "p-annual", {
          repository: { id: 8, fullName: "ada/annual" },
          name: "年会视频",
          pending: 2,
        }),
        link("p-other", "p-other"),
      ],
    };
    const lists = composeStartList(input({ ...base, listed: "unreadable" }));
    expect(read(lists)).toEqual({
      local: [
        "原子是什么 | ☁ 已连云端 · ada/atom",
        "旧的云端项目 | 还差一步：选仓库",
        "没问过 | ☁ 已连云端",
      ],
      // The copies in this browser, which open without the platform: the most recent first.
      cloud: [
        "片尾 |  | ☁ 已连云端 | 在这个浏览器里打开过",
        "年会视频 | ada/annual | ☁ 已连云端 · ada/annual | 在这个浏览器里打开过 | 有改动还没同步",
      ],
      browser: [],
    });
    expect(lists.local[0]?.mark).toEqual({ kind: "linked", repository: "ada/atom", stale: true });
    expect(markHint(lists.local[0]!.mark!, t.t)).toBe(
      "云端的列表读不出来，这是这个浏览器上次记下的情况。",
    );
    expect(lists.cloud.every((row) => !row.listed && !row.needsSignIn && !row.deletable)).toBe(
      true,
    );
    // The same while the list is on its way.
    expect(read(composeStartList(input({ ...base, listed: "loading" })))).toEqual(read(lists));
  });

  it("still lists the copies of this browser while nobody is signed in, to sync once someone is", () => {
    const lists = composeStartList(
      input({
        records: [folder("f1", "原子是什么")],
        projects: [kept("p-annual", "年会视频")],
        links: [
          link("f1", "p-atom", { repository: { id: 7, fullName: "ada/atom" }, owner: "user-ada" }),
          link("p-annual", "p-annual", { owner: "user-ada", pending: 1 }),
        ],
        listed: "signedOut",
        account: undefined,
      }),
    );
    expect(read(lists)).toEqual({
      local: ["原子是什么 | ☁ 已连云端 · ada/atom"],
      cloud: ["年会视频 |  | ☁ 已连云端 | 在这个浏览器里打开过 | 有改动还没同步 | 登录后继续同步"],
      browser: [],
    });
    expect(lists.cloud[0]?.needsSignIn).toBe(true);
  });

  it("says that a project is of another account than the one that is signed in", () => {
    const lists = composeStartList(
      input({
        records: [folder("f1", "别人的"), folder("f2", "我的")],
        projects: [kept("p-theirs", "别人的副本")],
        links: [
          link("f1", "p-far", { owner: "user-bob", repository: { id: 1, fullName: "bob/far" } }),
          link("f2", "p-mine", { owner: "user-ada" }),
          link("p-theirs", "p-theirs", { owner: "user-bob" }),
        ],
        listed: [listed("p-mine", "我的", { repository: repository("mine") })],
        account: "user-ada",
      }),
    );
    expect(read(lists)).toEqual({
      local: ["别人的 | 是另一个账号的云端项目", "我的 | ☁ 已连云端 · ada/mine"],
      cloud: ["别人的副本 |  | 是另一个账号的云端项目 | 在这个浏览器里打开过"],
      browser: [],
    });
    expect(markHint({ kind: "otherAccount" }, t.t)).toBe(
      "它连着的云端项目属于另一个账号。换回那个账号登录才能同步，本机的内容照常能编辑。",
    );
    // Whose it is was never noted down, and the list does not have it: it may be gone there.
    const unknown = composeStartList(
      input({
        records: [folder("f1", "不知道是谁的")],
        links: [link("f1", "p-far")],
        listed: [],
      }),
    );
    expect(unknown.local[0]?.mark).toEqual({
      kind: "attention",
      reason: "missing",
      repository: undefined,
    });
    expect(read(unknown).local).toEqual(["不知道是谁的 | ☁ 要处理"]);
  });

  it("marks what people have to do something about, and what is one step short of connected", () => {
    const lists = composeStartList(
      input({
        records: [
          folder("f1", "存档停了"),
          folder("f2", "有冲突"),
          folder("f3", "有文件没并进来"),
          folder("f4", "新平台的词"),
          folder("f5", "改版前连的"),
          folder("f6", "连到一半"),
        ],
        links: [
          link("f1", "p1"),
          link("f2", "p2"),
          link("f3", "p3"),
          link("f4", "p4"),
          link("f5", "p5"),
          // The first version may not have got there: the platform's list does not have it.
          link("f6", "p6", { creating: true }),
        ],
        listed: [
          listed("p1", "存档停了", {
            repository: repository("one", { state: "paused", reason: "gone" }),
            attention: "repository",
          }),
          listed("p2", "有冲突", { repository: repository("two"), attention: "conflicts" }),
          listed("p3", "有文件没并进来", { repository: repository("three"), attention: "blocked" }),
          listed("p4", "新平台的词", { repository: repository("four"), attention: "somethingNew" }),
          listed("p5", "改版前连的", { attention: "noRepository" }),
        ],
      }),
    );
    expect(read(lists).local).toEqual([
      "存档停了 | ☁ 要处理",
      "有冲突 | ☁ 要处理",
      "有文件没并进来 | ☁ 要处理",
      "新平台的词 | ☁ 要处理",
      "改版前连的 | 还差一步：选仓库",
      "连到一半 | 还差一步：选仓库",
    ]);
    expect(lists.local.map((row) => row.mark && markHint(row.mark, t.t))).toEqual([
      "仓库的存档停下了。打开项目，在云端面板里处理。",
      "GitHub 上的改动和项目里的改动冲突了。打开项目处理。",
      "GitHub 上有文件没能并进来。打开项目处理。",
      "云端有事要处理。打开项目，在云端面板里看。",
      "这个项目已经在云端，还没选仓库。打开项目接着选。",
      "这个项目已经在云端，还没选仓库。打开项目接着选。",
    ]);
    expect(lists.local[0]?.mark).toMatchObject({ reason: "repository", repository: "ada/one" });
    // One on its way there has everything of it only here.
    expect(lists.local.map((row) => row.pending)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(lists.cloud).toEqual([]);
  });

  it("lists a project of the platform without a repository as one that can be taken away there", () => {
    const base = {
      listed: [
        listed("p5", "改版前连的", { attention: "noRepository" }),
        listed("p6", "有仓库的", { repository: repository("six") }),
        listed("p7", "要取回的", { repository: repository("seven"), copy: "released" }),
      ],
    };
    const lists = composeStartList(input(base));
    expect(read(lists).cloud).toEqual([
      "改版前连的 |  | 还差一步：选仓库",
      "有仓库的 | ada/six | ☁ 已连云端 · ada/six",
      "要取回的 | ada/seven | ☁ 已连云端 · ada/seven | 要先从仓库取回",
    ]);
    expect(lists.cloud.map((row) => row.deletable)).toEqual([true, false, false]);
    expect(lists.cloud[1]?.repository).toEqual({
      fullName: "ada/six",
      url: "https://github.com/ada/six",
    });
    // Where the platform takes none away, none can be.
    const without = composeStartList(input({ ...base, canDelete: false }));
    expect(without.cloud.map((row) => row.deletable)).toEqual([false, false, false]);
  });

  it("takes a platform that says nothing about repositories as it is", () => {
    const lists = composeStartList(
      input({
        records: [folder("f1", "原子是什么"), folder("f2", "旧的")],
        projects: [kept("p3", "年会视频")],
        links: [
          link("f1", "p1", { repository: { id: 7, fullName: "ada/atom" } }),
          link("f2", "p2", { repository: null }),
          link("p3", "p3"),
        ],
        // As a platform from before lists them: an id, a name and a time.
        listed: [
          { id: "p1", name: "原子是什么", updatedAt: 3 },
          { id: "p2", name: "旧的", updatedAt: 2 },
          { id: "p3", name: "年会视频", updatedAt: 1 },
        ],
      }),
    );
    expect(read(lists)).toEqual({
      local: ["原子是什么 | ☁ 已连云端 · ada/atom", "旧的 | 还差一步：选仓库"],
      cloud: ["年会视频 |  | ☁ 已连云端 | 在这个浏览器里打开过"],
      browser: [],
    });
    expect(lists.cloud[0]).toMatchObject({ copy: "live", deletable: false });
  });

  it("hides nothing: a link to nothing says nothing, and a second copy is a project of the browser", () => {
    const lists = composeStartList(
      input({
        records: [folder("f1", "原子是什么")],
        projects: [
          kept("copy-a", "副本甲", { updatedAt: 2 }),
          kept("copy-b", "副本乙", { updatedAt: 1 }),
          kept("also-atom", "原子的另一份"),
        ],
        links: [
          link("f1", "p-atom"),
          // What a page that went away left behind: a link without a project.
          link("gone", "p-gone"),
          // Two copies of one project of the platform, and a copy of a project that has a folder,
          // which should not be: neither may disappear.
          link("copy-a", "p-twice"),
          link("copy-b", "p-twice"),
          link("also-atom", "p-atom"),
          // A link to another platform is not one of this one.
          { ...link("elsewhere", "p-x"), platform: "https://other.test" },
        ],
        listed: [
          listed("p-atom", "原子是什么"),
          listed("p-twice", "两份"),
          listed("p-gone", "没了"),
        ],
      }),
    );
    expect(read(lists)).toEqual({
      local: ["原子是什么 | ☁ 已连云端"],
      cloud: ["两份 |  | ☁ 已连云端 | 在这个浏览器里打开过", "没了 |  | ☁ 已连云端"],
      browser: ["副本乙", "原子的另一份"],
    });
    expect(lists.cloud[0]?.key).toBe("copy-a");
  });

  it("shows no project of the browser, and no copy, where the folders cannot be told from them", () => {
    const lists = composeStartList(
      input({
        records: undefined,
        projects: [kept("f1", "其实是文件夹"), kept("p2", "副本")],
        links: [link("f1", "p1"), link("p2", "p2")],
        listed: [listed("p1", "原子"), listed("p2", "副本"), listed("p3", "没在这里开过")],
      }),
    );
    // Opening one of those from the platform could make a second copy of what a folder has.
    expect(read(lists)).toEqual({
      local: [],
      cloud: ["没在这里开过 |  | ☁ 已连云端"],
      browser: [],
    });
  });

  it("has no word about a platform where the editor is hosted on none", () => {
    const lists = composeStartList(
      input({
        platform: undefined,
        records: [folder("f1", "原子是什么")],
        projects: [kept("b1", "浏览器里的")],
        links: [],
        listed: "loading",
        account: undefined,
        canDelete: false,
      }),
    );
    expect(lists.local[0]?.mark).toBeUndefined();
    expect(lists.cloud).toEqual([]);
    expect(lists.browser.map(({ name }) => name)).toEqual(["浏览器里的"]);
  });
});

/** An account whose state a test sets. */
function account(start: AccountSnapshot) {
  let snapshot = start;
  const listeners = new Set<() => void>();
  let asked = 0;
  const access: AccountAccess & { set(next: AccountSnapshot): void; readonly asked: number } = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    refresh: async () => {
      asked += 1;
    },
    takeOutcome: () => undefined,
    signIn: () => {},
    installApp: () => {},
    signOut: async () => {},
    set(next) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    get asked() {
      return asked;
    },
  };
  return access;
}

const ADA: AccountSnapshot = {
  status: "signedIn",
  id: "user-ada",
  name: "ada",
  appInstalled: true,
};

/** A browser with a platform whose list a test sets, and can keep from answering. */
function setUp(who = account(ADA)) {
  const links = new MemoryCloudLinks();
  const world = {
    records: [folder("f1", "原子是什么")] as FolderRecord[],
    projects: [kept("f1", "原子是什么", { folder: true }), kept("p-annual", "年会视频")],
    listed: [
      listed("p-atom", "原子是什么", { repository: repository("atom") }),
      listed("p-annual", "年会视频", { repository: repository("annual") }),
    ] as CloudProjectSummary[] | Error,
    asked: 0,
    hold: undefined as Promise<void> | undefined,
  };
  const list = new StartList({
    projects: { list: async () => world.projects },
    records: { list: async () => world.records },
    cloud: {
      platform: PLATFORM,
      links,
      list: async () => {
        world.asked += 1;
        await world.hold;
        if (world.listed instanceof Error) throw world.listed;
        return world.listed;
      },
      remove: async () => "removed",
    },
    account: who,
  });
  return { list, links, world, who };
}

describe("StartList", () => {
  it("shows what this computer has at once, and the platform's list when it comes", async () => {
    const { list, links, world } = setUp();
    await links.put(link("f1", "p-atom"));
    await links.put(link("p-annual", "p-annual"));
    expect(list.getSnapshot()).toMatchObject({ loading: true, cloudState: "loading" });
    let arrive = () => {};
    world.hold = new Promise((resolve) => {
      arrive = resolve;
    });
    const seen: string[] = [];
    list.subscribe(() => {
      const snapshot = list.getSnapshot();
      seen.push(
        `${snapshot.cloudState}: ${read(snapshot).local.join()} / ${read(snapshot).cloud.join()}`,
      );
    });
    const refreshed = list.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Before the platform answered: the folder and the copy, by what the links remember.
    expect(list.getSnapshot().loading).toBe(false);
    expect(seen).toEqual([
      "loading: 原子是什么 | ☁ 已连云端 / 年会视频 |  | ☁ 已连云端 | 在这个浏览器里打开过",
    ]);
    arrive();
    await refreshed;
    expect(seen.at(-1)).toBe(
      "ready: 原子是什么 | ☁ 已连云端 · ada/atom / 年会视频 | ada/annual | ☁ 已连云端 · ada/annual | 在这个浏览器里打开过",
    );
    expect(list.getSnapshot().failed).toEqual({ projects: false, folders: false, links: false });
  });

  it("has the links remember what the list said, for when it cannot be read", async () => {
    const { list, links, world } = setUp();
    await links.put(link("f1", "p-atom"));
    await links.put(link("p-annual", "p-annual", { name: "旧名字" }));
    await list.refresh();
    expect(await links.get("f1")).toMatchObject({
      name: "原子是什么",
      repository: { id: 7, fullName: "ada/atom" },
      owner: "user-ada",
    });
    expect((await links.get("p-annual"))?.name).toBe("年会视频");
    // The platform goes away: the list says so, and shows what it remembers.
    world.listed = new Error("offline");
    await list.refresh();
    expect(list.getSnapshot().cloudState).toBe("unreadable");
    expect(read(list.getSnapshot())).toMatchObject({
      local: ["原子是什么 | ☁ 已连云端 · ada/atom"],
      cloud: ["年会视频 | ada/annual | ☁ 已连云端 · ada/annual | 在这个浏览器里打开过"],
    });
    // A repository that is gone on the platform is forgotten here too.
    world.listed = [listed("p-atom", "原子是什么", { attention: "noRepository" })];
    await list.refresh();
    expect((await links.get("f1"))?.repository).toBeNull();
    // Nothing is written where nothing is new.
    const before = JSON.stringify([...links.links.values()]);
    await list.refresh();
    expect(JSON.stringify([...links.links.values()])).toBe(before);
  });

  it("asks the platform nothing while nobody is signed in, and reads the list once someone is", async () => {
    const who = account({ status: "signedOut" });
    const { list, links, world } = setUp(who);
    await links.put(link("p-annual", "p-annual", { pending: 3 }));
    await list.refresh();
    expect(world.asked).toBe(0);
    expect(list.getSnapshot().cloudState).toBe("signedOut");
    expect(read(list.getSnapshot()).cloud).toEqual([
      "年会视频 |  | ☁ 已连云端 | 在这个浏览器里打开过 | 有改动还没同步 | 登录后继续同步",
    ]);
    // Somebody signs in: the list is read without anybody asking for it.
    who.set(ADA);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.asked).toBe(1);
    expect(list.getSnapshot().cloudState).toBe("ready");
    // No folder here is connected to the first one: it is a project of the platform to open.
    expect(read(list.getSnapshot()).cloud).toEqual([
      "原子是什么 | ada/atom | ☁ 已连云端 · ada/atom",
      "年会视频 | ada/annual | ☁ 已连云端 · ada/annual | 在这个浏览器里打开过 | 有改动还没同步",
    ]);
    // A session that ended on the platform, whatever the account still says.
    world.listed = new CloudSignedOut("Nobody is signed in");
    await list.refresh();
    expect(list.getSnapshot().cloudState).toBe("signedOut");
  });

  it("finds out who is signed in first, and takes not knowing for a platform that is away", async () => {
    const who = account({ status: "unknown" });
    const { list, world } = setUp(who);
    await list.refresh();
    expect(who.asked).toBe(1);
    expect(world.asked).toBe(0);
    expect(list.getSnapshot().cloudState).toBe("unreadable");
  });

  it("says what of this computer could not be read, rather than that there is nothing", async () => {
    const { list, world } = setUp();
    world.projects = undefined as never;
    const failing = new StartList({
      projects: {
        list: async () => {
          throw new Error("blocked");
        },
      },
      records: {
        list: async () => {
          throw new Error("blocked");
        },
      },
    });
    await failing.refresh();
    expect(failing.getSnapshot()).toMatchObject({
      loading: false,
      cloudState: "none",
      local: [],
      browser: [],
      failed: { projects: true, folders: true, links: false },
    });
    list.close();
  });

  it("only counts the last time it was asked to read everything", async () => {
    const { list, world } = setUp();
    let arrive = () => {};
    world.hold = new Promise((resolve) => {
      arrive = resolve;
    });
    const first = list.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // People made a project meanwhile, and the page asks again.
    world.hold = undefined;
    world.records = [folder("f2", "新项目", 9), ...world.records];
    await list.refresh();
    arrive();
    await first;
    expect(read(list.getSnapshot()).local).toEqual(["新项目 | 仅本机", "原子是什么 | 仅本机"]);
    expect(list.getSnapshot().cloudState).toBe("ready");
  });
});
