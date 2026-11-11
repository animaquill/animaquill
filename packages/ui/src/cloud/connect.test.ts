import {
  RepositoryRefused,
  SYNC_CLOSE,
  SYNC_PROTOCOL,
  encodeSyncMessage,
  type LocalFolder,
  type RepositoryChoice,
} from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { afterEach, describe, expect, it } from "vitest";
import { memoryWindow } from "../workbench/memory-library.ts";
import { MemoryPlatform, TestTime } from "./cloud-support.ts";
import {
  connectProblemText,
  connectStepText,
  takeIntent,
  type CloudConnect,
  type ConnectIntent,
} from "./connect.ts";
import { CLOUD_FILE } from "./projects.ts";
import {
  answering,
  closeWindows,
  fixtureState,
  messagesOf,
  t,
  windowOf,
} from "./projects-support.ts";
import { FakeRepositories } from "./repository-support.ts";

/** Connecting a project to the platform in one dialog, see the design of the start page, 3. */

afterEach(closeWindows);

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

type Options = NonNullable<Parameters<typeof windowOf>[2]>;

/** A window with a project of this browser open, and a platform that saves projects to GitHub. */
async function setUp(options: Options = {}) {
  const time = new TestTime();
  const platform = new MemoryPlatform();
  const repository = new FakeRepositories();
  repository.platform = platform;
  const here = await windowOf(platform, time, { repository, ...options });
  const { id, state } = fixtureState();
  await here.library.create({ id, name: "原子" }, state);
  await here.open(id);
  return { time, platform, repository, here, id };
}

/** The same with the project in a folder, which says which project of the platform it is. */
async function setUpFolder(name = "atom") {
  const disk = new MemoryDisk();
  disk.folder(name, { quietly: true });
  disk.chooseNext(name);
  const folder = (await memoryFolders(disk).choose()) as LocalFolder;
  const time = new TestTime();
  const platform = new MemoryPlatform();
  const repository = new FakeRepositories();
  repository.platform = platform;
  const here = await windowOf(platform, time, {
    repository,
    folders: new Map([["本机1", folder]]),
  });
  const { state } = fixtureState();
  await here.library.create({ id: "本机1", name: "原子", folder: true }, state);
  await here.open("本机1");
  return { time, platform, repository, here, id: "本机1", disk, path: name };
}

/** The dialog of the open project, as the page opens it. */
function dialogOf(here: Awaited<ReturnType<typeof windowOf>>): CloudConnect {
  const connect = here.cloud.beginConnect();
  if (!connect) throw new Error("no dialog");
  return connect;
}

/** People press the button, and time goes on until what comes of it is there. */
async function submit(connect: CloudConnect, time: TestTime, ms = 500): Promise<void> {
  const done = connect.submit();
  await time.advance(ms);
  await done;
}

const stepsOf = (connect: CloudConnect) => {
  const { upload, repository, archive } = connect.getSnapshot().steps;
  return [upload, repository, archive].join(" ");
};

