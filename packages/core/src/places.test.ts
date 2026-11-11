import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { checkWritten } from "./check-change.ts";
import type { FileChange } from "./merge-files.ts";
import { elsewhereOf, placedAsset, type Here } from "./model.ts";
import { NOBODY } from "./origin.ts";
import {
  ProjectStore,
  STORAGE,
  USER,
  aiTask,
  folderBatch,
  type CommandResult,
  type ExecuteOptions,
} from "./store.ts";

const HASH = "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU=";
const OTHER = "sha256-LCa0a2j_xo_5m0U8HTBBNBNCLXBkg7-g-YpeiGJm564=";
const THIRD = "sha256-6bOrTGQvq9OQLIpDEjsqX_0xemtgGl_19ESFUq4taEg=";
/** The same content as `HASH`, the way a tool that writes hexadecimal has it. */
const HEX = "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ASSETS = "assets.json";
const URL = "https://bucket.example.com/animaquill/sha256/e3b0";

/** The repository of the project on GitHub, who is signed in, and a storage of the person. */
const REPO = "123456";
const OWNER = "a3f0c2d4-7b1e-4c55-9d2a-0b6e1f2a3c4d";
const STORE = "my-r2";
/** What each place is bound to, as uploads say it. */
const BOUND: Readonly<Record<string, object>> = {
  lfs: { repo: REPO },
  platform: { owner: OWNER },
  remote: { url: URL, store: STORE },
  local: {},
};
const HERE: Here = { repo: REPO, owner: OWNER, stores: [STORE] };

const file = {
  name: "a.mp4",
  kind: "video",
  path: "assets/a.mp4",
  storage: "local",
  hash: HASH,
  size: 3,
} as const;

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

/** A project with one video that came in, as the editor brings files in: only here. */
function withAsset(asset: object = file): ProjectStore {
  const store = ProjectStore.create(createProject({ name: "存放位置" }));
  success(store.execute({ type: "asset.add", params: { id: "a", asset } }));
  return store;
}

/** A project whose assets.json says this of the asset, as a file of another tool can. */
function fromFile(asset: object): ProjectStore {
  const files = ProjectStore.create(createProject({ name: "存放位置" })).exportFiles().files;
  files.set(ASSETS, JSON.stringify({ assets: { a: asset } }));
  const { store, problems } = ProjectStore.open(files);
  expect(problems.filter(({ severity }) => severity === "error")).toEqual([]);
  if (!store) throw new Error("The project did not open");
  return store;
}

const setStorage = (store: ProjectStore, params: object, options: ExecuteOptions) =>
  store.execute({ type: "asset.setStorage", params: { asset: "a", ...params } }, options);

/** What an upload says once the file got there. */
const uploaded = (store: ProjectStore, storage = "lfs", hash = HASH) =>
  success(setStorage(store, { storage, hash, ...BOUND[storage] }, { origin: STORAGE }));

const placed = (store: ProjectStore, id = "a", here?: Here) =>
  placedAsset(store.getState(), id, here);

/** The asset as assets.json has it. */
function inFile(store: ProjectStore, id = "a") {
  const { files, problems } = store.exportFiles();
  expect(problems).toEqual([]);
  return JSON.parse(files.get(ASSETS) as string).assets[id];
}

function twin(store: ProjectStore, client: number): ProjectStore {
  const doc = new Y.Doc();
  doc.clientID = client;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc), "sync");
  return new ProjectStore(doc);
}

function sync(a: ProjectStore, b: ProjectStore): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), "sync");
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)), "sync");
}

