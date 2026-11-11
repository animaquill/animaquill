import { CloudSignedOut, RepositoryRefused, type RepositoryChoice } from "@animaquill/host";
import { describe, expect, it } from "vitest";
import { RepositoryPicker } from "./repository-picker.ts";
import { FakeRepositories } from "./repository-support.ts";

const choice = (id: number, more: Partial<RepositoryChoice> = {}): RepositoryChoice => ({
  id,
  owner: "ada",
  name: `repo-${id}`,
  fullName: `ada/repo-${id}`,
  private: true,
  pushable: true,
  empty: true,
  archived: false,
  linked: false,
  ...more,
});

function setUp() {
  const platform = new FakeRepositories();
  const picker = new RepositoryPicker({ access: platform, project: "p1", name: "project_abc" });
  return { platform, picker };
}

describe("RepositoryPicker", () => {
  it("makes a new private repository by a name GitHub takes", async () => {
    const { platform, picker } = setUp();
    expect(picker.getSnapshot()).toMatchObject({ mode: "create", name: "project_abc" });
    expect(picker.canSubmit).toBe(true);
    picker.setName("我的片子");
    expect(picker.getSnapshot().nameProblem).toBe("characters");
    expect(picker.canSubmit).toBe(false);
    expect(await picker.submit()).toBeUndefined();
    expect(platform.links).toEqual([]);

    picker.setName(" my-film ");
    expect(picker.canSubmit).toBe(true);
    const status = await picker.submit();
    expect(platform.links).toEqual([{ create: { name: "my-film" } }]);
    expect(status?.repository?.fullName).toBe("ada/my-film");
    expect(picker.getSnapshot().linked).toBe(status);
  });

  it("says a name is taken, and stays for another one", async () => {
    const { platform, picker } = setUp();
    platform.refuse.link = new RepositoryRefused("nameTaken");
    expect(await picker.submit()).toBeUndefined();
    expect(picker.getSnapshot()).toMatchObject({ failure: "nameTaken", working: false });
    picker.setName("another");
    expect(picker.getSnapshot().failure).toBeUndefined();
    expect(await picker.submit()).toBeDefined();
  });

  it("lists what the App may touch, greys out what cannot be chosen, and says why", async () => {
    const { platform, picker } = setUp();
    platform.repositories = [
      choice(1),
      choice(2, { pushable: false }),
      choice(3, { archived: true }),
      choice(4, { linked: true }),
      choice(5, { private: false }),
    ];
    picker.setMode("existing");
    await Promise.resolve();
    await picker.refresh();
    const { list } = picker.getSnapshot();
    expect(list).toMatchObject({ state: "ready", manageUrl: platform.manageUrl });
    expect(list.repositories.map((each) => picker.unusable(each))).toEqual([
      undefined,
      "notPushable",
      "archived",
      "linked",
      undefined,
    ]);
    picker.select(2);
    expect(picker.getSnapshot().selected).toBeUndefined();

    // A project at its top only shows when people try it.
    picker.select(1);
    expect(picker.canSubmit).toBe(true);
    platform.refuse.link = new RepositoryRefused("hasProject", {
      files: ["animaquill.json", "timelines"],
    });
    expect(await picker.submit()).toBeUndefined();
    const snapshot = picker.getSnapshot();
    expect(snapshot.selected).toBeUndefined();
    expect(snapshot.refused.get(1)).toEqual({
      code: "hasProject",
      files: ["animaquill.json", "timelines"],
    });
    expect(picker.unusable(choice(1))).toBe("hasProject");
  });

  it("takes a public repository only once people said yes to it", async () => {
    const { platform, picker } = setUp();
    platform.repositories = [choice(5, { private: false })];
    picker.setMode("existing");
    await picker.refresh();
    picker.select(5);
    expect(picker.canSubmit).toBe(false);
    picker.confirmPublic(true);
    expect(picker.canSubmit).toBe(true);
    await picker.submit();
    expect(platform.links).toEqual([{ existing: { id: 5 }, confirmPublic: true }]);
  });

  it("says where the App is not installed, from the list or from trying", async () => {
    const { platform, picker } = setUp();
    platform.refuse.list = new RepositoryRefused("notInstalled");
    await picker.refresh();
    expect(picker.getSnapshot().notInstalled).toBe(true);
    expect(picker.canSubmit).toBe(false);

    const other = setUp();
    other.platform.refuse.link = new RepositoryRefused("notInstalled");
    await other.picker.submit();
    expect(other.picker.getSnapshot()).toMatchObject({ notInstalled: true, failure: undefined });
  });

  it("pages through a long list, and starts over on refresh", async () => {
    const { platform, picker } = setUp();
    platform.page = 2;
    platform.repositories = [choice(1), choice(2), choice(3)];
    await picker.refresh();
    expect(picker.getSnapshot().list).toMatchObject({ page: 1, more: true });
    await picker.more();
    expect(picker.getSnapshot().list.repositories.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(picker.getSnapshot().list.more).toBe(false);
    platform.repositories = [choice(4)];
    await picker.refresh();
    expect(picker.getSnapshot().list.repositories.map(({ id }) => id)).toEqual([4]);
  });

  it("does not offer the repository the project goes to now, in place of which people choose another", async () => {
    const platform = new FakeRepositories();
    platform.repositories = [choice(1, { linked: true }), choice(2)];
    const picker = new RepositoryPicker({
      access: platform,
      project: "p1",
      name: "x",
      current: {
        id: 1,
        owner: "ada",
        name: "repo-1",
        fullName: "ada/repo-1",
        private: true,
        branch: "main",
        url: "",
        createdHere: true,
        linkedAt: 1,
      },
    });
    await picker.refresh();
    expect(picker.getSnapshot().list.repositories.map((each) => picker.unusable(each))).toEqual([
      "current",
      undefined,
    ]);
  });

  it("says when people have to sign in again", async () => {
    const { platform, picker } = setUp();
    platform.refuse.link = new CloudSignedOut("gone");
    await picker.submit();
    expect(picker.getSnapshot().failure).toBe("signedOut");
  });

  it("asks the platform nothing about what people chose unless it was told to", async () => {
    const { platform, picker } = setUp();
    platform.repositories = [choice(1)];
    picker.setName("another");
    picker.setMode("existing");
    await picker.refresh();
    picker.select(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await picker.settled();
    expect(platform.checked).toEqual([]);
    expect(picker.getSnapshot()).toMatchObject({ checking: false, checked: false });
  });
});

describe("RepositoryPicker, asking before people go on", () => {
  /** A picker that asks right away, on a clock the test turns. */
  function asking(more: { canAsk?: () => boolean; project?: () => string | undefined } = {}) {
    const platform = new FakeRepositories();
    const timers: (() => void)[] = [];
    const picker = new RepositoryPicker({
      access: platform,
      project: more.project ?? "p1",
      name: "atom",
      precheck: {
        delayMs: 300,
        setTimeout: (run) => timers.push(run),
        clearTimeout: (timer) => {
          if (typeof timer === "number") timers[timer - 1] = () => {};
        },
        ...(more.canAsk && { canAsk: more.canAsk }),
      },
    });
    /** A moment passes: what was due runs, and what that set off settles. */
    const pass = async () => {
      for (;;) {
        const due = timers.splice(0);
        if (due.length === 0) break;
        for (const run of due) run();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    return { platform, picker, pass, timers };
  }

  it("asks once people stopped typing, and not for every letter", async () => {
    const { platform, picker, pass } = asking();
    picker.setName("m");
    picker.setName("my");
    picker.setName("my-film");
    expect(picker.getSnapshot()).toMatchObject({ checking: true, checked: false });
    await pass();
    expect(platform.checked).toEqual([{ create: { name: "my-film" } }]);
    expect(picker.getSnapshot()).toMatchObject({ checking: false, checked: true });
    // A name GitHub does not take needs no asking.
    picker.setName("我的片子");
    expect(picker.getSnapshot()).toMatchObject({ checking: false, checked: false });
    await pass();
    expect(platform.checked).toHaveLength(1);
  });

  it("only counts the answer about what people have chosen now", async () => {
    const { platform, picker, pass } = asking();
    let answer: (said: { ok: true } | { ok: false; reason: string }) => void = () => {};
    const check = platform.check.bind(platform);
    platform.check = (asked) =>
      "create" in asked && asked.create.name === "slow"
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : check(asked);
    picker.setName("slow");
    await pass();
    // They typed on while the platform was looking.
    picker.setName("fast");
    await pass();
    expect(picker.getSnapshot()).toMatchObject({ name: "fast", checked: true });
    answer({ ok: false, reason: "nameTaken" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(picker.getSnapshot()).toMatchObject({ nameProblem: undefined, checked: true });
  });

  it("says a name is not one GitHub takes where the platform finds that", async () => {
    const { platform, picker, pass } = asking();
    platform.check = async () => ({ ok: false, reason: "invalidName" });
    picker.setName("con");
    await pass();
    expect(picker.getSnapshot()).toMatchObject({ nameProblem: "refused", checking: false });
    expect(picker.canSubmit).toBe(false);
  });

  it("shows nothing where the platform could not say, and lets people try", async () => {
    const { platform, picker, pass } = asking();
    platform.refuse.check = new RepositoryRefused("unavailable");
    picker.setName("my-film");
    await pass();
    expect(picker.getSnapshot()).toMatchObject({
      checking: false,
      checked: false,
      nameProblem: undefined,
      failure: undefined,
    });
    expect(picker.canSubmit).toBe(true);
    // A reason it does not know is no reason either.
    platform.check = async () => ({ ok: false, reason: "somethingNew" });
    picker.setName("my-film-2");
    await pass();
    expect(picker.canSubmit).toBe(true);
    // That nobody is signed in is worth saying.
    platform.check = async () => {
      throw new CloudSignedOut("gone");
    };
    picker.setName("my-film-3");
    await pass();
    expect(picker.getSnapshot().failure).toBe("signedOut");
  });

  it("does not ask while it may not, and asks once it may", async () => {
    let may = false;
    const { platform, picker, pass } = asking({ canAsk: () => may });
    picker.setName("my-film");
    await pass();
    expect(platform.checked).toEqual([]);
    expect(picker.getSnapshot().checking).toBe(false);
    may = true;
    picker.recheck();
    await pass();
    expect(platform.checked).toEqual([{ create: { name: "my-film" } }]);
  });

  it("lets whoever waits for the answer know when it is there", async () => {
    const { picker, pass } = asking();
    picker.setName("my-film");
    let isSettled = false;
    void picker.settled().then(() => {
      isSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isSettled).toBe(false);
    await pass();
    expect(isSettled).toBe(true);
    // Nothing on its way: at once. And closing lets go of whoever waits.
    await picker.settled();
    picker.setName("another");
    const waiting = picker.settled();
    picker.close();
    await waiting;
  });

  it("links to the project it is given once people go on, and in place of the repository it has", async () => {
    let project: string | undefined;
    const { platform, picker } = asking({ project: () => project });
    // Not known yet: nothing goes anywhere.
    expect(await picker.submit()).toBeUndefined();
    expect(platform.links).toEqual([]);
    project = "p-later";
    expect(await picker.submit()).toBeDefined();
    expect(platform.calls).toContain("link p-later");

    const other = new FakeRepositories();
    other.answer = { ...other.answer, state: "ready" };
    const switching = new RepositoryPicker({
      access: other,
      project: "p1",
      name: "next",
      switching: true,
    });
    expect(await switching.submit()).toBeDefined();
    expect(other.links).toEqual([{ create: { name: "next" }, switch: true }]);
    // Without saying so, the platform keeps the repository it has.
    const plain = new RepositoryPicker({ access: other, project: "p1", name: "again" });
    expect(await plain.submit()).toBeUndefined();
    expect(plain.getSnapshot().failure).toBe("alreadyLinked");
  });
});
