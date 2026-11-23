import { describe, expect, it } from "vitest";
import {
  defaultPlaceOf,
  defaultToWrite,
  lfsUsable,
  planImport,
  type PlaceKind,
  type PlaceUnusable,
} from "./default-place.ts";

const all = (): PlaceUnusable | undefined => undefined;
const without =
  (...gone: PlaceKind[]) =>
  (kind: PlaceKind): PlaceUnusable | undefined =>
    gone.includes(kind) ? (kind === "lfs" ? "offline" : "noStore") : undefined;

describe("the default storage of a project", () => {
  it("is the repository online and this computer offline, where the project says nothing", () => {
    expect(defaultPlaceOf(undefined, "online", all)).toEqual({
      chosen: "lfs",
      written: false,
      effective: "lfs",
    });
    expect(defaultPlaceOf(undefined, "offline", without("lfs"))).toEqual({
      chosen: "local",
      written: false,
      effective: "local",
    });
  });

  it("is what the project says, in either mode", () => {
    expect(defaultPlaceOf({ kind: "local" }, "online", all)).toMatchObject({
      chosen: "local",
      written: true,
      effective: "local",
    });
  });

  it("falls back where the place cannot be used here, and says why", () => {
    // A project that said the repository, saved to a folder: offline, nothing goes there.
    expect(defaultPlaceOf({ kind: "lfs" }, "offline", without("lfs"))).toEqual({
      chosen: "lfs",
      written: true,
      effective: "local",
      unusable: "offline",
    });
    // Someone without the storage of the project: into the repository, where it can.
    expect(defaultPlaceOf({ kind: "remote" }, "online", without("remote"))).toEqual({
      chosen: "remote",
      written: true,
      effective: "lfs",
      unusable: "noStore",
    });
    expect(defaultPlaceOf({ kind: "platform" }, "online", without("platform", "lfs"))).toEqual({
      chosen: "platform",
      written: true,
      effective: "local",
      unusable: "noStore",
    });
  });

  it("writes nothing for what the mode has already", () => {
    expect(defaultToWrite("lfs", "online")).toBeNull();
    expect(defaultToWrite("local", "online")).toEqual({ kind: "local" });
    expect(defaultToWrite("local", "offline")).toBeNull();
    expect(defaultToWrite("lfs", "offline")).toEqual({ kind: "lfs" });
  });

  it("takes the repository where uploads only wait, and not where they cannot be", () => {
    expect(lfsUsable("online", undefined, true)).toBeUndefined();
    for (const waits of ["notMade", "signedOut", "repository"] as const)
      expect(lfsUsable("online", waits, true)).toBeUndefined();
    expect(lfsUsable("offline", undefined, true)).toBe("offline");
    expect(lfsUsable("online", "notCloud", true)).toBe("offline");
    expect(lfsUsable("online", "unsupported", true)).toBe("unsupported");
    expect(lfsUsable("online", undefined, false)).toBe("unsupported");
    expect(lfsUsable("online", "noRepository", true)).toBe("noRepository");
  });
});

describe("assets just imported", () => {
  const sizes = { large: 100, most: 1000 };
  const assets = {
    small: { hash: "sha256-a", size: 10 },
    big: { hash: "sha256-b", size: 500 },
    huge: { hash: "sha256-c", size: 2000 },
    unknown: {},
  };

  it("go into the storage where that is the default, the large told of, the too large left here", () => {
    expect(planImport(["small", "big", "huge", "unknown", "gone"], assets, "lfs", sizes)).toEqual({
      send: ["small", "big"],
      large: ["big"],
      tooLarge: ["huge"],
    });
  });

  it("stay here where the default is this computer", () => {
    expect(planImport(["small", "big", "huge"], assets, "local", sizes)).toEqual({
      send: [],
      large: [],
      tooLarge: [],
    });
  });
});