describe("writing down where the file of an asset is kept", () => {
  it("is what an upload does once the file got there, for the content the asset has", () => {
    const store = withAsset();
    uploaded(store);
    expect(placed(store)).toEqual({ ...file, storage: "lfs" });
    expect(inFile(store)).toEqual({ ...file, storage: "lfs" });
    // The asset itself stays as it was: where its file is sits next to it, with what it is bound to.
    expect(store.getState().assets?.["a"]).toEqual(file);
    expect(store.getState().places?.["a"]).toEqual({
      storage: "lfs",
      hash: HASH,
      size: 3,
      repo: REPO,
    });
  });

  it("takes each place that uploads put files in, with what it needs and is bound to", () => {
    for (const storage of ["lfs", "platform", "remote"]) {
      const store = withAsset();
      uploaded(store, storage);
      expect(inFile(store)).toMatchObject({ storage, hash: HASH, size: 3 });
      expect(store.getState().places?.["a"]).toMatchObject(BOUND[storage] ?? {});
    }
    // A storage of the person without an id of its own, as any https address.
    const store = withAsset();
    success(setStorage(store, { storage: "remote", url: URL, hash: HASH }, { origin: STORAGE }));
    expect(inFile(store)).toEqual({ ...file, storage: "remote", url: URL });
  });

  it("does not happen when the asset has another file now, as one replaced while it went up", () => {
    const store = withAsset();
    const replaced = { asset: "a", changes: { hash: OTHER, size: 5 } };
    success(store.execute({ type: "asset.update", params: replaced }));
    const result = setStorage(
      store,
      { storage: "lfs", hash: HASH, repo: REPO },
      { origin: STORAGE },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "file-changed" } });
    expect(placed(store)?.storage).toBe("local");
    expect(store.getState().places).toBeUndefined();
  });

  it("does not happen for an asset whose content nobody knows yet", () => {
    const { hash: _hash, ...unknown } = file;
    const store = withAsset(unknown);
    const result = setStorage(
      store,
      { storage: "lfs", hash: HASH, repo: REPO },
      { origin: STORAGE },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "file-changed" } });
  });

  it("needs the size of the file, which other computers check what they get by", () => {
    const { size: _size, ...unsized } = file;
    const store = withAsset(unsized);
    for (const storage of ["lfs", "platform", "remote"]) {
      const params = { storage, hash: HASH, ...BOUND[storage] };
      expect(setStorage(store, params, { origin: STORAGE }), storage).toMatchObject({
        ok: false,
        error: { code: "invalid-value" },
      });
    }
    // Only here needs nothing.
    success(setStorage(store, { storage: "local", hash: HASH }, { origin: USER }));
  });

  it("knows the content however a tool wrote its hash", () => {
    const store = withAsset({ ...file, hash: HEX });
    uploaded(store);
    expect(inFile(store)).toMatchObject({ storage: "lfs", hash: HEX });
  });

  it("is something only uploads say: people take it back to local, AI and the rest not at all", () => {
    const store = withAsset();
    const lfs = { storage: "lfs", hash: HASH, repo: REPO };
    expect(setStorage(store, lfs, { origin: USER })).toMatchObject({
      ok: false,
      error: { code: "upload-only" },
    });
    for (const origin of [aiTask("t"), folderBatch("1"), NOBODY]) {
      for (const params of [lfs, { storage: "local", hash: HASH }]) {
        expect(setStorage(store, params, { origin }), origin).toMatchObject({
          ok: false,
          error: { code: "user-only" },
        });
      }
    }
    expect(store.getState().places).toBeUndefined();
  });

  it("is all that uploads can do", () => {
    const store = withAsset();
    const rename = { type: "asset.update", params: { asset: "a", changes: { name: "b" } } };
    expect(store.execute(rename, { origin: STORAGE })).toMatchObject({
      ok: false,
      error: { code: "storage-only" },
    });
    const text = store.exportFiles().files.get(ASSETS) as string;
    expect(store.importFile(ASSETS, text, { origin: STORAGE })).toMatchObject({
      ok: false,
      error: { code: "storage-only" },
    });
    const batch: FileChange[] = [{ path: ASSETS, base: text, text }];
    const merged = store.mergeFiles(batch, { origin: STORAGE, baseOf: () => undefined });
    expect(merged).toMatchObject({ ok: false, error: { code: "storage-only" } });
  });

  it("says what each place is bound to, and only that", () => {
    const store = withAsset();
    for (const [params, why] of [
      [{ storage: "lfs", hash: HASH }, "lfs without its repository"],
      [{ storage: "platform", hash: HASH }, "platform without whose space"],
      [{ storage: "lfs", hash: HASH, repo: REPO, owner: OWNER }, "lfs with an owner"],
      [{ storage: "platform", hash: HASH, owner: OWNER, store: STORE }, "platform with a storage"],
      [{ storage: "remote", hash: HASH, url: URL, repo: REPO }, "remote with a repository"],
      [{ storage: "local", hash: HASH, repo: REPO }, "local bound to anything"],
      [{ storage: "lfs", hash: HASH, repo: "../a" }, "a repository that is no id"],
      [{ storage: "lfs", hash: HASH, repo: REPO, url: URL }, "lfs with an address"],
      [{ storage: "remote", hash: HASH }, "remote without an address"],
      [{ storage: "git", hash: HASH }, "git, which uploads never put files in"],
    ] as const) {
      expect(setStorage(store, params, { origin: STORAGE }), why).toMatchObject({
        ok: false,
        error: { code: "invalid-params" },
      });
    }
    expect(store.getState().places).toBeUndefined();
  });

  it("happens also while the project is locked: it changes nothing that the project shows", () => {
    const store = withAsset();
    const lock = { tags: [{ name: "定稿", locked: true }] };
    success(store.execute({ type: "project.setTags", params: lock }));
    uploaded(store);
    expect(placed(store)?.storage).toBe("lfs");
    success(setStorage(store, { storage: "local", hash: HASH }, { origin: USER }));
    expect(placed(store)?.storage).toBe("local");
    const rename = { type: "asset.update", params: { asset: "a", changes: { name: "b" } } };
    expect(store.execute(rename)).toMatchObject({ ok: false, error: { code: "project-locked" } });
  });

  it("is nothing to undo when an upload writes it down", () => {
    const store = withAsset();
    const imported = store.lastStep;
    uploaded(store);
    expect(store.lastStep).toBe(imported);
    expect(store.canUndoOrigin(STORAGE)).toBe(false);
    expect(store.history.at(-1)).toMatchObject({ origin: STORAGE, commands: ["asset.setStorage"] });
    // Undo goes on with what people did, and leaves where the file went alone.
    success(
      store.execute({ type: "asset.update", params: { asset: "a", changes: { name: "b" } } }),
    );
    expect(store.undo().ok).toBe(true);
    expect(placed(store)).toMatchObject({ name: "a.mp4", storage: "lfs" });
  });

  it("is something people can take back to local, and that back again", () => {
    const store = withAsset();
    uploaded(store);
    success(setStorage(store, { storage: "local", hash: HASH }, { origin: USER }));
    expect(inFile(store).storage).toBe("local");
    expect(store.undo().ok).toBe(true);
    expect(inFile(store).storage).toBe("lfs");
    expect(store.redo().ok).toBe(true);
    expect(inFile(store).storage).toBe("local");
  });

  it("does not stop people from taking back what they did to the asset meanwhile", () => {
    const store = withAsset();
    success(
      store.execute({ type: "asset.update", params: { asset: "a", changes: { name: "b" } } }),
    );
    uploaded(store);
    const back = store.undo();
    expect(back).toMatchObject({ ok: true, kept: [] });
    expect(placed(store)).toMatchObject({ name: "a.mp4", storage: "lfs" });
  });

  it("changes nothing when it says what is written down already", () => {
    const store = withAsset();
    uploaded(store);
    const revision = store.revision;
    expect(uploaded(store).patches).toEqual([]);
    expect(store.revision).toBe(revision);
    // What the asset says itself needs nothing next to it.
    success(setStorage(store, { storage: "local", hash: HASH }, { origin: USER }));
    expect(store.getState().places).toBeUndefined();
  });

  it("goes with the asset, and comes back with it", () => {
    const store = withAsset();
    uploaded(store);
    success(store.execute({ type: "asset.remove", params: { asset: "a" } }));
    expect(store.getState().places).toBeUndefined();
    expect(store.undo().ok).toBe(true);
    expect(placed(store)?.storage).toBe("lfs");
  });
});

