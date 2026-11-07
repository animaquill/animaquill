import {
  CLIP_VISUAL,
  createProject,
  parseTime,
  type ObjectDescriptor,
  type PropertySpec,
} from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { orderedTracks, type ClipState, type TimelineState } from "./model.ts";
import {
  clipIsHere,
  clipNodeOf,
  listedClip,
  objectForest,
  objectIsHere,
  pathsBelow,
  propertyTree,
  rowsOf,
  type ClipChild,
  type ListFilter,
  type ObjectNode,
  type TreeNode,
} from "./property-tree.ts";
import { ProjectStore } from "./store.ts";

const clip = (extra: object = {}, source: object = { kind: "color", color: "#000000" }) =>
  ({ id: "c", start: "2", duration: "5", track: "t", source, ...extra }) as ClipState;

const number = (path: string, extra: Partial<PropertySpec> = {}): PropertySpec => ({
  path,
  type: "number",
  ...extra,
});

const keys = (...times: string[]) => ({ keys: times.map((time) => ({ time, value: 1 })) });

const names = (nodes: readonly TreeNode[]): readonly unknown[] =>
  nodes.map((node) => {
    if (node.kind === "property") return node.spec.path;
    const label = node.kind === "group" ? node.group : node.id;
    return [label, names(node.children)];
  });

const filter = (range: ListFilter["range"], at = "3", extra: Partial<ListFilter> = {}) => ({
  range,
  moment: parseTime(at),
  ...extra,
});

describe("the rows of a property", () => {
  it.each(["number", "angle"] as const)("a %s is keys with a curve of its numbers", (type) => {
    expect(rowsOf({ path: "a", type })).toEqual([
      { path: "a", band: "keys", curve: "value", readout: "number" },
    ]);
  });

  it.each(["boolean", "choice", "text", "asset"] as const)(
    "a %s is one value at a time, without a curve",
    (type) => {
      expect(rowsOf({ path: "a", type })).toEqual([
        { path: "a", band: "segments", curve: "none", readout: "value" },
      ]);
    },
  );

  it("a color is keys on the colors in between, with the easing as its curve", () => {
    expect(rowsOf({ path: "a", type: "color" })).toEqual([
      { path: "a", band: "gradient", curve: "progress", readout: "color" },
    ]);
  });

  it("a vector is one row of keys, and a curve of numbers for each of its parts", () => {
    const rows = rowsOf({ path: "a", type: "vec2", components: ["x", "y"] });
    expect(rows).toEqual([
      { path: "a", band: "keys", curve: "none", readout: "components" },
      {
        path: "a",
        band: "keys",
        curve: "value",
        readout: "number",
        component: { index: 0, name: "x" },
      },
      {
        path: "a",
        band: "keys",
        curve: "value",
        readout: "number",
        component: { index: 1, name: "y" },
      },
    ]);
  });

  it("a list of numbers is one row, with the easing as its curve", () => {
    expect(rowsOf({ path: "a", type: "numbers" })).toEqual([
      { path: "a", band: "keys", curve: "progress", readout: "count" },
    ]);
  });

  it("a vector has one row for all of it, and one for each part of the same channel", () => {
    const rows = rowsOf({ path: "a", type: "number", components: ["x", "y"] });
    expect(rows.map(({ path }) => path)).toEqual(["a", "a", "a"]);
    expect(rows.map(({ component }) => component)).toEqual([
      undefined,
      { index: 0, name: "x" },
      { index: 1, name: "y" },
    ]);
  });
});

