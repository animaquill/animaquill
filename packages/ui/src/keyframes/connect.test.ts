import { clipNodeOf, type ClipState, type TreeNode } from "@animaquill/core";
import { CLIP_VISUAL, type ObjectDescriptor } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { connectionsFor } from "./connect.ts";

const keys = { keys: [{ time: "0", value: 1 }] };

const clip = (properties: object) =>
  ({
    id: "c",
    start: "0",
    duration: "5",
    track: "t",
    source: { kind: "scene", scene: "a" },
    properties,
  }) as ClipState;

const arm: ObjectDescriptor = {
  id: "object.arm2",
  name: "手臂",
  properties: [
    { path: "object.arm2.size", type: "number", name: "size" },
    { path: "object.arm2.x", type: "number", name: "x" },
    { path: "object.arm2.tint", type: "color", name: "tint" },
    { path: "object.arm2.y", type: "number", name: "y" },
  ],
};

const nameOf = (node: TreeNode) => {
  if (node.kind === "property") return node.spec.name ?? node.spec.path;
  if (node.kind === "object") return node.object.name ?? node.object.id;
  return node.kind === "group" ? node.group : node.id;
};

function connections(properties: object, path = "object.arm.x") {
  const one = clip(properties);
  const node = clipNodeOf(one, { objects: [CLIP_VISUAL, arm], ran: "complete" });
  return connectionsFor(node, one, path, nameOf);
}

describe("where keys without an object can go", () => {
  it("is first of all the property of the same name, on what code registered", () => {
    const found = connections({ "object.arm.x": keys });
    expect(found[0]).toEqual({ path: "object.arm2.x", label: "手臂 › x" });
    expect(found.map(({ path }) => path)).toContain("transform.x");
  });

  it("is what can take the keys, and holds nothing yet", () => {
    const found = connections({ "object.arm.x": keys, "object.arm2.y": 3 });
    const paths = found.map(({ path }) => path);
    expect(paths).not.toContain("object.arm2.tint");
    expect(paths).not.toContain("object.arm2.y");
    expect(paths).not.toContain("object.arm.x");
  });

  it("is nowhere for what nothing holds", () => {
    expect(connections({}, "object.arm.x")).toEqual([]);
  });

  it("is a color for a color", () => {
    const tint = { keys: [{ time: "0", value: "#ff0000" }] };
    const found = connections({ "object.arm.tint": tint }, "object.arm.tint");
    expect(found.map(({ path }) => path)).toEqual(["object.arm2.tint"]);
  });
});
