import { describe, expect, it } from "vitest";
import { REGISTRATION_LIMITS } from "@animaquill/core/registration";
import { isRegistration, readFromScene, readSamples, readSoundFailure } from "./protocol.ts";

const problem = { kind: "error", message: "boom", file: "a.js", line: 3, column: 7, frame: 12 };

describe("readFromScene", () => {
  it.each([
    [{ type: "hello", runtime: 1, capture: true }],
    [{ type: "ready", width: 1920, height: 1080 }],
    [{ type: "failed", message: "no" }],
    [{ type: "seeked", request: 3, frame: 7, stateful: false }],
    [{ type: "needs-replay", request: 3, frame: 7 }],
    [{ type: "position", frame: 7 }],
    [{ type: "progress", frame: 7 }],
    [{ type: "problem", problem }],
    [{ type: "pong", nonce: 9 }],
    [{ type: "objects", registration: '{"objects":[],"elements":[],"complete":true}' }],
    [{ type: "objects-unsure" }],
  ])("takes %j", (message) => {
    expect(readFromScene(message)).toEqual(message);
  });

  it.each([
    { type: "objects" },
    { type: "objects", registration: { objects: [], elements: [] } },
    { type: "objects", registration: " ".repeat(REGISTRATION_LIMITS.text + 1) },
  ])("takes no registration that is no text of a size that it can have, as in %j", (message) => {
    expect(readFromScene(message)).toBeUndefined();
  });

  it("tells a registration by its type, which is all it reads", () => {
    expect(isRegistration({ type: "objects" })).toBe(true);
    expect(isRegistration({ type: "frame" })).toBe(false);
    expect(isRegistration("objects")).toBe(false);
  });

  it.each([
    [undefined],
    [null],
    ["hello"],
    [7],
    [[]],
    [{}],
    [{ type: "nothing" }],
    [{ type: "constructor" }],
    [{ type: "hello" }],
    [{ type: "hello", runtime: "1" }],
    [{ type: "ready", width: Number.NaN, height: 1 }],
    [{ type: "seeked", request: 1.5, frame: 1 }],
    [{ type: "seeked", request: 1, frame: Number.POSITIVE_INFINITY }],
    [{ type: "needs-replay", request: 1 }],
    [{ type: "position", frame: "7" }],
    [{ type: "position", frame: -5 }],
    [{ type: "progress", frame: -1 }],
    [{ type: "seeked", request: -1, frame: 1 }],
    [{ type: "seeked", request: 1, frame: -9 }],
    [{ type: "needs-replay", request: 1, frame: -9 }],
    [{ type: "pong", nonce: -1 }],
    [{ type: "problem", problem: { ...problem, frame: -1 } }],
    [{ type: "problem", problem: "boom" }],
    [{ type: "problem", problem: { ...problem, kind: "anything" } }],
    [{ type: "problem", problem: { ...problem, frame: undefined } }],
    [{ type: "pong" }],
  ])("drops %j", (message) => {
    expect(readFromScene(message)).toBeUndefined();
  });

  it("drops a place that cannot be one", () => {
    const read = readFromScene({ type: "problem", problem: { ...problem, line: -7, column: -2 } });
    const { line: _, column: __, ...rest } = problem;
    expect(read).toEqual({ type: "problem", problem: rest });
  });

  it("keeps only what it knows", () => {
    const read = readFromScene({ type: "pong", nonce: 1, extra: {}, code: "x" });
    expect(read).toEqual({ type: "pong", nonce: 1 });
    const message = { type: "problem", problem: { ...problem, extra: 1, line: "3" } };
    const { line: _, ...rest } = problem;
    expect(readFromScene(message)).toEqual({ type: "problem", problem: rest });
  });

  it("does not let a scene send a novel", () => {
    const long = "x".repeat(1_000_000);
    const read = readFromScene({
      type: "problem",
      problem: { ...problem, message: long, stack: long, target: long, file: long, code: long },
    });
    expect(JSON.stringify(read).length).toBeLessThan(20000);
    const failed = readFromScene({ type: "failed", message: long });
    expect(JSON.stringify(failed).length).toBeLessThan(3000);
  });

  it("does not take what a scene claims as a capability", () => {
    expect(readFromScene({ type: "hello", runtime: 1, capture: "yes" })).toEqual({
      type: "hello",
      runtime: 1,
      capture: false,
    });
  });
});

describe("readSamples", () => {
  const asked = { maxChannels: 2, frames: 100 };
  const message = (channels: unknown, frames: unknown, bytes: number) => ({
    type: "samples",
    channels,
    frames,
    samples: new Blob([new Uint8Array(bytes)]),
  });

  it("takes what was asked for, without reading it", () => {
    const { samples } = message(2, 100, 800);
    expect(readSamples({ type: "samples", channels: 2, frames: 100, samples }, asked)).toEqual({
      channels: 2,
      frames: 100,
      samples,
    });
  });

  it("takes less than was asked for", () => {
    expect(readSamples(message(1, 10, 40), asked)?.frames).toBe(10);
  });

  it.each([
    ["no message", undefined],
    ["something else", { type: "hello" }],
    ["a size that does not fit", message(1, 100, 401)],
    ["a size that is too small", message(1, 100, 399)],
    ["more than was asked for", message(1, 101, 404)],
    ["too many channels", message(3, 10, 120)],
    ["no channels", message(0, 10, 0)],
    ["no frames", message(1, 0, 0)],
    ["parts of a sample", message(1.5, 10, 60)],
    ["a channel count that is no number", message("1", 10, 40)],
    ["frames that are no number", message(1, "10", 40)],
    ["samples that are no blob", { type: "samples", channels: 1, frames: 1, samples: "aaaa" }],
    ["samples that are an array", { ...message(1, 1, 4), samples: new Float32Array(1) }],
  ])("does not take %s", (_, data) => {
    expect(readSamples(data, asked)).toBeUndefined();
  });
});

describe("readSoundFailure", () => {
  it("knows the reasons there are", () => {
    expect(readSoundFailure("time")).toBe("time");
    expect(readSoundFailure("too-long")).toBe("too-long");
  });

  it("does not repeat what anybody can make it say", () => {
    expect(readSoundFailure("<img src=x>")).toBe("error");
    expect(readSoundFailure("constructor")).toBe("error");
  });
});