describe("connecting a project in one dialog", () => {
  it("puts the project on the platform, makes its repository and archives it, in one go", async () => {
    const { time, platform, repository, here, id } = await setUp();
    const connect = dialogOf(here);
    expect(connect.name).toBe("原子是什么");
    expect(connect.getSnapshot()).toMatchObject({
      need: undefined,
      account: "ada",
      repositoryOnly: false,
      phase: "choosing",
      problem: undefined,
    });
    expect(stepsOf(connect)).toBe("waiting waiting waiting");
    // Neither the project nor a folder has a name GitHub takes: one that always works.
    expect(connect.picker.getSnapshot()).toMatchObject({
      mode: "create",
      name: "animaquill-project",
    });
    // The platform is asked before anything is made.
    await time.advance(100);
    expect(repository.checked).toEqual([{ create: { name: "animaquill-project" } }]);
    expect(connect.picker.getSnapshot()).toMatchObject({ checking: false, checked: true });
    expect(platform.projects.size).toBe(0);
    expect(connect.canSubmit).toBe(true);
    expect(connect.takesBack).toBe(false);

    await submit(connect, time);
    const link = await here.browser.links.get(id);
    expect(link?.creating).toBeUndefined();
    expect(link).toMatchObject({ name: "原子是什么", owner: "user-ada" });
    expect(platform.projects.get(link?.project ?? "")?.head).toBe(1);
    expect(repository.links).toEqual([{ create: { name: "animaquill-project" } }]);
    expect(repository.calls).toContain(`link ${link?.project}`);
    expect(connect.getSnapshot()).toMatchObject({ phase: "archiving", problem: undefined });
    expect(connect.getSnapshot().linked?.repository?.fullName).toBe("ada/animaquill-project");
    expect(stepsOf(connect)).toBe("done done running");
    // From here on closing the dialog takes nothing back.
    expect(connect.takesBack).toBe(false);

    // The platform archives by itself, and the dialog hears of it.
    repository.archived(time.now());
    await time.advance(4000);
    expect(connect.getSnapshot()).toMatchObject({ phase: "done", problem: undefined });
    expect(stepsOf(connect)).toBe("done done done");
    expect(await connect.cancel()).toBe("closed");
    // Connected, with its repository: what a list shows of it is remembered.
    expect(await here.browser.links.get(id)).toMatchObject({
      repository: { id: 99, fullName: "ada/animaquill-project" },
    });
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
    // Nothing was said outside the dialog, and nothing else was asked.
    expect(messagesOf(here.notifications)).toEqual([]);
    expect(here.dialogs.getSnapshot()).toBeUndefined();
  });

  it("names a new repository after the folder, and moves on from a name that is taken", async () => {
    const { time, repository, here } = await setUpFolder("Atom Film");
    repository.taken.add("atom-film");
    repository.taken.add("atom-film-2");
    const connect = dialogOf(here);
    expect(connect.picker.getSnapshot()).toMatchObject({ name: "atom-film", nameTouched: false });
    await time.advance(100);
    // People did not type it: the next one that is free.
    expect(connect.picker.getSnapshot()).toMatchObject({
      name: "atom-film-3",
      nameProblem: undefined,
      checked: true,
    });
    expect(connect.picker.nameMovedOn).toBe(true);
    expect(repository.checked.map((asked) => "create" in asked && asked.create.name)).toEqual([
      "atom-film",
      "atom-film-2",
      "atom-film-3",
    ]);
    expect(connect.canSubmit).toBe(true);

    // A name they typed stays as they typed it, and says that it is taken.
    connect.picker.setName("atom-film");
    await time.advance(100);
    expect(connect.picker.getSnapshot()).toMatchObject({
      name: "atom-film",
      nameProblem: "taken",
      checked: false,
    });
    expect(connect.canSubmit).toBe(false);
    expect(t.t("repository.nameProblem.taken")).toBe(
      "你的 GitHub 上已经有叫这个名字的仓库了，换一个名字。",
    );
    // Nothing was made for any of it.
    expect(repository.links).toEqual([]);
    connect.picker.setName("another-film");
    await time.advance(100);
    expect(connect.canSubmit).toBe(true);
    connect.close();
  });

  it("gives up on finding a free name after a few, and says so at the name", async () => {
    const { time, repository, here } = await setUpFolder("atom");
    for (const name of ["atom", ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `atom-${n}`)])
      repository.taken.add(name);
    const connect = dialogOf(here);
    await time.advance(100);
    expect(connect.picker.getSnapshot()).toMatchObject({ name: "atom-9", nameProblem: "taken" });
    expect(repository.checked).toHaveLength(9);
    connect.close();
  });

  it("waits for the platform's word about the choice before it makes anything", async () => {
    const { time, platform, repository, here } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    // People type a name and press at once: the answer about it is still on its way.
    repository.taken.add("mine");
    connect.picker.setName("mine");
    expect(connect.picker.getSnapshot().checking).toBe(true);
    await submit(connect, time);
    expect(connect.getSnapshot()).toMatchObject({
      phase: "choosing",
      problem: { step: "repository", code: "choice" },
    });
    expect(stepsOf(connect)).toBe("waiting waiting waiting");
    expect(platform.projects.size).toBe(0);
    expect(await here.browser.links.get(here.session.key ?? "")).toBeUndefined();
    connect.close();
  });

  it("shows another name to people before it goes on with it", async () => {
    const { time, platform, repository, here } = await setUpFolder("atom");
    repository.taken.add("atom");
    const connect = dialogOf(here);
    // Pressed before the platform said that the name is taken.
    await submit(connect, time);
    expect(connect.picker.getSnapshot().name).toBe("atom-2");
    expect(connect.getSnapshot()).toMatchObject({ phase: "choosing", problem: undefined });
    expect(platform.projects.size).toBe(0);
    await submit(connect, time);
    expect(repository.links).toEqual([{ create: { name: "atom-2" } }]);
    connect.close();
  });

  it("says why a repository people have cannot take the project, before they go on", async () => {
    const { time, repository, here } = await setUp();
    repository.repositories = [
      choice(1),
      choice(2),
      choice(3, { linked: true, linkedProject: { id: "p9", name: "片头动画" } }),
      choice(4, { private: false }),
      choice(5),
    ];
    repository.checks.set(2, { ok: false, reason: "hasProject", files: ["animaquill.json"] });
    repository.checks.set(5, {
      ok: false,
      reason: "linkedElsewhere",
      project: { id: "p8", name: "年会视频" },
    });
    const connect = dialogOf(here);
    connect.picker.setMode("existing");
    await time.advance(100);
    connect.picker.select(1);
    await time.advance(10);
    expect(connect.picker.getSnapshot()).toMatchObject({ selected: 1, checked: true });
    expect(connect.canSubmit).toBe(true);

    // A project at its top shows as soon as people choose it.
    connect.picker.select(2);
    await time.advance(10);
    const picked = connect.picker.getSnapshot();
    expect(picked.selected).toBeUndefined();
    expect(picked.refused.get(2)).toEqual({ code: "hasProject", files: ["animaquill.json"] });
    expect(connect.canSubmit).toBe(false);
    // Whose repository it is already, as the list says and as the platform says.
    connect.picker.select(3);
    expect(connect.picker.getSnapshot().selected).toBeUndefined();
    connect.picker.select(5);
    await time.advance(10);
    expect(connect.picker.getSnapshot().refused.get(5)).toEqual({
      code: "linkedElsewhere",
      project: { id: "p8", name: "年会视频" },
    });
    // A public one is asked about as one people said yes to: what else is wrong shows first.
    connect.picker.select(4);
    await time.advance(10);
    expect(repository.checked.at(-1)).toEqual({ existing: { id: 4 }, confirmPublic: true });
    expect(connect.picker.getSnapshot().checked).toBe(true);
    expect(connect.canSubmit).toBe(false);
    connect.picker.confirmPublic(true);
    expect(connect.canSubmit).toBe(true);
    expect(repository.links).toEqual([]);
    connect.close();
  });

  it("has a repository that turned out to be public confirmed first", async () => {
    const { time, repository, here } = await setUp();
    repository.repositories = [choice(1)];
    // Private when it was listed, public by the time it was asked about.
    repository.checks.set(1, { ok: false, reason: "public" });
    const connect = dialogOf(here);
    connect.picker.setMode("existing");
    await time.advance(100);
    connect.picker.select(1);
    await time.advance(10);
    const [listed] = connect.picker.getSnapshot().list.repositories;
    expect(listed && connect.picker.isPublic(listed)).toBe(true);
    expect(connect.canSubmit).toBe(false);
    connect.picker.confirmPublic(true);
    expect(connect.canSubmit).toBe(true);
    await submit(connect, time);
    expect(repository.links).toEqual([{ existing: { id: 1 }, confirmPublic: true }]);
    connect.close();
  });
});

