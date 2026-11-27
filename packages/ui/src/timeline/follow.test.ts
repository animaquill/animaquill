import { describe, expect, it } from "vitest";
import {
  GLIDE_MS,
  ViewFollower,
  followScroll,
  type FollowSetting,
  type FollowedView,
  type PlayState,
  type PlayheadCause,
} from "./follow.ts";

const PAGE: FollowSetting = { on: true, mode: "page" };
const CENTER: FollowSetting = { on: true, mode: "center" };
const OFF: FollowSetting = { on: false, mode: "page" };

const input = (setting: FollowSetting, cause: PlayheadCause, x: number, direction: 1 | -1 = 1) => ({
  setting,
  cause,
  x,
  width: 1000,
  scrollX: 500,
  direction,
});

describe("where a view goes after the playhead moved", () => {
  it("turns a whole page at the right edge while playing, and at the left going backwards", () => {
    expect(followScroll(input(PAGE, "playing", 953))).toBe(500 + 953 - 48);
    expect(followScroll(input(PAGE, "playing", 952))).toBeUndefined();
    expect(followScroll(input(PAGE, "playing", 47, -1))).toBe(500 + 47 - 952);
    expect(followScroll(input(PAGE, "playing", 48, -1))).toBeUndefined();
  });

  it("lands where it went when one frame crossed more than a page", () => {
    expect(followScroll(input(PAGE, "playing", 3500))).toBe(500 + 3500 - 48);
    expect(followScroll(input(PAGE, "playing", -20))).toBe(500 - 20 - 48);
  });

  it("scrolls just far enough for a jump while not playing, keeping what came before in sight", () => {
    expect(followScroll(input(PAGE, "step", 2000, 1))).toBe(500 + 2000 - 952);
    expect(followScroll(input(PAGE, "step", -300, -1))).toBe(500 - 300 - 48);
    // Going back, where it went was before the view: it shows at the left.
    expect(followScroll(input(PAGE, "step", 20, 1))).toBe(500 + 20 - 48);
  });

  it("shows what comes after a place people asked to see", () => {
    expect(followScroll(input(PAGE, "goto", 2000, 1))).toBe(500 + 2000 - 48);
    expect(followScroll(input(PAGE, "goto", -300, -1))).toBe(500 - 300 - 952);
  });

  it("stays where a jump can be seen", () => {
    expect(followScroll(input(PAGE, "step", 500, 1))).toBeUndefined();
    expect(followScroll(input(PAGE, "step", 48, -1))).toBeUndefined();
  });

  it("holds the playhead in the middle the centred way, whatever moved it", () => {
    for (const cause of ["playing", "step", "goto", "scroll", "pointer"] as const) {
      expect(followScroll(input(CENTER, cause, 700))).toBe(500 + 700 - 500);
    }
    expect(followScroll(input(CENTER, "playing", 500))).toBeUndefined();
  });

  it("does nothing turned off, other than bringing what people asked for into view", () => {
    expect(followScroll(input(OFF, "playing", 2000))).toBeUndefined();
    expect(followScroll(input(OFF, "step", 2000))).toBeUndefined();
    expect(followScroll(input(OFF, "goto", 2000))).toBe(500 + 2000 - 48);
    expect(followScroll(input(OFF, "goto", 500))).toBeUndefined();
  });

  it("keeps a quarter of a narrow view as the margin", () => {
    const narrow = (width: number, x: number) =>
      followScroll({ setting: PAGE, cause: "playing", x, width, scrollX: 0, direction: 1 });
    expect(narrow(100, 76)).toBe(76 - 25);
    expect(narrow(100, 75)).toBeUndefined();
    expect(narrow(30, 23)).toBe(23 - 7.5);
    expect(narrow(0, 10)).toBeUndefined();
  });
});