describe("an asset that comes in by a command", () => {
  it("is only here, or in the person's own Git: nobody says through it that a file is elsewhere", () => {
    for (const origin of [USER, aiTask("t"), folderBatch("1")]) {
      const store = ProjectStore.create(createProject({ name: "存放位置" }));
      for (const asset of [
        { ...file, storage: "lfs" },
        { ...file, storage: "platform" },
        { ...file, storage: "remote", url: URL },
      ]) {
        const add = { type: "asset.add", params: { id: "b", asset } };
        expect(store.execute(add, { origin }), `${origin} ${asset.storage}`).toMatchObject({
          ok: false,
          error: { code: "invalid-params" },
        });
      }
      expect(store.getState().assets).toBeUndefined();
      for (const storage of ["local", "git"]) {
        const asset = { ...file, path: `assets/${storage}.mp4`, storage };
        success(store.execute({ type: "asset.add", params: { id: storage, asset } }, { origin }));
      }
    }
  });

  it("is only here where it does not say", () => {
    const store = ProjectStore.create(createProject({ name: "存放位置" }));
    const { storage: _storage, ...unsaid } = file;
    success(store.execute({ type: "asset.add", params: { id: "a", asset: unsaid } }));
    expect(store.getState().assets?.["a"]?.storage).toBe("local");
  });
});

