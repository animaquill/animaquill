import { ProjectStore } from "@animaquill/core";
import {
  RepositoryRefused,
  SYNC_CLOSE,
  memoryMakingNotes,
  newSyncId,
  type CloudAccess,
  type CloudClose,
} from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sourceFromFiles } from "../../../host/src/folders.ts";
import { prepareProject, keepFiles, readProjectFolder } from "../transfer/import.ts";
import { memoryWindow } from "../workbench/memory-library.ts";
import { MemoryPlatform, TestTime } from "./cloud-support.ts";
import {
  CloudCreate,
  createProblemText,
  takeCreateIntent,
  tidyCreated,
  type CloudCreateOptions,
  type CreateContent,
} from "./create.ts";
import { closeWindows, t, windowOf } from "./projects-support.ts";
import { upload as uploadTo } from "./upload.ts";
import { loadPinyin } from "./repository-name.ts";
import { FakeRepositories } from "./repository-support.ts";

/**
 * Making a new project of the platform, see the design of the start page, 3: platform first, this
 * computer after, so that wherever it stops, what is left is a whole project of some kind, or
 * nothing; giving up takes back what it made.
 */

afterEach(closeWindows);

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const fresh = (
  name: string,
  format?: NonNullable<Parameters<typeof createProject>[0]["format"]>,
): CreateContent => {
  const store = ProjectStore.create(createProject({ name, ...(format && { format }) }));
  const content = { state: store.encodeWhole(), projectId: store.getState().manifest.id };
  store.destroy();
  return content;
};

async function setUp(options: NonNullable<Parameters<typeof windowOf>[2]> = {}) {
  const time = new TestTime();
  const platform = new MemoryPlatform();
  platform.voidsUnmade = true;
  const repository = new FakeRepositories();
  repository.platform = platform;
  const memory = memoryWindow();
  const making = memoryMakingNotes();
  const here = await windowOf(platform, time, { repository, memory, ...options });
  const access: CloudAccess = {
    ...here.browser.access({ isAlive: () => true, asleep: false }),
    repository,
  };
  const opened: string[] = [];
  const createOf = (more: Partial<CloudCreateOptions> = {}) =>
    new CloudCreate({
      cloud: access,
      access: repository,
      account: here.who,
      name: "原子是什么",
      content: fresh,
      keep: (project, result, received) => here.cloud.keepUploaded(project, result, received),
      open: async (key) => {
        await here.open(key);
        opened.push(key);
        return { opened: here.session.key === key, inFolder: false };
      },
      projects: here.cloud,
      signIn: here.signIn,
      installApp: here.installApp,
      memory,
      making,
      window: "w",
      editor: "test",
      checkMs: 50,
      environment: time,
      ...more,
    });
  return { time, platform, repository, here, access, memory, making, createOf, opened };
}

type World = Awaited<ReturnType<typeof setUp>>;

/** People press "新建", and time goes on until what comes of it is there. */
async function submit(create: CloudCreate, time: TestTime, ms = 500): Promise<void> {
  const done = create.submit();
  await time.advance(ms);
  await done;
}

const stepsOf = (create: CloudCreate) => {
  const { upload, repository, place, archive } = create.getSnapshot().steps;
  return [upload, repository, place, archive].join(" ");
};

/**
 * What this browser keeps is all right, as a page that goes away now leaves it: no project that is
 * only in this browser without a link to the platform.
 */
async function expectNothingOnlyHere({ here }: World): Promise<void> {
  for (const summary of await here.library.list()) {
    if (summary.folder) continue;
    expect(await here.browser.links.get(summary.id)).toBeDefined();
  }
}

/** The projects of the platform, by id. */
const onPlatform = ({ platform }: World) => [...platform.projects.keys()];