describe("objects from a flat list", () => {
  const object = (id: string, parent?: string): ObjectDescriptor => ({
    id,
    properties: [],
    ...(parent === undefined ? {} : { parent }),
  });
  const shape = (trees: ReturnType<typeof objectForest>["roots"]): unknown[] =>
    trees.map(({ object: { id }, children }) => (children.length ? [id, shape(children)] : id));

  it("goes as deep as parents say, in the order of the list", () => {
    const forest = objectForest([
      object("rig"),
      object("hand", "arm"),
      object("arm", "rig"),
      object("leg", "rig"),
      object("logo"),
    ]);
    expect(shape(forest.roots)).toEqual([["rig", [["arm", ["hand"]], "leg"]], "logo"]);
    expect(forest.detached).toEqual([]);
  });

  it("puts what has a missing parent at the top and says so", () => {
    const forest = objectForest([object("a", "gone"), object("b")]);
    expect(shape(forest.roots)).toEqual(["a", "b"]);
    expect(forest.detached).toEqual(["a"]);
  });

  it("does not lose anything to a circle", () => {
    const forest = objectForest([
      object("a", "b"),
      object("b", "c"),
      object("c", "a"),
      object("d", "c"),
      object("me", "me"),
    ]);
    const all = JSON.stringify(shape(forest.roots));
    for (const id of ["a", "b", "c", "d", "me"]) expect(all).toContain(`"${id}"`);
    expect(forest.detached).toContain("me");
    expect(forest.detached.length).toBeGreaterThanOrEqual(2);
  });

  it("stops at a depth that makes no sense, and keeps what is deeper", () => {
    const chain = Array.from({ length: 200 }, (_, index) =>
      object(`o${index}`, index === 0 ? undefined : `o${index - 1}`),
    );
    const { roots, detached } = objectForest(chain);
    const count = (trees: typeof roots): number =>
      trees.reduce((sum, { children }) => sum + 1 + count(children), 0);
    const deepest = (trees: typeof roots): number =>
      Math.max(0, ...trees.map(({ children }) => 1 + deepest(children)));
    expect(count(roots)).toBe(200);
    expect(deepest(roots)).toBeLessThanOrEqual(32);
    expect(detached.length).toBeGreaterThan(0);
  });

  it("takes the first object of an id", () => {
    const first: ObjectDescriptor = { id: "a", name: "first", properties: [] };
    const { roots } = objectForest([first, { id: "a", name: "second", properties: [] }]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.object).toBe(first);
  });
});

describe("the tree of a clip", () => {
  it("the picture of a clip is the clip itself, with its groups, and without what has no keys", () => {
    const node = clipNodeOf(clip());
    expect(names(node.children)).toEqual([
      ["position", ["transform.x", "transform.y"]],
      ["size", ["transform.width", "transform.height"]],
      ["anchor", ["transform.anchorX", "transform.anchorY"]],
      "transform.scale",
      "transform.rotation",
      "opacity",
    ]);
  });

  it("a clip with nothing to animate has nothing below it", () => {
    expect(clipNodeOf(clip({}, { kind: "audio", media: { asset: "a" } })).children).toEqual([]);
  });

  it("objects go as deep as their parents, with groups inside of them", () => {
    const objects: ObjectDescriptor[] = [
      CLIP_VISUAL,
      {
        id: "rig",
        name: "骨架",
        properties: [
          number("object.rig.x", { group: "root" }),
          number("object.rig.y", { group: "root" }),
        ],
      },
      { id: "arm", parent: "rig", properties: [number("object.arm.r")] },
      { id: "hand", parent: "arm", properties: [number("object.hand.r")] },
      { id: "empty", parent: "rig", properties: [] },
    ];
    const node = clipNodeOf(clip({ id: "deep" }), objects);
    const rig = node.children.find(
      (child): child is ObjectNode => child.kind === "object",
    ) as ObjectNode;
    expect(rig.object.name).toBe("骨架");
    expect(names(rig.children)).toEqual([
      ["root", ["object.rig.x", "object.rig.y"]],
      [
        "deep/object:rig/object:arm",
        ["object.arm.r", ["deep/object:rig/object:arm/object:hand", ["object.hand.r"]]],
      ],
    ]);
    expect(pathsBelow(rig)).toEqual([
      "object.rig.x",
      "object.rig.y",
      "object.arm.r",
      "object.hand.r",
    ]);
  });

  it("is the same object as long as the clip is", () => {
    const one = clip();
    expect(clipNodeOf(one)).toBe(clipNodeOf(one));
  });

  it("keeps keys in sight that nothing describes, by what they look like", () => {
    const node = clipNodeOf(
      clip({
        properties: {
          "object.old.x": keys("0"),
          "param.title": { keys: [{ time: "0", value: "你好" }] },
          "param.on": { keys: [{ time: "0", value: true }] },
          "param.plain": 3,
          fit: { keys: [{ time: "0", value: "cover" }] },
          "transform.x": keys("1"),
        },
      }),
    );
    const orphans = node.children.at(-1) as ObjectNode;
    expect(orphans.orphans).toBe(true);
    const found = Object.fromEntries(
      orphans.children.map((child) => {
        const { spec } = child as { spec: PropertySpec };
        return [spec.path, spec.type];
      }),
    );
    expect(found).toEqual({
      "object.old.x": "number",
      "param.title": "text",
      "param.on": "boolean",
      fit: "choice",
    });
  });

  it("has no such group without such keys", () => {
    const node = clipNodeOf(clip({ properties: { "param.plain": 3, opacity: keys("0") } }));
    expect(node.children.some((child) => child.kind === "object")).toBe(false);
  });
});

