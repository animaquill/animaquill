import { readHandles, type ObjectHandles, type Registration } from "@animaquill/core";
import { Emitter } from "../workbench/emitter.ts";

/** What a scene said last about where its objects are. Only ever data, read by `readHandles`. */
interface Answer {
  readonly layer: string;
  readonly revision: string;
  /** The frame of the scene it is true of. */
  readonly frame: number;
  readonly raw: unknown;
}

/** What the overlay looks for: the state of the scene of the wanted clip, on the frame it shows. */
type Expected = Omit<Answer, "raw">;

export interface SceneHandlesOptions {
  /** Runs something before the next frame of the screen. Gives what stops that. */
  readonly schedule?: (run: () => void) => () => void;
  readonly now?: () => number;
  /** A scene says where its objects are more often than it does by itself. Said once a state. */
  readonly tooMany?: (layer: string, revision: string) => void;
}

/**
 * How many answers a scene gets to give at once, and in a second. The runtime gives one every 40
 * milliseconds at most, so only a scene that sends them itself gets near this.
 */
export const ANSWER_RULES = { burst: 40, perSecond: 40 } as const;

const NO_HANDLES: readonly ObjectHandles[] = [];

function nextFrame(run: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const frame = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame);
  }
  const timer = setTimeout(run, 16);
  return () => clearTimeout(timer);
}

/**
 * The handles of code objects, as the scenes of clips say where they are. A scene only works that out
 * for the one clip that wants it, while nothing plays: see `want`. What it says stays raw until the
 * overlay looks at it, against what the scene registered, so that a handle can only ever reach the
 * numbers of its own object. Code of a project can send as many answers as it likes, so only the
 * last one is kept, and the overlay looks again once a frame of the screen at most, and only for an
 * answer about what it shows.
 */
export class SceneHandles {
  readonly #emitter = new Emitter();
  readonly #wantedEmitter = new Emitter();
  readonly #schedule: (run: () => void) => () => void;
  readonly #now: () => number;
  readonly #tooMany: (layer: string, revision: string) => void;
  #wanted: string | undefined;
  #expected: Expected | undefined;
  #answer: Answer | undefined;
  #read:
    | {
        readonly answer: Answer;
        readonly registration: Registration;
        readonly reach: number | undefined;
        readonly objects: readonly ObjectHandles[];
      }
    | undefined;
  #version = 0;
  /** The overlay is going to hear about an answer before the next frame of the screen. */
  #scheduled = false;
  #room: number = ANSWER_RULES.burst;
  #filled: number;
  /** The states of scenes that heard that they say too much. */
  readonly #told = new Set<string>();

  constructor({ schedule = nextFrame, now, tooMany }: SceneHandlesOptions = {}) {
    this.#schedule = schedule;
    this.#now = now ?? (() => performance.now());
    this.#tooMany = tooMany ?? (() => {});
    this.#filled = this.#now();
  }

  /** For what draws them. */
  subscribe = this.#emitter.subscribe;
  /** For what asks scenes for them. */
  subscribeWanted = this.#wantedEmitter.subscribe;

  getVersion = (): number => this.#version;

  /** The clip whose scene is asked to say where its objects are. */
  get wanted(): string | undefined {
    return this.#wanted;
  }

  /**
   * Asks the scene of this clip to say where its objects are, from now on, and no other one. What
   * another one said before stays until the next answer, and only counts for that one.
   */
  want(layer: string | undefined): void {
    if (layer === this.#wanted) return;
    this.#wanted = layer;
    this.#room = ANSWER_RULES.burst;
    this.#filled = this.#now();
    this.#wantedEmitter.emit();
  }

  /**
   * What a scene said. Only the clip that was asked counts, only the last answer of it is kept, and
   * the overlay hears about one about what it shows before the next frame of the screen.
   */
  note(layer: string, revision: string, frame: number, raw: unknown): void {
    if (layer !== this.#wanted) return;
    if (!this.#take()) {
      this.#sayTooMany(layer, revision);
      return;
    }
    const answer = { layer, revision, frame, raw };
    this.#answer = answer;
    if (this.#isExpected(answer)) this.#soon();
  }

  /**
   * The handles of the objects of a clip, as its scene in this state said where they are on this
   * frame, within `reach` of its middle. Nothing when it has not said so yet, or said it of another
   * frame. This is also what an answer has to be about from now on to be heard of.
   */
  of(
    layer: string,
    revision: string,
    frame: number,
    registration: Registration | undefined,
    reach?: number,
  ): readonly ObjectHandles[] {
    const expected = this.#expected;
    if (expected?.layer !== layer || expected.revision !== revision || expected.frame !== frame) {
      this.#expected = { layer, revision, frame };
    }
    const answer = this.#answer;
    if (!answer || !registration || !this.#isExpected(answer)) return NO_HANDLES;
    const read = this.#read;
    if (read?.answer === answer && read.registration === registration && read.reach === reach) {
      return read.objects;
    }
    const { objects } = readHandles(answer.raw, registration.objects, reach);
    this.#read = { answer, registration, reach, objects };
    return objects;
  }

  #isExpected({ layer, revision, frame }: Expected): boolean {
    const expected = this.#expected;
    return expected?.layer === layer && expected.revision === revision && expected.frame === frame;
  }

  /** Whether there is room for another answer. Room comes back with time. */
  #take(): boolean {
    const now = this.#now();
    const elapsed = Math.max(now - this.#filled, 0);
    this.#filled = now;
    const room = this.#room + (elapsed / 1000) * ANSWER_RULES.perSecond;
    this.#room = Math.min(room, ANSWER_RULES.burst);
    if (this.#room < 1) return false;
    this.#room -= 1;
    return true;
  }

  #sayTooMany(layer: string, revision: string): void {
    const key = `${layer}\n${revision}`;
    if (this.#told.has(key)) return;
    this.#told.add(key);
    this.#tooMany(layer, revision);
  }

  #soon(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(() => {
      this.#scheduled = false;
      this.#version += 1;
      this.#emitter.emit();
    });
  }
}