describe("making a project of the platform", () => {
  it("makes it there, gives it its repository, keeps it here and opens it, in one press", async () => {
    const world = await setUp();
    const { time, platform, repository, here, createOf, opened } = world;
    const create = createOf();
    expect(create.kinds).toEqual(["cloud"]);
    expect(create.getSnapshot()).toMatchObject({
      kind: "cloud",
      need: undefined,
      phase: "choosing",
    });
    // The repository is called after the project, where GitHub takes that, and asked about first.
    create.setName("Atom");
    expect(create.picker?.getSnapshot().name).toBe("atom");
    await time.advance(100);
    expect(repository.checked).toEqual([{ create: { name: "atom" } }]);
    expect(onPlatform(world)).toEqual([]);
    expect(create.canSubmit).toBe(true);

    await submit(create, time);
    const [project] = onPlatform(world);
    expect(project).toBeDefined();
    expect(platform.projects.get(project!)?.name).toBe("Atom");
    expect(platform.repositories.get(project!)).toMatchObject({ name: "atom" });
    expect(repository.links).toEqual([{ create: { name: "atom" } }]);
    // Here as a copy that syncs, by its id on the platform, and open.
    const key = create.getSnapshot().key;
    expect(key).toBe(project);
    expect(opened).toEqual([project]);
    const link = await here.browser.links.get(project!);
    expect(link).toMatchObject({ project, name: "Atom" });
    expect(link?.creating).toBeUndefined();
    expect(here.cloud.getSnapshot()).toMatchObject({ kind: "linked", local: "browser" });
    expect(create.getSnapshot()).toMatchObject({ phase: "archiving", problem: undefined });
    expect(stepsOf(create)).toBe("done done done running");
    // Whole: nothing is left to tidy away.
    expect(world.making.list()).toEqual([]);
    expect(create.takesBack).toBe(false);

    repository.archived(time.now());
    await here.cloud.repository?.refresh();
    await time.advance(10);
    expect(create.getSnapshot().phase).toBe("done");
    expect(stepsOf(create)).toBe("done done done done");
    await expectNothingOnlyHere(world);
  });

  it("says when a name is taken before anything is made", async () => {
    const world = await setUp();
    const { time, repository, createOf } = world;
    repository.taken.add("mine");
    const create = createOf();
    create.picker?.setName("mine");
    await time.advance(100);
    expect(create.picker?.getSnapshot().nameProblem).toBe("taken");
    expect(create.canSubmit).toBe(false);
    await submit(create, time);
    expect(onPlatform(world)).toEqual([]);
  });

  describe("stops at each step, and leaves nothing on the platform once people give up", () => {
    it("where the project cannot get to the platform", async () => {
      const world = await setUp();
      const { time, platform, createOf, access } = world;
      // The platform closes every connection right away, as one that is not there.
      const closing: CloudAccess = {
        ...access,
        connect: () => {
          const connection = platform.connect("ada");
          connection.close(1000, "");
          return {
            ...connection,
            closed: connection.closed.then((): CloudClose => ({
              code: SYNC_CLOSE.unavailable,
              reason: "",
            })),
          };
        },
      };
      const create = createOf({ cloud: closing });
      await submit(create, time);
      expect(create.getSnapshot()).toMatchObject({
        phase: "choosing",
        problem: { step: "upload", code: "unreachable" },
      });
      expect(stepsOf(create)).toBe("failed waiting waiting waiting");
      expect(createProblemText(create.getSnapshot().problem!, t.t)).toContain("连不上平台");
      expect(create.takesBack).toBe(true);
      const outcome = create.cancel();
      await time.advance(100);
      expect(await outcome).toBe("closed");
      expect(create.getSnapshot().phase).toBe("cancelled");
      expect(onPlatform(world)).toEqual([]);
      // The id is taken away for good: a hello still on its way makes nothing.
      expect(platform.deleted.size).toBe(1);
      expect(world.making.list()).toEqual([]);
      await expectNothingOnlyHere(world);
    });

    it("while the project is on its way to the platform", async () => {
      const world = await setUp();
      const { time, platform, createOf } = world;
      platform.faults.silent = true;
      const create = createOf();
      const working = create.submit();
      await time.advance(200);
      expect(create.getSnapshot().steps.upload).toBe("running");
      expect(create.takesBack).toBe(true);
      platform.faults.silent = false;
      const outcome = create.cancel();
      await time.advance(100);
      expect(await outcome).toBe("closed");
      await working;
      expect(create.getSnapshot().phase).toBe("cancelled");
      expect(onPlatform(world)).toEqual([]);
      expect(platform.deleted.size).toBe(1);
      await expectNothingOnlyHere(world);
    });

    it("where the repository cannot be made", async () => {
      const world = await setUp();
      const { time, platform, repository, createOf } = world;
      const create = createOf();
      await time.advance(100);
      repository.refuse.link = new RepositoryRefused("unavailable");
      await submit(create, time);
      expect(create.getSnapshot()).toMatchObject({
        phase: "choosing",
        problem: { step: "repository", code: "unavailable" },
      });
      expect(stepsOf(create)).toBe("done failed waiting waiting");
      const [project] = onPlatform(world);
      expect(project).toBeDefined();
      // A page that goes away now leaves it for the next start page to take away.
      expect(world.making.list()).toEqual([project]);
      expect(await world.here.library.list()).toEqual([]);

      // Trying again goes on with the same project: it is not made twice.
      await submit(create, time);
      expect(onPlatform(world)).toEqual([project]);
      expect(create.getSnapshot().phase).toBe("archiving");
      await expectNothingOnlyHere(world);
      expect(platform.removed).toEqual([]);
    });

    it("gives up after the repository could not be made", async () => {
      const world = await setUp();
      const { time, platform, repository, createOf } = world;
      const create = createOf();
      await time.advance(100);
      repository.refuse.link = new RepositoryRefused("unavailable");
      await submit(create, time);
      const [project] = onPlatform(world);
      const outcome = create.cancel();
      await time.advance(100);
      expect(await outcome).toBe("closed");
      expect(create.getSnapshot().phase).toBe("cancelled");
      expect(onPlatform(world)).toEqual([]);
      expect(platform.removed).toEqual([project]);
      expect(platform.deleted.has(project!)).toBe(true);
      await expectNothingOnlyHere(world);
    });

    it("gives up while the repository is being made", async () => {
      const world = await setUp();
      const { time, platform, repository, createOf } = world;
      let refuse: (error: Error) => void = () => {};
      const link = repository.link.bind(repository);
      repository.link = (project, choice) =>
        new Promise((_, reject) => {
          refuse = reject;
        }).then(() => link(project, choice));
      const create = createOf();
      await time.advance(100);
      const working = create.submit();
      await time.advance(200);
      expect(create.getSnapshot().steps.repository).toBe("running");
      const outcome = create.cancel();
      await time.advance(10);
      refuse(new RepositoryRefused("unavailable"));
      await time.advance(100);
      expect(await outcome).toBe("closed");
      await working;
      expect(onPlatform(world)).toEqual([]);
      expect(platform.removed.length).toBe(1);
      await expectNothingOnlyHere(world);
    });

    it("stays where the platform cannot say that the project is gone, until people let go", async () => {
      const world = await setUp();
      const { time, platform, repository, createOf } = world;
      const create = createOf();
      await time.advance(100);
      repository.refuse.link = new RepositoryRefused("unavailable");
      await submit(create, time);
      const [project] = onPlatform(world);
      platform.faults.unreachable = true;
      const outcome = create.cancel();
      await time.advance(100);
      expect(await outcome).toBe("unconfirmed");
      expect(create.getSnapshot()).toMatchObject({ unconfirmed: true, phase: "choosing" });
      const forced = create.cancel({ force: true });
      await time.advance(100);
      expect(await forced).toBe("closed");
      // Left for the next start page, which takes it away once the platform is there.
      expect(world.making.list()).toEqual([project]);
      platform.faults.unreachable = false;
      await tidyCreated(world.access, world.making);
      expect(onPlatform(world)).toEqual([]);
      expect(world.making.list()).toEqual([]);
    });

    it("does not take back a project once it has its repository", async () => {
      const world = await setUp();
      const { time, platform, createOf } = world;
      const create = createOf();
      await submit(create, time);
      expect(await create.cancel()).toBe("closed");
      expect(onPlatform(world)).toHaveLength(1);
      expect(platform.removed).toEqual([]);
    });
  });

  describe("leaves something whole wherever the page goes away", () => {
    it("before the project is on the platform: nothing", async () => {
      const world = await setUp();
      const { time, platform, createOf } = world;
      platform.faults.silent = true;
      const create = createOf();
      void create.submit();
      await time.advance(200);
      create.close();
      expect(onPlatform(world)).toEqual([]);
      await expectNothingOnlyHere(world);
    });

    it("between the platform and the repository: a project without one, which the next start page takes away", async () => {
      const world = await setUp();
      const { time, platform, repository, createOf, access } = world;
      // One that another page or computer is making right now, without a repository yet either.
      // Of another browser, whose notes this one does not have.
      const other = createOf({ making: memoryMakingNotes() });
      await time.advance(100);
      repository.refuse.link = new RepositoryRefused("unavailable");
      await submit(other, time);
      const [elsewhere] = onPlatform(world);
      other.close();

      const create = createOf();
      await time.advance(100);
      repository.refuse.link = new RepositoryRefused("unavailable");
      await submit(create, time);
      const mine = onPlatform(world).find((id) => id !== elsewhere);
      create.close();
      await expectNothingOnlyHere(world);
      expect(await world.here.library.list()).toEqual([]);

      // The next page of this window.
      await tidyCreated(access, world.making);
      expect(onPlatform(world)).toEqual([elsewhere]);
      expect(platform.removed).toEqual([mine]);
    });

    it("between the repository and this browser: a whole project, to open from the platform", async () => {
      const world = await setUp();
      const { time, createOf, access } = world;
      let keep: () => void = () => {};
      const create = createOf({
        keep: () =>
          new Promise((resolve) => {
            keep = () => resolve(undefined);
          }),
      });
      const working = create.submit();
      await time.advance(500);
      expect(create.getSnapshot().steps).toMatchObject({ repository: "done", place: "running" });
      create.close();
      keep();
      await working;
      expect(onPlatform(world)).toHaveLength(1);
      await expectNothingOnlyHere(world);
      expect(world.making.list()).toEqual([]);
      await tidyCreated(access, world.making);
      expect(onPlatform(world)).toHaveLength(1);
    });

    it("between this browser and opening: a copy with its link", async () => {
      const world = await setUp();
      const { time, createOf, here } = world;
      const create = createOf({ open: () => new Promise(() => {}) });
      void create.submit();
      await time.advance(500);
      expect(create.getSnapshot().key).toBeDefined();
      create.close();
      const kept = await here.library.list();
      expect(kept).toHaveLength(1);
      await expectNothingOnlyHere(world);
    });
  });

  it("says where it could not come into this browser, and takes nothing back", async () => {
    const world = await setUp();
    const { time, platform, createOf } = world;
    const create = createOf({ keep: async () => undefined });
    await submit(create, time);
    expect(create.getSnapshot()).toMatchObject({
      phase: "done",
      problem: { step: "place", code: "browser" },
    });
    expect(createProblemText(create.getSnapshot().problem!, t.t)).toContain("云端项目已经建好");
    expect(onPlatform(world)).toHaveLength(1);
    expect(platform.removed).toEqual([]);
  });

  it("asks for a folder in the press, and makes nothing where people choose none", async () => {
    const world = await setUp();
    const { time, createOf } = world;
    let asked = 0;
    const create = createOf({
      chooseFolder: async () => {
        asked += 1;
        return asked === 1 ? undefined : "project";
      },
    });
    create.setWithFolder(true);
    await time.advance(100);
    const pressed = create.submit();
    // Right in the press, before anything waits.
    expect(asked).toBe(1);
    await time.advance(100);
    await pressed;
    expect(create.getSnapshot()).toMatchObject({ phase: "choosing", problem: undefined });
    expect(onPlatform(world)).toEqual([]);
    await submit(create, time);
    expect(create.getSnapshot().problem).toEqual({ step: "folder", code: "project" });
    expect(onPlatform(world)).toEqual([]);
  });

  it("comes back with what people chose after signing in, and goes on", async () => {
    const world = await setUp({ signedIn: false });
    const { time, here, createOf, memory } = world;
    const create = createOf();
    expect(create.getSnapshot().need).toBe("signIn");
    expect(create.canSubmit).toBe(false);
    create.setName("原子");
    create.setWithFolder(true);
    create.picker?.setName("atom-film");
    await create.signIn();
    expect(here.signIn).toHaveBeenCalledTimes(1);
    // The page goes.
    create.close();

    const intent = takeCreateIntent(memory, time.now());
    expect(intent).toMatchObject({
      name: "原子",
      repository: "atom-film",
      touched: true,
      mode: "create",
    });
    // Once.
    expect(takeCreateIntent(memory, time.now())).toBeUndefined();
    here.who.set({ status: "signedIn", id: "user-ada", name: "ada", appInstalled: true });
    const again = createOf({ intent: intent!, chooseFolder: async () => undefined });
    expect(again.getSnapshot()).toMatchObject({ kind: "cloud", name: "原子", need: undefined });
    // No folder without a way to choose one.
    expect(again.picker?.getSnapshot().name).toBe("atom-film");
    await time.advance(100);
    again.setWithFolder(false);
    await submit(again, time);
    expect(again.getSnapshot().phase).toBe("archiving");
    expect(world.platform.repositories.get(onPlatform(world)[0]!)).toMatchObject({
      name: "atom-film",
    });
  });

  it("is what an imported project becomes, with the files of its assets here", async () => {
    const world = await setUp();
    const { time, here, createOf, platform } = world;
    const folder = mkdtempSync(join(tmpdir(), "animaquill-import-"));
    made.push(folder);
    const sample = fileURLToPath(new URL("../../../schema/fixtures/v1", import.meta.url));
    const root = join(folder, "原子");
    cpSync(sample, root, { recursive: true });
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets/logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    // Tags are the person's own: a folder brought in has none to say.
    const manifest = JSON.parse(readFileSync(join(root, "animaquill.json"), "utf8"));
    delete manifest.tags;
    writeFileSync(join(root, "animaquill.json"), JSON.stringify(manifest));
    const files: File[] = [];
    const walk = (place: string, prefix: string) => {
      for (const entry of readdirSync(place, { withFileTypes: true })) {
        const path = join(place, entry.name);
        if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
        else {
          const file = new File([new Uint8Array(readFileSync(path))], entry.name);
          Object.defineProperty(file, "webkitRelativePath", {
            value: `${basename(root)}/${prefix}${entry.name}`,
          });
          files.push(file);
        }
      }
    };
    walk(root, "");
    const read = await readProjectFolder(sourceFromFiles(files), t.t);
    const prepared = await prepareProject(read);
    expect(prepared.files).toHaveLength(1);
    const content = (name: string): CreateContent => {
      const store = ProjectStore.create(
        { ...prepared.project, manifest: { ...prepared.project.manifest, name } },
        prepared.sources,
      );
      const result = { state: store.encodeWhole(), projectId: store.getState().manifest.id };
      store.destroy();
      return result;
    };
    const create = createOf({
      name: prepared.project.manifest.name,
      content,
      imported: true,
      receive: (project, name) => here.cloud.receiveFor(project, name),
      bring: (media) => keepFiles(prepared, media),
    });
    // Only a project of the platform: nothing new is only in this browser.
    expect(create.getSnapshot().kind).toBe("cloud");
    await submit(create, time);
    const [project] = onPlatform(world);
    expect(platform.projects.get(project!)?.projectId).toBe(prepared.project.manifest.id);
    expect(create.getSnapshot().phase).toBe("archiving");
    const key = create.getSnapshot().key!;
    const hash = prepared.files[0]!.hash;
    expect(await here.library.media(key).get(hash)).toBeDefined();
    expect(here.session.store?.getState().manifest.name).toBe("原子是什么");
    await expectNothingOnlyHere(world);
  });
});