describe("what has to be there before a project can connect", () => {
  it("has people sign in first, and comes back with what they chose", async () => {
    const memory = memoryWindow();
    const { time, platform, repository, here, id } = await setUp({ signedIn: false, memory });
    const connect = dialogOf(here);
    expect(connect.getSnapshot()).toMatchObject({ need: "signIn", account: undefined });
    expect(connect.canSubmit).toBe(false);
    connect.picker.setName("my-film");
    await time.advance(100);
    // Nothing is asked of the platform while nobody is signed in.
    expect(repository.calls).toEqual([]);
    await connect.signIn();
    expect(here.signIn).toHaveBeenCalledOnce();
    expect(platform.projects.size).toBe(0);

    // The page comes back, signed in: the dialog opens again with the name they typed.
    const back = await windowOf(platform, time, {
      repository,
      memory,
      library: here.library,
      browser: here.browser,
    });
    await back.open(id);
    const again = back.cloud.beginConnect({ resume: true });
    expect(again?.getSnapshot()).toMatchObject({ need: undefined, phase: "choosing" });
    expect(again?.picker.getSnapshot()).toMatchObject({ name: "my-film", nameTouched: true });
    // Once: a reload after that opens nothing by itself.
    expect(back.cloud.beginConnect({ resume: true })).toBeUndefined();
    await time.advance(100);
    expect(repository.checked).toEqual([{ create: { name: "my-film" } }]);
    again?.close();
  });

  it("has people install the GitHub App first, and comes back with the repository they chose", async () => {
    const memory = memoryWindow();
    const { time, platform, repository, here, id } = await setUp({ memory });
    here.who.set({ status: "signedIn", id: "user-ada", name: "ada", appInstalled: false });
    const connect = dialogOf(here);
    expect(connect.getSnapshot().need).toBe("installApp");
    expect(connect.canSubmit).toBe(false);
    await connect.installApp();
    expect(here.installApp).toHaveBeenCalledOnce();

    repository.repositories = [choice(1), choice(2)];
    const kept = JSON.parse(memory.read("cloud.connect") ?? "null") as ConnectIntent;
    memory.write("cloud.connect", JSON.stringify({ ...kept, mode: "existing", selected: 2 }));
    const back = await windowOf(platform, time, {
      repository,
      memory,
      library: here.library,
      browser: here.browser,
    });
    await back.open(id);
    const again = back.cloud.beginConnect({ resume: true });
    await time.advance(100);
    expect(again?.picker.getSnapshot()).toMatchObject({ mode: "existing", selected: 2 });
    again?.close();
  });

  it("finds out that the App is not installed from the platform too, whatever the account says", async () => {
    const { time, repository, here } = await setUp();
    repository.refuse.check = new RepositoryRefused("notInstalled");
    const connect = dialogOf(here);
    await time.advance(100);
    expect(connect.getSnapshot().need).toBe("installApp");
    expect(connect.canSubmit).toBe(false);
    connect.close();
  });

  it("waits until it is known who is signed in", async () => {
    const { time, repository, here } = await setUp();
    here.who.set({ status: "unknown" });
    const connect = dialogOf(here);
    expect(connect.getSnapshot().need).toBe("account");
    await time.advance(100);
    expect(repository.calls).toEqual([]);
    here.who.set({ status: "signedIn", id: "user-ada", name: "ada", appInstalled: true });
    expect(connect.getSnapshot()).toMatchObject({ need: undefined, account: "ada" });
    await time.advance(100);
    expect(repository.checked).toHaveLength(1);
    connect.close();
  });

  it("forgets what the dialog was at where people stayed, closed it, or it was too long ago", async () => {
    const memory = memoryWindow();
    const { time, here, id } = await setUp({ signedIn: false, memory });
    // People did not leave after all, as with something that could not be kept.
    here.world.leaving = false;
    const stayed = dialogOf(here);
    await stayed.signIn();
    expect(memory.read("cloud.connect")).toBe("");
    stayed.close();

    // They left, and the dialog closing with the page does not take it back.
    here.world.leaving = true;
    const left = dialogOf(here);
    await left.signIn();
    left.close();
    expect(JSON.parse(memory.read("cloud.connect") ?? "null")).toMatchObject({ key: id });
    // For another project, or much later, it is nothing.
    const kept = memory.read("cloud.connect") ?? "";
    expect(takeIntent(memory, "another", time.now())).toBeUndefined();
    expect(memory.read("cloud.connect")).toBe("");
    memory.write("cloud.connect", kept);
    expect(takeIntent(memory, id, time.now() + 31 * 60_000)).toBeUndefined();
    memory.write("cloud.connect", kept);
    expect(takeIntent(memory, id, time.now() + 60_000)).toMatchObject({ key: id });
    memory.write("cloud.connect", "not json");
    expect(takeIntent(memory, id, time.now())).toBeUndefined();

    // Closing a dialog that never left forgets it.
    memory.write("cloud.connect", kept);
    const closed = dialogOf(here);
    closed.close();
    expect(memory.read("cloud.connect")).toBe("");
  });
});