describe("what people change of an asset while an upload writes down where its file went", () => {
  // Yjs decides between two values of one key by which of the two windows has the larger number.
  for (const [uploads, renames] of [
    [1, 2],
    [2, 1],
  ] as const) {
    it(`both stay, when they meet (${uploads} uploads, ${renames} renames)`, () => {
      const store = withAsset();
      const uploading = twin(store, uploads);
      const renaming = twin(store, renames);
      uploaded(uploading);
      const changes = { name: "新名字", tags: ["片头"] };
      success(renaming.execute({ type: "asset.update", params: { asset: "a", changes } }));
      sync(uploading, renaming);
      for (const each of [uploading, renaming]) {
        expect(placed(each)).toEqual({ ...file, ...changes, storage: "lfs" });
        expect(inFile(each)).toEqual({ ...file, ...changes, storage: "lfs" });
      }
    });

    it(`says the file is only here, when it was replaced meanwhile (${uploads}, ${renames})`, () => {
      const store = withAsset();
      const uploading = twin(store, uploads);
      const replacing = twin(store, renames);
      uploaded(uploading);
      const changes = { hash: OTHER, size: 5 };
      success(replacing.execute({ type: "asset.update", params: { asset: "a", changes } }));
      sync(uploading, replacing);
      for (const each of [uploading, replacing]) {
        expect(inFile(each)).toEqual({ ...file, ...changes, storage: "local" });
      }
    });

    it(`keeps the size of the file where a file without it came in meanwhile (${uploads}, ${renames})`, () => {
      const store = withAsset();
      const uploading = twin(store, uploads);
      const importing = twin(store, renames);
      uploaded(uploading, "platform");
      // Each of the two is fine on its own: an asset only here needs no size.
      const { size: _size, ...unsized } = file;
      const text = JSON.stringify({ assets: { a: { ...unsized, name: "外面" } } });
      success(importing.importFile(ASSETS, text, { origin: USER }));
      sync(uploading, importing);
      for (const each of [uploading, importing]) {
        expect(inFile(each)).toEqual({ ...file, name: "外面", storage: "platform" });
      }
    });
  }
});