describe("what can be made", () => {
  it("is a folder, a project of the platform, and one in this browser only for tests", async () => {
    const world = await setUp();
    const make = world.createOf({
      createLocal: async () => {},
      createHere: async () => {},
    });
    expect(make.kinds).toEqual(["local", "cloud", "browser"]);
    // Tests make theirs in the browser by default; people never get that kind.
    expect(make.getSnapshot().kind).toBe("browser");
    const people = world.createOf({ createLocal: async () => {} });
    expect(people.kinds).toEqual(["local", "cloud"]);
    expect(people.getSnapshot().kind).toBe("cloud");
    const imported = world.createOf({ createHere: async () => {}, imported: true });
    expect(imported.kinds).toEqual(["cloud"]);
  });

  it("makes a project of this computer right in the press", async () => {
    const world = await setUp();
    const names: string[] = [];
    const create = world.createOf({
      createLocal: async (name) => {
        names.push(name);
      },
    });
    create.setKind("local");
    create.setName("本地的");
    const pressed = create.submit();
    expect(names).toEqual(["本地的"]);
    await pressed;
    expect(create.getSnapshot().phase).toBe("done");
    expect(onPlatform(world)).toEqual([]);
  });
});

describe("what a new project is like", () => {
  it("is of the platform where someone is signed in, and of this computer where not", async () => {
    const world = await setUp({ signedIn: false });
    const create = world.createOf({ createLocal: async () => {} });
    expect(create.getSnapshot().kind).toBe("local");
    // Signing in, as the account says once it knows.
    world.here.who.set({ status: "signedIn", id: "user-ada", name: "ada", appInstalled: true });
    expect(create.getSnapshot().kind).toBe("cloud");
    // What people chose stays, whatever the account says.
    create.setKind("local");
    world.here.who.set({ status: "signedOut" });
    world.here.who.set({ status: "signedIn", id: "user-ada", name: "ada", appInstalled: true });
    expect(create.getSnapshot().kind).toBe("local");
    // Without folders there is only the platform, signed in or not.
    const noFolders = (await setUp({ signedIn: false })).createOf();
    expect(noFolders.kinds).toEqual(["cloud"]);
    expect(noFolders.getSnapshot()).toMatchObject({ kind: "cloud", need: "signIn" });
  });

  it("is made in the shape and at the frame rate people chose, landscape at 30 by default", async () => {
    const world = await setUp();
    const { time, platform, here } = world;
    const local: unknown[] = [];
    const create = world.createOf({
      createLocal: async (_name, format) => {
        local.push(format);
      },
    });
    expect(create.getSnapshot()).toMatchObject({ shape: "landscape", fps: "30" });
    expect(create.format).toMatchObject({ width: 1920, height: 1080, fps: "30" });
    create.setShape("portrait");
    create.setFps("60");
    await time.advance(100);
    await submit(create, time);
    const [project] = onPlatform(world);
    const store = here.session.store;
    expect(store?.getState().manifest.formats[0]).toMatchObject({
      id: "portrait",
      width: 1080,
      height: 1920,
      fps: "60",
    });
    expect(store?.getState().manifest.fps).toBe("60");
    expect(platform.projects.get(project!)).toBeDefined();

    const mine = world.createOf({ createLocal: async (_name, format) => void local.push(format) });
    mine.setKind("local");
    mine.setSize("1280", "720");
    expect(mine.getSnapshot().shape).toBe("custom");
    await mine.submit();
    expect(local).toEqual([{ id: "custom", name: "自定义", width: 1280, height: 720, fps: "30" }]);
  });

  it("takes no size that the format of a project does not", async () => {
    const world = await setUp();
    const create = world.createOf();
    await world.time.advance(100);
    expect(create.canSubmit).toBe(true);
    for (const [width, height] of [
      ["0", "720"],
      ["12.5", "720"],
      ["", "720"],
      ["abc", "1"],
    ]) {
      create.setSize(width!, height!);
      expect(create.format).toBeUndefined();
      expect(create.canSubmit).toBe(false);
    }
    await submit(create, world.time);
    expect(onPlatform(world)).toEqual([]);
  });

  it("gets a repository called after it, in pinyin, until people name it", async () => {
    const world = await setUp();
    const create = world.createOf({ pinyin: loadPinyin });
    // Until the pinyin is there, a name that always works.
    expect(create.picker?.getSnapshot().name).toMatch(/^animaquill-\d{8}$/);
    await world.time.advance(10);
    await loadPinyin();
    await world.time.advance(10);
    expect(create.picker?.getSnapshot().name).toBe("yuan-zi-shi-shen-me");
    create.setName("原子 2");
    expect(create.picker?.getSnapshot().name).toBe("yuan-zi-2");
    create.picker?.setName("mine");
    create.setName("别的");
    expect(create.picker?.getSnapshot().name).toBe("mine");
  });
});

