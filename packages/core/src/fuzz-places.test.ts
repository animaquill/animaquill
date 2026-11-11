import { createHash } from "node:crypto";
import {
  createProject,
  downloadableFrom,
  isElsewhere,
  isSameHash,
  type Asset,
} from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { FUZZ, randomFrom, replica, seedIds, sync, type Random } from "./fuzz-support.ts";
import type { FileChange } from "./merge-files.ts";
import { placedAsset } from "./model.ts";
import { ProjectStore, STORAGE, USER, folderBatch } from "./store.ts";

const ASSETS = "assets.json";
const IDS = ["x1", "x2", "x3"];
const URL = "https://bucket.example.com/a";
/** What uploads bind each place to, see `asset.setStorage`. */
const BOUND: Readonly<Record<string, object>> = {
  lfs: { repo: "123456" },
  platform: { owner: "u-1" },
  remote: { url: URL },
};

/**
 * Where an upload put a content, or where a file said it is, and how large it was: nothing else may
 * ever be said, as another computer gets the file by its hash and checks it by its size.
 */
interface Put {
  readonly hash: string;
  readonly size: number | undefined;
  readonly storage: string;
  readonly url: string | undefined;
}

describe.each([1, 2, 3, 4, 5, 6])("where files are kept, seed %i", FUZZ, (seed) => {
  it("never says a file is somewhere it was not put, and keeps assets.json to the format", () => {
    seedIds(seed);
    const random: Random = randomFrom(seed);
    /** A content of its own each time: two files of one hash would make a false word look true. */
    let made = 0;
    const fresh = () => {
      made += 1;
      const digest = createHash("sha256").update(`${seed}:${made}`).digest("base64url");
      return `sha256-${digest}=`;
    };

    const first = ProjectStore.create(createProject({ name: "存放位置" }));
    for (const id of IDS) {
      const asset = {
        kind: "video",
        path: `assets/${id}.mp4`,
        storage: "local",
        hash: fresh(),
        size: 3,
      };
      expect(first.execute({ type: "asset.add", params: { id, asset } }).ok).toBe(true);
    }
    const stores = [first, replica(first), replica(first)];
    /** What each window last wrote into its folder, which the folder changes from. */
    const written = (store: ProjectStore) => store.exportFiles().files.get(ASSETS);
    const folders = stores.map(written);
    /** By asset: what may be said of where its files are. */
    const puts = new Map<string, Put[]>(IDS.map((id) => [id, []]));
    const put = (
      id: string,
      hash: string,
      size: number | undefined,
      storage: string,
      url?: string,
    ) => puts.get(id)?.push({ hash, size, storage, url });
    const isPut = (id: string, asset: Asset) =>
      asset.hash !== undefined &&
      (puts.get(id) ?? []).some(
        (each) =>
          isSameHash(each.hash, asset.hash as string) &&
          each.size === asset.size &&
          each.storage === asset.storage &&
          each.url === asset.url,
      );

    let uploads = 0;
    let merges = 0;
    let batches = 0;
    for (let round = 0; round < 300; round++) {
      const index = random.int(stores.length);
      const store = stores[index] as ProjectStore;
      const id = random.pick(IDS) as string;
      const asset = store.getState().assets?.[id];
      const chance = random.int(100);
      if (chance < 22) {
        // An upload finishes, now and then for a file that was replaced meanwhile.
        if (!asset?.hash) continue;
        const storage = random.pick(["lfs", "platform", "remote"]) as string;
        const hash = random.chance(0.15) ? fresh() : asset.hash;
        const params = { asset: id, storage, hash, ...BOUND[storage] };
        const result = store.execute({ type: "asset.setStorage", params }, { origin: STORAGE });
        if (result.ok) {
          uploads += 1;
          put(id, hash, asset.size, storage, storage === "remote" ? URL : undefined);
        }
      } else if (chance < 30) {
        if (asset?.hash) {
          const params = { asset: id, storage: "local", hash: asset.hash };
          store.execute({ type: "asset.setStorage", params });
        }
      } else if (chance < 40) {
        const changes = random.chance(0.5)
          ? { name: `n${random.int(9)}` }
          : { tags: [`t${random.int(9)}`] };
        store.execute({ type: "asset.update", params: { asset: id, changes } });
      } else if (chance < 48) {
        // People take another file for the asset, now and then one that only its size tells apart.
        const size = 3 + random.int(5);
        const changes = random.chance(0.7) ? { hash: fresh(), size } : { size };
        store.execute({ type: "asset.update", params: { asset: id, changes } });
      } else if (chance < 62) {
        // Something changes assets.json in the folder, from what the window last wrote there.
        const base = folders[index];
        const document = base === undefined ? undefined : JSON.parse(base);
        const there = document?.assets[id];
        if (base === undefined || !there) continue;
        const kind = random.int(7);
        if (kind === 0) Object.assign(there, { hash: fresh(), size: 3 + random.int(5) });
        // A file only here needs no size: an upload of it meanwhile still knows it.
        else if (kind === 1 && there.storage === "local") delete there.size;
        else if (kind === 2) {
          // Another computer uploaded another file and says so.
          Object.assign(there, { hash: fresh(), size: 3, storage: "lfs" });
          delete there.url;
          put(id, there.hash, 3, "lfs");
        } else if (kind === 3) {
          // Something leaves out the size, whatever it says of where the file is: an asset that
          // says it is in the cloud space is then not what the format takes.
          delete there.size;
        } else if (kind === 4 && there.size !== undefined) {
          // Another computer uploaded this same file and says so, as it then comes here by syncing.
          const storage = random.pick(["lfs", "platform", "remote"]) as string;
          const url = storage === "remote" ? URL : undefined;
          Object.assign(there, { storage });
          if (url === undefined) delete there.url;
          else there.url = url;
          put(id, there.hash, there.size, storage, url);
        } else if (kind === 5) {
          // Another size for the same hash: another file all the same.
          there.size = 3 + random.int(5);
        } else there.name = `f${random.int(9)}`;
        const batch: FileChange[] = [{ path: ASSETS, base, text: JSON.stringify(document) }];
        const files = store.exportFiles().files;
        batches += 1;
        const result = store.mergeFiles(batch, {
          origin: folderBatch(String(batches)),
          baseOf: (path) => files.get(path),
        });
        if (result.ok) merges += 1;
        // The window writes what it has again.
        folders[index] = written(store);
      } else if (chance < 70) {
        // A tool writes assets.json as the editor has it, with a change.
        const text = store.exportFiles().files.get(ASSETS);
        if (text === undefined) continue;
        const document = JSON.parse(text);
        const there = document.assets[id];
        if (!there) continue;
        if (random.chance(0.5) && there.storage === "local") delete there.size;
        else Object.assign(there, { hash: fresh(), size: 3 });
        store.importFile(ASSETS, JSON.stringify(document), { origin: USER });
      } else if (chance < 76) {
        if (asset) store.execute({ type: "asset.remove", params: { asset: id } });
        else {
          const again = {
            kind: "video",
            path: `assets/${id}.mp4`,
            storage: "local",
            hash: fresh(),
            size: 3,
          };
          store.execute({ type: "asset.add", params: { id, asset: again } });
        }
      } else if (chance < 82) {
        if (random.chance(0.6)) store.undo();
        else store.redo();
      } else if (chance < 86) {
        folders[index] = written(store);
      } else {
        const other = random.pick(stores) as ProjectStore;
        if (other !== store) sync(store, other);
      }
      for (const each of stores) {
        expect(each.exportFiles().problems, `round ${round}`).toEqual([]);
        for (const name of IDS) {
          const placed = placedAsset(each.getState(), name);
          if (placed && isElsewhere(placed.storage)) {
            expect(isPut(name, placed), `${name} round ${round}`).toBe(true);
            // Everything here that says a file is elsewhere knows it well enough to get it.
            expect(downloadableFrom(placed), `${name} round ${round}`).toBe(placed.storage);
          }
        }
      }
    }

    // Enough happened for the rounds to mean something, whichever way they went.
    expect(uploads).toBeGreaterThan(10);
    expect(merges).toBeGreaterThan(10);
    sync(stores[0] as ProjectStore, stores[1] as ProjectStore);
    sync(stores[1] as ProjectStore, stores[2] as ProjectStore);
    sync(stores[0] as ProjectStore, stores[1] as ProjectStore);
    const [a, ...others] = stores.map((store) => store.exportFiles());
    expect(a?.problems).toEqual([]);
    for (const other of others) expect(other.files.get(ASSETS)).toBe(a?.files.get(ASSETS));
    for (const store of stores.slice(1)) expect(store.getState()).toEqual(stores[0]?.getState());
  });
});