describe("a place, as an asset reads with it", () => {
  it("says nothing where the asset has another size than the file it was written down for", () => {
    const store = withAsset();
    uploaded(store);
    // Another size with the same hash, as a tool wrote it: no file anybody uploaded is like that.
    success(store.execute({ type: "asset.update", params: { asset: "a", changes: { size: 4 } } }));
    expect(store.getState().places?.["a"]).toBeDefined();
    expect(inFile(store)).toEqual({ ...file, size: 4 });
  });

  it("says nothing where it is bound to another repository, person or storage than here", () => {
    for (const [storage, elsewhere] of [
      ["lfs", { repo: "999" }],
      ["platform", { owner: "someone-else" }],
      ["remote", { stores: ["another-bucket"] }],
    ] as const) {
      const store = withAsset();
      uploaded(store, storage);
      expect(placed(store, "a", HERE)?.storage, storage).toBe(storage);
      expect(elsewhereOf(store.getState(), "a", HERE), storage).toBe(storage);
      // Copied, linked to another repository, opened by somebody else, or on another computer.
      for (const here of [{ ...HERE, ...elsewhere }, {}]) {
        expect(placed(store, "a", here)?.storage, storage).toBe("local");
        expect(elsewhereOf(store.getState(), "a", here), storage).toBeUndefined();
      }
      // Where nobody says where here is, a place counts as it is.
      expect(placed(store)?.storage).toBe(storage);
    }
  });

  it("counts anywhere for a storage that has no id, as any address", () => {
    const store = withAsset();
    success(setStorage(store, { storage: "remote", url: URL, hash: HASH }, { origin: STORAGE }));
    expect(placed(store, "a", {})?.storage).toBe("remote");
  });

  it("goes into files only where it is bound to where they go", () => {
    const store = withAsset();
    uploaded(store);
    const asFile = (here: Here) =>
      JSON.parse(store.exportFiles({ here }).files.get(ASSETS) as string).assets.a.storage;
    expect(asFile({ repo: REPO })).toBe("lfs");
    expect(asFile({ repo: "999" })).toBe("local");
  });
});

describe("another file for an asset", () => {
  it("is only here: where the one before went says nothing about it", () => {
    const store = withAsset();
    uploaded(store, "platform");
    const replaced = { asset: "a", changes: { hash: OTHER, size: 5 } };
    success(store.execute({ type: "asset.update", params: replaced }));
    expect(inFile(store)).toMatchObject({ storage: "local", hash: OTHER });
    // The file from before comes back with undo, and so does where it was.
    expect(store.undo().ok).toBe(true);
    expect(inFile(store)).toMatchObject({ storage: "platform", hash: HASH });
  });

  it("is only here also where a file of the project said where the one before was", () => {
    const store = fromFile({ ...file, storage: "remote", url: URL });
    const replaced = { asset: "a", changes: { hash: OTHER, size: 5 } };
    success(store.execute({ type: "asset.update", params: replaced }));
    const asset = inFile(store);
    expect(asset).toMatchObject({ storage: "local", hash: OTHER });
    expect(asset).not.toHaveProperty("url");
  });

  it("is no other file when only the way the hash is written changed", () => {
    const store = fromFile({ ...file, storage: "lfs" });
    success(
      store.execute({ type: "asset.update", params: { asset: "a", changes: { hash: HEX } } }),
    );
    expect(inFile(store)).toMatchObject({ storage: "lfs", hash: HEX });
  });
});

