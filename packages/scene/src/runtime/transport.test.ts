import { describe, expect, it } from "vitest";
import { frameAt, Transport, type TransportHooks, type Walkable } from "./transport.ts";

/** A clock that goes one frame per step, and that can be told how far back it can go. */
function setup(
  options: {
    readonly oldest?: number;
    readonly arrived?: () => Promise<void>;
    readonly fps?: number;
  } = {},
) {
  const log: string[] = [];
  let position = -1;
  const steps: number[] = [];
  const clock: Walkable = {
    get frame() {
      return position;
    },
    get stateful() {
      return options.oldest !== undefined;
    },
    step: async (target) => {
      steps.push(target);
      position += 1;
      await Promise.resolve();
    },
    rewind: (frame) => {
      if (frame < (options.oldest ?? 0)) return false;
      position = frame;
      return true;
    },
  };
  let wall = 0;
  const screen: (() => void)[] = [];
  const broken: unknown[] = [];
  const walked: number[] = [];
  const hooks: TransportHooks = {
    arrived: options.arrived ?? (() => Promise.resolve()),
    seeked: (request, frame, stateful) => log.push(`seeked ${request} ${frame} ${stateful}`),
    needsReplay: (request, frame) => log.push(`replay ${request} ${frame}`),
    position: (frame) => log.push(`position ${frame}`),
    walked: (frame) => walked.push(frame),
    wall: () => wall,
    onScreenFrame: (run) => screen.push(run),
    broke: (error) => broken.push(error),
    fps: options.fps ?? 10,
  };
  const settled = async () => {
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
  };
  return {
    transport: new Transport(clock, hooks),
    log,
    broken,
    walked,
    steps,
    settled,
    setPosition: (frame: number) => (position = frame),
    screenFrame: async (at: number) => {
      wall = at;
      const next = screen.splice(0);
      for (const run of next) run();
      await settled();
    },
    screen,
  };
}

