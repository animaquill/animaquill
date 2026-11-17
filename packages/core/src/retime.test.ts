import { Animation, EASE_PRESET_NAMES, createProject, type Key } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { compileChannel, sample } from "./curve.ts";
import { orderedTracks } from "./model.ts";
import { applyEdit } from "./property-edit.ts";
import { retimeKeys, reversedPreset } from "./retime.ts";
import { ProjectStore } from "./store.ts";

function setup() {
  const store = ProjectStore.create(createProject({ name: "伸缩" }));
  const main = () => {
    const timeline = store.getState().timelines["main"];
    if (!timeline) throw new Error("no timeline");
    return timeline;
  };
  const track = orderedTracks(main()).find(({ kind }) => kind === "video")?.id as string;
  const run = (type: string, params: object) => {
    const result = store.execute({ type, params });
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
    return result;
  };
  run("clip.add", {
    timeline: "main",
    track,
    id: "c",
    start: "0",
    duration: "10",
    source: { kind: "color", color: "#ff0000" },
  });
  const owner = { clip: "c" };
  const edit = (...edits: readonly object[]) =>
    store.execute({ type: "property.edit", params: { timeline: "main", edits } });
  const value = (path: string, clip = "c") => main().clips[clip]?.properties?.[path];
  const failure = (result: ReturnType<typeof edit>) => {
    if (result.ok) throw new Error("it went through");
    return result.error;
  };
  return { store, run, owner, edit, value, failure };
}

const three: Animation = {
  keys: [
    { time: "0", value: 0 },
    { time: "1", value: 10 },
    { time: "2", value: 30 },
  ],
};

const retime = (
  animation: Animation,
  times: readonly string[],
  from: readonly [string, string],
  to: readonly [string, string],
) => retimeKeys(animation, { times, from, to }, "transform.x", undefined);

const timesOf = (animation: Animation) => animation.keys.map(({ time }) => time);
const valuesOf = (animation: Animation) => animation.keys.map(({ value }) => value);

describe("retiming keys", () => {
  it("stretches, keeping the shares between them and the values", () => {
    const { value, removed } = retime(three, ["0", "1", "2"], ["0", "2"], ["0", "4"]);
    expect(timesOf(value)).toEqual(["0", "2", "4"]);
    expect(valuesOf(value)).toEqual([0, 10, 30]);
    expect(removed).toEqual([]);
  });

  it("squeezes, from the other end too", () => {
    expect(timesOf(retime(three, ["0", "1", "2"], ["0", "2"], ["0", "1"]).value)).toEqual([
      "0",
      "0.5",
      "1",
    ]);
    expect(timesOf(retime(three, ["0", "1", "2"], ["0", "2"], ["1", "2"]).value)).toEqual([
      "1",
      "1.5",
      "2",
    ]);
  });

  it("moves, which is a stretch of the same length", () => {
    expect(timesOf(retime(three, ["0", "1", "2"], ["0", "2"], ["3", "5"]).value)).toEqual([
      "3",
      "4",
      "5",
    ]);
  });

  it("is exact, also for thirds", () => {
    const { value } = retime(three, ["0", "1", "2"], ["0", "2"], ["0", "1"]);
    const again = retime(value, ["0", "0.5", "1"], ["0", "3"], ["0", "1"]).value;
    expect(timesOf(again)).toEqual(["0", "1/6", "1/3"]);
  });

  it("reverses when the order turns around: the keys and their values go the other way", () => {
    const { value } = retime(three, ["0", "1", "2"], ["0", "2"], ["2", "0"]);
    expect(timesOf(value)).toEqual(["0", "1", "2"]);
    expect(valuesOf(value)).toEqual([30, 10, 0]);
  });

  it("only moves the keys it is asked to, and a key where one lands gives way", () => {
    const four: Animation = { keys: [...three.keys, { time: "4", value: 99 }] };
    const { value, removed } = retime(four, ["0", "1", "2"], ["0", "2"], ["0", "4"]);
    expect(timesOf(value)).toEqual(["0", "2", "4"]);
    expect(valuesOf(value)).toEqual([0, 10, 30]);
    expect(removed).toEqual(["4"]);
    // One that is passed over stays.
    const five: Animation = { keys: [...three.keys, { time: "3", value: 99 }] };
    const passed = retime(five, ["0", "1", "2"], ["0", "2"], ["0", "4"]);
    expect(timesOf(passed.value)).toEqual(["0", "2", "3", "4"]);
    expect(passed.removed).toEqual([]);
  });

  it("goes onto frames when asked, the nearest one, on the timeline", () => {
    // The clock of the clip is a third of a frame ahead of the timeline.
    const frames = { rate: { n: 30n, d: 1n }, shift: { n: 1n, d: 90n } };
    const { value } = retimeKeys(
      three,
      { times: ["0", "1", "2"], from: ["0", "2"], to: ["0", "2.1"], frames: true },
      "transform.x",
      frames,
    );
    // 0 → 0 is a third of a frame before frame 0 on the timeline, 1 → 1.05 is a sixth of a frame
    // past frame 31 there, 2 → 2.1 a third of a frame before frame 63.
    expect(timesOf(value)).toEqual(["1/90", "94/90", "190/90"].map(spell));
  });

  it("refuses two keys on one frame, and changes nothing", () => {
    const frames = { rate: { n: 30n, d: 1n }, shift: { n: 0n, d: 1n } };
    const close: Animation = {
      keys: [
        { time: "0", value: 0 },
        { time: "0.1", value: 1 },
        { time: "1", value: 2 },
      ],
    };
    expect(() =>
      retimeKeys(
        close,
        { times: ["0", "0.1", "1"], from: ["0", "1"], to: ["0", "1/10"], frames: true },
        "transform.x",
        frames,
      ),
    ).toThrow(expect.objectContaining({ code: "invalid-value" }));
  });
});

