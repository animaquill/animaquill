import type { LocalGitRepoHost } from "./local/host.ts";
import { describe, expect, test } from "vitest";
import { GitHubUnavailable } from "../github/client.ts";
import {
  RepoHosts,
  placeOf,
  type GitHubPlace,
  type LocalPlace,
  type RepoHost,
  type RepoSession,
} from "./repo-host.ts";

/** Repositories on whichever provider: the one way to them, see repo-host.ts. */

/** A host that says which place it was asked for, by the branch it gives as the tip. */
const naming = <Place extends GitHubPlace | LocalPlace>(name: string): RepoHost<Place> => ({
  open: (place) =>
    ({ tip: async () => `${name}:${place.provider}:${place.repoId}` }) as unknown as RepoSession,
});

describe("RepoHosts", () => {
  test("goes to the host of the place's provider", async () => {
    const hosts = new RepoHosts({
      github: naming<GitHubPlace>("on GitHub"),
      local: naming<LocalPlace>("here") as unknown as LocalGitRepoHost,
    });
    expect(hosts.providers).toEqual(["github", "local"]);
    const github = hosts.open({ provider: "github", installationId: 1, repoId: 7 });
    expect(await github.tip("main")).toBe("on GitHub:github:7");
    const local = hosts.open({ provider: "local", repoId: 7, dir: "repos/7.git" });
    expect(await local.tip("main")).toBe("here:local:7");
  });

  test("reaches no repository on a provider it has no host for: GitHub unreachable, never gone", async () => {
    const hosts = RepoHosts.github(undefined);
    expect(hosts.has("github")).toBe(false);
    expect(hosts.providers).toEqual([]);
    const session = hosts.open({ provider: "github", installationId: 1, repoId: 7 });
    await expect(session.info()).rejects.toBeInstanceOf(GitHubUnavailable);
    await expect(session.lfsHave([], "upload")).rejects.toBeInstanceOf(GitHubUnavailable);
    await expect(session.close()).resolves.toBeUndefined();
    const local = RepoHosts.github(naming<GitHubPlace>("on GitHub")).open({
      provider: "local",
      repoId: 7,
      dir: "repos/7.git",
    });
    await expect(local.tip("main")).rejects.toBeInstanceOf(GitHubUnavailable);
  });
});

describe("placeOf", () => {
  test("is what the row says, for each provider", () => {
    expect(placeOf({ provider: "github", repoId: 7, installationId: 3, localDir: null })).toEqual({
      provider: "github",
      installationId: 3,
      repoId: 7,
    });
    expect(
      placeOf({ provider: "local", repoId: 7, installationId: null, localDir: "repos/7.git" }),
    ).toEqual({ provider: "local", repoId: 7, dir: "repos/7.git" });
  });

  test("refuses a row the checks of the table would not take", () => {
    expect(() =>
      placeOf({ provider: "github", repoId: 7, installationId: null, localDir: null }),
    ).toThrow(/installation/);
    expect(() =>
      placeOf({ provider: "local", repoId: 7, installationId: null, localDir: null }),
    ).toThrow(/folder/);
  });
});
