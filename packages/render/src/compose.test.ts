import type { RenderJoin, RenderLayer, RenderPlan } from "@animaquill/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How the compositor puts transitions together, with canvases that only count what happens to
 * them: which code runs in which order on what, and how many whole pictures a frame takes.
 */

interface Run {
  readonly type: string;
  readonly use: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly canvas: unknown;
}

let runs: Run[] = [];
const canvases: FakeCanvas[] = [];

class FakeCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    canvases.push(this);
  }
  getContext() {
    // Every method does nothing, and a gradient takes its stops.
    return new Proxy(
      {},
      {
        get: (_target, key) => (key === "canvas" ? this : () => ({ addColorStop: () => {} })),
        set: () => true,
      },
    );
  }
}

vi.stubGlobal("OffscreenCanvas", FakeCanvas);
vi.mock("./transitions/built-in.ts", () => ({
  codeOf:
    (type: string) =>
    (aq: {
      canvas: unknown;
      render: (draw: (frame: Record<string, unknown>) => void) => void;
      scratch: (width: number, height: number) => unknown;
    }) =>
      aq.render((given) => {
        // A wipe takes a strip for its edge, as the real one does.
        if (type === "wipe") aq.scratch(8, given["height"] as number);
        runs.push({
          type,
          use: given["use"] as string,
          from: given["from"],
          to: given["to"],
          canvas: aq.canvas,
        });
      }),
}));

const { Composer } = await import("./compose.ts");

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  runs = [];
  canvases.length = 0;
});

const WIDTH = 3840;
const HEIGHT = 2160;

const layer = (id: string, start: number, end: number, more: Partial<RenderLayer> = {}) =>
  ({
    id,
    start,
    end,
    offset: 0,
    source: { kind: "color", color: "#ff0000" },
    fit: "fixed",
    channels: {},
    ...more,
  }) as RenderLayer;

const join = (id: string, from: string, to: string, start: number, end: number, type = "wipe") =>
  ({
    id,
    track: "t",
    from,
    to,
    how: { kind: "built-in", type },
    start,
    end,
    duration: end - start,
  }) as RenderJoin;

const edge = (type: string, start: number, end: number) => ({
  how: { kind: "built-in" as const, type },
  start,
  end,
  duration: end - start,
});

const planOf = (
  layers: readonly RenderLayer[],
  joins: readonly RenderJoin[],
  background = "#123456",
) =>
  ({
    width: WIDTH,
    height: HEIGHT,
    stage: { width: WIDTH, height: HEIGHT },
    background,
    layers,
    joins,
  }) as unknown as RenderPlan;

/** What layers a frame painted, and which of them straight onto the picture. */
let onPicture: string[] = [];

function frame(composer: InstanceType<typeof Composer>, plan: RenderPlan, seconds: number) {
  const painted: string[] = [];
  onPicture = [];
  const target = new FakeCanvas(4, 4).getContext() as unknown as CanvasRenderingContext2D;
  composer.compose(target, plan, plan.layers, seconds, (on, drawn) => {
    painted.push(drawn.id);
    if (on === target) onPicture.push(drawn.id);
    return undefined;
  });
  return painted;
}

/** Canvases as large as the picture that have their memory, as against let go. */
const whole = () => canvases.filter(({ width }) => width === WIDTH).length;

describe("joins that run into each other", () => {
  it("go one after the other as they are joined, whatever their starts and ids", () => {
    // B is all of [1, 2]: the join before it is all after its cut, the one after all before.
    const a = layer("A", 0, 1, { shows: { from: 0, to: 2 } });
    const b = layer("B", 1, 2);
    const c = layer("C", 2, 3, { shows: { from: 1, to: 3 } });
    // The second has the id that comes first, and both start at once.
    const plan = planOf([a, b, c], [join("ja", "B", "C", 1, 2), join("jb", "A", "B", 1, 2)]);
    const painted = frame(new Composer(), plan, 1.5);
    expect(painted).toEqual(["A", "B", "C"]);
    expect(runs.map(({ type, use }) => `${type} ${use}`)).toEqual(["wipe join", "wipe join"]);
    expect(runs[1]?.from).toBe(runs[0]?.canvas);
  });
});

describe("transitions at the edges of a clip and a join at once", () => {
  it("work on the picture of the clip first, and the join gets what they made", () => {
    // A comes in by pushing while its join to B is under way.
    const a = layer("A", 0, 1, { shows: { from: 0, to: 1.5 }, enter: edge("push", 0, 1) });
    const b = layer("B", 1, 2, { shows: { from: 0.5, to: 2 }, exit: edge("dip", 1.5, 2) });
    const plan = planOf([a, b], [join("j", "A", "B", 0.5, 1.5)]);
    frame(new Composer(), plan, 0.75);
    expect(runs.map(({ type, use }) => `${type} ${use}`)).toEqual(["push enter", "wipe join"]);
    expect(runs[1]?.from).toBe(runs[0]?.canvas);
    // B's own one starts later, at 1.5: on its own the picture of B goes in as it is.
    runs = [];
    frame(new Composer(), plan, 1.75);
    expect(runs.map(({ type, use }) => `${type} ${use}`)).toEqual(["dip exit"]);
  });
});

