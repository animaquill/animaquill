import { describe, expect, it } from "vitest";
import { CloudSignedOut } from "./index.ts";
import { browserOrganizerAccess, OrganizerBusy } from "./organizer-access.ts";

/** The platform's clock is this much ahead of this computer's. */
const AHEAD = 3600_000;

function platformOf(answer: (request: { method: string; body: any }) => Response) {
  const asked: { method: string; body: any; headers: Record<string, string> }[] = [];
  let clock = 1_000_000;
  const access = browserOrganizerAccess({
    api: (path) => `/api${path}`,
    changeHeaders: { "x-test": "1" },
    // The request takes 10 ms each way.
    now: () => (clock += 10),
    fetch: async (input, init) => {
      expect(input).toBe("/api/organizer");
      const request = {
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        headers: { ...(init?.headers as Record<string, string>) },
      };
      asked.push(request);
      clock += 10;
      return answer(request);
    },
  });
  return { access, asked, now: () => clock };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("how projects are organised, on a platform over HTTP", () => {
  it("reads it by this computer's clock", async () => {
    const { access } = platformOf(() =>
      json(200, {
        // Half way: sent at 1_000_010, back at 1_000_030.
        now: 1_000_020 + AHEAD,
        groups: [
          { id: "g", name: "工作", at: 500_000 + AHEAD },
          { id: "h", name: "删了", at: 600_000 + AHEAD, deleted: true },
        ],
        marks: [
          {
            project: "p",
            star: { starred: true, at: 700_000 + AHEAD },
            group: { id: null, at: 800_000 + AHEAD },
          },
          { project: "q", group: { id: "g", at: 900_000 + AHEAD } },
        ],
      }),
    );
    expect(await access.read()).toEqual({
      groups: [
        { id: "g", name: "工作", at: 500_000 },
        { id: "h", name: "删了", at: 600_000, deleted: true },
      ],
      marks: [
        { project: "p", star: { starred: true, at: 700_000 }, group: { id: null, at: 800_000 } },
        { project: "q", group: { id: "g", at: 900_000 } },
      ],
    });
  });

  it("gives changes with what this computer's clock says, and reads what came of them", async () => {
    const { access, asked } = platformOf(() =>
      json(200, {
        now: 1_000_030 + AHEAD,
        groups: ["kept", { taken: "w" }],
        marks: [
          { project: "p", star: "kept", group: "noGroup" },
          { project: "q", missing: true },
        ],
        state: { groups: [{ id: "w", name: "工作", at: 1000 + AHEAD }], marks: [] },
      }),
    );
    const changes = {
      groups: [
        { id: "g", name: "新", at: 900_000 },
        { id: "x", name: "工作", at: 900_001 },
      ],
      marks: [
        { project: "p", star: { starred: true, at: 900_002 }, group: { id: "x", at: 900_002 } },
        { project: "q", star: { starred: false, at: 900_003 } },
      ],
    };
    expect(await access.change(changes)).toEqual({
      groups: ["kept", { taken: "w" }],
      marks: [
        { project: "p", star: "kept", group: "noGroup" },
        { project: "q", missing: true },
      ],
      state: { groups: [{ id: "w", name: "工作", at: 1000 }], marks: [] },
    });
    expect(asked[0]).toMatchObject({
      method: "POST",
      body: { now: 1_000_010, ...changes },
      headers: { "x-test": "1", "content-type": "application/json" },
    });
  });

  it("says who is not signed in, when it is busy, and takes nothing it cannot read", async () => {
    await expect(platformOf(() => json(401, { error: "signedOut" })).access.read()).rejects.toThrow(
      CloudSignedOut,
    );
    const busy = platformOf(() =>
      json(429, { error: "busy" }, { "retry-after": "7" }),
    ).access.read();
    await expect(busy).rejects.toThrow(OrganizerBusy);
    await expect(busy).rejects.toMatchObject({ retryAfterMs: 7000 });
    for (const answer of [
      json(503, { error: "unavailable" }),
      new Response("<html>gateway</html>", { status: 200 }),
      json(200, { groups: [], marks: [] }),
      json(200, { now: 1, groups: [{ id: "g" }], marks: [] }),
      json(200, { now: 1, groups: [], marks: [{ project: 5 }] }),
    ])
      await expect(platformOf(() => answer.clone()).access.read()).rejects.toThrow();
    // An answer that does not say what came of each change is none.
    const short = platformOf(() =>
      json(200, { now: 1, groups: [], marks: [], state: { groups: [], marks: [] } }),
    );
    await expect(
      short.access.change({ groups: [{ id: "g", name: "x", at: 1 }] }),
    ).rejects.toThrow();
    await expect(
      platformOf(() => json(200, {})).access.change({
        marks: Array.from({ length: 201 }, (_, i) => ({
          project: `p${i}`,
          star: { starred: true, at: 1 },
        })),
      }),
    ).rejects.toThrow(RangeError);
  });
});