describe("what the independent review found", () => {
  /** As the platform: no repository for a project that is not there. */
  const strict = (world: World) => {
    const link = world.repository.link.bind(world.repository);
    world.repository.link = async (project, choice) => {
      if (!world.platform.projects.has(project)) throw new RepositoryRefused("notFound");
      return link(project, choice);
    };
  };

  it("leaves the project another window of the browser is making, as a duplicated tab", async () => {
    const world = await setUp();
    const { time, platform, repository, access, making, createOf } = world;
    strict(world);
    const create = createOf();
    await time.advance(100);
    repository.refuse.link = new RepositoryRefused("unavailable");
    await submit(create, time);
    const [project] = onPlatform(world);
    // The other tab tidies what the browser noted: this one is still making it.
    await tidyCreated(access, making);
    expect(platform.projects.has(project!)).toBe(true);
    await submit(create, time);
    expect(create.getSnapshot().phase).toBe("archiving");
    expect(onPlatform(world)).toEqual([project]);
    expect(making.list()).toEqual([]);
  });

  it("takes away what a closed window left halfway, from another window", async () => {
    const world = await setUp();
    const { time, repository, access, making, createOf } = world;
    const create = createOf();
    await time.advance(100);
    repository.refuse.link = new RepositoryRefused("unavailable");
    await submit(create, time);
    // The tab is closed: what it held, it lets go of.
    create.close();
    await tidyCreated(access, making);
    expect(onPlatform(world)).toEqual([]);
    expect(making.list()).toEqual([]);
  });

  it("makes the project anew where it is gone from the platform before it had its repository", async () => {
    const world = await setUp();
    const { time, platform, repository, createOf } = world;
    strict(world);
    const create = createOf();
    await time.advance(100);
    repository.refuse.link = new RepositoryRefused("unavailable");
    await submit(create, time);
    const [first] = onPlatform(world);
    platform.remove("ada", first!);
    await submit(create, time);
    expect(create.getSnapshot().problem).toEqual({ step: "upload", code: "undone" });
    expect(createProblemText(create.getSnapshot().problem!, t.t)).toContain("重新开始");
    // Not stuck: the next press makes it under a new id.
    await submit(create, time);
    expect(create.getSnapshot().phase).toBe("archiving");
    const [second] = onPlatform(world);
    expect(second).not.toBe(first);
    expect(platform.repositories.has(second!)).toBe(true);
  });

  it("keeps an id the platform's list does not have yet from being made later", async () => {
    const world = await setUp();
    const { time, platform, access, making } = world;
    const project = newSyncId();
    // A page that went away while its first version was on its way.
    making.note(project);
    await tidyCreated(access, making);
    expect(making.list()).toEqual([]);
    expect(platform.deleted.has(project)).toBe(true);
    const content = fresh("Atom");
    const late = uploadTo(access, {
      project,
      state: content.state,
      create: { name: "Atom", projectId: content.projectId },
      window: "w0",
      editor: "test",
    });
    await time.advance(500);
    await expect(late.done).rejects.toMatchObject({ code: "missing" });
    expect(platform.projects.has(project)).toBe(false);
  });

  it("makes nothing where the files of an imported project cannot be kept here", async () => {
    const world = await setUp();
    const { time, platform, repository, here, createOf, making } = world;
    const create = createOf({
      imported: true,
      receive: (project, name) => here.cloud.receiveFor(project, name),
      bring: async () => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      },
    });
    await time.advance(100);
    await submit(create, time);
    expect(create.getSnapshot()).toMatchObject({
      phase: "choosing",
      problem: { step: "files", code: "quota" },
    });
    expect(createProblemText(create.getSnapshot().problem!, t.t)).toContain("空间不够");
    expect(onPlatform(world)).toEqual([]);
    expect(platform.deleted.size).toBe(0);
    expect(repository.links).toEqual([]);
    expect(await here.library.list()).toEqual([]);
    expect(making.list()).toEqual([]);
    expect(create.takesBack).toBe(false);
  });

  it("does not change the name of the repository once people pressed", async () => {
    const world = await setUp();
    let loaded: (toPinyin: (text: string) => string[]) => void = () => {};
    const create = world.createOf({
      pinyin: () => new Promise((resolve) => (loaded = resolve)),
      chooseFolder: () => new Promise(() => {}),
    });
    const before = create.picker?.getSnapshot().name;
    create.setWithFolder(true);
    await world.time.advance(100);
    void create.submit();
    loaded((text) => [...text].map(() => "zi"));
    await world.time.advance(10);
    expect(create.picker?.getSnapshot().name).toBe(before);
  });
});