describe("the memory of transitions", () => {
  it("is as few whole pictures as a frame can take: what is done with goes back at once", () => {
    const a = layer("A", 0, 1, { shows: { from: 0, to: 1.6 }, enter: edge("push", 0, 1) });
    const b = layer("B", 1, 2, { shows: { from: 0.6, to: 2.4 } });
    const c = layer("C", 2, 3, { shows: { from: 1.4, to: 3 }, exit: edge("push", 2, 3) });
    const plan = planOf(
      [a, b, c],
      [join("j1", "A", "B", 0.6, 1.6), join("j2", "B", "C", 1.4, 2.4)],
    );
    // A join while A comes in by pushing: the picture of A goes back once the push has it.
    frame(new Composer(), plan, 0.95);
    expect(runs.map(({ type, use }) => `${type} ${use}`)).toEqual(["push enter", "wipe join"]);
    expect(whole()).toBe(3);
    // Two joins of one kind that run into each other: the second takes another canvas of that
    // code, because what the first made is its side before.
    canvases.length = 0;
    runs = [];
    frame(new Composer(), plan, 1.5);
    expect(runs.map(({ type, use }) => `${type} ${use}`)).toEqual(["wipe join", "wipe join"]);
    expect(whole()).toBe(4);
  });

  it("takes no more for a second join of another track at the same time", () => {
    const tracks = [
      layer("A", 0, 1, { shows: { from: 0, to: 1.5 } }),
      layer("B", 1, 2, { shows: { from: 0.5, to: 2 } }),
      layer("C", 0, 1, { shows: { from: 0, to: 1.5 } }),
      layer("D", 1, 2, { shows: { from: 0.5, to: 2 } }),
    ];
    const plan = planOf(tracks, [join("j1", "A", "B", 0.5, 1.5), join("j2", "C", "D", 0.5, 1.5)]);
    frame(new Composer(), plan, 1);
    expect(runs).toHaveLength(2);
    expect(whole()).toBe(3);
  });

  it("is nothing for a dissolve that is the first thing on a black picture", () => {
    const a = layer("A", 0, 1, { shows: { from: 0, to: 1.5 } });
    const b = layer("B", 1, 2, { shows: { from: 0.5, to: 2 } });
    const dissolve = join("j", "A", "B", 0.5, 1.5, "fade");
    frame(new Composer(), planOf([a, b], [dissolve], "#000000"), 1);
    expect(onPicture).toEqual(["A", "B"]);
    expect(whole()).toBe(0);
    // With something else on the picture already, its sum goes over that as one picture.
    const below = layer("below", 0, 2);
    for (const plan of [
      planOf([a, b], [dissolve], "#000001"),
      planOf([a, b], [dissolve], "#00000080"),
      planOf([below, a, b], [dissolve], "#000000"),
    ]) {
      canvases.length = 0;
      frame(new Composer(), plan, 1);
      expect(onPicture).toEqual(plan.layers.length === 3 ? ["below"] : []);
      expect(whole()).toBe(1);
    }
    // What comes after it goes onto the picture as always, and a second dissolve has a canvas.
    const c = layer("C", 0, 1, { shows: { from: 0, to: 1.5 } });
    const d = layer("D", 1, 2, { shows: { from: 0.5, to: 2 } });
    canvases.length = 0;
    const second = join("k", "C", "D", 0.5, 1.5, "fade");
    frame(new Composer(), planOf([a, b, c, d], [dissolve, second], "#000000"), 1);
    expect(onPicture).toEqual(["A", "B"]);
    expect(whole()).toBe(1);
  });

  it("is a single whole picture for a dissolve, and nothing for a fade", () => {
    const a = layer("A", 0, 1, { shows: { from: 0, to: 1.5 } });
    const b = layer("B", 1, 2, { shows: { from: 0.5, to: 2 }, exit: edge("fade", 1.5, 2) });
    const dissolve = planOf([a, b], [join("j", "A", "B", 0.5, 1.5, "fade")]);
    const composer = new Composer();
    frame(composer, dissolve, 1);
    expect(whole()).toBe(1);
    expect(runs).toEqual([]);
    frame(composer, dissolve, 1.75);
    expect(whole()).toBe(1);
  });

  it("goes for what frames stop taking, while they go on taking the rest", () => {
    const a = layer("A", 0, 1, { shows: { from: 0, to: 2 } });
    const b = layer("B", 1, 2);
    const c = layer("C", 2, 3, { shows: { from: 1, to: 3 } });
    const chain = planOf([a, b, c], [join("ja", "A", "B", 1, 2), join("jb", "B", "C", 1, 2)]);
    const composer = new Composer();
    frame(composer, chain, 1.5);
    expect(whole()).toBe(4);
    // A dissolve after that only needs one of them, and takes the same one each time.
    const dissolve = planOf([a, b], [join("j", "A", "B", 1, 2, "fade")]);
    for (let count = 0; count < 299; count += 1) frame(composer, dissolve, 1.5);
    expect(whole()).toBe(4);
    // The 300th frame in a row that did not take the others lets them go.
    frame(composer, dissolve, 1.5);
    expect(whole()).toBe(1);
  });

  it("all goes after a while without transitions, the canvases of code and its strips too", () => {
    const a = layer("A", 0, 1, { shows: { from: 0, to: 1.5 }, enter: edge("wipe", 0, 1) });
    const b = layer("B", 1, 2, { shows: { from: 0.5, to: 2 } });
    const plan = planOf([a, b], [join("j", "A", "B", 0.5, 1.5)]);
    const composer = new Composer();
    frame(composer, plan, 0.75);
    expect(canvases.filter(({ width }) => width > 0).length).toBeGreaterThan(3);
    const nothing = planOf([], []);
    for (let count = 0; count < 299; count += 1) frame(composer, nothing, 10);
    expect(whole()).toBeGreaterThan(0);
    frame(composer, nothing, 10);
    // Only the canvases these frames drew on are left: none of the compositor's.
    expect(canvases.filter(({ width }) => width > 4).length).toBe(0);
    expect(canvases.filter(({ width }) => width === 1).length).toBe(0);
  });
});