/** Times as the format spells them. */
function spell(text: string): string {
  const [n, d] = text.split("/").map(BigInt) as [bigint, bigint];
  const divisor = gcd(n, d);
  const [top, bottom] = [n / divisor, d / divisor];
  if (bottom === 1n) return String(top);
  return 1000000n % bottom === 0n ? String(Number(top) / Number(bottom)) : `${top}/${bottom}`;
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

describe("reversing easing", () => {
  const two = (first: Partial<Key>, second: Partial<Key> = {}): Animation => ({
    keys: [
      { time: "0", value: 0, ...first },
      { time: "2", value: 100, ...second },
    ],
  });
  const reversed = (animation: Animation) =>
    retime(animation, timesOf(animation), ["0", "2"], ["2", "0"]).value;

  it("a bezier becomes its reverse, which plays the same curve backwards", () => {
    const eased = two({ interp: "bezier", out: [0.1, 0.2] }, { in: [0.7, 0.9] });
    const back = reversed(eased);
    expect(back.keys).toEqual([
      { time: "0", value: 100, interp: "bezier", out: [0.3, 0.1] },
      { time: "2", value: 0, in: [0.9, 0.8] },
    ]);
    expectPlayedBackwards(eased, back, 0, 2);
  });

  it("a bezier that arrives the usual way leaves the usual way when reversed", () => {
    const back = reversed(two({ interp: "bezier", out: [0.42, 0] }));
    expect(back.keys).toEqual([
      { time: "0", value: 100, interp: "bezier", out: [0, 0] },
      { time: "2", value: 0, in: [0.58, 1] },
    ]);
  });

  it("presets swap in and out, both ends stay, steps jump at the other end", () => {
    const swaps = [
      ["elasticIn", "elasticOut"],
      ["elasticOut", "elasticIn"],
      ["elasticInOut", "elasticInOut"],
      ["bounceIn", "bounceOut"],
      ["bounceOut", "bounceIn"],
      ["bounceInOut", "bounceInOut"],
      ["stepsStart", "stepsEnd"],
      ["stepsEnd", "stepsStart"],
    ] as const;
    for (const [name, other] of swaps) {
      const presetParams = name.startsWith("steps")
        ? { steps: 3 }
        : name.startsWith("elastic")
          ? { amplitude: 1.5, period: 0.4 }
          : undefined;
      const eased = two({ interp: "preset", preset: name, ...(presetParams && { presetParams }) });
      const back = reversed(eased);
      expect(back.keys[0]).toEqual({
        time: "0",
        value: 100,
        interp: "preset",
        preset: other,
        ...(presetParams && { presetParams }),
      });
      expect(back.keys[1]).toEqual({ time: "2", value: 0 });
      expectPlayedBackwards(eased, back, 0, 2);
    }
  });

  it("knows the other end of every preset with a direction", () => {
    for (const name of EASE_PRESET_NAMES) {
      const other = reversedPreset(name);
      expect(reversedPreset(other)).toBe(name);
      if (name.endsWith("InOut")) expect(other).toBe(name);
      else expect(other).not.toBe(name);
    }
  });

  it("linear stays, holding still holds, a spring keeps what it is, from the other key", () => {
    expect(reversed(two({})).keys).toEqual([
      { time: "0", value: 100 },
      { time: "2", value: 0 },
    ]);
    expect(reversed(two({ interp: "hold" })).keys).toEqual([
      { time: "0", value: 100, interp: "hold" },
      { time: "2", value: 0 },
    ]);
    const spring = { stiffness: 100, damping: 10 };
    expect(reversed(two({ interp: "spring", spring })).keys).toEqual([
      { time: "0", value: 100, interp: "spring", spring },
      { time: "2", value: 0 },
    ]);
    // A preset this editor does not know stays what it is.
    expect(reversed(two({ interp: "preset", preset: "wobble" })).keys[0]).toMatchObject({
      preset: "wobble",
    });
  });

  it("reversing twice gives back exactly what was there, also handles and what is not used", () => {
    const many: Animation = {
      keys: [
        { time: "0", value: 0, in: [0.3, 0.3], interp: "bezier", out: [0.123456, 1.7] },
        { time: "0.5", value: 5, in: [0.2, -0.4], interp: "preset", preset: "bounceOut" },
        { time: "1", value: 7, in: [0.6, 0.6], interp: "hold" },
        { time: "1.5", value: 2, interp: "spring", spring: { stiffness: 50, damping: 4 } },
        { time: "2", value: 9, in: [0.25, 0.75], interp: "bezier", out: [0.9, 0.1] },
      ],
      before: "loop",
      after: "continue",
    };
    const once = reversed(many);
    expect(once).not.toEqual(many);
    expect(reversed(once)).toEqual(many);
  });

  it("turns before and after around only when all keys turn around", () => {
    const ends: Animation = { ...three, before: "loop", after: "continue" };
    const all = retime(ends, ["0", "1", "2"], ["0", "2"], ["2", "0"]).value;
    expect(all).toMatchObject({ before: "continue", after: "loop" });
    const some = retime(ends, ["0", "1"], ["0", "1"], ["1", "0"]).value;
    expect(some).toMatchObject({ before: "loop", after: "continue" });
    const one: Animation = { ...three, after: "pingpong" };
    expect(retime(one, ["0", "1", "2"], ["0", "2"], ["2", "0"]).value).toEqual({
      keys: [
        { time: "0", value: 30 },
        { time: "1", value: 10 },
        { time: "2", value: 0 },
      ],
      before: "pingpong",
    });
  });

  it("a part that turns around keeps how it goes on to the keys around it", () => {
    const run: Animation = {
      keys: [
        { time: "0", value: 0, interp: "hold" },
        { time: "1", value: 1, interp: "preset", preset: "elasticIn" },
        { time: "2", value: 2, interp: "bezier", out: [0.2, 0.4] },
        { time: "3", value: 3, in: [0.5, 0.5] },
      ],
    };
    const { value } = retime(run, ["1", "2"], ["1", "2"], ["2", "1"]);
    expect(value.keys).toEqual([
      { time: "0", value: 0, interp: "hold" },
      // What the key at 2 arrived with, it now leaves with, the other way round.
      { time: "1", value: 2, interp: "preset", preset: "elasticOut" },
      // The last of them goes on to the key at 3 as the last one did.
      { time: "2", value: 1, interp: "bezier", out: [0.2, 0.4] },
      { time: "3", value: 3, in: [0.5, 0.5] },
    ]);
  });

  it("leaves shaking as it is: it goes by the clock of the clip", () => {
    const shaking: Animation = {
      ...three,
      modifiers: [{ type: "noise", amount: 2, frequency: 3, seed: 5 }],
    };
    const { value } = retime(shaking, ["0", "1", "2"], ["0", "2"], ["2", "0"]);
    expect(value.modifiers).toEqual(shaking.modifiers);
  });
});

/** The curve of `after` in `[a, b]` is that of `before` played backwards. */
function expectPlayedBackwards(before: Animation, after: Animation, a: number, b: number) {
  const old = compileChannel(before, "number");
  const now = compileChannel(after, "number");
  if (!old || !now) throw new Error("no channel");
  for (let step = 0; step <= 40; step += 1) {
    const t = a + ((b - a) * step) / 40 + 1e-7;
    if (t >= b) continue;
    expect(sample(now, a + b - t) as number).toBeCloseTo(sample(old, t) as number, 6);
  }
}

describe("retimeKeys through property.edit", () => {
  it("writes the keys, and says which keys gave way", () => {
    const { edit, owner, value } = setup();
    const x = { owner, path: "transform.x" };
    edit({ ...x, op: "set", value: { keys: [...three.keys, { time: "4", value: 99 }] } });
    const result = edit({
      ...x,
      op: "retimeKeys",
      times: ["0", "1", "2"],
      from: ["0", "2"],
      to: ["0", "4"],
    });
    expect(result.ok && result.results).toEqual([
      { removed: [{ clip: "c", path: "transform.x", times: ["4"] }] },
    ]);
    expect(timesOf(value("transform.x") as Animation)).toEqual(["0", "2", "4"]);
    // Nothing gave way, and nothing says so.
    const again = edit({ ...x, op: "retimeKeys", times: ["4"], from: ["0", "1"], to: ["1", "2"] });
    expect(again.ok && again.results).toEqual([undefined]);
  });

  it("refuses a stretch of no length, keys that are not there, two on one frame, and before zero", () => {
    const { edit, owner, value, failure } = setup();
    const x = { owner, path: "transform.x" };
    edit({ ...x, op: "set", value: three });
    const all = { ...x, op: "retimeKeys", times: ["0", "1", "2"] };
    expect(failure(edit({ ...all, from: ["1", "1"], to: ["0", "2"] })).params).toEqual({
      rule: "retime-span",
      path: "transform.x",
    });
    expect(failure(edit({ ...all, from: ["0", "2"], to: ["3", "3"] })).params).toEqual({
      rule: "retime-span",
      path: "transform.x",
    });
    expect(
      failure(edit({ ...x, op: "retimeKeys", times: ["5"], from: ["0", "1"], to: ["0", "2"] })),
    ).toMatchObject({ code: "not-found" });
    expect(
      failure(edit({ ...all, from: ["0", "2"], to: ["0", "1/60"], frames: true })).params,
    ).toMatchObject({ rule: "keys-collide", path: "transform.x" });
    expect(failure(edit({ ...all, from: ["0", "2"], to: ["-1", "1"] })).params).toMatchObject({
      rule: "format",
    });
    expect(value("transform.x")).toEqual(three);
  });

  it("goes on frames of the project, on the clock of the clip", () => {
    const { edit, owner, value, run } = setup();
    run("clip.update", { timeline: "main", clip: "c", changes: { start: "1/60", offset: "0" } });
    const x = { owner, path: "transform.x" };
    edit({ ...x, op: "set", value: three });
    edit({
      ...x,
      op: "retimeKeys",
      times: ["0", "1", "2"],
      from: ["0", "2"],
      to: ["0", "1"],
      frames: true,
    });
    // On the timeline the clock starts half a frame in: frames are at n/30 - 1/60 on the clock.
    const times = timesOf(value("transform.x") as Animation);
    expect(times).toEqual(["1/60", "31/60", "61/60"].map(spell));
  });

  it("works across clips in one step, and undo and redo bring back exactly what was there", () => {
    const { store, edit, owner, run } = setup();
    run("clip.add", {
      timeline: "main",
      track: orderedTracks(store.getState().timelines["main"] as never).find(
        ({ kind }) => kind === "video",
      )?.id,
      id: "d",
      start: "11",
      duration: "10",
      source: { kind: "color", color: "#00ff00" },
    });
    edit(
      { owner, path: "transform.x", op: "set", value: three },
      { owner: { clip: "d" }, path: "transform.y", op: "set", value: three },
    );
    const before = structuredClone(store.getState());
    const result = edit(
      {
        owner,
        path: "transform.x",
        op: "retimeKeys",
        times: ["0", "1", "2"],
        from: ["0", "2"],
        to: ["2", "0"],
      },
      {
        owner: { clip: "d" },
        path: "transform.y",
        op: "retimeKeys",
        times: ["1"],
        from: ["0", "2"],
        to: ["2", "0"],
      },
    );
    expect(result.ok).toBe(true);
    const after = structuredClone(store.getState());
    expect(store.undo().ok).toBe(true);
    expect(store.getState()).toEqual(before);
    expect(store.redo().ok).toBe(true);
    expect(store.getState()).toEqual(after);
  });

  it("applyEdit shows the same as the command writes", () => {
    const shown = applyEdit(three, {
      op: "retimeKeys",
      times: ["1"],
      from: ["0", "2"],
      to: ["0", "4"],
    });
    expect(timesOf(shown as Animation)).toEqual(["0", "2"]);
  });
});