describe("where a step of connecting stops", () => {
  it("says that there is no network, keeps the link, and goes on with the same project", async () => {
    const { time, platform, repository, here, id } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    // The platform is out of reach, and the browser knows it has no network.
    platform.faults.silent = true;
    time.online = false;
    await submit(connect, time, 40_000);
    expect(connect.getSnapshot()).toMatchObject({
      phase: "choosing",
      problem: { step: "upload", code: "offline" },
    });
    expect(stepsOf(connect)).toBe("failed waiting waiting");
    expect(connectProblemText(connect.getSnapshot().problem!, t.t)).toBe(
      "浏览器没有网络，项目还没传到云端。联网后会自动接着传，传好后再点“连接到云端”。",
    );
    const link = await here.browser.links.get(id);
    expect(link?.creating).toBe(true);
    expect(platform.projects.size).toBe(0);
    expect(repository.links).toEqual([]);
    // Closing the dialog now takes the link back.
    expect(connect.takesBack).toBe(true);

    // The network comes back: the project gets there by itself, and the dialog says so.
    platform.faults.silent = false;
    time.online = true;
    time.wake();
    await time.advance(40_000);
    expect(stepsOf(connect)).toBe("done waiting waiting");
    expect(connect.getSnapshot()).toMatchObject({ phase: "choosing", problem: undefined });
    expect(platform.projects.has(link?.project ?? "")).toBe(true);
    // Going on is people's to say, and goes on with the project that is there.
    expect(repository.links).toEqual([]);
    await submit(connect, time);
    expect(stepsOf(connect)).toBe("done done running");
    expect(platform.projects.size).toBe(1);
    expect((await here.browser.links.get(id))?.project).toBe(link?.project);
    expect(repository.calls).toContain(`link ${link?.project}`);
    connect.close();
  });

  it("says that the platform cannot be reached once it did not answer for a while", async () => {
    const { time, platform, here } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    // Every connection breaks at once, with a network as far as the browser knows.
    const real = platform.connect.bind(platform);
    platform.connect = (user, tag) => {
      const connection = real(user, tag);
      connection.close();
      return connection;
    };
    await submit(connect, time, 5000);
    expect(connect.getSnapshot().problem).toEqual({ step: "upload", code: "unreachable" });
    expect(connectProblemText(connect.getSnapshot().problem!, t.t)).toContain("暂时连不上平台");
    // Trying again waits again, and goes through once the platform is back.
    platform.connect = real;
    await submit(connect, time, 40_000);
    expect(stepsOf(connect)).toBe("done done running");
    connect.close();
  });

  it("says what the platform does not take the project for", async () => {
    const { time, platform, here } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    const real = platform.connect.bind(platform);
    let code: number = SYNC_CLOSE.quota;
    platform.connect = (user, tag) => {
      const connection = real(user, tag);
      connection.close();
      return { ...connection, closed: Promise.resolve({ code, reason: "" }) };
    };
    await submit(connect, time);
    expect(connect.getSnapshot().problem).toEqual({ step: "upload", code: "quota" });
    expect(connectProblemText(connect.getSnapshot().problem!, t.t)).toBe(
      "超过了你在云端能存的项目数或大小。删掉不用的云端项目后再试。",
    );
    code = SYNC_CLOSE.tooLarge;
    await submit(connect, time);
    expect(connect.getSnapshot().problem).toEqual({ step: "upload", code: "tooLarge" });
    code = SYNC_CLOSE.outdated;
    await submit(connect, time);
    expect(connect.getSnapshot().problem).toEqual({ step: "upload", code: "outdated" });
    code = SYNC_CLOSE.protocol;
    await submit(connect, time);
    expect(connect.getSnapshot().problem).toEqual({
      step: "upload",
      code: "rejected",
      reason: "malformed",
    });
    expect(connectProblemText(connect.getSnapshot().problem!, t.t)).toBe(
      "云端没有接受这个项目（读不懂）。",
    );
    // A session that ended: only signing in again helps, whatever the account still says.
    code = SYNC_CLOSE.signedOut;
    await submit(connect, time);
    expect(connect.getSnapshot()).toMatchObject({
      need: "signIn",
      problem: { step: "upload", code: "signedOut" },
    });
    expect(connect.canSubmit).toBe(false);
    expect(platform.projects.size).toBe(0);
    connect.close();
  });

  it("says why the project could not begin to connect", async () => {
    const { time, here } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    here.browser.links.failing = true;
    await submit(connect, time);
    expect(connect.getSnapshot().problem).toEqual({ step: "upload", code: "failed" });
    expect(stepsOf(connect)).toBe("failed waiting waiting");
    here.browser.links.failing = false;
    here.library.failing = true;
    here.session.store?.execute({ type: "file.write", params: { path: "code/a.js", text: "a" } });
    await submit(connect, time);
    expect(connect.getSnapshot().problem).toEqual({ step: "upload", code: "notSaved" });
    here.library.failing = false;
    await submit(connect, time, 6000);
    expect(stepsOf(connect)).toBe("done done running");
    connect.close();
  });

  it("goes back to choosing where the platform says no to the repository, with the project in place", async () => {
    const { time, platform, repository, here, id } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    // Taken in the moment between asking and making.
    repository.refuse.link = new RepositoryRefused("nameTaken");
    connect.picker.setName("mine");
    await time.advance(100);
    await submit(connect, time);
    expect(connect.getSnapshot()).toMatchObject({
      phase: "choosing",
      problem: { step: "repository", code: "nameTaken" },
    });
    expect(stepsOf(connect)).toBe("done failed waiting");
    expect(connectProblemText(connect.getSnapshot().problem!, t.t)).toBe(
      "你的 GitHub 上已经有叫这个名字的仓库了，换一个名字。",
    );
    const project = (await here.browser.links.get(id))?.project ?? "";
    expect(platform.projects.has(project)).toBe(true);
    const connections = platform.connections;

    // Another name: the project is there already, and only the repository is made.
    connect.picker.setName("another");
    await time.advance(100);
    await submit(connect, time);
    expect(stepsOf(connect)).toBe("done done running");
    expect(platform.projects.size).toBe(1);
    expect(platform.connections).toBe(connections);
    expect(repository.links).toEqual([
      { create: { name: "mine" } },
      { create: { name: "another" } },
    ]);
    connect.close();
  });

  it("shows at the repository what the platform found when it tried", async () => {
    const { time, repository, here } = await setUp();
    repository.repositories = [choice(1), choice(2)];
    const connect = dialogOf(here);
    connect.picker.setMode("existing");
    await time.advance(100);
    connect.picker.select(1);
    await time.advance(10);
    repository.refuse.link = new RepositoryRefused("linkedElsewhere", {
      project: { id: "p9", name: "片头动画" },
    });
    await submit(connect, time);
    expect(connect.getSnapshot()).toMatchObject({
      phase: "choosing",
      problem: { step: "repository", code: "choice" },
    });
    expect(connect.picker.getSnapshot().refused.get(1)).toEqual({
      code: "linkedElsewhere",
      project: { id: "p9", name: "片头动画" },
    });
    expect(connect.canSubmit).toBe(false);
    connect.picker.select(2);
    await time.advance(10);
    await submit(connect, time);
    expect(stepsOf(connect)).toBe("done done running");
    connect.close();
  });

  it("takes a repository that was linked after all for linked", async () => {
    const { time, repository, here } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    // The answer to the first try never came back, and the next try hears that it is done.
    const link = repository.link.bind(repository);
    let tries = 0;
    repository.link = async (project, chosen) => {
      tries += 1;
      if (tries === 1) {
        await link(project, chosen);
        throw new RepositoryRefused("unavailable");
      }
      throw new RepositoryRefused("alreadyLinked");
    };
    await submit(connect, time);
    expect(connect.getSnapshot().problem).toEqual({ step: "repository", code: "unavailable" });
    await submit(connect, time);
    expect(connect.getSnapshot()).toMatchObject({ phase: "archiving", problem: undefined });
    expect(stepsOf(connect)).toBe("done done running");
    connect.close();
  });

  it("has people sign in again where the session ended at the repository, and takes back what it made if they give up then", async () => {
    const memory = memoryWindow();
    const { time, platform, repository, here, id } = await setUp({ memory });
    const connect = dialogOf(here);
    await time.advance(100);
    const { CloudSignedOut } = await import("@animaquill/host");
    repository.refuse.link = new CloudSignedOut("Nobody is signed in");
    await submit(connect, time);
    expect(connect.getSnapshot()).toMatchObject({
      need: "signIn",
      problem: { step: "repository", code: "signedOut" },
    });
    const project = (await here.browser.links.get(id))?.project ?? "";
    await connect.signIn();
    expect(JSON.parse(memory.read("cloud.connect") ?? "null")).toMatchObject({
      key: id,
      created: project,
    });

    // The page comes back. The project is on the platform, by this try: giving up takes it away.
    const back = await windowOf(platform, time, {
      repository,
      memory,
      library: here.library,
      browser: here.browser,
    });
    await here.cloud.close();
    await here.session.close();
    await back.open(id);
    await time.advance(200);
    const again = back.cloud.beginConnect({ resume: true });
    expect(again?.getSnapshot()).toMatchObject({ repositoryOnly: true, need: undefined });
    expect(again?.takesBack).toBe(true);
    expect(await again?.cancel()).toBe("cancelled");
    expect(platform.projects.size).toBe(0);
    expect(await back.browser.links.get(id)).toBeUndefined();
  });

  it("takes nothing back where the first archive does not get there: the project is connected", async () => {
    const { time, platform, repository, here, id } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    await submit(connect, time);
    // It failed, and the platform tries again by itself.
    repository.answer = {
      ...repository.answer,
      archiving: false,
      failures: 1,
      retryAt: time.now() + 60_000,
    };
    await time.advance(4000);
    expect(connect.getSnapshot()).toMatchObject({
      phase: "archiving",
      problem: { step: "archive", code: "retrying" },
    });
    expect(stepsOf(connect)).toBe("done done running");
    expect(connectProblemText(connect.getSnapshot().problem!, t.t)).toContain(
      "第一次存档还没成功，平台会自动再试。",
    );
    // It paused: GitHub does not let the branch move.
    repository.answer = { ...repository.answer, state: "paused", reason: "protected" };
    // Nothing is on its way any more: the platform is asked now and then, as for any project.
    await time.advance(61_000);
    expect(connect.getSnapshot().problem).toMatchObject({ step: "archive", code: "paused" });
    expect(stepsOf(connect)).toBe("done done failed");
    expect(connectProblemText(connect.getSnapshot().problem!, t.t)).toBe(
      "第一次存档先停着：GitHub 不让存档写进这个仓库。项目已经连上云端，实时同步照常。仓库可能设了保护规则，不让直接写入。在 GitHub 上去掉这条规则后点“现在存档”，或者换一个仓库。",
    );
    // Closing the dialog leaves all of it: it goes on in the panel.
    expect(connect.takesBack).toBe(false);
    expect(await connect.cancel()).toBe("closed");
    const link = await here.browser.links.get(id);
    expect(platform.projects.has(link?.project ?? "")).toBe(true);
    expect(platform.repositories.has(link?.project ?? "")).toBe(true);
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
    // And it gets there later, with nobody watching.
    repository.archived(time.now());
  });
});

