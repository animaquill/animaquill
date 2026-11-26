import { createHash } from "node:crypto";
import { RepoHosts } from "../archive/repo-host.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORAGE } from "@animaquill/core";
import { eq } from "drizzle-orm";
import { LfsDownloads, type DownloadLimits } from "../lfs/downloads.ts";
import { LfsPusher } from "../lfs/push.ts";
import { Staging } from "../lfs/staging.ts";
import { LfsSweeper } from "../lfs/sweep.ts";
import { LfsUploads, type LfsLimits } from "../lfs/uploads.ts";
import { changeLfs } from "../me/lfs.ts";
import type { Logger } from "../database.ts";
import { lfsUploads } from "../schema.ts";
import { edit, linkTo, newProject, quiet, type Editor, type World } from "./archive-support.ts";
import type { FakeRepo } from "./fake-github.ts";
import { platform } from "./platform-support.ts";

/**
 * What tests of uploads into Git LFS share: a staging folder of their own (taken away with
 * `done`), the API that takes the pieces, the worker's pushes and sweeps, all on the clock of the
 * world, and a project linked to a repository of the fake GitHub.
 */

/** A staging folder whose disk has as much room as a test says. */
export class RoomyStaging extends Staging {
  free = 1024 ** 4;
  override async freeBytes(): Promise<number> {
    return this.free;
  }
}

export const oidOf = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
/** The hash of the format for content, as the editor writes it. */
export const hashOf = (data: Buffer | string) =>
  `sha256-${createHash("sha256").update(data).digest("base64url")}=`;

