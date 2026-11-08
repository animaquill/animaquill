import { REGISTRATION_LIMITS, readRegistrationText } from "@animaquill/core/registration";
import type { ObjectDescriptor } from "@animaquill/schema/properties";
import { describe, expect, it } from "vitest";
import { MESSAGE_RULES, MessageBudget } from "../budget.ts";
import type { FromScene } from "../protocol.ts";
import { ClipValues, CodeObjects } from "./content.ts";
import { REGISTRATION_EVERY_MS, RegistrationSender } from "./registering.ts";

function setup() {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const sent: FromScene[] = [];
  const said: string[] = [];
  let objects: readonly ObjectDescriptor[] = [];
  let params: Readonly<Record<string, unknown>> = {};
  let settled = true;
  const sender = new RegistrationSender(
    {
      objects: () => objects,
      elements: () => [],
      params: () => params,
      settled: () => settled,
    },
    {
      send: (message) => sent.push(message),
      report: (code, target) => said.push(`${code} ${target ?? ""}`.trim()),
      now: () => now,
      later: (run, ms) => timers.push({ at: now + ms, run }),
    },
  );
  /** Time goes on, and what was due runs. */
  const pass = (ms: number) => {
    now += ms;
    for (const timer of timers.splice(0).toSorted((a, b) => a.at - b.at)) {
      if (timer.at <= now) timer.run();
      else timers.push(timer);
    }
  };
  const registrations = () =>
    sent.flatMap((message) =>
      message.type === "objects" ? [readRegistrationText(message.registration)?.registration] : [],
    );
  return {
    sender,
    sent,
    said,
    pass,
    registrations,
    set: (next: readonly ObjectDescriptor[]) => (objects = next),
    setParams: (next: Readonly<Record<string, unknown>>) => (params = next),
    unsettle: () => (settled = false),
  };
}

const arm: ObjectDescriptor = {
  id: "arm",
  properties: [{ path: "x", type: "number", default: 0 }],
};

