import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, piecesOf, type CommandCall } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { SYNC_LIMITS } from "@animaquill/host/sync";
import { Archiver } from "../archive/archiver.ts";
import { EXPORT_HEAP_MB, ProjectExporter } from "../archive/exporter.ts";
import { GitHubRepoHost } from "../archive/github-host.ts";
import { GitHubApp } from "../github/app.ts";
import { installations, projectRepos, projects, projectUpdates, users } from "../schema.ts";
import { SYNC_HUB_LIMITS } from "../sync/hub.ts";
import { weightOf } from "../sync/copies.ts";
import { createTestDatabase } from "./database.ts";

/**
 * How much memory archiving the largest project the platform takes needs, for the worker's
 * mem_limit. Not a test: run by hand, each step
 * in a process of its own, so that what one step took does not count for the next:
 *
 *   node test/measure-archive.ts build <folder>        the largest projects, as Yjs updates
 *   node test/measure-archive.ts export <file>         making one into files, in the thread
 *   node test/measure-archive.ts archive <file> <github>  a whole archive, with AQ_TEST_DATABASE
 *
 * `<github>` is a fake GitHub server (fake-github-server.ts), in a process of its own as well.
 * The largest project: 16 MB as Yjs encodes it, or as much as the working copies take of one
 * (`projectMemory` of SYNC_HUB_LIMITS, see `weightOf`), whichever comes first.
 */

const [mode, file, github] = process.argv.slice(2);
const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;

const sizeOf = (state: Uint8Array) => {
  const { store } = ProjectStore.fromUpdates([state]);
  let structs = 0;
  for (const pieces of store!.doc.store.clients.values()) structs += pieces.length;
  const values = piecesOf(state)?.values ?? 0;
  store!.destroy();
  return { bytes: state.length, structs, values, weight: weightOf(state.length, structs, values) };
};

const fits = (state: Uint8Array) => {
  const size = sizeOf(state);
  return size.bytes <= SYNC_LIMITS.state && size.weight <= SYNC_HUB_LIMITS.projectMemory;
};