describe("the tree of a clip with a scene", () => {
  const scene = (properties: object) =>
    clip({ id: "s", properties }, { kind: "scene", scene: "a" });
  const arm: ObjectDescriptor = {
    id: "object.arm",
    name: "手臂",
    properties: [number("object.arm.x"), { ...number("object.arm.size"), animatable: false }],
  };
  const groups = (node: ReturnType<typeof clipNodeOf>) =>
    Object.fromEntries(
      node.children
        .filter((child): child is ObjectNode => child.kind === "object")
        .map((child) => [
          child.orphans ? "orphans" : child.pending ? "pending" : child.object.id,
          pathsBelow(child),
        ]),
    );
  const properties = {
    "object.arm.x": keys("0"),
    "object.arm.size": 3,
    "object.gone.x": keys("0"),
    "object.gone.y": 2,
    "element.logo.opacity": 0.5,
    "param.old": 4,
    "transform.x": keys("1"),
    "audio.volume": -3,
  };

  it("keeps what code has to describe as it is, while the code did not get through", () => {
    for (const ran of ["never", "partial"] as const) {
      const node = clipNodeOf(scene(properties), { objects: [CLIP_VISUAL, arm], ran });
      expect(groups(node)).toEqual({
        "object.arm": ["object.arm.x"],
        pending: ["object.gone.x", "object.gone.y", "element.logo.opacity"],
        orphans: ["param.old"],
      });
    }
  });

  it("knows what lost its object once the code got through", () => {
    const node = clipNodeOf(scene(properties), { objects: [CLIP_VISUAL, arm], ran: "complete" });
    expect(groups(node)).toEqual({
      "object.arm": ["object.arm.x"],
      orphans: ["object.gone.x", "object.gone.y", "element.logo.opacity", "param.old"],
    });
    const orphans = node.children.at(-1) as ObjectNode;
    expect(orphans.children.every((child) => child.kind === "property" && child.orphan)).toBe(true);
  });

  it("keeps what is there in sight by what it holds", () => {
    const node = clipNodeOf(
      scene({ "object.a.c": "#ff0000", "object.a.v": [1, 2], "object.a.t": "hi" }),
      { objects: [CLIP_VISUAL], ran: "complete" },
    );
    const orphans = node.children.at(-1) as ObjectNode;
    expect(orphans.children.map((child) => (child as { spec: PropertySpec }).spec.type)).toEqual([
      "color",
      "numbers",
      "text",
    ]);
  });

  it("is the same as long as the clip and its description are", () => {
    const one = scene(properties);
    const described = { objects: [CLIP_VISUAL, arm], ran: "complete" as const };
    expect(clipNodeOf(one, described)).toBe(clipNodeOf(one, described));
    expect(clipNodeOf(one, { ...described })).not.toBe(clipNodeOf(one, described));
  });
});