export const lfsWorld = async (
  w: World,
  options: {
    readonly limits?: Partial<LfsLimits>;
    readonly downloadLimits?: Partial<DownloadLimits>;
    /** Where the downloads log, in place of nowhere. */
    readonly downloadLog?: Logger;
    readonly transferMs?: number;
    /** A staging folder of the test's own making, in place of `RoomyStaging`. */
    readonly staging?: (dir: string) => RoomyStaging;
    /**
     * Whether the person said they know what the storage means, which the platform asks before
     * any file: yes, unless a test is about that.
     */
    readonly acknowledged?: boolean;
  } = {},
) => {
  if (options.acknowledged !== false)
    await changeLfs(
      w.db,
      w.userId,
      { account: w.userId, acknowledged: true },
      w.time.now.getTime(),
    );
  const dir = mkdtempSync(join(tmpdir(), "aq-staging-"));
  const staging = options.staging?.(dir) ?? new RoomyStaging(dir);
  /** Uploads the API queued for pushing, in order. */
  const queued: string[] = [];
  const uploads = new LfsUploads({
    db: w.db,
    staging,
    hosts: RepoHosts.github(w.host),
    enqueue: async (upload) => {
      queued.push(upload);
    },
    log: quiet,
    // Tests send files of a few small pieces: any size will do, unless a test is about that.
    limits: { minChunkBytes: 1, ...options.limits },
    now: () => w.time.now,
  });
  const downloads = new LfsDownloads({
    db: w.db,
    hosts: RepoHosts.github(w.host),
    log: options.downloadLog ?? quiet,
    now: () => w.time.now.getTime(),
    ...(options.downloadLimits && { limits: options.downloadLimits }),
  });
  const p = await platform(w, { lfs: uploads, lfsDownloads: downloads });
  const pusher = new LfsPusher({
    db: w.db,
    hosts: RepoHosts.github(w.host),
    staging,
    log: quiet,
    now: () => w.time.now,
    ...(options.transferMs !== undefined && { transferMs: () => options.transferMs as number }),
  });
  const sweeper = new LfsSweeper({ db: w.db, staging, log: quiet, now: () => w.time.now });
  let repos = 0;

  /** A project with a repository of its own name, as the editor sends files for. */
  const linked = async (name = `film-${(repos += 1)}`) => {
    const project = await newProject(w);
    const repo = w.github.addRepo(w.person, { name, select: true });
    await linkTo(w, project.id, repo);
    return { project, repo };
  };

  /** Starts sending a file, as the editor does. */
  const begin = (project: string, data: Buffer, size = data.length) =>
    p.send("POST", `/api/projects/${project}/lfs/objects`, {
      payload: JSON.stringify({ oid: oidOf(data), size }),
      headers: { "content-type": "application/json" },
    });

  /** A piece of a file, at `offset`. */
  const piece = (id: string, offset: number | string, data: Buffer) =>
    p.send("PUT", `/api/lfs/uploads/${id}`, {
      payload: data,
      headers: { "content-type": "application/octet-stream", "upload-offset": String(offset) },
    });

  const rowOf = async (id: string) =>
    (await w.db.select().from(lfsUploads).where(eq(lfsUploads.id, id)))[0];

  /**
   * The upload once the platform read its file through, which it does after the last piece without
   * making that wait: asked as the editor asks, until it says something else than "receiving" with
   * all of the file there.
   */
  const checked = async (id: string) => {
    for (let tries = 0; ; tries++) {
      const answer = await p.send("GET", `/api/lfs/uploads/${id}`);
      const { state, received, size } = answer.json ?? {};
      if (answer.status !== 200 || state !== "receiving" || received !== size) return answer;
      if (tries >= 400) throw new Error(`upload ${id} is still not checked`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  /**
   * All of a file, piece by piece, as the editor sends it, and then how the platform found it:
   * resolves to the answer that says so, or to the first piece that was not taken.
   */
  const sendAll = async (id: string, data: Buffer, chunk: number) => {
    let answer;
    for (let at = 0; at < data.length; at += chunk) {
      answer = await piece(id, at, data.subarray(at, at + chunk));
      if (answer.status !== 200) return answer;
    }
    const { state, received, size } = answer!.json;
    return state === "receiving" && received === size ? checked(id) : answer!;
  };

  /** Puts a file into the repository's storage as the editor and the worker do, all of it. */
  const upload = async (project: string, data: Buffer) => {
    const begun = await begin(project, data);
    if (begun.json.state === "present") return begun.json;
    await sendAll(begun.json.id, data, begun.json.chunk);
    const pushed = await pusher.push(begun.json.id);
    if (pushed.kind !== "done") throw new Error(`not pushed: ${JSON.stringify(pushed)}`);
    return begun.json;
  };

  /** An asset of the project with this content, as the editor adds it. */
  const addAsset = async (
    project: { id: string; editor: Editor },
    id: string,
    path: string,
    data: Buffer,
  ) =>
    edit(w, project, {
      type: "asset.add",
      params: {
        id,
        asset: { kind: "video", path, hash: hashOf(data), size: data.length },
      },
    });

  /** Where the file of an asset is, as an upload writes it down once it got there. */
  const placeIn = async (
    project: { id: string; editor: Editor },
    asset: string,
    repo: FakeRepo | string,
    data: Buffer,
  ) =>
    edit(
      w,
      project,
      {
        type: "asset.setStorage",
        params: {
          asset,
          storage: "lfs",
          hash: hashOf(data),
          repo: typeof repo === "string" ? repo : String(repo.id),
        },
      },
      STORAGE,
    );

  /** Looks objects up, as the editor of another computer does. */
  const lookup = (project: string, objects: readonly { oid: string; size: number }[]) =>
    p.send("POST", `/api/projects/${project}/lfs/lookup`, {
      payload: JSON.stringify({ objects }),
      headers: { "content-type": "application/json" },
    });

  /** A piece of an object, as the editor asks for it. */
  const download = (
    project: string,
    data: Buffer | { oid: string; size: number },
    range?: string,
    headers: Record<string, string> = { "x-animaquill": "1", "sec-fetch-site": "same-origin" },
  ) => {
    const { oid, size } = Buffer.isBuffer(data) ? { oid: oidOf(data), size: data.length } : data;
    return p.sendRaw("GET", `/api/projects/${project}/lfs/objects/${oid}?size=${size}`, {
      headers: { ...headers, ...(range !== undefined && { range }) },
    });
  };

  return {
    dir,
    staging,
    uploads,
    downloads,
    lookup,
    download,
    queued,
    p,
    pusher,
    sweeper,
    linked,
    begin,
    piece,
    sendAll,
    rowOf,
    checked,
    upload,
    addAsset,
    placeIn,
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
};

export type LfsWorld = Awaited<ReturnType<typeof lfsWorld>>;
