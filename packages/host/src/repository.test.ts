import { describe, expect, test } from "vitest";
import { CloudSignedOut, RepositoryRefused } from "./index.ts";
import { browserRepository, statusOf } from "./repository.ts";

/** Saving projects to repositories through a platform's API, as a browser does it. */

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const platform = (answer: (sent: Sent) => Response) => {
  const sent: Sent[] = [];
  const access = browserRepository({
    api: (path) => `https://platform.example/api${path}`,
    changeHeaders: { "x-animaquill": "1" },
    fetch: async (input, init) => {
      const request = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      sent.push(request);
      return answer(request);
    },
  });
  return { access, sent };
};

const STATUS = {
  repository: {
    id: 7,
    owner: "octo",
    name: "film",
    fullName: "octo/film",
    private: true,
    branch: "main",
    url: "https://github.com/octo/film",
    createdHere: true,
    linkedAt: 1,
  },
  state: "paused",
  reason: "diverged",
  archiving: false,
  lastArchive: {
    sha: "a".repeat(40),
    seq: 3,
    at: 2,
    kind: "auto",
    changed: 1,
    removed: 0,
    url: "u",
  },
  diverged: {
    sha: "b".repeat(40),
    files: ["code/gone.js", "timelines/main/timeline.json"],
    deleted: ["code/gone.js"],
  },
  head: 4,
  archivedSeq: 3,
  somethingNew: true,
};

describe("repositories through the platform", () => {
  test("asks the platform's API, and sends what changes something with its headers", async () => {
    const { access, sent } = platform(() => Response.json(STATUS));
    await access.status("p/1");
    await access.link("p1", { create: { name: "film" } });
    await access.archiveNow("p1", { replace: "b".repeat(40) });
    await access.archiveNow("p1");
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET https://platform.example/api/projects/p%2F1/repository",
      "POST https://platform.example/api/projects/p1/repository",
      "POST https://platform.example/api/projects/p1/archive",
      "POST https://platform.example/api/projects/p1/archive",
    ]);
    expect(sent[0]!.headers).toEqual({});
    expect(sent[1]).toMatchObject({
      headers: { "x-animaquill": "1", "content-type": "application/json" },
      body: { create: { name: "film" } },
    });
    expect(sent[2]!.body).toEqual({ replace: "b".repeat(40) });
    expect(sent[3]!.body).toEqual({});
  });

  test("reads a status field by field, leaving out what it does not know", async () => {
    const { access } = platform(() => Response.json(STATUS));
    const { somethingNew: _, ...known } = STATUS;
    expect(await access.status("p1")).toEqual(known);
    expect(statusOf({ state: "none", head: 2, archivedSeq: 0, archiving: false })).toEqual({
      state: "none",
      archiving: false,
      head: 2,
      archivedSeq: 0,
    });
    expect(statusOf({ state: "weird", repository: { id: "x" } })).toMatchObject({ state: "none" });
    // An older platform does not say which files went; a file it says went is one of them.
    expect(
      statusOf({ state: "paused", diverged: { sha: "c", files: ["a"], deleted: ["a", "b", 3] } })
        .diverged,
    ).toEqual({ sha: "c", files: ["a"], deleted: ["a"] });
    expect(statusOf({ state: "paused", diverged: { sha: "c", files: ["a"] } }).diverged).toEqual({
      sha: "c",
      files: ["a"],
      deleted: [],
    });
    expect(() => statusOf("nonsense")).toThrow();
  });

  test("lists repositories to choose from", async () => {
    const { access, sent } = platform(() =>
      Response.json({
        repositories: [
          {
            id: 1,
            owner: "octo",
            name: "a",
            private: true,
            pushable: true,
            empty: true,
            linked: false,
          },
          { id: "not a number" },
        ],
        page: 2,
        more: true,
        manageUrl: "https://github.com/settings/installations/9",
      }),
    );
    expect(await access.list(2)).toEqual({
      repositories: [
        {
          id: 1,
          owner: "octo",
          name: "a",
          fullName: "octo/a",
          private: true,
          pushable: true,
          empty: true,
          archived: false,
          linked: false,
        },
      ],
      page: 2,
      more: true,
      manageUrl: "https://github.com/settings/installations/9",
    });
    expect(sent[0]!.url).toBe("https://platform.example/api/github/repositories?page=2");
  });

  test("says what the platform refuses, with what goes with it", async () => {
    const answers: Response[] = [
      Response.json({ error: "signedOut" }, { status: 401 }),
      Response.json({ error: "hasProject", files: ["animaquill.json"] }, { status: 409 }),
      Response.json(
        { error: "diverged", diverged: { sha: "c".repeat(40), files: ["code/a.js"] } },
        { status: 409 },
      ),
      Response.json({ error: "busy" }, { status: 429, headers: { "retry-after": "42" } }),
      new Response("Bad Gateway", { status: 502 }),
    ];
    const { access } = platform(() => answers.shift() as Response);
    await expect(access.status("p1")).rejects.toBeInstanceOf(CloudSignedOut);
    await expect(access.link("p1", { existing: { id: 1 } })).rejects.toMatchObject({
      code: "hasProject",
      files: ["animaquill.json"],
    });
    await expect(access.archiveNow("p1")).rejects.toMatchObject({
      code: "diverged",
      diverged: { sha: "c".repeat(40), files: ["code/a.js"], deleted: [] },
    });
    await expect(access.archiveNow("p1")).rejects.toMatchObject({ code: "busy", retryAfter: 42 });
    const down = await access.status("p1").catch((error: unknown) => error);
    expect(down).toBeInstanceOf(RepositoryRefused);
    expect(down).toMatchObject({ code: "unavailable" });
  });
  test("a network that fails, or an answer the platform did not mean, is one of the agreed refusals", async () => {
    const offline = browserRepository({
      api: (path) => path,
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const failed = await offline.status("p1").catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(RepositoryRefused);
    expect(failed).toMatchObject({ code: "unavailable" });
    const answers: Response[] = [
      Response.json({ error: "Bad Request", message: "the body is not JSON" }, { status: 400 }),
      Response.json({ error: "internal" }, { status: 500 }),
      Response.json({ error: "Payload Too Large" }, { status: 413 }),
      new Response("<html>gateway</html>", { status: 404 }),
    ];
    const { access } = platform(() => answers.shift() as Response);
    await expect(access.link("p1", { create: { name: "x" } })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(access.status("p1")).rejects.toMatchObject({ code: "unavailable" });
    await expect(access.link("p1", { create: { name: "x" } })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(access.status("p1")).rejects.toMatchObject({ code: "unavailable" });
  });
});
