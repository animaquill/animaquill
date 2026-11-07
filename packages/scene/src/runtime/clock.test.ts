import { describe, expect, it, vi } from "vitest";
import { SceneClock, type ClockHooks } from "./clock.ts";

function clockAt(fps = 60, hooks: Partial<ClockHooks> = {}, den = 1) {
  const failures: unknown[] = [];
  const clock = new SceneClock(
    { num: fps, den },
    {
      turn: () => Promise.resolve(),
      settle: () => {},
      due: () => undefined,
      announce: () => Promise.resolve(false),
      failed: (error) => failures.push(error),
      ...hooks,
    },
  );
  return { clock, failures };
}

async function walk(clock: SceneClock, frame: number) {
  while (clock.frame < frame) await clock.step(frame);
}

describe("SceneClock", () => {
  it("stands still until somebody moves it", () => {
    const { clock } = clockAt();
    expect(clock.frame).toBe(-1);
    expect(clock.now).toBe(0);
    expect(clock.stateful).toBe(false);
  });

  it("computes a moment from its frame, without adding anything up", async () => {
    const { clock } = clockAt(60);
    expect(clock.momentOf(60)).toBe(1000);
    expect(clock.momentOf(6)).toBe(100);
    expect(clock.momentOf(60 * 3600)).toBe(3600000);
    let added = 0;
    for (let frame = 0; frame < 60; frame += 1) added += 1000 / 60;
    expect(added).not.toBe(1000);
    const seen: number[] = [];
    const loop = (time: number) => {
      seen.push(time);
      clock.requestFrame(loop);
    };
    clock.requestFrame(loop);
    await walk(clock, 60);
    expect(seen.at(-1)).toBe(1000);
    expect(seen).toHaveLength(61);
  });

  it("gets a fractional rate exactly right", () => {
    const { clock } = clockAt(30000, {}, 1001);
    expect(clock.momentOf(30000)).toBe(1001000);
    expect(clock.momentOf(30)).toBe(1001);
  });

  it("a timer due exactly on a frame runs on that frame, and not the next", async () => {
    const { clock } = clockAt(60);
    const frames: number[] = [];
    clock.setTimer(() => frames.push(clock.now), 1000, false);
    await walk(clock, 59);
    expect(frames).toEqual([]);
    await walk(clock, 60);
    expect(frames).toEqual([1000]);
  });

  it("runs timers at their own moment, in order", async () => {
    const { clock } = clockAt(10);
    const log: string[] = [];
    clock.setTimer(() => log.push(`b@${clock.now}`), 150, false);
    clock.setTimer(() => log.push(`a@${clock.now}`), 120, false);
    clock.setTimer(() => log.push(`c@${clock.now}`), 150, false);
    await walk(clock, 2);
    expect(log).toEqual(["a@120", "b@150", "c@150"]);
    expect(clock.now).toBe(200);
  });

  it("repeats an interval without drifting", async () => {
    const { clock } = clockAt(60);
    const times: number[] = [];
    clock.setTimer(() => times.push(clock.now), 100, true);
    await walk(clock, 60);
    expect(times).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  });

  it("stops what is cleared, also from inside its own callback", async () => {
    const { clock } = clockAt(60);
    let runs = 0;
    const id = clock.setTimer(
      () => {
        runs += 1;
        if (runs === 3) clock.clearTimer(id);
      },
      10,
      true,
    );
    const never = clock.setTimer(() => (runs = 100), 5, false);
    clock.clearTimer(never);
    await walk(clock, 60);
    expect(runs).toBe(3);
  });

  it.each([
    [undefined, 0],
    [Number.NaN, 0],
    [-100, 0],
    ["20", 20],
    [12.9, 12],
    [Number.POSITIVE_INFINITY, 0],
  ])("reads a delay of %j like a browser", async (delay, expected) => {
    const { clock } = clockAt(1000);
    let at: number | undefined;
    clock.setTimer(() => (at = clock.now), delay as number, false);
    await walk(clock, 30);
    expect(at).toBe(expected);
  });

  it("keeps a timer that restarts itself from stopping time", async () => {
    const { clock } = clockAt(60);
    let runs = 0;
    const again = () => {
      runs += 1;
      clock.setTimer(again, 0, false);
    };
    clock.setTimer(again, 0, false);
    await walk(clock, 6);
    expect(clock.now).toBe(100);
    // The first ones run at once, and from then on they wait 4 ms each, as in a browser.
    expect(runs).toBe(5 + 25 + 1);
  });

  it("clamps an interval of 0 the same way", async () => {
    const { clock } = clockAt(60);
    let runs = 0;
    clock.setTimer(() => (runs += 1), 0, true);
    await walk(clock, 6);
    expect(runs).toBeGreaterThan(5);
    expect(runs).toBeLessThan(40);
  });

  it("counts a promise that a timer resolves as part of that timer", async () => {
    // The loop `await sleep(0)` is nested like a timer in a timer, or it would never end.
    let turn: () => void = () => {};
    const { clock } = clockAt(60, {
      turn: async () => {
        turn();
        await Promise.resolve();
      },
    });
    const sleep = () =>
      new Promise<void>((resolve) => {
        clock.setTimer(resolve, 0, false);
      });
    let continuations = 0;
    const loop = async () => {
      for (;;) {
        await sleep();
        continuations += 1;
      }
    };
    turn = () => {};
    void loop();
    await walk(clock, 6);
    expect(clock.frame).toBe(6);
    expect(continuations).toBeGreaterThan(5);
  });

  it("lets what a timer started run before the next one", async () => {
    const log: string[] = [];
    const { clock } = clockAt(60, {
      // A real turn of the event loop: all promises run.
      turn: () => new Promise((resolve) => setImmediate(resolve)),
    });
    clock.setTimer(
      () => {
        log.push("first");
        void Promise.resolve()
          .then(() => {})
          .then(() => log.push("promise of the first"));
      },
      10,
      false,
    );
    clock.setTimer(() => log.push("second"), 10, false);
    await walk(clock, 1);
    expect(log).toEqual(["first", "promise of the first", "second"]);
  });

  describe("frames", () => {
    it("runs a frame callback once, on the next frame, with its time", async () => {
      const { clock } = clockAt(10);
      const times: number[] = [];
      clock.requestFrame((time) => times.push(time));
      await walk(clock, 3);
      expect(times).toEqual([0]);
    });

    it("runs what a frame requests on the frame after that", async () => {
      const { clock } = clockAt(10);
      const times: number[] = [];
      const loop = (time: number) => {
        times.push(time);
        if (times.length < 3) clock.requestFrame(loop);
      };
      clock.requestFrame(loop);
      await walk(clock, 5);
      expect(times).toEqual([0, 100, 200]);
    });

    it("leaves out what an earlier callback of the frame cancelled", async () => {
      const { clock } = clockAt(10);
      const log: string[] = [];
      clock.requestFrame(() => {
        log.push("first");
        clock.cancelFrame(second);
      });
      const second = clock.requestFrame(() => log.push("second"));
      await walk(clock, 0);
      expect(log).toEqual(["first"]);
    });

    it("runs timers before frames, as a browser does", async () => {
      const { clock } = clockAt(10);
      const log: string[] = [];
      clock.requestFrame(() => log.push("frame"));
      clock.setTimer(() => log.push("timer"), 0, false);
      await walk(clock, 0);
      expect(log).toEqual(["timer", "frame"]);
    });

    it("stops at every frame that has a callback", async () => {
      const { clock } = clockAt(10);
      const loop = () => clock.requestFrame(loop);
      clock.requestFrame(loop);
      await clock.step(100);
      expect(clock.frame).toBe(0);
      await clock.step(100);
      expect(clock.frame).toBe(1);
    });
  });

  describe("how it gets there", () => {
    it("goes straight there when nothing is waiting", async () => {
      const { clock } = clockAt(60);
      await clock.step(3600);
      expect(clock.frame).toBe(3600);
      expect(clock.stateful).toBe(false);
    });

    it("stops only for what is due", async () => {
      const { clock } = clockAt(60);
      clock.setTimer(() => {}, 1000, false);
      await clock.step(3600);
      expect(clock.frame).toBe(60);
      await clock.step(3600);
      expect(clock.frame).toBe(3600);
    });

    it("never passes the frame it was asked for", async () => {
      const { clock } = clockAt(60);
      clock.setTimer(() => {}, 1000, false);
      await clock.step(10);
      expect(clock.frame).toBe(10);
      expect(clock.waiting).toBe(true);
    });

    it("stops for what the page says is due", async () => {
      let due: number | undefined = 500;
      let settled = 0;
      const told: number[] = [];
      const { clock } = clockAt(60, {
        settle: () => (settled += 1),
        due: () => due,
        announce: () => {
          told.push(clock.frame);
          const happened = clock.now >= 500 && due !== undefined;
          if (happened) due = undefined;
          return Promise.resolve(happened);
        },
      });
      await clock.step(600);
      expect(clock.frame).toBe(30);
      expect(clock.stateful).toBe(true);
      expect(settled).toBe(2);
      await clock.step(600);
      expect(clock.frame).toBe(600);
      expect(told).toEqual([30, 600]);
    });

    it("keeps things in place after everything that moves them", async () => {
      const settled: string[] = [];
      const { clock } = clockAt(10, {
        settle: () => settled.push(String(clock.now)),
      });
      clock.setTimer(() => {}, 50, false);
      clock.requestFrame(() => {});
      await walk(clock, 1);
      // Frame 0, then the timer at 50, frame 1.
      expect(settled).toEqual(["0", "0", "50", "100"]);
    });

    it("does the same however it is asked to go", async () => {
      const run = async (stops: readonly number[]) => {
        const { clock } = clockAt(60);
        const log: string[] = [];
        let x = 0;
        const loop = (time: number) => {
          x += 1;
          log.push(`f${time.toFixed(3)}:${x}`);
          clock.requestFrame(loop);
        };
        clock.requestFrame(loop);
        clock.setTimer(() => log.push(`t${clock.now}`), 700, true);
        for (const stop of stops) await walk(clock, stop);
        return log;
      };
      const direct = await run([300]);
      expect(await run([1, 2, 3, 100, 299, 300])).toEqual(direct);
      expect(await run([150, 300])).toEqual(direct);
    });
  });

  describe("going back", () => {
    it("can go anywhere as long as no code ran", async () => {
      const { clock } = clockAt(60);
      await clock.step(100);
      expect(clock.rewind(10)).toBe(true);
      expect(clock.frame).toBe(10);
      expect(clock.now).toBe(clock.momentOf(10));
    });

    it("goes back as far as the last code that ran", async () => {
      const { clock } = clockAt(10);
      clock.setTimer(() => {}, 1000, false);
      await walk(clock, 50);
      expect(clock.rewind(30)).toBe(true);
      expect(clock.rewind(10)).toBe(true);
      expect(clock.rewind(9)).toBe(false);
      expect(clock.frame).toBe(10);
    });

    it("never goes back through a frame callback", async () => {
      const { clock } = clockAt(10);
      const loop = () => clock.requestFrame(loop);
      clock.requestFrame(loop);
      await walk(clock, 5);
      expect(clock.rewind(4)).toBe(false);
      expect(clock.stateful).toBe(true);
    });

    it("runs what is still due when time comes back to it", async () => {
      const { clock } = clockAt(10);
      const seen: number[] = [];
      clock.setTimer(() => seen.push(clock.now), 2000, false);
      await walk(clock, 10);
      expect(clock.rewind(5)).toBe(true);
      await walk(clock, 30);
      expect(seen).toEqual([2000]);
    });
  });

  it("hands on what code throws and keeps going", async () => {
    const { clock, failures } = clockAt(10);
    const after = vi.fn();
    clock.setTimer(
      () => {
        throw new Error("in a timer");
      },
      0,
      false,
    );
    clock.requestFrame(() => {
      throw new Error("in a frame");
    });
    clock.requestFrame(after);
    await walk(clock, 1);
    expect(failures.map((error) => (error as Error).message)).toEqual(["in a timer", "in a frame"]);
    expect(after).toHaveBeenCalledOnce();
    expect(clock.frame).toBe(1);
  });
});
