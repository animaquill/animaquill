/*
 * Whether the views that show time (the timeline, the keyframe tab) scroll along with the playhead,
 * and how: a page at a time, as in Premiere, or with the playhead held in the middle, as in the
 * editors of phones. The rules are here once, and each view has a `ViewFollower` of its own.
 */

export type FollowMode = "page" | "center";

export interface FollowSetting {
  readonly on: boolean;
  readonly mode: FollowMode;
}

/** On, a page at a time: what professional editors do. */
export const DEFAULT_FOLLOW: FollowSetting = { on: true, mode: "page" };

/** Why the playhead moved, which decides what the views do about it. */
export type PlayheadCause =
  /** Playing. */
  | "playing"
  /** Keys, buttons, and moves after an edit: the views follow it as the setting says. */
  | "step"
  /** People asked to see that moment: it gets in view, also with following off. */
  | "goto"
  /** The mouse or a finger put it there, on a ruler: that view stays where it is. */
  | "pointer"
  /** In the centred way scrolling across carries time along. */
  | "scroll";

export interface PlayheadMove {
  readonly frame: number;
  readonly from: number;
  readonly cause: PlayheadCause;
  /** The view that moved it, for "pointer" and "scroll": it needs no following itself. */
  readonly by?: object | undefined;
  /** Counts moves, so that two can be told apart. */
  readonly serial: number;
}

/** Whether it plays, how fast, and when by the clock this round of playing began. */
export interface PlayState {
  readonly playing: boolean;
  readonly rate: number;
  readonly began: number;
}

/** How close to an edge the playhead can be before a page turns. Narrow views keep a quarter. */
export const FOLLOW_MARGIN = 48;
/** How long the view takes to glide back to the playhead in the centred way. */
export const GLIDE_MS = 200;

export const followMargin = (width: number): number => Math.min(FOLLOW_MARGIN, width / 4);

export interface FollowInput {
  readonly setting: FollowSetting;
  readonly cause: PlayheadCause;
  /** Where the playhead is on screen now. */
  readonly x: number;
  readonly width: number;
  readonly scrollX: number;
  /** Which way it plays, or which way it jumped. */
  readonly direction: 1 | -1;
}

/**
 * Where a view scrolls to after the playhead moved, or undefined to stay where it is. How far it
 * can go is up to the view.
 */
export function followScroll({
  setting,
  cause,
  x,
  width,
  scrollX,
  direction,
}: FollowInput): number | undefined {
  if (width <= 0) return undefined;
  const margin = followMargin(width);
  const toLeft = scrollX + x - margin;
  const toRight = scrollX + x - (width - margin);
  if (setting.on && setting.mode === "center") {
    const middle = scrollX + x - width / 2;
    return middle === scrollX ? undefined : middle;
  }
  if (!setting.on && cause !== "goto") return undefined;
  if (setting.on && cause === "playing") {
    // The whole page turns over at once, and one frame that crossed more than a page lands too.
    if (direction > 0) return x > width - margin || x < 0 ? toLeft : undefined;
    return x < margin || x > width ? toRight : undefined;
  }
  if (x >= margin && x <= width - margin) return undefined;
  // Asked to look somewhere, people see what comes after it.
  if (cause === "goto") return direction > 0 ? toLeft : toRight;
  // Pages are for playing. Anything else, such as keys or the end of what was just added, scrolls
  // just far enough that the playhead shows, so that what came before it stays in sight.
  return x < margin ? toLeft : toRight;
}

/** Something that shows time across, for its follower. */
export interface FollowedView {
  readonly width: number;
  readonly pixelsPerSecond: number;
  readonly scrollX: number;
  readonly frame: number;
  readonly fps: number;
  /** Where the playhead can go: up to the end as it looks now. */
  readonly lastFrame: number;
  /** The end, in seconds, which the centred way can bring to the middle. */
  readonly end: number;
  /** How far there is to scroll across the usual way, with the room after the end. */
  readonly contentWidth: number;
  /** Scrolls across without anything else, for the follower. The view keeps it in range. */
  placeX(scrollX: number): void;
}

/** A view out of functions that read it, which keeps whatever they read private. */
export function followedView(
  read: { readonly [Key in Exclude<keyof FollowedView, "placeX">]: () => number } & {
    readonly placeX: (scrollX: number) => void;
  },
): FollowedView {
  return {
    get width() {
      return read.width();
    },
    get pixelsPerSecond() {
      return read.pixelsPerSecond();
    },
    get scrollX() {
      return read.scrollX();
    },
    get frame() {
      return read.frame();
    },
    get fps() {
      return read.fps();
    },
    get lastFrame() {
      return read.lastFrame();
    },
    get end() {
      return read.end();
    },
    get contentWidth() {
      return read.contentWidth();
    },
    placeX: read.placeX,
  };
}