describe("telling the editor what was registered", () => {
  it("waits for the first frame, where code may still register", () => {
    const { sender, sent, pass, set, registrations } = setup();
    set([arm]);
    sender.changed();
    pass(5000);
    expect(sent).toEqual([]);
    sender.framesRan();
    pass(0);
    expect(registrations()).toEqual([{ objects: [arm], elements: [], complete: true, params: {} }]);
  });

  it("says what parameters it went by", () => {
    const { sender, pass, setParams, registrations } = setup();
    setParams({ "param.count": 2 });
    sender.framesRan();
    pass(0);
    expect(registrations()[0]?.params).toEqual({ "param.count": "2" });
  });

  it("goes again for a change, after a while, and not for what did not change", () => {
    const { sender, sent, pass, set } = setup();
    sender.framesRan();
    pass(0);
    set([arm]);
    sender.changed();
    pass(REGISTRATION_EVERY_MS / 2);
    expect(sent).toHaveLength(1);
    pass(REGISTRATION_EVERY_MS / 2);
    expect(sent).toHaveLength(2);
    sender.changed();
    pass(REGISTRATION_EVERY_MS * 2);
    expect(sent).toHaveLength(2);
  });

  it("is not all there is once code threw, and says so without saying all of it again", () => {
    const { sender, sent, pass, set, registrations } = setup();
    set([arm]);
    sender.framesRan();
    pass(0);
    sender.failed();
    pass(REGISTRATION_EVERY_MS);
    expect(sent.at(-1)).toEqual({ type: "objects-unsure" });
    set([arm, { ...arm, id: "leg" }]);
    sender.changed();
    pass(REGISTRATION_EVERY_MS);
    expect(registrations().at(-1)?.complete).toBe(false);
  });

  it("is not all there is when code threw before its first frame", () => {
    const { sender, pass, registrations } = setup();
    sender.failed();
    sender.framesRan();
    pass(0);
    expect(registrations()[0]?.complete).toBe(false);
  });

  it("is not all there is when it does not fit, and keeps what came first", () => {
    const { sender, said, pass, set, registrations } = setup();
    const name = "名".repeat(200);
    set(
      Array.from({ length: 2000 }, (_, i) => ({
        id: `o${i}`,
        name,
        properties: Array.from({ length: 4 }, (__, p) => ({
          path: `p${p}`,
          type: "number" as const,
          name,
          group: "g",
        })),
      })),
    );
    sender.framesRan();
    pass(0);
    const [first] = registrations();
    expect(first?.complete).toBe(false);
    expect(first?.objects.length).toBeGreaterThan(0);
    expect(first?.objects.length).toBeLessThan(2000);
    expect(said).toEqual(["object-too-many bytes"]);
  });

  it("sends all of the most there can be, the way people write it, in one go", () => {
    const { sender, sent, said, pass, set, registrations } = setup();
    // 2000 bones with 5 properties each is 10000 properties, with names and groups as a rig has.
    set(
      Array.from({ length: REGISTRATION_LIMITS.objects }, (_, i) => ({
        id: `rig.spine.chest.arm_l.bone${i}`,
        name: `左臂骨骼 ${i}`,
        parent: `rig.spine.chest.arm_l.bone${Math.max(i - 1, 0)}`,
        properties: ["x", "y", "rotation", "scale", "visible"].map((path) => ({
          path,
          type: path === "visible" ? ("boolean" as const) : ("number" as const),
          name: `属性 ${path}`,
          group: "transform",
          unit: "world",
          default: 0,
          min: -10000,
          max: 10000,
        })),
      })),
    );
    sender.framesRan();
    pass(0);
    expect(said).toEqual([]);
    const [registration] = registrations();
    expect(registration?.complete).toBe(true);
    expect(registration?.objects).toHaveLength(REGISTRATION_LIMITS.objects);
    const [message] = sent;
    expect(new MessageBudget(0).weigh(message, 0, true)).toBe("ok");
  });

  it("never sends more than a scene may, however often what it registers changes", () => {
    const { sender, sent, said, pass, set } = setup();
    const budget = new MessageBudget(0);
    let time = 0;
    const objects = (round: number) =>
      Array.from({ length: 1600 }, (_, i) => ({
        id: `rig.bone${i}`,
        name: `骨骼 ${i} ${round} ${"长".repeat(100)}`,
        properties: [{ path: "x", type: "number" as const, default: round }],
      }));
    sender.framesRan();
    for (let round = 0; round < 120; round += 1) {
      set(objects(round));
      sender.changed();
      pass(250);
      time += 250;
      for (const message of sent.splice(0)) {
        expect(budget.weigh(message, time, message.type === "objects")).toBe("ok");
      }
    }
    expect(said).toContain("object-churn");
  });
});

describe("objects that keep changing what they are", () => {
  it("stop being told after a few changes, which makes what is told not all there is", () => {
    let changes = 0;
    const objects = new CodeObjects(
      new ClipValues({}),
      () => 0,
      () => (changes += 1),
    );
    const said: string[] = [];
    const register = (round: number) =>
      objects.register("arm", { properties: { x: round } }, (code) => said.push(code));
    for (let round = 0; round < 10; round += 1) register(round);
    expect(objects.settled).toBe(false);
    expect(said).toEqual(["object-unstable"]);
    expect(changes).toBe(4);
    expect(objects.descriptors()[0]?.properties[0]?.default).toBe(3);
    // What code reads is what it said last, though.
    expect(register(11).at(0).x).toBe(11);
  });

  it("that come after the first frame make what is told not all there is", () => {
    const objects = new CodeObjects(
      new ClipValues({}),
      () => 0,
      () => {},
    );
    const said: string[] = [];
    const register = (id: string) =>
      objects.register(id, { properties: { x: 0 } }, (code, target) =>
        said.push(`${code} ${target}`),
      );
    register("arm");
    objects.firstFrameRan();
    // The same again, as code does in every frame, is nothing new.
    register("arm");
    expect(objects.settled).toBe(true);
    register("leg");
    register("tail");
    expect(objects.settled).toBe(false);
    expect(said).toEqual(["object-late leg"]);
    expect(objects.descriptors().map(({ id }) => id)).toEqual(["arm", "leg", "tail"]);
  });

  it("budget of the compositor holds for one registration of the largest kind", () => {
    const message = { type: "objects", registration: "x".repeat(1_500_000) };
    expect(new MessageBudget(0).weigh(message, 0, true)).toBe("ok");
    expect(MESSAGE_RULES.maxRegistrationBytes).toBeLessThan(MESSAGE_RULES.burstBytes);
  });
});
