import { describe, expect, test } from "vitest";
import { browserCloudProjects, projectSummaryOf } from "./cloud-projects.ts";
import { CloudSignedOut } from "./index.ts";

/** The projects of a platform over its HTTP API, as a browser reaches it. */

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

const platform = (answer: (sent: Sent) => Response | Promise<Response>) => {
  const sent: Sent[] = [];
  const projects = browserCloudProjects({
    api: (path) => `https://platform.example/api${path}`,
    changeHeaders: { "x-animaquill": "1" },
    fetch: async (input, init) => {
      const request = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      };
      sent.push(request);
      return answer(request);
    },
  });
  return { projects, sent };
};

const FULL = {
  id: "p1",
  name: "原子是什么",
  createdAt: 100,
  updatedAt: 200,
  copy: "live",
  size: { documents: 4096, assets: { count: 3, bytes: 900, elsewhere: 1 } },
  repository: {
    id: 7,
    owner: "ada",
    name: "atom",
    fullName: "ada/atom",
    private: true,
    url: "https://github.com/ada/atom",
    state: "paused",
    reason: "gone",
    checkedAt: 150,
  },
  archive: { at: 180, seq: 9, behind: true },
  attention: "repository",
};

describe("the list of projects of the platform", () => {
  test("reads every field the platform says about a project", () => {
    expect(projectSummaryOf({ ...FULL, somethingNew: true })).toEqual(FULL);
  });

  test("takes a platform that says only what it always said", () => {
    expect(projectSummaryOf({ id: "p1", name: "原子", updatedAt: 5 })).toEqual({
      id: "p1",
      name: "原子",
      updatedAt: 5,
    });
  });

  test("leaves out what is not what it should be, and keeps the rest", () => {
    expect(
      projectSummaryOf({
        id: "p1",
        name: "原子",
        updatedAt: 5,
        createdAt: "yesterday",
        copy: 3,
        size: { documents: "big" },
        repository: { id: "7", owner: "ada", name: "atom" },
        archive: "soon",
        attention: null,
      }),
    ).toEqual({ id: "p1", name: "原子", updatedAt: 5 });
    // A repository says at least which one it is; the rest has something to fall back on.
    expect(
      projectSummaryOf({
        id: "p1",
        name: "原子",
        updatedAt: 5,
        repository: { id: 7, owner: "ada", name: "atom" },
        archive: {},
        size: { documents: 10, assets: { count: 1 } },
      }),
    ).toEqual({
      id: "p1",
      name: "原子",
      updatedAt: 5,
      repository: {
        id: 7,
        owner: "ada",
        name: "atom",
        fullName: "ada/atom",
        private: false,
        url: "",
        state: "ready",
      },
      archive: { seq: 0, behind: false },
      size: { documents: 10 },
    });
    // Words of a newer platform come through as they are: the editor decides what it knows.
    expect(
      projectSummaryOf({ id: "p", name: "n", updatedAt: 1, copy: "frozen", attention: "new" }),
    ).toMatchObject({ copy: "frozen", attention: "new" });
  });

  test("is no project without an id, a name and a time", () => {
    expect(projectSummaryOf({ name: "原子", updatedAt: 5 })).toBeUndefined();
    expect(projectSummaryOf({ id: "", name: "原子", updatedAt: 5 })).toBeUndefined();
    expect(projectSummaryOf({ id: "p1", updatedAt: 5 })).toBeUndefined();
    expect(projectSummaryOf({ id: "p1", name: "原子" })).toBeUndefined();
    expect(projectSummaryOf("p1")).toBeUndefined();
    expect(projectSummaryOf(null)).toBeUndefined();
  });

  test("asks the platform's API, and keeps what are projects", async () => {
    const { projects, sent } = platform(() =>
      Response.json({ projects: [FULL, { id: 5 }, { id: "p2", name: "片头", updatedAt: 9 }] }),
    );
    expect(await projects.list()).toEqual([FULL, { id: "p2", name: "片头", updatedAt: 9 }]);
    expect(sent).toEqual([
      { url: "https://platform.example/api/projects", method: "GET", headers: {} },
    ]);
    const odd = platform(() => Response.json({ projects: "none" }));
    expect(await odd.projects.list()).toEqual([]);
  });

  test("says that nobody is signed in, and rejects where the platform cannot say", async () => {
    const out = platform(() => Response.json({ error: "signedOut" }, { status: 401 }));
    await expect(out.projects.list()).rejects.toBeInstanceOf(CloudSignedOut);
    const down = platform(() => new Response("Bad Gateway", { status: 502 }));
    await expect(down.projects.list()).rejects.toThrow("502");
    const offline = platform(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(offline.projects.list()).rejects.toThrow("Failed to fetch");
  });
});

describe("taking a project of the platform away", () => {
  test("asks with the headers of a change, and says what came of it", async () => {
    const answers = [
      new Response(null, { status: 204 }),
      Response.json({ error: "notFound" }, { status: 404 }),
      Response.json({ error: "hasRepository" }, { status: 409 }),
    ];
    const { projects, sent } = platform(() => answers.shift() as Response);
    expect(await projects.remove("p/1")).toBe("removed");
    expect(await projects.remove("p2")).toBe("missing");
    expect(await projects.remove("p3")).toBe("hasRepository");
    expect(sent[0]).toEqual({
      url: "https://platform.example/api/projects/p%2F1",
      method: "DELETE",
      headers: { "x-animaquill": "1" },
    });
  });

  test("takes only the platform's own word for a project that is not there", async () => {
    // A platform that takes no projects away, or a gateway, says 404 too: the project may be there.
    const answers = [
      Response.json(
        { message: "Route DELETE:/api/projects/p1 not found", error: "Not Found" },
        { status: 404 },
      ),
      new Response("<html>not found</html>", { status: 404 }),
      Response.json({ error: "busy" }, { status: 429 }),
      Response.json({ error: "unavailable" }, { status: 503 }),
      Response.json({ error: "somethingElse" }, { status: 409 }),
    ];
    const { projects } = platform(() => answers.shift() as Response);
    await expect(projects.remove("p1")).rejects.toThrow("404");
    await expect(projects.remove("p1")).rejects.toThrow("404");
    await expect(projects.remove("p1")).rejects.toThrow("429");
    await expect(projects.remove("p1")).rejects.toThrow("503");
    await expect(projects.remove("p1")).rejects.toThrow("409");
  });

  test("says that nobody is signed in, and rejects without a network", async () => {
    const out = platform(() => Response.json({ error: "signedOut" }, { status: 401 }));
    await expect(out.projects.remove("p1")).rejects.toBeInstanceOf(CloudSignedOut);
    const offline = platform(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(offline.projects.remove("p1")).rejects.toThrow("Failed to fetch");
  });
});
