import type { SceneProblem } from "@animaquill/scene";
import { Strikes, WATCHDOG_RULES } from "@animaquill/scene";
import type { SceneStatus } from "@animaquill/render";
import { Emitter } from "../workbench/emitter.ts";

/** How the preview is doing as a whole. */
export type CompositorState =
  /** It answers, as far as anybody knows. */
  | "running"
  /** It stopped answering, and it gets started again by itself. */
  | "restarting"
  /** It keeps hanging, so it stays off until somebody says otherwise. */
  | "stopped";

export interface PreviewSnapshot {
  readonly compositor: CompositorState;
  /** Goes up when the compositor has to start again. A new frame is what gets rid of a hung one. */
  readonly generation: number;
  /** False after somebody asked for a preview without scenes, to get out of one that takes it down. */
  readonly runScenes: boolean;
  /** How scenes are doing, by clip, as far as there is anything to say. */
  readonly scenes: ReadonlyMap<string, SceneStatus>;
}

export interface PreviewMessages {
  /** Something was wrong with what a scene did. `last` says that more of these will not be told. */
  problem(clip: string, problem: SceneProblem, last: boolean): void;
  /** The preview hung and starts again by itself. */
  restarted(): void;
}

/** Past this a scene has said what it had to say. */
const MAX_PROBLEMS_TOLD = 3;

/** Nobody needs to hear about scenes that are fine. */
const isWorthSaying = ({ state }: SceneStatus) => state !== "ready" && state !== "closed";

/**
 * What people should know about the preview. Panels come and go, and this stays: hangs in a row only
 * mean something when something remembers them.
 */
export class PreviewStatus {
  readonly #emitter = new Emitter();
  readonly #messages: PreviewMessages;
  /** How many problems people heard of, by clip. It starts over with every new start of a scene. */
  readonly #told = new Map<string, number>();
  /** Where scenes must not run any more, which only ends with this page. */
  readonly #retired = new Set<string>();
  #strikes = new Strikes(WATCHDOG_RULES.strikes, WATCHDOG_RULES.forgiveAfterMs);
  #snapshot: PreviewSnapshot = {
    compositor: "running",
    generation: 0,
    runScenes: true,
    scenes: new Map(),
  };

  constructor(messages: PreviewMessages) {
    this.#messages = messages;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): PreviewSnapshot => this.#snapshot;

  #set(changes: Partial<PreviewSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...changes };
    this.#emitter.emit();
  }

  /** It answers. That alone proves little, see `Strikes`. */
  worked(): void {
    this.#strikes.worked(performance.now());
    if (this.#snapshot.compositor !== "running") this.#set({ compositor: "running" });
  }

  /** It stopped answering. A new one gets all scenes to start over, so it knows nothing of them. */
  hung(): void {
    const { generation } = this.#snapshot;
    if (this.#strikes.hung(performance.now())) {
      this.#set({ compositor: "restarting", generation: generation + 1, scenes: new Map() });
      this.#messages.restarted();
    } else this.#set({ compositor: "stopped", scenes: new Map() });
  }

  /** Somebody asked for it, which starts the count over. */
  restart({ runScenes = this.#snapshot.runScenes } = {}): void {
    this.#strikes = new Strikes(WATCHDOG_RULES.strikes, WATCHDOG_RULES.forgiveAfterMs);
    const { generation } = this.#snapshot;
    this.#set({ compositor: "running", generation: generation + 1, runScenes, scenes: new Map() });
  }

  noteScene(clip: string, status: SceneStatus): void {
    if (status.state === "opening") this.#told.delete(clip);
    const scenes = new Map(this.#snapshot.scenes);
    if (isWorthSaying(status)) scenes.set(clip, status);
    else if (!scenes.delete(clip)) return;
    this.#set({ scenes });
  }

  /** The compositor started again and knows nothing of what it said before. */
  forgetScenes(): void {
    if (this.#snapshot.scenes.size > 0) this.#set({ scenes: new Map() });
  }

  /** What a new compositor has to stay away from, because it cannot know. */
  get retiredOrigins(): readonly string[] {
    return [...this.#retired];
  }

  noteRetired(origin: string): void {
    this.#retired.add(origin);
  }

  noteProblem(clip: string, problem: SceneProblem): void {
    const told = (this.#told.get(clip) ?? 0) + 1;
    this.#told.set(clip, told);
    if (told <= MAX_PROBLEMS_TOLD)
      this.#messages.problem(clip, problem, told === MAX_PROBLEMS_TOLD);
  }
}
