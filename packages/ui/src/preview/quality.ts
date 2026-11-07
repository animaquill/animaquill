import type { SettingsStore } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { readSetting } from "../workbench/settings.ts";
import type { FrameRateReading, PreviewFrameRate } from "./frame-rate.ts";

/** How much of the full resolution the preview draws, from sharpest to fastest. */
export const QUALITY_SCALES = [1, 0.5, 0.25] as const;
export type QualityScale = (typeof QUALITY_SCALES)[number];
export type QualityChoice = "auto" | "full" | "half" | "quarter";
export const QUALITY_CHOICES: readonly QualityChoice[] = ["auto", "full", "half", "quarter"];

const FIXED: Readonly<Record<Exclude<QualityChoice, "auto">, QualityScale>> = {
  full: 1,
  half: 0.5,
  quarter: 0.25,
};

/** The rules of the automatic choice, by readings of the meter, which come once a second. */
export const AUTO_RULES = {
  /** Short this many times in a row is not the start of playing or one hiccup. */
  downAfter: 2,
  /** Readings right after a change say more about the change than about the new resolution. */
  settle: 2,
  /** Over this share of the project frame rate, there would be room for more. */
  keepsUp: 0.97,
  /** Keeping up this many times in a row is when the next sharper one gets a try. */
  upAfter: 5,
  /** A try that does not last this long failed, and the next one waits twice as long. */
  lasts: 10,
  /** However often it failed, it gets another try after this many. */
  upAfterAtMost: 80,
} as const;

/**
 * The automatic choice. It goes for the frame rate first, and goes back up once there is room. The
 * two directions ask for different things, and a try that fails makes the next one wait longer, so
 * it does not go back and forth.
 */
export class AutoQuality {
  #level = 0;
  #short = 0;
  #good = 0;
  #settle = 0;
  #upAfter: number = AUTO_RULES.upAfter;
  /** Readings since the last step up, while it may still turn out to be too much. */
  #sinceUp: number | undefined;

  get scale(): QualityScale {
    return QUALITY_SCALES[this.#level] ?? 1;
  }

  /** What the meter said. True when the scale changed. */
  note(reading: FrameRateReading | undefined): boolean {
    if (!reading) {
      // Playing started again: what came before is no streak any more.
      this.#short = 0;
      this.#good = 0;
      return false;
    }
    if (this.#sinceUp !== undefined) {
      this.#sinceUp += 1;
      if (this.#sinceUp >= AUTO_RULES.lasts) {
        this.#sinceUp = undefined;
        this.#upAfter = AUTO_RULES.upAfter;
      }
    }
    if (this.#settle > 0) {
      this.#settle -= 1;
      return false;
    }
    if (reading.short) {
      this.#good = 0;
      this.#short += 1;
      if (this.#short < AUTO_RULES.downAfter || this.#level >= QUALITY_SCALES.length - 1) {
        return false;
      }
      if (this.#sinceUp !== undefined) {
        this.#upAfter = Math.min(this.#upAfter * 2, AUTO_RULES.upAfterAtMost);
        this.#sinceUp = undefined;
      }
      this.#step(1);
      return true;
    }
    this.#short = 0;
    if (reading.painted < reading.fps * AUTO_RULES.keepsUp) {
      this.#good = 0;
      return false;
    }
    this.#good += 1;
    if (this.#good < this.#upAfter || this.#level === 0) return false;
    this.#sinceUp = 0;
    this.#step(-1);
    return true;
  }

  #step(by: number): void {
    this.#level += by;
    this.#short = 0;
    this.#good = 0;
    this.#settle = AUTO_RULES.settle;
  }
}

interface Size {
  readonly width: number;
  readonly height: number;
}

export interface PictureSizes {
  /** What it draws. */
  readonly shown: Size;
  /** What it would draw at full quality, which is what an export gets. */
  readonly full: Size;
}

const sameSize = (a: Size, b: Size) => a.width === b.width && a.height === b.height;

export interface QualitySnapshot {
  readonly choice: QualityChoice;
  /** What the preview draws at now. */
  readonly scale: QualityScale;
  /** The pixels of what the preview was last given, while there is one. */
  readonly size: PictureSizes | undefined;
}

const SETTINGS_KEY = "previewQuality";
const SETTINGS_VERSION = 1;

function parseSaved(value: unknown): QualityChoice | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, choice } = value as { version?: unknown; choice?: unknown };
  return version === SETTINGS_VERSION && QUALITY_CHOICES.includes(choice as QualityChoice)
    ? (choice as QualityChoice)
    : undefined;
}

/** The pixels of a picture at this scale. Never none, which a canvas cannot have. */
export function scaledSize(width: number, height: number, scale: number) {
  return {
    width: Math.max(Math.round(width * scale), 1),
    height: Math.max(Math.round(height * scale), 1),
  };
}

/**
 * How sharp the preview is. Only the preview: what gets exported never hears of it. Every window
 * shares the choice, and each one follows its own frame rate when the choice is automatic.
 */
export class PreviewQuality {
  readonly #settings: SettingsStore;
  readonly #emitter = new Emitter();
  #auto = new AutoQuality();
  #snapshot: QualitySnapshot = { choice: "auto", scale: 1, size: undefined };

  constructor(settings: SettingsStore, frameRate: PreviewFrameRate) {
    this.#settings = settings;
    frameRate.subscribe(() => {
      const meter = frameRate.getSnapshot();
      if (this.#snapshot.choice !== "auto" || meter.state !== "playing") return;
      if (this.#auto.note(meter.reading)) this.#update();
    });
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): QualitySnapshot => this.#snapshot;

  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, parseSaved);
    if (reading.kind === "ok") this.#adopt(reading.value);
    this.#settings.listen(SETTINGS_KEY, (value) => {
      const choice = parseSaved(value);
      if (choice) this.#adopt(choice);
    });
  }

  choose(choice: QualityChoice): void {
    this.#adopt(choice);
    this.#settings
      .save(SETTINGS_KEY, { version: SETTINGS_VERSION, choice })
      .catch((error: unknown) => console.warn("Preview quality could not be saved", error));
  }

  /** What the preview got last, or undefined once it is gone. */
  noteSize(size: QualitySnapshot["size"]): void {
    const was = this.#snapshot.size;
    if (
      was === size ||
      (was && size && sameSize(was.shown, size.shown) && sameSize(was.full, size.full))
    ) {
      return;
    }
    this.#set({ ...this.#snapshot, size });
  }

  #adopt(choice: QualityChoice): void {
    if (choice === this.#snapshot.choice) return;
    // Back to automatic starts from the sharpest, as if nothing was known.
    if (choice === "auto") this.#auto = new AutoQuality();
    this.#set({ ...this.#snapshot, choice });
    this.#update();
  }

  #update(): void {
    const { choice } = this.#snapshot;
    const scale = choice === "auto" ? this.#auto.scale : FIXED[choice];
    if (scale !== this.#snapshot.scale) this.#set({ ...this.#snapshot, scale });
  }

  #set(snapshot: QualitySnapshot): void {
    this.#snapshot = snapshot;
    this.#emitter.emit();
  }
}