describe("whether something is there", () => {
  it("a clip is there from its first moment to before its end, exactly", () => {
    const thirds = clip({ start: "1/3", duration: "1/3" });
    expect(clipIsHere(thirds, parseTime("1/3"))).toBe(true);
    expect(clipIsHere(thirds, parseTime("0.333333333"))).toBe(false);
    expect(clipIsHere(thirds, parseTime("2/3"))).toBe(false);
    expect(clipIsHere(thirds, parseTime("0.666666666"))).toBe(true);
  });

  it("a hidden clip is not", () => {
    expect(clipIsHere(clip({ hidden: true }), parseTime("3"))).toBe(false);
  });

  const object = (extra: Partial<ObjectDescriptor>): ObjectDescriptor => ({
    id: "o",
    properties: [
      number("object.o.on"),
      number("object.o.off", { default: 0 }),
      { path: "object.o.flag", type: "boolean" },
    ],
    ...extra,
  });

  it("an object without a word about it is there for as long as the clip", () => {
    expect(objectIsHere(object({}), clip(), 100)).toBe(true);
  });

  it("goes by its spans on the clock of the clip", () => {
    const spans = [
      [1, 2],
      [3, 4],
    ] as const;
    const held = object({ spans });
    expect(objectIsHere(held, clip(), 1)).toBe(true);
    expect(objectIsHere(held, clip(), 2)).toBe(false);
    expect(objectIsHere(held, clip(), 3.5)).toBe(true);
    expect(objectIsHere(held, clip(), 0.5)).toBe(false);
  });

  it("goes by what a property says, at that moment", () => {
    const shown = object({ presence: "object.o.on" });
    const fading = clip({
      properties: {
        "object.o.on": {
          keys: [
            { time: "0", value: 1, interp: "hold" },
            { time: "2", value: 0, interp: "hold" },
            { time: "3", value: 1 },
          ],
        },
      },
    });
    expect(objectIsHere(shown, fading, 1)).toBe(true);
    expect(objectIsHere(shown, fading, 2.5)).toBe(false);
    expect(objectIsHere(shown, fading, 3.5)).toBe(true);
  });

  it("takes a true value too, and goes by the default without a value", () => {
    const shown = object({ presence: "object.o.flag" });
    expect(objectIsHere(shown, clip({ properties: { "object.o.flag": true } }), 1)).toBe(true);
    expect(objectIsHere(shown, clip({ properties: { "object.o.flag": false } }), 1)).toBe(false);
    expect(objectIsHere(object({ presence: "object.o.off" }), clip(), 1)).toBe(false);
    expect(objectIsHere(shown, clip(), 1)).toBe(true);
    expect(objectIsHere(object({ presence: "object.o.missing" }), clip(), 1)).toBe(true);
  });
});

describe("what gets listed", () => {
  const animated = clip({
    id: "animated",
    properties: { "transform.x": keys("0", "1"), opacity: 0.5 },
  });

  it("all of it for the whole list, and the same object when nothing went", () => {
    const node = clipNodeOf(animated);
    expect(listedClip(node, animated, filter("all", "100"))).toBe(node);
  });

  it("here, only what is at the moment", () => {
    const node = clipNodeOf(animated);
    expect(listedClip(node, animated, filter("here", "3"))).toBe(node);
    expect(listedClip(node, animated, filter("here", "1"))).toBeUndefined();
    expect(listedClip(node, animated, filter("here", "7"))).toBeUndefined();
  });

  it("only what has keys, with the parents of that", () => {
    const listed = listedClip(clipNodeOf(animated), animated, filter("keyed", "100"));
    expect(names(listed?.children ?? [])).toEqual([["position", ["transform.x"]]]);
    const still = clip({ id: "still", properties: { opacity: 0.5 } });
    expect(listedClip(clipNodeOf(still), still, filter("keyed"))).toBeUndefined();
  });

  it("what people pinned or selected stays, all of it", () => {
    const node = clipNodeOf(animated);
    const always = (id: string) => id === "animated";
    expect(listedClip(node, animated, filter("here", "100", { always }))).toBe(node);
    expect(listedClip(node, animated, filter("keyed", "100", { always }))).toBe(node);
  });

  it("looking for something goes for that too: it is what people are looking at right now", () => {
    const node = clipNodeOf(animated);
    const always = (id: string) => id === "animated";
    const matches = (found: TreeNode) => found.kind === "property" && found.spec.path === "opacity";
    const listed = listedClip(node, animated, filter("here", "100", { always, matches }));
    expect(names(listed?.children ?? [])).toEqual(["opacity"]);
  });

  it("an object can be pinned while the rest of its clip is somewhere else", () => {
    const objects: ObjectDescriptor[] = [
      { id: "a", properties: [number("object.a.x")] },
      { id: "b", properties: [number("object.b.x")] },
    ];
    const deep = clip({ id: "pinned-object" });
    const node = clipNodeOf(deep, objects);
    const always = (id: string) => id === "pinned-object/object:b";
    const listed = listedClip(node, deep, filter("here", "100", { always }));
    expect(listed?.children.map(({ id }) => id)).toEqual(["pinned-object/object:b"]);
  });

  it("goes by names, and a name brings along what is under it", () => {
    const node = clipNodeOf(animated);
    const name = (wanted: string) => (found: TreeNode) =>
      (found.kind === "property" ? found.spec.path : found.kind === "group" ? found.group : "") ===
      wanted;
    const byProperty = listedClip(node, animated, filter("all", "3", { matches: name("opacity") }));
    expect(names(byProperty?.children ?? [])).toEqual(["opacity"]);
    const byGroup = listedClip(node, animated, filter("all", "3", { matches: name("size") }));
    expect(names(byGroup?.children ?? [])).toEqual([
      ["size", ["transform.width", "transform.height"]],
    ]);
    const nothing = listedClip(node, animated, filter("all", "3", { matches: () => false }));
    expect(nothing).toBeUndefined();
  });

  it("a name of the clip itself brings all of it", () => {
    const node = clipNodeOf(animated);
    const matches = (found: TreeNode) => found.kind === "clip";
    expect(listedClip(node, animated, filter("all", "3", { matches }))).toBe(node);
  });

  it("the range goes first, whatever the name says", () => {
    const node = clipNodeOf(animated);
    const matches = (found: TreeNode) => found.kind === "clip";
    const listed = listedClip(node, animated, filter("keyed", "3", { matches }));
    expect(names(listed?.children ?? [])).toEqual([["position", ["transform.x"]]]);
  });

  describe("objects with a life of their own", () => {
    const objects: ObjectDescriptor[] = [
      { id: "always", properties: [number("object.always.x")] },
      { id: "early", spans: [[0, 2]], properties: [number("object.early.x")] },
      { id: "child", parent: "early", properties: [number("object.child.x")] },
      {
        id: "late",
        parent: "always",
        spans: [[3, 10]],
        properties: [number("object.late.x")],
      },
    ];
    const deep = clip({ id: "lives" });
    const node = clipNodeOf(deep, objects);
    const ids = (at: string) =>
      (function walk(children: readonly ClipChild[]): unknown[] {
        return children.flatMap((child) =>
          child.kind === "object" ? [child.object.id, ...walk(child.children)] : [],
        );
      })(listedClip(node, deep, filter("here", at))?.children ?? []);

    it("the clock of the clip decides, and a child goes with its parent", () => {
      // The clip starts at 2, so its clock reads 1 at 3 and 4 at 6.
      expect(ids("3")).toEqual(["always", "early", "child"]);
      expect(ids("6")).toEqual(["always", "late"]);
    });

    it("the whole list has them all", () => {
      const all = listedClip(node, deep, filter("all"));
      expect(all).toBe(node);
    });
  });

  it("the offset of a clip counts for its clock", () => {
    const objects: ObjectDescriptor[] = [
      { id: "o", spans: [[10, 11]], properties: [number("object.o.x")] },
    ];
    const late = clip({ id: "offset", offset: "9" });
    const node = clipNodeOf(late, objects);
    expect(listedClip(node, late, filter("here", "3"))).toBeDefined();
    expect(listedClip(node, late, filter("here", "4"))).toBeUndefined();
  });

  it("keys that nothing describes stay, also when their clip is somewhere else", () => {
    const orphaned = clip({ id: "orphaned", properties: { "param.old": keys("0") } });
    const node = clipNodeOf(orphaned);
    const listed = listedClip(node, orphaned, filter("here", "100"));
    expect(listed?.children).toHaveLength(1);
    expect(pathsBelow(listed as TreeNode)).toEqual(["param.old"]);
  });
});