describe("giving up on connecting", () => {
  it("only closes where nothing was made", async () => {
    const { time, platform, here, id } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    expect(await connect.cancel()).toBe("closed");
    expect(platform.projects.size).toBe(0);
    expect(platform.removed).toEqual([]);
    expect(await here.browser.links.get(id)).toBeUndefined();
    expect(here.cloud.getSnapshot().kind).toBe("none");
  });

  it("takes the project on the platform away again, so that nothing is left there", async () => {
    const { time, platform, repository, here, id, disk, path } = await setUpFolder();
    const connect = dialogOf(here);
    await time.advance(100);
    repository.refuse.link = new RepositoryRefused("unavailable");
    await submit(connect, time);
    expect(connect.getSnapshot().problem).toEqual({ step: "repository", code: "unavailable" });
    // Halfway: on the platform, without a repository, and the folder says so.
    const project = (await here.browser.links.get(id))?.project ?? "";
    expect(platform.projects.has(project)).toBe(true);
    expect(disk.has(`${path}/${CLOUD_FILE}`)).toBe(true);
    expect(connect.takesBack).toBe(true);

    expect(await connect.cancel()).toBe("cancelled");
    expect(connect.getSnapshot().phase).toBe("cancelled");
    // No project is left on the platform that nobody asked for.
    expect(platform.projects.size).toBe(0);
    expect(platform.removed).toEqual([project]);
    // And the project is one of this computer only again, in every way.
    expect(await here.browser.links.get(id)).toBeUndefined();
    expect(disk.has(`${path}/${CLOUD_FILE}`)).toBe(false);
    expect(here.cloud.getSnapshot().kind).toBe("none");
    expect(here.session.key).toBe(id);
    here.session.store?.execute({ type: "file.write", params: { path: "code/a.js", text: "a" } });
    await time.advance(5000);
    expect(platform.projects.size).toBe(0);
    expect(messagesOf(here.notifications)).toEqual([]);
    // Connecting again later starts from nothing.
    const again = dialogOf(here);
    expect(again.getSnapshot()).toMatchObject({ repositoryOnly: false, phase: "choosing" });
    again.close();
  });

  it("takes away a project that only got to the platform after it was asked to take it away", async () => {
    const platform = new MemoryPlatform();
    let asked = 0;
    const { state, id: projectId } = fixtureState();
    const { time, here, id } = await setUpWith(platform, {
      remove: async (project) => {
        asked += 1;
        if (asked === 1) {
          // What the window sent before it stopped was still on its way: it gets there now.
          const late = platform.connect("ada");
          await late.opened;
          late.send(
            encodeSyncMessage({
              t: "hello",
              v: SYNC_PROTOCOL,
              project,
              after: 0,
              device: "device",
              window: "w",
              editor: "test",
              create: { name: "原子", projectId },
              payload: state,
            }),
          );
          return "missing";
        }
        return platform.remove("ada", project);
      },
    });
    const connect = dialogOf(here);
    await time.advance(100);
    // The platform says nothing: the window is still saying hello when people give up.
    platform.faults.silent = true;
    const submitted = connect.submit();
    await time.advance(100);
    expect(here.cloud.session?.getSnapshot().state).toBe("connecting");
    platform.faults.silent = false;
    const cancelled = connect.cancel();
    await time.advance(3000);
    expect(await cancelled).toBe("cancelled");
    await submitted;
    // Asked twice: the first time it was not there yet.
    expect(asked).toBe(2);
    expect(platform.projects.size).toBe(0);
    expect(await here.browser.links.get(id)).toBeUndefined();
  });

  it("takes away what another window of the browser made of the project while this one gave up", async () => {
    const platform = new MemoryPlatform();
    let asked = 0;
    const { state, id: projectId } = fixtureState();
    const { time, repository, here, id } = await setUpWith(platform, {
      remove: async (project) => {
        asked += 1;
        const outcome = platform.remove("ada", project);
        if (asked === 1) {
          // The other window took over syncing when this one stopped, before it heard that the
          // link is gone: what it sent gets there right after the project was taken away, and
          // makes it again.
          const late = platform.connect("ada");
          await late.opened;
          late.send(
            encodeSyncMessage({
              t: "hello",
              v: SYNC_PROTOCOL,
              project,
              after: 0,
              device: "device",
              window: "other",
              editor: "test",
              create: { name: "原子", projectId },
              payload: state,
            }),
          );
        }
        return outcome;
      },
    });
    here.world.others.set(id, 1);
    const connect = dialogOf(here);
    await time.advance(100);
    repository.refuse.link = new RepositoryRefused("unavailable");
    await submit(connect, time);
    expect(platform.projects.size).toBe(1);
    const cancelled = connect.cancel();
    await time.advance(3000);
    expect(await cancelled).toBe("cancelled");
    // Asked once more, after no window synced the project any more.
    expect(asked).toBe(2);
    expect(platform.projects.size).toBe(0);
    expect(await here.browser.links.get(id)).toBeUndefined();
  });

  it("stops the other windows of the browser that have the project open, and leaves nothing behind", async () => {
    const { time, platform, repository, here, id } = await setUp();
    // The same project in another window of this browser, which hears what happens to its link.
    const other = await windowOf(platform, time, {
      repository,
      browser: here.browser,
      library: here.library,
    });
    await other.open(id);
    here.world.others.set(id, 1);
    const connect = dialogOf(here);
    await time.advance(100);
    repository.refuse.link = new RepositoryRefused("unavailable");
    await submit(connect, time);
    expect(other.cloud.getSnapshot().kind).toBe("linked");
    expect(platform.projects.size).toBe(1);

    // This window stops syncing to give up, and the other one takes over for a moment: whatever
    // it makes of the project on the platform meanwhile is not left there either.
    const cancelled = connect.cancel();
    await time.advance(5000);
    expect(await cancelled).toBe("cancelled");
    expect(platform.projects.size).toBe(0);
    expect(await here.browser.links.get(id)).toBeUndefined();
    expect(other.cloud.getSnapshot().kind).toBe("none");
    // Nothing brings it back: neither window syncs the project any more.
    other.session.store?.execute({
      type: "file.write",
      params: { path: "code/later.js", text: "later" },
    });
    await time.advance(60_000);
    expect(platform.projects.size).toBe(0);
  });

  it("stays connected where the platform cannot say that the project is gone, unless people say to let go", async () => {
    const { time, platform, repository, here, id } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    repository.refuse.link = new RepositoryRefused("unavailable");
    await submit(connect, time);
    const project = (await here.browser.links.get(id))?.project ?? "";
    // The platform goes away.
    platform.faults.unreachable = true;
    expect(await connect.cancel()).toBe("unconfirmed");
    expect(connect.getSnapshot()).toMatchObject({
      phase: "choosing",
      cancelling: false,
      unconfirmed: true,
    });
    // Nothing is in between: it is connected, one step short, and syncs on.
    expect((await here.browser.links.get(id))?.project).toBe(project);
    await time.advance(500);
    expect(here.cloud.getSnapshot().kind).toBe("linked");
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
    expect(platform.projects.has(project)).toBe(true);

    // Later the platform is back, and giving up takes everything back.
    platform.faults.unreachable = false;
    expect(await connect.cancel()).toBe("cancelled");
    expect(platform.projects.size).toBe(0);
    expect(await here.browser.links.get(id)).toBeUndefined();
  });

  it("lets go all the same where people say so, which can leave a project on the platform", async () => {
    const { time, platform, repository, here, id } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    repository.refuse.link = new RepositoryRefused("unavailable");
    await submit(connect, time);
    const project = (await here.browser.links.get(id))?.project ?? "";
    platform.faults.unreachable = true;
    expect(await connect.cancel()).toBe("unconfirmed");
    expect(await connect.cancel({ force: true })).toBe("cancelled");
    expect(await here.browser.links.get(id)).toBeUndefined();
    expect(here.cloud.getSnapshot().kind).toBe("none");
    // It is still there, without a repository: the list of the start page has it, to take away.
    expect(platform.projects.has(project)).toBe(true);
    platform.faults.unreachable = false;
    expect(platform.list("ada")).toMatchObject([{ id: project, attention: "noRepository" }]);
  });

  it("stays connected where the platform has a repository for the project after all", async () => {
    const { time, platform, repository, here, id } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    // The repository was linked, and the answer did not come back.
    const link = repository.link.bind(repository);
    repository.link = async (project, chosen) => {
      await link(project, chosen);
      throw new RepositoryRefused("unavailable");
    };
    await submit(connect, time);
    expect(connect.getSnapshot().problem).toEqual({ step: "repository", code: "unavailable" });
    const project = (await here.browser.links.get(id))?.project ?? "";
    expect(await connect.cancel()).toBe("kept");
    await time.advance(500);
    expect(platform.projects.has(project)).toBe(true);
    expect(platform.removed).toEqual([]);
    expect((await here.browser.links.get(id))?.project).toBe(project);
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
    // What is left is the first archive, into the repository the platform says it has.
    expect(connect.getSnapshot()).toMatchObject({ phase: "archiving", unconfirmed: false });
    expect(stepsOf(connect)).toBe("done done running");
    expect(connect.getSnapshot().linked?.repository?.fullName).toBe("ada/animaquill-project");
    connect.close();
  });

  it("leaves people something to press where they gave up in the middle and the platform could not say", async () => {
    const { time, platform, here, id } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    // The project is on its way, slowly, when people give up, and the platform is out of reach.
    platform.faults.silent = true;
    const submitted = connect.submit();
    await time.advance(100);
    expect(connect.getSnapshot().phase).toBe("working");
    platform.faults.unreachable = true;
    const cancelled = connect.cancel();
    await time.advance(3000);
    expect(await cancelled).toBe("unconfirmed");
    await submitted;
    expect(connect.getSnapshot()).toMatchObject({
      phase: "choosing",
      cancelling: false,
      unconfirmed: true,
    });
    expect((await here.browser.links.get(id))?.creating).toBe(true);
    // The platform comes back. The connection that got no answer has to run out first, which the
    // dialog says; then the project is there, and going on works.
    platform.faults.silent = false;
    platform.faults.unreachable = false;
    expect(connect.canSubmit).toBe(true);
    await submit(connect, time, 40_000);
    expect(stepsOf(connect)).toBe("done waiting waiting");
    expect(connect.getSnapshot()).toMatchObject({ phase: "choosing", problem: undefined });
    await submit(connect, time);
    expect(stepsOf(connect)).toBe("done done running");
    connect.close();
  });

  it("waits for a repository that is being made right now, and keeps what came of it", async () => {
    const { time, platform, repository, here, id } = await setUp();
    const connect = dialogOf(here);
    await time.advance(100);
    let finish = () => {};
    const link = repository.link.bind(repository);
    repository.link = async (project, chosen) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return link(project, chosen);
    };
    const submitted = connect.submit();
    await time.advance(500);
    expect(stepsOf(connect)).toBe("done running waiting");
    const cancelled = connect.cancel();
    await time.advance(10);
    expect(connect.getSnapshot().cancelling).toBe(true);
    finish();
    await time.advance(10);
    expect(await cancelled).toBe("kept");
    await submitted;
    const project = (await here.browser.links.get(id))?.project ?? "";
    expect(platform.repositories.has(project)).toBe(true);
    expect(platform.removed).toEqual([]);
    expect(connect.getSnapshot()).toMatchObject({ phase: "archiving", cancelling: false });
    connect.close();
  });
});

