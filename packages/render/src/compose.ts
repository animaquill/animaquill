import type { PlannedTransition, RenderJoin, RenderLayer, RenderPlan } from "@animaquill/core";
import { fadeLeftAt, isFade, opacityAt, progressAt, shownAt, showsAt } from "@animaquill/core/view";
import { codeOf } from "./transitions/built-in.ts";
import type { Corners, TransitionFrame, TransitionUse } from "./transitions/code.ts";

/** What the compositor draws on: its picture, or a picture of a layer on its own. */
export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Draws a layer the way the picture has it, with this much of it showing, and says where its clip
 * box ended up. Nothing when there was nothing to draw.
 */
export type LayerPainter = (
  target: Context2D,
  layer: RenderLayer,
  opacity: number,
  /** How it goes onto what is there: over it, or added to it. */
  operation?: GlobalCompositeOperation,
) => Corners | undefined;

/** A whole picture of something: a layer on its own, or what a transition made of two. */
interface Drawn {
  readonly canvas: OffscreenCanvas;
  readonly box: Corners | null;
  /** How much of it shows, for a fade out that comes after something else. */
  readonly alpha: number;
}

/** A transition of code that comes with the editor, with its own canvas, see transitions/code.ts. */
interface Instance {
  readonly canvas: OffscreenCanvas;
  draw(frame: TransitionFrame): void;
}

interface Buffer {
  readonly canvas: OffscreenCanvas;
  readonly context: OffscreenCanvasRenderingContext2D;
}

/** Transitions that run into each other on a track: what one makes is the side before of the next. */
type Chain = readonly RenderJoin[];

/** Frames without a transition after which the canvases for them go, to give back their memory. */
const KEEP_FRAMES = 300;

const isOn = (transition: PlannedTransition | undefined, seconds: number) =>
  transition !== undefined && showsAt(transition, seconds) ? transition : undefined;

/** Joins at the same moment that follow each other, in order: see `transitionsNotDone` too. */
function chainsOf(joins: readonly RenderJoin[]): readonly Chain[] {
  const chains: RenderJoin[][] = [];
  const ending = new Map<string, RenderJoin[]>();
  for (const join of joins) {
    const chain = ending.get(join.from);
    if (chain) chain.push(join);
    else chains.push([join]);
    ending.delete(join.from);
    ending.set(join.to, chain ?? (chains.at(-1) as RenderJoin[]));
  }
  return chains;
}

/**
 * Puts the layers of a moment on the picture, track by track, with their transitions. What has
 * none is drawn straight onto the picture, as it always was, and so is a fade, which is the layer
 * with less opacity. Any other transition gets the layers it is about as pictures of their own,
 * each as large as the picture, and what it makes goes onto the picture in their place. A join
 * gets the two layers of its cut, and what it makes goes where the later of them is: everything
 * of a track before it is behind it.
 */
export class Composer {
  readonly #buffers: Buffer[] = [];
  #used = 0;
  readonly #instances = new Map<string, Instance[]>();
  readonly #taken = new Map<string, number>();
  #nothing: OffscreenCanvas | undefined;
  #width = 1;
  #height = 1;
  #pixelRatio = 1;
  #idle = 0;

  compose(
    target: CanvasRenderingContext2D,
    plan: RenderPlan,
    showing: readonly RenderLayer[],
    seconds: number,
    paintLayer: LayerPainter,
  ): void {
    this.#width = Math.max(plan.width, 1);
    this.#height = Math.max(plan.height, 1);
    this.#pixelRatio = plan.stage.width > 0 ? plan.width / plan.stage.width : 1;
    const chains = chainsOf(plan.joins.filter((join) => showsAt(join, seconds)));
    const index = new Map(showing.map((layer, at) => [layer.id, at]));
    const byId = new Map(showing.map((layer) => [layer.id, layer]));
    /** Where each chain goes: at the last of its layers that is there. */
    const placed = new Map<number, Chain>();
    const joined = new Set<string>();
    for (const chain of chains) {
      const members = [(chain[0] as RenderJoin).from, ...chain.map(({ to }) => to)];
      for (const member of members) joined.add(member);
      const last = Math.max(...members.map((member) => index.get(member) ?? -1));
      if (last >= 0) placed.set(last, chain);
    }
    let buffered = chains.length > 0;
    try {
      showing.forEach((layer, at) => {
        const chain = placed.get(at);
        if (chain) {
          const drawn =
            this.#dissolve(chain, byId, seconds, paintLayer) ??
            this.#chain(chain, byId, seconds, paintLayer);
          this.#composite(target, drawn);
          return;
        }
        if (joined.has(layer.id)) return;
        if (!this.#needsPicture(layer, seconds)) {
          paintLayer(target, layer, shownAt(layer, seconds));
          return;
        }
        buffered = true;
        this.#composite(target, this.#own(layer, seconds, paintLayer));
      });
    } finally {
      this.#end(buffered);
    }
  }