describe("an lfs asset without its hash and size, as projects from before 2026-11-10 have them", () => {
  const bare = { name: "旁白", kind: "audio", path: "assets/voice/en.flac", storage: "lfs" };

  it("opens, can be changed and is written as it is, but cannot be downloaded", () => {
    const store = fromFile(bare);
    success(
      store.execute({ type: "asset.update", params: { asset: "a", changes: { name: "配音" } } }),
    );
    expect(inFile(store)).toEqual({ ...bare, name: "配音" });
    expect(elsewhereOf(store.getState(), "a")).toBeUndefined();
  });

  it("is something an upload only writes down once it knows the hash and the size", () => {
    const store = fromFile({ ...bare, hash: HASH });
    const lfs = { storage: "lfs", hash: HASH, repo: REPO };
    expect(setStorage(store, lfs, { origin: STORAGE })).toMatchObject({
      ok: false,
      error: { code: "invalid-value" },
    });
    expect(elsewhereOf(store.getState(), "a")).toBeUndefined();
  });

  it("is what the platform takes too, but no cloud space without them", () => {
    expect(checkWritten(["assets", "a"], bare)).toBeUndefined();
    const { hash: _hash, size: _size, ...without } = file;
    expect(checkWritten(["assets", "a"], { ...without, storage: "platform" })).toBeDefined();
    expect(checkWritten(["assets", "a"], { ...without, storage: "remote" })).toBeDefined();
  });
});

describe("assets.json that comes in", () => {
  const rewrite = (store: ProjectStore, change: (asset: Record<string, unknown>) => void) => {
    const document = JSON.parse(store.exportFiles().files.get(ASSETS) as string);
    change(document.assets.a);
    return JSON.stringify(document);
  };

  it("keeps where the file went, when it says so too", () => {
    const store = withAsset();
    uploaded(store);
    const text = rewrite(store, (asset) => (asset.name = "新名字"));
    success(store.importFile(ASSETS, text, { origin: USER }));
    expect(placed(store)).toMatchObject({ name: "新名字", storage: "lfs" });
    // The asset goes on saying what it said itself: taking back the place still goes back to it.
    expect(store.getState().assets?.["a"]?.storage).toBe("local");
    expect(store.getState().places?.["a"]).toBeDefined();
  });

  it("changes nothing when it is what the editor wrote", () => {
    const store = withAsset();
    uploaded(store);
    const text = store.exportFiles().files.get(ASSETS) as string;
    expect(success(store.importFile(ASSETS, text, { origin: USER })).patches).toEqual([]);
  });

  it("says where the file is when it says something else, and the place goes", () => {
    const store = withAsset();
    uploaded(store);
    const text = rewrite(store, (asset) => (asset.storage = "platform"));
    success(store.importFile(ASSETS, text, { origin: USER }));
    expect(placed(store)?.storage).toBe("platform");
    expect(store.getState().assets?.["a"]?.storage).toBe("platform");
    expect(store.getState().places).toBeUndefined();
  });

  it("says another file is only here, where it left what was said of the one before", () => {
    const store = withAsset();
    uploaded(store);
    // A tool replaced the file and wrote its hash, and left the rest.
    const text = rewrite(store, (asset) => Object.assign(asset, { hash: OTHER, size: 5 }));
    success(store.importFile(ASSETS, text, { origin: USER }));
    expect(inFile(store)).toEqual({ ...file, hash: OTHER, size: 5 });
  });

  it("says where another file is, where it says so of the new one", () => {
    const store = withAsset();
    const text = rewrite(store, (asset) =>
      Object.assign(asset, { hash: OTHER, size: 5, storage: "platform" }),
    );
    success(store.importFile(ASSETS, text, { origin: USER }));
    expect(inFile(store)).toEqual({ ...file, hash: OTHER, size: 5, storage: "platform" });
  });

  it("leaves the place of an asset it takes away, which says nothing without it", () => {
    const store = withAsset();
    uploaded(store);
    const text = JSON.stringify({ assets: {} });
    success(store.importFile(ASSETS, text, { origin: USER }));
    expect(placed(store)).toBeUndefined();
    expect(store.getState().assets ?? {}).toEqual({});
    // The asset that comes back with undo is where it was.
    expect(store.undo().ok).toBe(true);
    expect(inFile(store).storage).toBe("lfs");
  });
});