describe("Transport", () => {
  it("walks to a frame and says so", async () => {
    const { transport, log, settled } = setup();
    transport.seek(1, 3);
    await settled();
    expect(log).toEqual(["seeked 1 3 false"]);
  });

  it("says how far it got on the way", async () => {
    const { transport, walked, settled } = setup();
    transport.seek(1, 3);
    await settled();
    expect(walked).toEqual([0, 1, 2, 3]);
  });

  it("says so as well when it is there already", async () => {
    const { transport, log, settled, setPosition } = setup();
    setPosition(3);
    transport.seek(1, 3);
    await settled();
    expect(log).toEqual(["seeked 1 3 false"]);
  });

  it("goes back when it can", async () => {
    const { transport, log, settled, setPosition } = setup();
    setPosition(10);
    transport.seek(1, 3);
    await settled();
    expect(log).toEqual(["seeked 1 3 false"]);
  });

  it("says when it cannot go back", async () => {
    const { transport, log, settled, setPosition } = setup({ oldest: 5 });
    setPosition(10);
    transport.seek(1, 3);
    await settled();
    expect(log).toEqual(["replay 1 3"]);
  });

  it("follows the latest request, and answers that one", async () => {
    const { transport, log, settled, steps } = setup();
    transport.seek(1, 100);
    await Promise.resolve();
    transport.seek(2, 2);
    await settled();
    expect(log).toEqual(["seeked 2 2 false"]);
    expect(steps.at(-1)).toBeLessThan(100);
  });

  it("turns around when a walk gets overtaken by a request behind it", async () => {
    const { transport, log, settled } = setup();
    transport.seek(1, 100);
    await Promise.resolve();
    await Promise.resolve();
    transport.seek(2, 0);
    await settled();
    expect(log).toEqual(["seeked 2 0 false"]);
  });

  it("does not answer for a frame that nobody wants any more", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const { transport, log, settled } = setup({ arrived: () => promise });
    transport.seek(1, 2);
    await settled();
    transport.seek(2, 4);
    resolve();
    await settled();
    expect(log).toEqual(["seeked 2 4 false"]);
  });

  it("tells who it is going to need a new scene for", async () => {
    const { transport, log, settled, setPosition } = setup({ oldest: 5 });
    setPosition(10);
    transport.seek(1, 20);
    await Promise.resolve();
    transport.seek(2, 1);
    await settled();
    expect(log).toEqual(["replay 2 1"]);
  });

  it("does not keep it to itself when walking fails", async () => {
    const { transport, log, broken, settled } = setup({
      arrived: () => Promise.reject(new Error("broken")),
    });
    transport.seek(1, 2);
    await settled();
    expect(log).toEqual([]);
    expect(broken).toHaveLength(1);
    transport.seek(2, 3);
    await settled();
    expect(broken).toHaveLength(2);
  });

  describe("playing", () => {
    it("works out the frame from the base", () => {
      expect(frameAt({ frame: 10, at: 1000, rate: 1 }, 1000, 60)).toBe(10);
      expect(frameAt({ frame: 10, at: 1000, rate: 1 }, 2000, 60)).toBe(70);
      expect(frameAt({ frame: 10, at: 1000, rate: 2 }, 2000, 60)).toBe(130);
      expect(frameAt({ frame: 0, at: 0, rate: 1 }, 16, 60)).toBe(0);
      expect(frameAt({ frame: 0, at: 0, rate: 1 }, 17, 60)).toBe(1);
    });

    it("follows the time on frames of the screen, and says where it is", async () => {
      const { transport, log, screenFrame, setPosition } = setup();
      setPosition(0);
      transport.play({ frame: 0, at: 0, rate: 1 });
      await screenFrame(300);
      await screenFrame(500);
      expect(log).toEqual(["position 3", "position 5"]);
    });

    it("does nothing while the frame has not changed", async () => {
      const { transport, log, screenFrame, setPosition } = setup();
      setPosition(0);
      transport.play({ frame: 0, at: 0, rate: 1 });
      await screenFrame(50);
      await screenFrame(90);
      expect(log).toEqual([]);
    });

    it("stops when paused", async () => {
      const { transport, log, screenFrame, screen, setPosition } = setup();
      setPosition(0);
      transport.play({ frame: 0, at: 0, rate: 1 });
      await screenFrame(100);
      transport.pause();
      await screenFrame(1000);
      expect(log).toEqual(["position 1"]);
      expect(screen).toHaveLength(0);
    });

    it("takes a new base without starting a second loop", async () => {
      const { transport, screen, setPosition, screenFrame } = setup();
      setPosition(0);
      transport.play({ frame: 0, at: 0, rate: 1 });
      transport.play({ frame: 0, at: 100, rate: 1 });
      await screenFrame(100);
      expect(screen).toHaveLength(1);
    });

    it("keeps one loop, however often it starts and stops", async () => {
      const { transport, screen, setPosition, screenFrame } = setup();
      setPosition(0);
      const base = { frame: 0, at: 0, rate: 1 };
      transport.play(base);
      transport.pause();
      transport.play(base);
      transport.pause();
      transport.play(base);
      expect(screen).toHaveLength(1);
      await screenFrame(100);
      expect(screen).toHaveLength(1);
    });

    it("waits for a correction backwards to pass, and does not jump", async () => {
      const { transport, log, screenFrame, setPosition } = setup();
      setPosition(5);
      transport.play({ frame: 3, at: 0, rate: 1 });
      await screenFrame(100);
      expect(log).toEqual([]);
      await screenFrame(300);
      expect(log).toEqual(["position 6"]);
    });

    it("answers a seek for the frame it asked for, also when playing starts right after it", async () => {
      let done = () => {};
      const arrived = () => new Promise<void>((resolve) => (done = resolve));
      const { transport, log, settled, screenFrame } = setup({ arrived });
      transport.seek(1, 3);
      transport.play({ frame: 3, at: 0, rate: 1 });
      await settled();
      await screenFrame(1000);
      done();
      await settled();
      expect(log).toEqual(["seeked 1 3 false"]);
      await screenFrame(2000);
      done();
      await settled();
      expect(log).toEqual(["seeked 1 3 false", "position 23"]);
    });

    it("says where it is, also with the next frame already wanted when it gets there", async () => {
      let done = () => {};
      const arrived = () => new Promise<void>((resolve) => (done = resolve));
      const { transport, log, settled, screenFrame } = setup({ arrived });
      transport.play({ frame: 0, at: 0, rate: 1 });
      await screenFrame(100);
      await screenFrame(200);
      await settled();
      done();
      await settled();
      expect(log).toEqual(["position 1"]);
    });

    it("stops playing for a seek", async () => {
      const { transport, log, screenFrame, settled, setPosition } = setup();
      setPosition(0);
      transport.play({ frame: 0, at: 0, rate: 1 });
      transport.seek(1, 2);
      await settled();
      await screenFrame(1000);
      expect(log).toEqual(["seeked 1 2 false"]);
    });

    it("takes no time at all as a reason to stand still", async () => {
      const { transport, screen } = setup();
      transport.play({ frame: 0, at: 0, rate: 0 });
      expect(screen).toHaveLength(0);
    });
  });

  describe("drawing a frame again", () => {
    it("gets there again where it stands, and tells nobody it was asked", async () => {
      let arrivals = 0;
      const { transport, log, settled, setPosition } = setup({
        arrived: async () => void (arrivals += 1),
      });
      setPosition(4);
      transport.refresh();
      await settled();
      expect(arrivals).toBe(1);
      expect(log).toEqual(["position 4"]);
    });

    it("is nothing before the first frame, or while playing", async () => {
      let arrivals = 0;
      const { transport, settled, setPosition } = setup({
        arrived: async () => void (arrivals += 1),
      });
      transport.refresh();
      await settled();
      expect(arrivals).toBe(0);
      setPosition(0);
      transport.play({ frame: 0, at: 0, rate: 1 });
      transport.refresh();
      await settled();
      expect(arrivals).toBe(0);
    });

    it("on the way somewhere, gets there once more, with what changed on the way", async () => {
      const drawn: number[] = [];
      let value = 1;
      let release: () => void = () => {};
      const { transport, settled, setPosition, log } = setup({
        arrived: () => {
          drawn.push(value);
          return new Promise<void>((done) => (release = done));
        },
      });
      setPosition(4);
      transport.seek(1, 4);
      await settled();
      // The value changes after the frame read it, while it is still on its way to the screen.
      value = 2;
      transport.refresh();
      transport.refresh();
      release();
      await settled();
      release();
      await settled();
      expect(drawn).toEqual([1, 2]);
      expect(log).toEqual(["seeked 1 4 false", "position 4"]);
    });
  });
});
