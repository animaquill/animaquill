import {
  CloudSignedOut,
  type AccountAccess,
  type RepositoryAccess,
  type RepositoryCheck,
  type RepositoryChoice,
} from "@animaquill/host";
import { describe, expect, it, vi } from "vitest";
import { RepositoryOpening } from "./open-repository.ts";

const repo = (id: number, change: Partial<RepositoryChoice> = {}): RepositoryChoice => ({
  id,
  owner: "me",
  name: `r${id}`,
  fullName: `me/r${id}`,
  private: true,
  pushable: true,
  empty: false,
  archived: false,
  linked: false,
  ...change,
});

function accessOf(
  pages: readonly (readonly RepositoryChoice[])[],
  checks: Readonly<Record<number, RepositoryCheck>> = {},
) {
  const check = vi.fn(async ({ existing }: { existing: { id: number } }) => {
    return checks[existing.id] ?? { ok: true };
  });
  const access = {
    list: vi.fn(async (page = 1) => ({
      repositories: pages[page - 1] ?? [],
      page,
      more: page < pages.length,
      manageUrl: "https://github.com/apps/x",
    })),
    check,
  } as unknown as RepositoryAccess;
  return { access, check };
}

const signedIn = (appInstalled = true) =>
  ({
    subscribe: () => () => {},
    getSnapshot: () => ({ status: "signedIn", name: "me", appInstalled }),
  }) as unknown as AccountAccess;

describe("opening from a repository", () => {
  it("opens a project of one's own, and says what others are, without asking", async () => {
    const { access, check } = accessOf([
      [
        repo(1, { linked: true, linkedProject: { id: "p1", name: "片头" } }),
        repo(2, { linked: true }),
        repo(3, { pushable: false }),
        repo(4, { archived: true }),
        repo(5, { empty: true }),
      ],
    ]);
    const opening = new RepositoryOpening({ access, account: signedIn() });
    await opening.refresh();
    opening.select("1");
    expect(opening.action).toEqual({ kind: "open", project: { id: "p1", name: "片头" } });
    // Another person's project, and repositories it cannot write to, cannot be chosen.
    for (const id of ["2", "3", "4"]) {
      opening.select(id);
      expect(opening.getSnapshot().selected).toBe("1");
    }
    expect(opening.getSnapshot().states.get("2")).toMatchObject({ reason: "linked" });
    expect(opening.getSnapshot().states.get("3")).toMatchObject({ reason: "notPushable" });
    expect(opening.getSnapshot().states.get("4")).toMatchObject({ reason: "archived" });
    opening.select("5");
    expect(opening.action).toEqual({ kind: "create" });
    expect(check).not.toHaveBeenCalled();
  });

  it("asks the platform once about a repository with files, and restores one with a project", async () => {
    const { access, check } = accessOf([[repo(1), repo(2), repo(3, { private: false })]], {
      1: { ok: false, reason: "hasProject", files: ["animaquill.json"] },
      3: { ok: false, reason: "linkedElsewhere", project: { id: "p3", name: "旧的" } },
    });
    const opening = new RepositoryOpening({ access, account: signedIn() });
    await opening.refresh();
    opening.select("1");
    expect(opening.getSnapshot().states.get("1")).toEqual({ kind: "checking" });
    expect(opening.action).toBeUndefined();
    await vi.waitFor(() => expect(opening.action).toEqual({ kind: "restore" }));
    opening.select("2");
    await vi.waitFor(() => expect(opening.action).toEqual({ kind: "create" }));
    opening.select("1");
    expect(check).toHaveBeenCalledTimes(2);
    // A public one is asked about as one people said yes to: what it has is what counts here.
    opening.select("3");
    await vi.waitFor(() =>
      expect(opening.action).toEqual({ kind: "open", project: { id: "p3", name: "旧的" } }),
    );
    expect(check).toHaveBeenLastCalledWith({ existing: { id: 3 }, confirmPublic: true });
  });

  it("takes the next page, filters what it has, and lets go of one it cannot use", async () => {
    const { access } = accessOf([[repo(1), repo(2)], [repo(30)]], {
      2: { ok: false, reason: "notPushable" },
    });
    const opening = new RepositoryOpening({ access, account: signedIn() });
    await opening.refresh();
    expect(opening.getSnapshot().more).toBe(true);
    await opening.more();
    expect(opening.getSnapshot().rows.map(({ id }) => id)).toEqual(["1", "2", "30"]);
    expect(opening.getSnapshot().more).toBe(false);
    opening.setFilter(" R3 ");
    expect(opening.shown.map(({ id }) => id)).toEqual(["30"]);
    opening.select("2");
    await vi.waitFor(() =>
      expect(opening.getSnapshot().states.get("2")).toMatchObject({ reason: "notPushable" }),
    );
    expect(opening.getSnapshot().selected).toBeUndefined();
  });

  it("says what has to happen first, and when the list cannot be read", async () => {
    const { access } = accessOf([[repo(1)]]);
    const notInstalled = new RepositoryOpening({ access, account: signedIn(false) });
    await notInstalled.refresh();
    expect(notInstalled.getSnapshot()).toMatchObject({ need: "installApp", list: "idle" });
    const signedOut = {
      subscribe: () => () => {},
      getSnapshot: () => ({ status: "signedOut" }),
    } as unknown as AccountAccess;
    const out = new RepositoryOpening({ access, account: signedOut });
    await out.refresh();
    expect(out.getSnapshot().need).toBe("signIn");
    const failing = {
      list: async () => {
        throw new Error("unreachable");
      },
    } as unknown as RepositoryAccess;
    const failed = new RepositoryOpening({ access: failing, account: signedIn() });
    await failed.refresh();
    expect(failed.getSnapshot().list).toBe("failed");
    const lapsed = {
      list: async () => {
        throw new CloudSignedOut();
      },
    } as unknown as RepositoryAccess;
    const gone = new RepositoryOpening({ access: lapsed, account: signedIn() });
    await gone.refresh();
    expect(gone.getSnapshot().need).toBe("signIn");
  });

  it("lists the repositories of the server's own that no project has, each to restore", async () => {
    const opening = new RepositoryOpening({
      localRepositories: async () => [
        { dir: "a.git", name: "片头", project: "p1", bytes: 10 },
        { dir: "b.git", name: "片尾", project: "p2" },
      ],
      account: signedIn(),
    });
    await opening.refresh();
    expect(opening.getSnapshot().source).toBe("local");
    opening.select("b.git");
    expect(opening.action).toEqual({ kind: "restore" });
    const empty = new RepositoryOpening({ localRepositories: async () => [], account: signedIn() });
    await empty.refresh();
    expect(empty.getSnapshot()).toMatchObject({ list: "ready", rows: [] });
  });
});