export interface FollowClock {
  now(): number;
  nextFrame(run: () => void): () => void;
}

export const browserClock: FollowClock = {
  now: () => performance.now(),
  nextFrame(run) {
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(() => run());
      return () => cancelAnimationFrame(frame);
    }
    const timer = setTimeout(run, 16);
    return () => clearTimeout(timer);
  },
};

export type ScrollOutcome =
  /** Scroll the view as usual. */
  | { readonly kind: "scroll" }
  /** The centred way: move the playhead to this frame instead, which brings the view along. */
  | { readonly kind: "scrub"; readonly frame: number }
  /** Leave it: what is left of a movement that started before this round of playing. */
  | { readonly kind: "drop" };

const easeOut = (share: number) => 1 - (1 - share) ** 3;

/**
 * Keeps one view along with the playhead. It decides, and the view scrolls: `placeX` for following,
 * and whatever `scrolled` says for what people do.
 */
export class ViewFollower {
  readonly #view: FollowedView;
  readonly #setting: () => FollowSetting;
  readonly #clock: FollowClock;
  /** The view this follows for, which a move names when it came from there. */
  readonly #owner: object;
  /** People scrolled the playhead out of sight while it played: no pages until it is back. */
  #held = false;
  /** People scrolled while it played, which `moved` looks at next. */
  #scrolledWhilePlaying = false;
  #began = Number.NEGATIVE_INFINITY;
  /** What is left of a frame after scrolling across in the centred way, in frames. */
  #remainder = 0;
  #stopGlide: (() => void) | undefined;
  /** The playhead moved while the view had no size: it gets in sight once it has one. */
  #pending = false;

  constructor(view: FollowedView, setting: () => FollowSetting, clock: FollowClock, owner: object) {
    this.#view = view;
    this.#setting = setting;
    this.#clock = clock;
    this.#owner = owner;
  }

  /** Whether the playhead is held in the middle. */
  get centred(): boolean {
    const { on, mode } = this.#setting();
    return on && mode === "center";
  }

  /** Whether the view is gliding back to the playhead. */
  get gliding(): boolean {
    return this.#stopGlide !== undefined;
  }

  /** Whether this round of playing goes on without pages, because people looked elsewhere. */
  get held(): boolean {
    return this.#held;
  }