/** Code as people write it, a line at a time, up to `bytes`. */
const codeOf = (bytes: number, salt: string) => {
  const lines: string[] = [];
  let length = 0;
  for (let index = 0; length < bytes; index++) {
    const line = `export const value_${salt}_${index} = { at: ${index}, name: "item ${index}" };\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join("").slice(0, bytes);
};

const build = (folder: string) => {
  mkdirSync(folder, { recursive: true });
  // Code: the largest files a project may have, as many as fit in 16 MB.
  const code = ProjectStore.create(createProject({ name: "最大的代码" }));
  const fileBytes = 8 * MB - 4096;
  for (let index = 0; ; index++) {
    const before = code.encodeWhole();
    const result = code.execute({
      type: "file.write",
      params: { path: `code/big${index}.js`, text: codeOf(fileBytes, String(index)) },
    } as CommandCall);
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
    if (!fits(code.encodeWhole())) {
      // One more whole file is too much: as much of one as still fits.
      const rest = SYNC_LIMITS.state - before.length - 64 * 1024;
      code.execute({
        type: "file.write",
        params: { path: `code/big${index}.js`, text: codeOf(rest, String(index)) },
      } as CommandCall);
      break;
    }
  }
  const codeState = code.encodeWhole();
  writeFileSync(join(folder, "code.bin"), codeState);

  // A timeline: clips, one after the other, as many as the working copies take of one project. Made
  // as a document at once (commands one by one take long at this size), the number found by halves.
  const withClips = (clips: number) => {
    const project = createProject({ name: "最长的时间轴" });
    const main = project.timelines.get("main")!;
    const document = main.document!;
    const video = document.tracks.find((track) => track.kind === "video")!;
    const timelines = new Map(project.timelines);
    timelines.set("main", {
      ...main,
      document: {
        ...document,
        sections: [{ ...document.sections[0]!, duration: String(Math.max(10, clips)) }],
        tracks: document.tracks.map((track) =>
          track !== video
            ? track
            : {
                ...track,
                clips: Array.from({ length: clips }, (_, index) => ({
                  id: `clip_${index}`,
                  name: `片段 ${index}`,
                  start: String(index),
                  duration: "1",
                  source: { kind: "color" as const, color: "#336699" },
                })),
              },
        ),
      },
    });
    const store = ProjectStore.create({ ...project, timelines } as typeof project);
    const state = store.encodeWhole();
    store.destroy();
    return state;
  };
  let low = 0;
  let high = 40_000;
  let last = withClips(0);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const state = withClips(middle);
    if (fits(state)) {
      low = middle;
      last = state;
    } else high = middle;
  }
  const clips = low;
  const timelineState = last;
  console.error(`timeline: ${clips} clips, ${JSON.stringify(sizeOf(timelineState))}`);
  writeFileSync(join(folder, "timeline.bin"), timelineState);
  console.log(
    JSON.stringify({
      code: { ...sizeOf(codeState), files: Object.keys(code.getState().files).length },
      timeline: { ...sizeOf(timelineState), clips },
      limits: { bytes: SYNC_LIMITS.state, weight: SYNC_HUB_LIMITS.projectMemory },
    }),
  );
};

/** Samples the memory of this process, threads included, until stopped. */
const sampler = () => {
  let peak = process.memoryUsage.rss();
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 2);
  return {
    stop() {
      clearInterval(timer);
      return Math.max(peak, process.resourceUsage().maxRSS * 1024);
    },
  };
};

const measureExport = async (path: string) => {
  const state = readFileSync(path);
  const before = process.memoryUsage.rss();
  const sampling = sampler();
  const started = performance.now();
  const session = new ProjectExporter({ heapMb: EXPORT_HEAP_MB }).open();
  const result = await session.export([state]);
  const documents = new Map<string, string>();
  for (const [name, text] of result.files)
    if (name.endsWith(".json")) documents.set(name, text.text);
  const errors = await session.check(documents);
  await session.close();
  const peak = sampling.stop();
  console.log(
    JSON.stringify({
      project: path,
      files: result.files.size,
      text: mb([...result.files.values()].reduce((sum, each) => sum + each.text.length, 0)),
      errors: errors.length,
      ms: Math.round(performance.now() - started),
      rssBeforeMb: mb(before),
      rssPeakMb: mb(peak),
      threadHeapPeakMb: mb(result.peakHeap),
    }),
  );
};

const measureArchive = async (path: string, githubUrl: string) => {
  const state = readFileSync(path);
  const t = await createTestDatabase();
  try {
    const person = { id: 424242, login: "measure" };
    const ask = async (what: string) => {
      const response = await fetch(`${githubUrl}${what}`, {
        method: what.startsWith("/_fake/key") ? "GET" : "POST",
      });
      return what.startsWith("/_fake/key") ? response.text() : response.json();
    };
    const { installation } = (await ask(`/_fake/install?user=${person.id}.${person.login}`)) as {
      installation: number;
    };
    const { id: repoId } = (await ask(
      `/_fake/repo?user=${person.id}.${person.login}&name=big-${path.replace(/^.*\/|\.bin$/g, "")}`,
    )) as { id: number };
    const privateKey = (await ask("/_fake/key")) as string;
    const [user] = await t.db
      .insert(users)
      .values({ githubId: person.id, login: person.login })
      .returning();
    await t.db.insert(installations).values({
      id: installation,
      accountId: person.id,
      accountLogin: person.login,
      accountType: "User",
      repositorySelection: "selected",
    });
    const { store } = ProjectStore.fromUpdates([state]);
    const projectId = store!.getState().manifest.id;
    store!.destroy();
    await t.db.insert(projects).values({
      id: "big",
      ownerId: user!.id,
      projectId,
      name: "big",
      head: 1,
      digest: "d",
      bytes: state.length,
    });
    await t.db.insert(projectUpdates).values({
      projectId: "big",
      seq: 1,
      digest: "d",
      data: state,
      kind: "first",
      device: "d",
      window: "w",
      base: 0,
    });
    await t.db.insert(projectRepos).values({
      projectId: "big",
      installationId: installation,
      repoId,
      ownerId: person.id,
      ownerLogin: person.login,
      name: "big",
      branch: "main",
      private: true,
      createdHere: true,
    });
    const apiUrl = `${githubUrl}/api`;
    const app = new GitHubApp({ apiUrl, issuer: "Iv1.a1b2c3d4e5f60718", privateKey });
    const archiver = new Archiver({
      db: t.db,
      host: new GitHubRepoHost(app, { apiUrl, webUrl: githubUrl }),
      exporter: new ProjectExporter({ heapMb: EXPORT_HEAP_MB }),
      log: { info() {}, warn: console.warn, error: console.error },
    });
    const before = process.memoryUsage.rss();
    const sampling = sampler();
    const started = performance.now();
    const outcome = await archiver.run("big", "first");
    const peak = sampling.stop();
    const files = (await (await fetch(`${githubUrl}/_fake/files?repo=${repoId}`)).json()) as Record<
      string,
      string
    >;
    console.log(
      JSON.stringify({
        project: path,
        outcome: outcome.kind,
        filesOnGitHub: Object.keys(files).length,
        ms: Math.round(performance.now() - started),
        rssBeforeMb: mb(before),
        rssPeakMb: mb(peak),
      }),
    );
  } finally {
    await t.drop();
  }
};

if (mode === "build" && file) build(file);
else if (mode === "export" && file) await measureExport(file);
else if (mode === "archive" && file && github) await measureArchive(file, github);
else {
  console.error(
    "usage: measure-archive.ts build <folder> | export <file> | archive <file> <github>",
  );
  process.exitCode = 2;
}
