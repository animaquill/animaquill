import { describe, expect, test } from "vitest";
import { NoAnswer } from "./answers.ts";
import { browserCloudProjects, projectSummaryOf } from "./cloud-projects.ts";
import { CloudSignedOut } from "./index.ts";

/** The projects of a platform over its HTTP API, as a browser reaches it. */

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

const platform = (
  answer: (sent: Sent, signal: AbortSignal | undefined) => Response | Promise<Response>,
  timeoutMs?: number,
) => {
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
      return answer(request, init?.signal ?? undefined);
    },
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
  return { projects, sent };
};

/** An answer that never comes, as on a line that hangs: only giving up ends it. */
const hanging = (_sent: Sent, signal: AbortSignal | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });

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

  test("is no project without an id that names a project of a platform", () => {
    expect(projectSummaryOf({ name: "原子", updatedAt: 5 })).toBeUndefined();
    expect(projectSummaryOf({ id: "", name: "原子", updatedAt: 5 })).toBeUndefined();
    expect(projectSummaryOf({ id: 5, name: "原子", updatedAt: 5 })).toBeUndefined();
    // Nothing the sync protocol takes, so nothing that could be opened, or be a project here.
    expect(projectSummaryOf({ id: "../x y", name: "原子", updatedAt: 5 })).toBeUndefined();
    expect(projectSummaryOf({ id: "p".repeat(65), name: "原子", updatedAt: 5 })).toBeUndefined();
    expect(projectSummaryOf("p1")).toBeUndefined();
    expect(projectSummaryOf(null)).toBeUndefined();
  });

  test("keeps a project whose name or time it cannot read: the platform has it all the same", () => {
    // Whether the platform still has a project is read from the list: one that fell out of it
    // for a field would look like one that is gone.
    expect(projectSummaryOf({ id: "p1", updatedAt: 5 })).toEqual({
      id: "p1",
      name: "",
      updatedAt: 5,
    });
    expect(projectSummaryOf({ id: "p1", name: "原子", updatedAt: "2026-11-11T00:00:00Z" })).toEqual(
      { id: "p1", name: "原子", updatedAt: 0 },
    );
  });

  test("asks the platform's API, and keeps what are projects, each once", async () => {
    const { projects, sent } = platform(() =>
      Response.json({
        projects: [
          FULL,
          { id: 5 },
          { id: "p2", name: "片头", updatedAt: 9 },
          { id: "p1", name: "同一个项目又来一次", updatedAt: 300 },
          { id: "not an id", name: "不是项目", updatedAt: 1 },
        ],
      }),
    );
    expect(await projects.list()).toEqual([FULL, { id: "p2", name: "片头", updatedAt: 9 }]);
    expect(sent).toEqual([
      { url: "https://platform.example/api/projects", method: "GET", headers: {} },
    ]);
    const none = platform(() => Response.json({ projects: [] }));
    expect(await none.projects.list()).toEqual([]);
  });

  test("takes an answer that is no list for no answer, never for no projects", async () => {
    // An empty list says that the platform has none of the projects this browser has copies of.
    for (const body of ['{"projects":"none"}', "{}", '{"error":"unavailable"}', "[]", "null"]) {
      const odd = platform(
        () => new Response(body, { headers: { "content-type": "application/json" } }),
      );
      await expect(odd.projects.list(), body).rejects.toThrow("not a list");
    }
    const page = platform(
      () => new Response("<html>登录</html>", { headers: { "content-type": "text/html" } }),
    );
    await expect(page.projects.list()).rejects.toThrow();
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

  test("gives up on a platform that does not answer, and stops asking", async () => {
    let given: AbortSignal | undefined;
    const { projects } = platform((sent, signal) => {
      given = signal;
      return hanging(sent, signal);
    }, 20);
    await expect(projects.list()).rejects.toBeInstanceOf(NoAnswer);
    expect(given?.aborted).toBe(true);
    // Also where whatever carries the request does not hear that it should stop.
    const deaf = platform(() => new Promise<Response>(() => {}), 20);
    await expect(deaf.projects.list()).rejects.toBeInstanceOf(NoAnswer);
    // An answer whose body never ends is none either.
    const slow = platform(
      () =>
        ({
          status: 200,
          ok: true,
          json: () => new Promise(() => {}),
        }) as unknown as Response,
      20,
    );
    await expect(slow.projects.list()).rejects.toBeInstanceOf(NoAnswer);
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

  test("takes only the platform's 204 for a project that is gone, not anything that went well", async () => {
    // A gateway, or a page that asks people to sign in, says 200 to anything: the project is
    // still there, and people would be told it is not.
    const answers = [
      new Response("<html>登录</html>", { status: 200, headers: { "content-type": "text/html" } }),
      Response.json({ ok: true }),
      new Response(null, { status: 202 }),
      new Response(null, { status: 205 }),
    ];
    const { projects } = platform(() => answers.shift() as Response);
    await expect(projects.remove("p1")).rejects.toThrow("200");
    await expect(projects.remove("p1")).rejects.toThrow("200");
    await expect(projects.remove("p1")).rejects.toThrow("202");
    await expect(projects.remove("p1")).rejects.toThrow("205");
  });

  test("says that nobody is signed in, and rejects without a network", async () => {
    const out = platform(() => Response.json({ error: "signedOut" }, { status: 401 }));
    await expect(out.projects.remove("p1")).rejects.toBeInstanceOf(CloudSignedOut);
    const offline = platform(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(offline.projects.remove("p1")).rejects.toThrow("Failed to fetch");
  });

  test("gives up on a platform that does not answer: the project may still be there", async () => {
    const { projects } = platform(hanging, 20);
    await expect(projects.remove("p1")).rejects.toBeInstanceOf(NoAnswer);
  });
});
