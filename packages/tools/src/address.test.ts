import { describe, expect, it } from "vitest";
import {
  formatAddress,
  parseAddress,
  valueOfAddress,
  withoutAddresses,
  type Address,
} from "./address.ts";
import { toolsOn } from "./test-support.ts";

describe("addresses of the editor", () => {
  it("are read back as they were written", () => {
    const all: Address[] = [
      { kind: "time", timeline: "main", t: "73/6" },
      { kind: "time", timeline: "main", t: "12.5", version: "en.vertical" },
      { kind: "object", id: "clip_7Hq2", timeline: "main" },
      { kind: "object", id: "asset_logo", timeline: undefined },
      { kind: "keyframe", id: "clip_7Hq2", timeline: "main", property: "position", t: "3" },
      { kind: "file", path: "scenes/intro/scene.html", from: 12, to: 18 },
      { kind: "file", path: "scenes/a b/[x].html", from: 3, to: 3 },
      { kind: "objects", ids: ["clip_a", "clip_b"], timeline: "main" },
    ];
    for (const address of all) expect(parseAddress(formatAddress(address))).toEqual(address);
  });

  it("are written as the design has them", () => {
    expect(formatAddress({ kind: "time", timeline: "main", t: "73/6" })).toBe(
      "aq://time?timeline=main&t=73/6",
    );
    expect(formatAddress({ kind: "object", id: "clip_7Hq2", timeline: "main" })).toBe(
      "aq://object/clip_7Hq2?timeline=main",
    );
    expect(formatAddress({ kind: "file", path: "scenes/intro/scene.html", from: 12, to: 18 })).toBe(
      "aq://file/scenes/intro/scene.html#L12-18",
    );
    expect(formatAddress({ kind: "objects", ids: ["clip_a", "clip_b"], timeline: "main" })).toBe(
      "aq://objects?timeline=main&ids=clip_a,clip_b",
    );
  });

  it("stand for an id, a time, a path or ids; anything else is none", () => {
    expect(valueOfAddress("aq://object/clip_7Hq2?timeline=main")).toBe("clip_7Hq2");
    expect(valueOfAddress("aq://time?timeline=main&t=73/6")).toBe("73/6");
    expect(valueOfAddress("aq://file/scenes/intro/scene.html#L12-18")).toBe(
      "scenes/intro/scene.html",
    );
    expect(valueOfAddress("aq://objects?ids=a,b")).toEqual(["a", "b"]);
    expect(valueOfAddress("clip_7Hq2")).toBeUndefined();
    expect(valueOfAddress("aq://nothing/x")).toBeUndefined();
    expect(valueOfAddress("aq://time?timeline=main")).toBeUndefined();
  });

  it("in arguments become what they stand for, and a list takes each of several", () => {
    const args = {
      ids: ["aq://objects?timeline=main&ids=clip_a,clip_b", "aq://object/clip_c?timeline=main"],
      from: "aq://time?timeline=main&t=1/2",
      text: "see aq://object/clip_c in the code",
      keep: 3,
    };
    expect(withoutAddresses(args)).toEqual({
      ids: ["clip_a", "clip_b", "clip_c"],
      from: "1/2",
      text: "see aq://object/clip_c in the code",
      keep: 3,
    });
    const plain = { ids: ["clip_a"], n: 1 };
    expect(withoutAddresses(plain)).toBe(plain);
  });
});

describe("tools given addresses", () => {
  it("read the object, the timeline from a moment, and the file they point to", async () => {
    const { call } = toolsOn();
    const byId = await call("aq_object_read", { ids: ["clip_interview"] });
    const byLink = await call("aq_object_read", {
      ids: ["aq://object/clip_interview?timeline=main"],
    });
    expect(byLink.isError).toBeFalsy();
    expect(byLink.text.split("\n")[1]).toBe(byId.text.split("\n")[1]);
    const from = await call("aq_timeline_read", {
      from: "aq://time?timeline=main&t=1",
      limit: 5,
    });
    expect(from.isError).toBeFalsy();
    const file = await call("aq_file_read", {
      path: "aq://file/scenes/title/index.html#L1-3",
      limit: 3,
    });
    expect(file.isError).toBeFalsy();
    expect(file.text).toContain("1→");
  });
});
