import { readHandles, type ObjectHandles, type Registration } from "@animaquill/core";
import { Emitter } from "../workbench/emitter.ts";

/** What a scene said last about where its objects are. Only ever data, read by `readHandles`. */
interface Answer {
  readonly revision: string;
  /** The frame of the scene it is true of. */
  readonly frame: number;
  readonly raw: unknown;
}

const NO_HANDLES: readonly ObjectHandles[] = [];

/**
 * The handles of code objects, as the scenes of clips say where they are. A scene only works that out
 * for the one clip that wants it, while nothing plays: see `want`. What it says stays raw until the
 * editor knows what the scene registered, and goes through `readHandles` against that, so that a
 * handle can only ever reach the numbers of its own object.
 */
export class SceneHandles {
  readonly #emitter = new Emitter();
  readonly #wantedEmitter = new Emitter();
  #wanted: string | undefined;
  #answer: (Answer & { readonly layer: string }) | undefined;
  #read:
    | {
        readonly answer: Answer;
        readonly registration: Registration;
        readonly objects: readonly ObjectHandles[];
      }
    | undefined;
  #version = 0;

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
    this.#wantedEmitter.emit();
  }

  /** What a scene said. Only the one that was asked counts. */
  note(layer: string, revision: string, frame: number, raw: unknown): void {
    if (layer !== this.#wanted) return;
    this.#answer = { layer, revision, frame, raw };
    this.#changed();
  }

  /**
   * The handles of the objects of a clip, as its scene in this state said where they are on this
   * frame. Nothing when it has not said so yet, or said it of another frame.
   */
  of(
    layer: string,
    revision: string,
    frame: number,
    registration: Registration | undefined,
  ): readonly ObjectHandles[] {
    const answer = this.#answer;
    if (!answer || !registration) return NO_HANDLES;
    if (answer.layer !== layer || answer.revision !== revision || answer.frame !== frame) {
      return NO_HANDLES;
    }
    const read = this.#read;
    if (read?.answer === answer && read.registration === registration) return read.objects;
    const { objects } = readHandles(answer.raw, registration.objects);
    this.#read = { answer, registration, objects };
    return objects;
  }

  #changed(): void {
    this.#version += 1;
    this.#emitter.emit();
  }
}