  #x(): number {
    const view = this.#view;
    return (view.frame / view.fps) * view.pixelsPerSecond - view.scrollX;
  }

  #middle(): number {
    const view = this.#view;
    return (view.frame / view.fps) * view.pixelsPerSecond - view.width / 2;
  }

  #sized(): boolean {
    return this.#view.width > 0 && this.#view.pixelsPerSecond > 0;
  }

  #newRound(play: PlayState): void {
    if (!play.playing || play.began === this.#began) return;
    this.#began = play.began;
    this.#held = false;
    this.#scrolledWhilePlaying = false;
    this.stopGliding();
  }

  /** The playhead moved; scrolls as the setting says. */
  moved(move: PlayheadMove, play: PlayState): void {
    this.#newRound(play);
    if (move.by !== this.#owner || move.cause !== "scroll") this.#remainder = 0;
    if (!this.#sized()) {
      this.#pending = true;
      return;
    }
    this.#pending = false;
    const setting = this.#setting();
    const ownPointer = move.by === this.#owner && move.cause === "pointer";
    if (setting.on && setting.mode === "center") {
      // The ruler drag keeps the view where it is, and it glides back after.
      if (ownPointer) {
        this.stopGliding();
        return;
      }
      const jump = move.cause === "step" || move.cause === "goto";
      const far = Math.abs(this.#x() - this.#view.width / 2) > this.#view.width / 4;
      if (jump && !play.playing && far) this.#glide();
      else this.pin();
      return;
    }
    this.stopGliding();
    if (ownPointer) return;
    const playing = play.playing && move.cause === "playing";
    if (setting.on && playing) {
      const x = this.#x();
      const seen = x >= 0 && x <= this.#view.width;
      if (this.#scrolledWhilePlaying) {
        this.#scrolledWhilePlaying = false;
        if (!seen) this.#held = true;
      }
      if (this.#held) {
        if (!seen) return;
        this.#held = false;
      }
    }
    const direction = playing ? (play.rate < 0 ? -1 : 1) : move.frame >= move.from ? 1 : -1;
    this.#place(move.cause, direction);
  }

  #place(cause: PlayheadCause, direction: 1 | -1): void {
    const view = this.#view;
    const target = followScroll({
      setting: this.#setting(),
      cause,
      x: this.#x(),
      width: view.width,
      scrollX: view.scrollX,
      direction,
    });
    if (target !== undefined) view.placeX(target);
  }

  /**
   * People scrolled across by `dx` pixels, in a movement that began at `since` by the clock. Says
   * what to do with it: in the centred way that is moving the playhead.
   */
  scrolled(dx: number, since: number, play: PlayState): ScrollOutcome {
    this.#newRound(play);
    this.stopGliding();
    const setting = this.#setting();
    if (!setting.on) return { kind: "scroll" };
    // A trackpad goes on by itself after the fingers left, and that was before playing started.
    if (play.playing && since < play.began) return { kind: "drop" };
    if (setting.mode === "center") {
      const view = this.#view;
      if (!this.#sized()) return { kind: "drop" };
      const exact = view.frame + this.#remainder + (dx / view.pixelsPerSecond) * view.fps;
      const frame = Math.round(exact);
      const kept = Math.min(Math.max(frame, 0), Math.max(view.lastFrame, 0));
      this.#remainder = kept === frame ? exact - frame : 0;
      return { kind: "scrub", frame: kept };
    }
    if (play.playing) this.#scrolledWhilePlaying = true;
    return { kind: "scroll" };
  }

  /** A press on the view let go: after a drag on the ruler in the centred way it glides back. */
  released(play: PlayState): void {
    if (!this.centred || !this.#sized()) return;
    if (play.playing) this.pin();
    else if (Math.abs(this.#x() - this.#view.width / 2) > 0.5) this.#glide();
  }

  /** A press on the view: whatever glides stops where it is. */
  pressed(): void {
    this.stopGliding();
  }

  /** The view has a new size. */
  resized(): void {
    if (!this.#sized()) return;
    if (this.#pending) this.catchUp();
    else if (this.centred) this.pin();
  }

  /** Brings the playhead in sight as the setting says, as after a time out of view. */
  catchUp(): void {
    this.#pending = false;
    if (!this.#sized()) {
      this.#pending = true;
      return;
    }
    const setting = this.#setting();
    if (!setting.on) return;
    if (setting.mode === "center") this.pin();
    else this.#place("step", 1);
  }

  /** The setting changed from `before`. */
  changed(before: FollowSetting): void {
    const now = this.#setting();
    const wasCentred = before.on && before.mode === "center";
    if (this.centred && !wasCentred && this.#sized()) this.#glide();
    if (!this.centred) this.stopGliding();
    this.#held = false;
    this.#remainder = 0;
    if (now.on && now.mode === "page" && !before.on) this.catchUp();
  }

  /** The x to zoom around, given where people asked. */
  zoomCenter(asked: number, play: PlayState): number {
    if (!this.#sized()) return asked;
    if (this.centred) {
      this.stopGliding();
      return this.#view.width / 2;
    }
    const { on } = this.#setting();
    const x = this.#x();
    if (on && play.playing && x >= 0 && x <= this.#view.width) return x;
    return asked;
  }

  /** How far across it can scroll: below 0 and past the end in the centred way. */
  range(): { readonly min: number; readonly max: number } {
    const view = this.#view;
    if (this.centred) {
      const min = -view.width / 2;
      return { min, max: Math.max(view.end * view.pixelsPerSecond - view.width / 2, min) };
    }
    return { min: 0, max: Math.max(view.contentWidth - view.width, 0) };
  }

  /** Playing started: whatever was held or gliding stops, and the centred way holds it right away. */
  started(play: PlayState): void {
    this.#newRound(play);
    if (this.centred && this.#sized()) this.pin();
  }

  /** In the centred way, puts the playhead in the middle right away. */
  pin(): void {
    this.stopGliding();
    if (!this.centred || !this.#sized()) return;
    const middle = this.#middle();
    if (middle !== this.#view.scrollX) this.#view.placeX(middle);
  }

  stopGliding(): void {
    this.#stopGlide?.();
    this.#stopGlide = undefined;
  }

  /** Eases the view to the playhead, wherever it goes meanwhile. A new glide starts from here. */
  #glide(): void {
    this.stopGliding();
    const view = this.#view;
    const from = view.scrollX;
    const start = this.#clock.now();
    const step = () => {
      const share = Math.min((this.#clock.now() - start) / GLIDE_MS, 1);
      const target = this.#middle();
      view.placeX(from + (target - from) * easeOut(share));
      if (share >= 1) this.#stopGlide = undefined;
      else this.#stopGlide = this.#clock.nextFrame(step);
    };
    this.#stopGlide = this.#clock.nextFrame(step);
  }
}