/** As `setUp`, on a platform the test made, with something in place of what the platform does. */
async function setUpWith(platform: MemoryPlatform, overrides: Options["overrides"]) {
  const time = new TestTime();
  const repository = new FakeRepositories();
  repository.platform = platform;
  const here = await windowOf(platform, time, { repository, ...(overrides && { overrides }) });
  const { id, state } = fixtureState();
  await here.library.create({ id, name: "原子" }, state);
  await here.open(id);
  return { time, platform, repository, here, id };
}

describe("a project that is on the platform without a repository", () => {
  /** Connected the way it went before: the project is there, and the question about GitHub was put off. */
  async function fromBefore() {
    const set = await setUp();
    const { time, here, id } = set;
    answering(here.dialogs, (request) => request.kind !== "repository");
    await here.cloud.connect();
    await time.advance(200);
    expect(here.cloud.repository?.status?.state).toBe("none");
    const project = (await here.browser.links.get(id))?.project ?? "";
    return { ...set, project };
  }

  it("only gets its repository and its first archive", async () => {
    const { time, platform, repository, here, project } = await fromBefore();
    const connect = dialogOf(here);
    expect(connect.getSnapshot()).toMatchObject({ repositoryOnly: true, phase: "choosing" });
    expect(stepsOf(connect)).toBe("done waiting waiting");
    const connections = platform.connections;
    await time.advance(100);
    await submit(connect, time);
    expect(stepsOf(connect)).toBe("done done running");
    expect(platform.connections).toBe(connections);
    expect(platform.projects.size).toBe(1);
    expect(repository.calls).toContain(`link ${project}`);
    repository.archived(time.now());
    await time.advance(4000);
    expect(connect.getSnapshot().phase).toBe("done");
    connect.close();
    // It has its repository now: there is nothing left for the dialog to do.
    expect(here.cloud.beginConnect()).toBeUndefined();
  });

  it("stays on the platform whatever people do in the dialog", async () => {
    const { time, platform, repository, here, id, project } = await fromBefore();
    const connect = dialogOf(here);
    await time.advance(100);
    repository.refuse.link = new RepositoryRefused("unavailable");
    await submit(connect, time);
    expect(connect.getSnapshot().problem).toEqual({ step: "repository", code: "unavailable" });
    // The dialog did not put it there: closing it takes nothing away.
    expect(connect.takesBack).toBe(false);
    expect(await connect.cancel()).toBe("closed");
    expect(platform.projects.has(project)).toBe(true);
    expect(platform.removed).toEqual([]);
    expect((await here.browser.links.get(id))?.project).toBe(project);
    expect(here.cloud.session?.getSnapshot().state).toBe("online");
  });

  it("has no dialog where the platform saves no projects to repositories, or no project is open", async () => {
    const time = new TestTime();
    const platform = new MemoryPlatform();
    const here = await windowOf(platform, time);
    expect(here.cloud.beginConnect()).toBeUndefined();
    const { id, state } = fixtureState();
    await here.library.create({ id, name: "原子" }, state);
    await here.open(id);
    expect(here.cloud.beginConnect()).toBeUndefined();
  });
});