describe("assets.json that changed in the project folder", () => {
  const FOLDER = folderBatch("1");
  const merge = (store: ProjectStore, base: string, change: (asset: any) => void) => {
    const document = JSON.parse(base);
    change(document.assets.a);
    const batch: FileChange[] = [{ path: ASSETS, base, text: JSON.stringify(document) }];
    const written = store.exportFiles().files;
    const result = store.mergeFiles(batch, { origin: FOLDER, baseOf: (path) => written.get(path) });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result;
  };
  const baseOf = (store: ProjectStore) => store.exportFiles().files.get(ASSETS) as string;

  it("brings in what changed there, and keeps where the file went", () => {
    const store = withAsset();
    uploaded(store);
    const result = merge(store, baseOf(store), (asset) => (asset.name = "外面改的"));
    expect(result.conflicts).toEqual([]);
    expect(placed(store)).toMatchObject({ name: "外面改的", storage: "lfs" });
  });

  it("brings in where the file is, when that changed there", () => {
    const store = withAsset();
    uploaded(store);
    const result = merge(store, baseOf(store), (asset) => (asset.storage = "local"));
    expect(result.conflicts).toEqual([]);
    expect(placed(store)?.storage).toBe("local");
    expect(store.getState().places).toBeUndefined();
  });

  it("takes another file from there with all that goes with it, not where the one before went", () => {
    const store = withAsset();
    const base = baseOf(store);
    // The upload finished after the editor last wrote assets.json.
    uploaded(store);
    const result = merge(store, base, (asset) => Object.assign(asset, { hash: OTHER, size: 5 }));
    expect(result.conflicts).toEqual([]);
    expect(inFile(store)).toEqual({ ...file, hash: OTHER, size: 5 });
  });

  it("says another file from there is only here, where it left what was said of the one before", () => {
    const store = fromFile({ ...file, storage: "lfs" });
    const result = merge(store, baseOf(store), (asset) =>
      Object.assign(asset, { hash: OTHER, size: 5 }),
    );
    expect(result.conflicts).toEqual([]);
    expect(inFile(store)).toEqual({ ...file, hash: OTHER, size: 5 });
  });

  it("says where another file from there is, where it says so of the new one", () => {
    const store = withAsset();
    const result = merge(store, baseOf(store), (asset) =>
      Object.assign(asset, { hash: OTHER, size: 5, storage: "lfs" }),
    );
    expect(result.conflicts).toEqual([]);
    expect(inFile(store)).toEqual({ ...file, hash: OTHER, size: 5, storage: "lfs" });
  });

  it("keeps the file of the editor, where both have another one, and says so", () => {
    const store = withAsset();
    const base = baseOf(store);
    const replaced = { asset: "a", changes: { hash: THIRD, size: 7 } };
    success(store.execute({ type: "asset.update", params: replaced }));
    const result = merge(store, base, (asset) =>
      Object.assign(asset, { hash: OTHER, size: 5, storage: "lfs", name: "外面改的" }),
    );
    expect(result.conflicts).toEqual([
      { file: ASSETS, path: ["assets", "a", "hash"], theirs: OTHER },
    ]);
    expect(inFile(store)).toEqual({ ...file, name: "外面改的", hash: THIRD, size: 7 });
  });

  it("keeps the file of the editor, where only the editor has another one", () => {
    const store = withAsset();
    const base = baseOf(store);
    const replaced = { asset: "a", changes: { hash: THIRD, size: 7 } };
    success(store.execute({ type: "asset.update", params: replaced }));
    const result = merge(store, base, (asset) => (asset.storage = "lfs"));
    expect(result.conflicts).toEqual([]);
    expect(inFile(store)).toEqual({ ...file, hash: THIRD, size: 7 });
  });

  it("keeps where the file of an asset went that the folder took away while it is in use", () => {
    const store = withAsset();
    const clip = { start: "0", duration: "1", source: { kind: "video", media: { asset: "a" } } };
    const timeline = store.getState().manifest.timelines[0] as string;
    const track = Object.values(store.getState().timelines[timeline]?.tracks ?? {}).find(
      ({ kind }) => kind === "video",
    );
    const add = { timeline, track: track?.id, clip: { id: "c", ...clip } };
    success(store.execute({ type: "clip.add", params: add }));
    uploaded(store);
    const base = baseOf(store);
    const document = JSON.parse(base);
    delete document.assets.a;
    const batch: FileChange[] = [{ path: ASSETS, base, text: JSON.stringify(document) }];
    const written = store.exportFiles().files;
    const result = store.mergeFiles(batch, { origin: FOLDER, baseOf: (path) => written.get(path) });
    expect(result.ok).toBe(true);
    expect(inFile(store)).toMatchObject({ storage: "lfs", hash: HASH });
  });

  it("changes nothing of where a file is when the folder's assets.json has to wait", () => {
    const store = withAsset();
    const base = baseOf(store);
    uploaded(store, "platform");
    // Each side on its own is fine; together the asset would be in the cloud space without a size.
    const result = merge(store, base, (asset) => {
      asset.storage = "remote";
      asset.url = "https://bucket.example.com/a.mp4";
      delete asset.size;
    });
    expect(result.files).toMatchObject([{ path: ASSETS, status: "blocked" }]);
    expect(store.getState().places?.["a"]).toEqual({
      storage: "platform",
      hash: HASH,
      size: 3,
      owner: OWNER,
    });
    expect(inFile(store)).toEqual({ ...file, storage: "platform" });
  });

  it("keeps where the file went, when that came after what the folder has", () => {
    const store = withAsset();
    const base = baseOf(store);
    uploaded(store);
    const result = merge(store, base, (asset) => (asset.name = "外面改的"));
    expect(result.conflicts).toEqual([]);
    expect(placed(store)).toMatchObject({ name: "外面改的", storage: "lfs" });
    expect(inFile(store)).toMatchObject({ name: "外面改的", storage: "lfs" });
  });
});

