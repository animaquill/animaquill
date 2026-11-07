/**
 * Keeps every animation of the page on the scene's clock. The browser's own timeline cannot be told
 * what time it is, so an animation stays paused as far as the browser knows, and this sets its time.
 *
 * What the project does to an animation has to keep working, so `play`, `pause` and the rest change
 * a small model of the animation here, and the real one follows on the next `sync`. Otherwise
 * `await animation.finished` would never return, because a paused animation never finishes.
 */

interface Track {
  readonly animation: Animation;
  /** The moment at which the animation's time is 0. None while it stands still. */
  origin: number | null;
  /** Its time while it stands still. */
  held: number;
  rate: number;
  /** Whether whoever waits for its end has heard. */
  told: boolean;
  finished: Finished | undefined;
}

interface Finished {
  readonly promise: Promise<Animation>;
  readonly resolve: (animation: Animation) => void;
  readonly reject: (reason: unknown) => void;
}

/** Project code that reacts to these needs them on the frame they belong to. */
const ANIMATION_EVENTS = new Set([
  "animationcancel",
  "animationend",
  "animationiteration",
  "animationstart",
  "transitioncancel",
  "transitionend",
  "transitionrun",
  "transitionstart",
]);

const SMIL = "animate, animateMotion, animateTransform, set";

/** Attributes and children are what can start an animation. Text cannot. */
const WATCH = { attributes: true, childList: true, subtree: true } as const;

