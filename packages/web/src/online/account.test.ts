import { describe, expect, it } from "vitest";
import { describeSession, describeSpace, GITHUB_PICTURES } from "./account.ts";

/** What the server says of who is signed in and of the cloud space, as the account menu takes it. */

describe("who is signed in", () => {
  it("is the person, with their picture at the size it shows at, from GitHub only", () => {
    expect(
      describeSession({
        status: "signedIn",
        user: { id: "u1", login: "ada", avatarUrl: `${GITHUB_PICTURES}/u/1?v=4` },
        app: { installed: true },
        repositories: "github",
      }),
    ).toEqual({
      status: "signedIn",
      id: "u1",
      name: "ada",
      picture: `${GITHUB_PICTURES}/u/1?v=4&s=64`,
      appInstalled: true,
    });
    expect(
      describeSession({
        status: "signedIn",
        user: { login: "ada", avatarUrl: "https://elsewhere.example.com/a.png" },
        id: "u2",
        repositories: "local",
      }),
    ).toEqual({
      status: "signedIn",
      id: "u2",
      name: "ada",
      appInstalled: false,
      repositories: "local",
    });
    // Pictures from where the deployment says, and nowhere else.
    expect(
      describeSession(
        { status: "signedIn", user: { login: "ada", avatarUrl: "https://pictures.example.com/a" } },
        "https://pictures.example.com",
      ),
    ).toMatchObject({ picture: "https://pictures.example.com/a?s=64" });
  });

  it("is nobody for anything else", () => {
    for (const body of [null, {}, { status: "signedOut" }, { status: "signedIn", user: {} }])
      expect(describeSession(body)).toEqual({ status: "signedOut" });
  });
});

describe("the cloud space", () => {
  it("is what the server says, or a mistake", () => {
    expect(describeSpace({ mode: "readonly", limit: 10, used: 3 })).toEqual({
      mode: "readonly",
      limit: 10,
      used: 3,
    });
    for (const body of [null, { mode: "on", limit: -1, used: 0 }, { mode: "x", limit: 1, used: 0 }])
      expect(() => describeSpace(body)).toThrow();
    // No limit, as a server of one's own says it; with what is kept on the platform itself.
    const platform = { limit: null, used: 7, count: { limit: null, used: 1 }, projects: [] };
    expect(describeSpace({ mode: "off", limit: null, used: 0, platform })).toEqual({
      mode: "off",
      limit: null,
      used: 0,
      platform,
    });
  });
});