describe("how connecting reads", () => {
  it("names the steps, the second by what it does", () => {
    expect(connectStepText("upload", "create", t.t)).toBe("上传项目");
    expect(connectStepText("repository", "create", t.t)).toBe("新建仓库");
    expect(connectStepText("repository", "existing", t.t)).toBe("关联仓库");
    expect(connectStepText("archive", "existing", t.t)).toBe("第一次存档");
  });

  it("says why a step stopped in words people can act on", () => {
    const upload = (code: string) => connectProblemText({ step: "upload", code } as never, t.t);
    expect(upload("notSaved")).toBe("有改动还没存好，稍等一下再试。");
    expect(upload("unsupported")).toBe("这个浏览器存不了同步需要的记录，不能连接云端。");
    expect(upload("folderNotReady")).toBe("项目文件夹还没打开好，稍后再试。");
    expect(upload("failed")).toBe("浏览器里的记录写不进去，没能开始。可以再试一次。");
    expect(upload("signedOut")).toBe("登录已过期。重新登录后回到这里，接着连接。");
    expect(upload("outdated")).toBe("编辑器比平台旧，刷新页面后再连接。");
    expect(upload("tooLarge")).toBe("项目的文档和代码太大，云端存不下。删掉太大的文件后再试。");
    expect(upload("stopped")).toBe("上传停下了，再试一次。");
    const repository = (code: string) =>
      connectProblemText({ step: "repository", code } as never, t.t);
    expect(repository("choice")).toBe("仓库这里要改一下，改好再试。");
    expect(repository("invalidName")).toBe("GitHub 不接受这个仓库名，换一个名字。");
    expect(repository("busy")).toBe("操作太频繁了，稍后再试。");
    expect(repository("unavailable")).toBe("暂时连不上平台或 GitHub，稍后再试。");
    expect(repository("signedOut")).toBe("登录已过期，重新登录后再试。");
    // What has no words of its own says its code.
    expect(repository("notLinked")).toBe("没有成功（notLinked），稍后再试。");
    // Nothing of Git shows in any of it.
    const all = JSON.stringify([
      (t.options.resources as Record<string, { translation: { cloud: object; start: object } }>)[
        "zh-CN"
      ]?.translation.cloud,
      (t.options.resources as Record<string, { translation: { cloud: object; start: object } }>)[
        "zh-CN"
      ]?.translation.start,
    ]);
    expect(all).not.toMatch(/提交|推送|分支|LFS|commit|push|branch/i);
  });
});