function makeFinished(): Finished {
  const { promise, resolve, reject } = Promise.withResolvers<Animation>();
  // The browser does the same, or cancelling would count as an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const endOf = ({ animation }: Track) => Number(animation.effect?.getComputedTiming().endTime ?? 0);

/** How far an animation's effect has come, in a form that shows when it crossed a boundary. */
function phaseOf({ animation }: Track): string {
  const timing = animation.effect?.getComputedTiming();
  if (!timing) return "";
  const { delay = 0, endDelay = 0, currentIteration, endTime = 0, localTime } = timing;
  const time = Number(localTime ?? 0);
  if (time < delay) return "before";
  if (time >= Number(endTime) - endDelay) return "after";
  return `active ${currentIteration}`;
}

export class AnimationClock {
  readonly #now: () => number;
  readonly #tracks = new Map<Animation, Track>();
  /** Outermost SVG elements with SMIL in them, with the moment they appeared. */
  readonly #svgs = new Map<SVGSVGElement, number>();
  /** `document.getAnimations` does not look into these. */
  readonly #shadowRoots = new Set<ShadowRoot>();
  /** Those whose end somebody waits for. */
  readonly #watched = new WeakSet<Animation>();
  readonly #phases = new WeakMap<Track, string>();
  /** Records arrive between one turn of the page and the next, so both ways of hearing count. */
  readonly #observer = new MutationObserver((records) => this.#noted(records));
  #dirty = true;
  #eventsWatched = false;
  #started = false;
  readonly #real = {
    pause: Animation.prototype.pause,
    play: Animation.prototype.play,
    reverse: Animation.prototype.reverse,
    updatePlaybackRate: Animation.prototype.updatePlaybackRate,
    finish: Animation.prototype.finish,
    cancel: Animation.prototype.cancel,
    setCurrentTime: Object.getOwnPropertyDescriptor(Animation.prototype, "currentTime"),
    setRate: Object.getOwnPropertyDescriptor(Animation.prototype, "playbackRate"),
    playState: Object.getOwnPropertyDescriptor(Animation.prototype, "playState"),
  };

  constructor(now: () => number) {
    this.#now = now;
    this.#install();
  }

  /** From here on the document exists, and time counts. */
  start(): void {
    this.#started = true;
    this.#observer.observe(document, WATCH);
    this.#findShadowRoots(document);
  }

  #noted(records: readonly MutationRecord[]): void {
    if (records.length > 0) this.#dirty = true;
    for (const { addedNodes } of records) {
      for (const node of addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.shadowRoot) this.#addShadowRoot(node.shadowRoot);
        this.#findShadowRoots(node);
      }
    }
  }

  /** Those written in a page or added as HTML never went through `attachShadow`. */
  #findShadowRoots(within: ParentNode): void {
    for (const element of within.querySelectorAll("*")) {
      if (element.shadowRoot) this.#addShadowRoot(element.shadowRoot);
    }
  }

  #addShadowRoot(root: ShadowRoot): void {
    if (this.#shadowRoots.has(root)) return;
    this.#shadowRoots.add(root);
    this.#observer.observe(root, WATCH);
    this.#dirty = true;
    this.#findShadowRoots(root);
  }

  get size(): number {
    return this.#tracks.size;
  }

  /** Whether code in the project reacts to the events of CSS animations and transitions. */
  get eventsWatched(): boolean {
    return this.#eventsWatched;
  }

  /**
   * Finds what is new and puts everything where it belongs at this moment. `getAnimations` gets very
   * slow with many animations, so it only runs when the document changed.
   */
  sync(): void {
    if (!this.#started) return;
    this.#noted(this.#observer.takeRecords());
    if (this.#dirty) {
      this.#dirty = false;
      this.#collect();
    }
    this.#place();
  }

  /** The next moment somebody waits for the end of an animation. */
  due(): number | undefined {
    // Which frame an event belongs to is only known by looking at each one.
    if (this.#eventsWatched && this.#tracks.size > 0) return 0;
    let next: number | undefined;
    for (const track of this.#tracks.values()) {
      if (track.origin === null || track.told || !this.#isWatched(track)) continue;
      const end = track.origin + (track.rate > 0 ? endOf(track) / track.rate : 0);
      if (Number.isFinite(end) && (next === undefined || end < next)) next = end;
    }
    return next;
  }

  /** Tells those who wait that their animation ended. Gives whether anybody was told anything. */
  announce(): boolean {
    let told = false;
    for (const track of this.#tracks.values()) {
      if (track.told || !this.#isWatched(track) || !this.#ended(track)) continue;
      this.#tell(track);
      told = true;
    }
    return told;
  }

  /** Whether an animation passed one of the points its CSS events are about, since the last time. */
  crossedEventPoint(): boolean {
    let crossed = false;
    for (const track of this.#tracks.values()) {
      if (!(track.animation instanceof CSSAnimation || track.animation instanceof CSSTransition)) {
        continue;
      }
      const phase = phaseOf(track);
      if (this.#phases.get(track) !== phase) crossed = true;
      this.#phases.set(track, phase);
    }
    return crossed;
  }

  #isWatched({ animation }: Track): boolean {
    return this.#watched.has(animation);
  }

  #timeOf(track: Track): number {
    return track.origin === null ? track.held : (this.#now() - track.origin) * track.rate;
  }

  #ended(track: Track): boolean {
    if (track.rate === 0) return false;
    return track.rate > 0 ? this.#timeOf(track) >= endOf(track) : this.#timeOf(track) <= 0;
  }

  #tell(track: Track): void {
    track.told = true;
    const { animation } = track;
    track.finished?.resolve(animation);
    animation.dispatchEvent(
      new AnimationPlaybackEvent("finish", {
        currentTime: this.#timeOf(track),
        timelineTime: this.#now(),
      }),
    );
  }

  #adopt(animation: Animation): Track {
    // One that nobody started yet is not running either.
    const held = animation.playState !== "running";
    const time = Number(this.#real.setCurrentTime?.get?.call(animation) ?? 0);
    this.#real.pause.call(animation);
    const track: Track = {
      animation,
      origin: held ? null : this.#now(),
      held: held ? time : 0,
      rate: animation.playbackRate,
      told: false,
      finished: undefined,
    };
    this.#tracks.set(animation, track);
    return track;
  }

  /** Scroll timelines have nothing to do with time, and nothing here should touch them. */
  #follows(animation: Animation): boolean {
    return animation.timeline instanceof DocumentTimeline;
  }

  #collect(): void {
    // This brings the styles up to date, so it has to come before anything that goes by them.
    const found = [document, ...this.#shadowRoots].flatMap((root) => root.getAnimations());
    for (const [animation, track] of this.#tracks) {
      // The browser cancels a CSS animation when its class goes away. Setting its time would bring
      // it back from the dead, this time as something that nothing can remove.
      if (this.#real.playState?.get?.call(animation) === "idle") {
        track.finished?.reject(new DOMException("The animation was aborted", "AbortError"));
        this.#tracks.delete(animation);
      } else {
        // A removed element stays in memory as long as its animation is held on to here.
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (target && !target.isConnected) this.#tracks.delete(animation);
      }
    }
    for (const animation of found) {
      if (!this.#tracks.has(animation) && this.#follows(animation)) this.#adopt(animation);
    }
    for (const svg of document.querySelectorAll("svg")) {
      if (svg.ownerSVGElement || this.#svgs.has(svg) || !svg.querySelector(SMIL)) continue;
      svg.pauseAnimations();
      this.#svgs.set(svg, this.#now());
    }
    for (const svg of this.#svgs.keys()) if (!svg.isConnected) this.#svgs.delete(svg);
    for (const root of this.#shadowRoots) if (!root.isConnected) this.#shadowRoots.delete(root);
  }

  #place(): void {
    const setTime = this.#real.setCurrentTime?.set;
    for (const track of this.#tracks.values()) {
      const time = this.#timeOf(track);
      // Project code can write anything into a start time, and the browser would throw on that.
      if (Number.isFinite(time)) setTime?.call(track.animation, time);
    }
    const now = this.#now();
    for (const [svg, born] of this.#svgs) svg.setCurrentTime((now - born) / 1000);
  }

  #setRate(track: Track, rate: number): void {
    const time = this.#timeOf(track);
    track.rate = rate;
    this.#real.setRate?.set?.call(track.animation, rate);
    if (track.origin !== null) this.#run(track, time);
    track.told = false;
  }

  /** Starts running from a given time of the animation. */
  #run(track: Track, time: number): void {
    if (track.rate === 0) {
      track.origin = null;
      track.held = time;
    } else {
      track.origin = this.#now() - time / track.rate;
    }
  }

  /** What `play` does at the ends of an animation. */
  #replay(track: Track, time: number): void {
    const end = endOf(track);
    let from = time;
    if (track.rate > 0 && (time < 0 || time >= end)) from = 0;
    if (track.rate < 0 && (time <= 0 || time > end)) from = end;
    this.#run(track, from);
    if (track.told) track.finished = undefined;
    track.told = false;
  }

  /** What code does to an animation goes to the model, and the real one follows on `sync`. */
  #install(): void {
    const { prototype } = Animation;
    const real = this.#real;
    const trackOf = (animation: Animation) => this.#tracks.get(animation);
    const adopted = (animation: Animation) =>
      this.#follows(animation) ? (trackOf(animation) ?? this.#adopt(animation)) : undefined;

    const method = <T extends unknown[]>(
      name: "cancel" | "finish" | "pause" | "play" | "reverse" | "updatePlaybackRate",
      run: (animation: Animation, ...args: T) => void,
    ) => {
      prototype[name] = function onClock(this: Animation, ...args: T) {
        run(this, ...args);
      } as never;
    };

    method("pause", (animation) => {
      const track = adopted(animation);
      if (!track) {
        real.pause.call(animation);
        return;
      }
      track.held = this.#timeOf(track);
      track.origin = null;
    });
    method("play", (animation) => {
      const track = adopted(animation);
      if (track) this.#replay(track, this.#timeOf(track));
      else real.play.call(animation);
    });
    method("reverse", (animation) => {
      const track = adopted(animation);
      if (!track) {
        real.reverse.call(animation);
        return;
      }
      const time = this.#timeOf(track);
      track.rate = -track.rate;
      real.setRate?.set?.call(animation, track.rate);
      this.#replay(track, time);
    });
    method("updatePlaybackRate", (animation, rate: number) => {
      const track = adopted(animation);
      if (track) this.#setRate(track, rate);
      else real.updatePlaybackRate.call(animation, rate);
    });
    method("finish", (animation) => {
      const track = trackOf(animation);
      const end = track && endOf(track);
      // The browser has its own way of saying no to this.
      if (!track || track.rate === 0 || (track.rate > 0 && end === Number.POSITIVE_INFINITY)) {
        real.finish.call(animation);
        return;
      }
      track.held = track.rate > 0 ? Number(end) : 0;
      track.origin = null;
      if (!track.told) this.#tell(track);
    });
    method("cancel", (animation) => {
      const track = trackOf(animation);
      real.cancel.call(animation);
      if (!track) return;
      this.#tracks.delete(animation);
      track.finished?.reject(new DOMException("The animation was aborted", "AbortError"));
    });

    const accessor = (
      name: keyof Animation,
      get: (track: Track) => unknown,
      set?: (track: Track, value: never) => void,
    ) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      Object.defineProperty(prototype, name, {
        ...descriptor,
        get(this: Animation) {
          const track = trackOf(this);
          return track ? get(track) : descriptor?.get?.call(this);
        },
        set(this: Animation, value: never) {
          const track = set && (value === null ? trackOf(this) : adopted(this));
          if (track) set?.(track, value);
          else descriptor?.set?.call(this, value);
        },
      });
    };

    accessor(
      "currentTime",
      (track) => {
        const time = this.#timeOf(track);
        if (!this.#ended(track)) return time;
        return track.rate > 0 ? endOf(track) : 0;
      },
      (track, value: number) => {
        if (track.origin === null) track.held = value;
        else this.#run(track, value);
        track.told = false;
      },
    );
    accessor(
      "startTime",
      (track) => track.origin,
      (track, value: number | null) => {
        if (value === null) track.held = this.#timeOf(track);
        track.origin = value;
        track.told = false;
      },
    );
    accessor(
      "playbackRate",
      (track) => track.rate,
      (track, value: number) => this.#setRate(track, value),
    );
    accessor("pending", () => false);
    accessor("ready", (track) => Promise.resolve(track.animation));
    accessor("playState", (track) => {
      if (this.#ended(track)) return "finished";
      return track.origin === null ? "paused" : "running";
    });
    accessor("finished", (track) => {
      this.#watched.add(track.animation);
      track.finished ??= makeFinished();
      if (track.told) track.finished.resolve(track.animation);
      return track.finished.promise;
    });

    const watch = (animation: Animation) => this.#watched.add(animation);
    const onfinish = Object.getOwnPropertyDescriptor(prototype, "onfinish");
    Object.defineProperty(prototype, "onfinish", {
      ...onfinish,
      set(this: Animation, value: Animation["onfinish"]) {
        watch(this);
        onfinish?.set?.call(this, value);
      },
    });
    prototype.addEventListener = function addEventListener(
      this: Animation,
      type: string,
      ...rest: [EventListenerOrEventListenerObject, (boolean | AddEventListenerOptions)?]
    ) {
      if (type === "finish") watch(this);
      EventTarget.prototype.addEventListener.call(this, type, ...rest);
    } as typeof prototype.addEventListener;

    const { animate } = Element.prototype;
    const follow = (animation: Animation) => {
      if (this.#follows(animation)) this.#adopt(animation);
    };
    Element.prototype.animate = function animateOnClock(keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      follow(animation);
      return animation;
    };

    this.#watchChanges();
    this.#watchEvents();
  }

  /** What can start an animation and does not show up as a change of the document. */
  #watchChanges(): void {
    const added = (root: ShadowRoot) => this.#addShadowRoot(root);
    const changed = () => {
      this.#dirty = true;
    };
    const { attachShadow } = Element.prototype;
    Element.prototype.attachShadow = function attachShadowOnClock(init) {
      const root = attachShadow.call(this, init);
      added(root);
      return root;
    };
    const sheet = CSSStyleSheet.prototype;
    for (const name of ["insertRule", "deleteRule", "replace", "replaceSync"] as const) {
      const real = sheet[name] as (...args: unknown[]) => unknown;
      sheet[name] = function onClock(this: CSSStyleSheet, ...args: unknown[]) {
        changed();
        return real.apply(this, args);
      } as never;
    }
    // The list of adopted stylesheets changes in place too, and that does not call any setter.
    for (const { prototype } of [Document, ShadowRoot]) {
      const adopted = Object.getOwnPropertyDescriptor(prototype, "adoptedStyleSheets");
      Object.defineProperty(prototype, "adoptedStyleSheets", {
        ...adopted,
        get(this: DocumentOrShadowRoot) {
          return new Proxy(adopted?.get?.call(this) as CSSStyleSheet[], {
            set(list, key, value) {
              changed();
              return Reflect.set(list, key, value);
            },
            deleteProperty(list, key) {
              changed();
              return Reflect.deleteProperty(list, key);
            },
          });
        },
        set(this: DocumentOrShadowRoot, sheets: CSSStyleSheet[]) {
          changed();
          adopted?.set?.call(this, sheets);
        },
      });
    }
  }

  #watchEvents(): void {
    const watching = () => {
      this.#eventsWatched = true;
    };
    const { addEventListener } = EventTarget.prototype;
    EventTarget.prototype.addEventListener = function watchedListener(
      this: EventTarget,
      type: string,
      ...rest: [EventListenerOrEventListenerObject | null, (boolean | AddEventListenerOptions)?]
    ) {
      if (ANIMATION_EVENTS.has(type)) watching();
      addEventListener.call(this, type, ...rest);
    };
    const targets = [HTMLElement.prototype, SVGElement.prototype, Document.prototype, window];
    for (const target of targets) {
      for (const type of ANIMATION_EVENTS) {
        const name = `on${type}`;
        const descriptor = Object.getOwnPropertyDescriptor(target, name);
        if (!descriptor?.set) continue;
        Object.defineProperty(target, name, {
          ...descriptor,
          set(this: unknown, value: unknown) {
            watching();
            descriptor.set?.call(this, value);
          },
        });
      }
    }
  }
}