/** A view of 1000 pixels at 100 pixels a second and 10 frames a second: a frame is 10 pixels. */
function viewOf(setting: { current: FollowSetting }) {
  let time = 0;
  const frames: (() => void)[] = [];
  const view = {
    width: 1000,
    pixelsPerSecond: 100,
    scrollX: 0,
    frame: 0,
    fps: 10,
    lastFrame: 1000,
    end: 100,
    contentWidth: 12_500,
    placeX(x: number) {
      const { min, max } = follower.range();
      view.scrollX = Math.min(Math.max(x, min), max);
    },
  } satisfies FollowedView & { frame: number; scrollX: number };
  const clock = {
    now: () => time,
    nextFrame(run: () => void) {
      frames.push(run);
      return () => {
        const index = frames.indexOf(run);
        if (index >= 0) frames.splice(index, 1);
      };
    },
  };
  const owner = {};
  const follower = new ViewFollower(view, () => setting.current, clock, owner);
  let serial = 0;
  const playing = (began = 0, rate = 1): PlayState => ({ playing: true, rate, began });
  const still: PlayState = { playing: false, rate: 1, began: Number.NEGATIVE_INFINITY };
  const move = (frame: number, cause: PlayheadCause, play: PlayState, by?: object) => {
    const from = view.frame;
    view.frame = frame;
    serial += 1;
    follower.moved({ frame, from, cause, by, serial }, play);
  };
  /** Lets time pass, frame by frame. */
  const pass = (milliseconds: number) => {
    const end = time + milliseconds;
    while (time < end) {
      time = Math.min(time + 16, end);
      for (const run of frames.splice(0)) run();
    }
  };
  const x = () => (view.frame / view.fps) * view.pixelsPerSecond - view.scrollX;
  return { view, follower, owner, move, pass, playing, still, x, frames };
}

