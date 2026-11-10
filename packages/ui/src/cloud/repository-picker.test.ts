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
});