describe("the tree of a timeline", () => {
  function timeline(): TimelineState {
    const store = ProjectStore.create(createProject({ name: "树" }));
    const main = () => store.getState().timelines["main"] as TimelineState;
    const video = orderedTracks(main()).find(({ kind }) => kind === "video")?.id as string;
    const audio = orderedTracks(main()).find(({ kind }) => kind === "audio")?.id as string;
    const add = (id: string, start: string, track: string, source: object) =>
      store.execute({
        type: "clip.add",
        params: { timeline: "main", track, clip: { id, start, duration: "2", source } },
      });
    add("late", "4", video, { kind: "color", color: "#000000" });
    add("early", "0", video, { kind: "color", color: "#000000" });
    add("sound", "0", audio, { kind: "audio", media: { asset: "a" } });
    return main();
  }

  it("has tracks with their clips in time order, and leaves out what has nothing to show", () => {
    const tree = propertyTree(timeline(), filter("all"));
    expect(tree.map(({ children }) => children.map(({ clip: id }) => id))).toEqual([
      ["early", "late"],
    ]);
  });

  it("follows the moment", () => {
    const clipsAt = (at: string) =>
      propertyTree(timeline(), filter("here", at)).flatMap(({ children }) =>
        children.map(({ clip: id }) => id),
      );
    expect(clipsAt("1")).toEqual(["early"]);
    expect(clipsAt("3")).toEqual([]);
    expect(clipsAt("5")).toEqual(["late"]);
  });
});