describe("a view that follows the playhead", () => {
  it("stops turning pages when people scroll the playhead away while it plays", () => {
    const { view, follower, move, playing, x } = viewOf({ current: PAGE });
    move(10, "playing", playing());
    expect(follower.scrolled(3000, 1, playing()).kind).toBe("scroll");
    view.scrollX += 3000;
    move(20, "playing", playing());
    expect(follower.held).toBe(true);
    move(99, "playing", playing());
    expect(view.scrollX).toBe(3000);
    // Back in sight, it goes on from there, and turns the page at the edge again.
    move(301, "playing", playing());
    expect(follower.held).toBe(false);
    move(396, "playing", playing());
    expect(x()).toBe(48);
  });

  it("follows again when playing starts over", () => {
    const { view, follower, move, playing, x } = viewOf({ current: PAGE });
    move(10, "playing", playing());
    follower.scrolled(3000, 1, playing());
    view.scrollX += 3000;
    move(20, "playing", playing());
    expect(follower.held).toBe(true);
    follower.started(playing(500));
    expect(follower.held).toBe(false);
    move(200, "playing", playing(500));
    expect(x()).toBe(48);
  });

  it("goes on turning pages when people scroll and the playhead still shows", () => {
    const { view, follower, move, playing, x } = viewOf({ current: PAGE });
    move(10, "playing", playing());
    follower.scrolled(50, 1, playing());
    view.scrollX += 50;
    move(20, "playing", playing());
    expect(follower.held).toBe(false);
    move(200, "playing", playing());
    expect(x()).toBe(48);
  });

  it("leaves a movement alone that started before this round of playing", () => {
    const { follower, move, playing } = viewOf({ current: PAGE });
    move(10, "playing", playing(1000));
    expect(follower.scrolled(3000, 900, playing(1000)).kind).toBe("drop");
    expect(follower.held).toBe(false);
    const centred = viewOf({ current: CENTER });
    expect(centred.follower.scrolled(30, 900, playing(1000)).kind).toBe("drop");
    expect(centred.follower.scrolled(30, 1000, playing(1000)).kind).toBe("scrub");
  });

  it("moves the playhead by what scrolls across in the centred way, keeping parts of frames", () => {
    const { view, follower, still } = viewOf({ current: CENTER });
    view.frame = 50;
    expect(follower.scrolled(25, 0, still)).toEqual({ kind: "scrub", frame: 53 });
    view.frame = 53;
    let frame = 53;
    // Ten small steps of a tenth of a frame each make one frame.
    for (let step = 0; step < 10; step += 1) {
      const outcome = follower.scrolled(1, 0, still);
      if (outcome.kind === "scrub") frame = outcome.frame;
      view.frame = frame;
    }
    expect(frame).toBe(54);
  });

  it("goes no further than the timeline in the centred way", () => {
    const { view, follower, still } = viewOf({ current: CENTER });
    view.frame = 2;
    expect(follower.scrolled(-500, 0, still)).toEqual({ kind: "scrub", frame: 0 });
    view.frame = 998;
    expect(follower.scrolled(500, 0, still)).toEqual({ kind: "scrub", frame: 1000 });
  });

  it("scrolls as usual when off, and a page at a time when nothing plays", () => {
    const { follower, still } = viewOf({ current: OFF });
    expect(follower.scrolled(30, 0, still).kind).toBe("scroll");
    expect(viewOf({ current: PAGE }).follower.scrolled(30, 0, still).kind).toBe("scroll");
  });

  it("glides back to the middle after the ruler, and stops when something else happens", () => {
    const { view, follower, owner, move, pass, still, x, frames } = viewOf({ current: CENTER });
    move(100, "step", still);
    pass(GLIDE_MS);
    expect(x()).toBe(500);
    move(150, "pointer", still, owner);
    expect(x()).toBe(1000);
    follower.released(still);
    pass(GLIDE_MS / 2);
    expect(x()).toBeGreaterThan(500);
    expect(x()).toBeLessThan(1000);
    pass(GLIDE_MS);
    expect(x()).toBe(500);
    // Scrolling, zooming, a press and playing all stop it where it is.
    for (const stop of [
      () => follower.scrolled(1, 0, still),
      () => follower.zoomCenter(10, still),
      () => follower.pressed(),
      () => follower.started({ playing: true, rate: 1, began: 5 }),
    ]) {
      move(view.frame + 50, "pointer", still, owner);
      follower.released(still);
      pass(32);
      stop();
      expect(frames).toHaveLength(0);
    }
  });

  it("glides to a jump far away, and goes right to a near one", () => {
    const { follower, move, pass, still, x } = viewOf({ current: CENTER });
    move(100, "step", still);
    expect(follower.gliding).toBe(true);
    pass(GLIDE_MS);
    move(110, "step", still);
    expect(follower.gliding).toBe(false);
    expect(x()).toBe(500);
  });

  it("holds the playhead from other views right away", () => {
    const { move, still, x } = viewOf({ current: CENTER });
    move(300, "scroll", still, {});
    expect(x()).toBe(500);
    move(500, "pointer", still, {});
    expect(x()).toBe(500);
  });

  it("goes below 0 and past the end only in the centred way", () => {
    const setting = { current: PAGE };
    const { follower } = viewOf(setting);
    expect(follower.range()).toEqual({ min: 0, max: 11_500 });
    setting.current = CENTER;
    expect(follower.range()).toEqual({ min: -500, max: 9500 });
  });

  it("zooms around the playhead while it plays, and in the middle the centred way", () => {
    const setting = { current: PAGE };
    const { view, follower, still, playing } = viewOf(setting);
    view.frame = 30;
    expect(follower.zoomCenter(700, still)).toBe(700);
    expect(follower.zoomCenter(700, playing())).toBe(300);
    view.frame = 300;
    expect(follower.zoomCenter(700, playing())).toBe(700);
    setting.current = CENTER;
    expect(follower.zoomCenter(700, still)).toBe(500);
  });

  it("waits until it has a size, then catches up the way it is set", () => {
    const { view, follower, move, still, x } = viewOf({ current: PAGE });
    view.width = 0;
    move(500, "step", still);
    expect(view.scrollX).toBe(0);
    view.width = 1000;
    follower.resized();
    expect(x()).toBe(952);
  });
});