  /** Whether a layer has a transition at this moment that works on its picture. */
  #needsPicture(layer: RenderLayer, seconds: number): boolean {
    const enter = isOn(layer.enter, seconds);
    const exit = isOn(layer.exit, seconds);
    return (enter !== undefined && !isFade(enter)) || (exit !== undefined && !isFade(exit));
  }

  /**
   * A dissolve between two layers that need no picture of their own, the quick way: each drawn
   * once straight onto the same canvas, added up with its share, which is what the code of `fade`
   * does with their pictures. Nothing when that is not what this is.
   */
  #dissolve(
    chain: Chain,
    layers: ReadonlyMap<string, RenderLayer>,
    seconds: number,
    paintLayer: LayerPainter,
  ): Drawn | undefined {
    const [join, more] = chain;
    if (!join || more || !isFade(join)) return undefined;
    const sides = [layers.get(join.from), layers.get(join.to)];
    if (sides.some((layer) => layer && this.#needsPicture(layer, seconds))) return undefined;
    const progress = progressAt(join, seconds);
    const buffer = this.#buffer();
    const [from, to] = sides;
    if (from) paintLayer(buffer.context, from, shownAt(from, seconds) * (1 - progress), "lighter");
    if (to) paintLayer(buffer.context, to, shownAt(to, seconds) * progress, "lighter");
    return { canvas: buffer.canvas, box: null, alpha: 1 };
  }

  /** The joins of a chain one after the other, each from what the one before made. */
  #chain(
    chain: Chain,
    layers: ReadonlyMap<string, RenderLayer>,
    seconds: number,
    paintLayer: LayerPainter,
  ): Drawn {
    const ownOf = (id: string) => {
      const layer = layers.get(id);
      return layer ? this.#own(layer, seconds, paintLayer) : this.#empty();
    };
    let current = ownOf((chain[0] as RenderJoin).from);
    for (const join of chain) current = this.#run(join, "join", current, ownOf(join.to), seconds);
    return current;
  }

  /**
   * A layer as a picture of its own, with the transitions at its edges that are not joins: what
   * comes in first, then what goes out. A fade goes into the drawing where that is the same.
   */
  #own(layer: RenderLayer, seconds: number, paintLayer: LayerPainter): Drawn {
    const enter = isOn(layer.enter, seconds);
    const exit = isOn(layer.exit, seconds);
    const entersOtherwise = enter !== undefined && !isFade(enter);
    let alpha = opacityAt(layer, seconds);
    if (enter && !entersOtherwise) alpha *= progressAt(enter, seconds);
    // A fade out comes last, so it can only go into the drawing when nothing else comes first.
    const fadesNow = exit !== undefined && isFade(exit) && !entersOtherwise;
    if (exit && fadesNow) alpha *= fadeLeftAt(exit, seconds);
    const buffer = this.#buffer();
    const box = alpha > 0 ? (paintLayer(buffer.context, layer, alpha) ?? null) : null;
    let drawn: Drawn = { canvas: buffer.canvas, box, alpha: 1 };
    if (enter && entersOtherwise) drawn = this.#run(enter, "enter", this.#empty(), drawn, seconds);
    if (exit && !isFade(exit)) drawn = this.#run(exit, "exit", drawn, this.#empty(), seconds);
    else if (exit && !fadesNow)
      drawn = { ...drawn, alpha: drawn.alpha * fadeLeftAt(exit, seconds) };
    return drawn;
  }

  /** Runs the code of a transition on two pictures, into a canvas of its own. */
  #run(
    transition: PlannedTransition,
    use: TransitionUse,
    from: Drawn,
    to: Drawn,
    seconds: number,
  ): Drawn {
    const instance = this.#instance(transition.how.type);
    const width = this.#width;
    const height = this.#height;
    instance.draw({
      from: this.#solid(from),
      to: this.#solid(to),
      progress: progressAt(transition, seconds),
      time: seconds - transition.start,
      duration: transition.duration,
      use,
      boxes: { from: from.box, to: to.box },
      values: transition.how.values ?? {},
      width,
      height,
      pixelRatio: this.#pixelRatio,
      canvas: instance.canvas,
    });
    return { canvas: instance.canvas, box: null, alpha: 1 };
  }

  /** A picture with all of it showing as it does, which is what code gets. */
  #solid(drawn: Drawn): OffscreenCanvas {
    if (drawn.alpha === 1) return drawn.canvas;
    const buffer = this.#buffer();
    buffer.context.globalAlpha = Math.min(Math.max(drawn.alpha, 0), 1);
    buffer.context.drawImage(drawn.canvas, 0, 0);
    buffer.context.globalAlpha = 1;
    return buffer.canvas;
  }

  #composite(target: CanvasRenderingContext2D, drawn: Drawn): void {
    if (!(drawn.alpha > 0)) return;
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalCompositeOperation = "source-over";
    target.globalAlpha = Math.min(drawn.alpha, 1);
    target.drawImage(drawn.canvas, 0, 0);
    target.globalAlpha = 1;
  }

  /** Nothing, as a picture: where there is nothing on a side of a transition. */
  #empty(): Drawn {
    const nothing = (this.#nothing ??= new OffscreenCanvas(1, 1));
    if (nothing.width !== this.#width || nothing.height !== this.#height) {
      nothing.width = this.#width;
      nothing.height = this.#height;
    }
    return { canvas: nothing, box: null, alpha: 1 };
  }

  /** A clear canvas as large as the picture, for this frame. */
  #buffer(): Buffer {
    let buffer = this.#buffers[this.#used];
    if (!buffer) {
      const canvas = new OffscreenCanvas(this.#width, this.#height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No 2D context");
      buffer = { canvas, context };
      this.#buffers.push(buffer);
    }
    this.#used += 1;
    const { canvas, context } = buffer;
    if (canvas.width !== this.#width || canvas.height !== this.#height) {
      canvas.width = this.#width;
      canvas.height = this.#height;
    } else {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    return buffer;
  }

  /**
   * The code of a transition that is free for this frame. The same code at two places at once has
   * two of them. What they make only depends on what they get, so any of them can do any place.
   */
  #instance(type: string): Instance {
    const all = this.#instances.get(type) ?? [];
    this.#instances.set(type, all);
    const taken = this.#taken.get(type) ?? 0;
    this.#taken.set(type, taken + 1);
    let instance = all[taken];
    if (!instance) {
      const canvas = new OffscreenCanvas(this.#width, this.#height);
      let draw: ((frame: TransitionFrame) => void) | undefined;
      codeOf(type)({
        canvas,
        render: (given) => {
          draw = given;
        },
      });
      instance = { canvas, draw: (frame) => draw?.(frame) };
      all.push(instance);
    }
    const { canvas } = instance;
    if (canvas.width !== this.#width || canvas.height !== this.#height) {
      canvas.width = this.#width;
      canvas.height = this.#height;
    }
    return instance;
  }

  /** What one frame took is free for the next. A long while without any lets go of all of it. */
  #end(buffered: boolean): void {
    this.#used = 0;
    this.#taken.clear();
    this.#idle = buffered ? 0 : this.#idle + 1;
    if (this.#idle < KEEP_FRAMES || this.#buffers.length + this.#instances.size === 0) return;
    for (const { canvas } of this.#buffers) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this.#buffers.length = 0;
    this.#instances.clear();
    this.#nothing = undefined;
  }
}