describe("what a platform takes of where files are", () => {
  const value = (raw: unknown) => checkWritten(["places", "a"], raw);

  it("takes every place the editor writes down", () => {
    expect(value({ storage: "lfs", hash: HASH, size: 3, repo: REPO })).toBeUndefined();
    expect(value({ storage: "platform", hash: HASH, size: 3, owner: OWNER })).toBeUndefined();
    expect(value({ storage: "local", hash: HASH })).toBeUndefined();
    expect(value({ storage: "remote", url: URL, hash: HASH, size: 3 })).toBeUndefined();
    expect(
      value({ storage: "remote", url: URL, hash: HASH, size: 3, store: STORE }),
    ).toBeUndefined();
  });

  it("turns away what it never writes", () => {
    for (const raw of [
      { storage: "git", hash: HASH },
      { storage: "remote", hash: HASH, size: 3 },
      { storage: "lfs", url: URL, hash: HASH, size: 3, repo: REPO },
      { storage: "lfs" },
      { storage: "lfs", hash: "md5-abc", size: 3, repo: REPO },
      { storage: "lfs", hash: HASH, repo: REPO },
      { storage: "lfs", hash: HASH, size: 3 },
      { storage: "platform", hash: HASH, size: 3, repo: REPO },
      { storage: "local", hash: HASH, owner: OWNER },
      { storage: "lfs", hash: HASH, size: -1, repo: REPO },
      { storage: "lfs", hash: HASH, size: 3, repo: REPO, extra: 1 },
      "lfs",
    ]) {
      expect(value(raw), JSON.stringify(raw)).toBeDefined();
    }
    const place = { storage: "lfs", hash: HASH, size: 3, repo: REPO };
    expect(checkWritten(["places", "../a"], place)).toBeDefined();
    expect(checkWritten(["places", "a", "storage"], "lfs")).toBeDefined();
  });
});

describe("the example project", () => {
  it("has an asset of every kind of place, each as files have it", () => {
    const { store } = ProjectStore.open(loadFixture("v1"));
    const assets = store?.getState().assets ?? {};
    expect(new Set(Object.values(assets).map(({ storage }) => storage))).toEqual(
      new Set(["git", "lfs", "local", "platform", "remote"]),
    );
  });
});
