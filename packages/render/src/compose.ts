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
  /** Lets its canvas go for something else in this frame, once nothing needs what is on it. */
  readonly done: () => void;
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

/**
 * Things to draw on that a frame takes and gives back, which the next frames take again. What no
 * frame took for a while goes, with its memory.
 */
class Pool<T> {
  #all: T[] = [];
  #free: T[] = [];
  /** The frame each one was last taken in. */
  readonly #taken = new Map<T, number>();
  readonly #letGo: (item: T) => void;

  constructor(letGoOf: (item: T) => void) {
    this.#letGo = letGoOf;
  }

  get size(): number {
    return this.#all.length;
  }

  take(frame: number, make: () => T): T {
    let item = this.#free.pop();
    if (item === undefined) {
      item = make();
      this.#all.push(item);
    }
    this.#taken.set(item, frame);
    return item;
  }

  give(item: T): void {
    if (!this.#free.includes(item)) this.#free.push(item);
  }

  /**
   * Whatever a frame did not give back, it gives back when it is over. What this many frames in a
   * row did not take goes. The ones taken last come first, so that what is more than frames need
   * gets old.
   */
  end(frame: number, keep: number): void {
    this.#all = this.#all.filter((item) => {
      if (frame - (this.#taken.get(item) ?? frame) <= keep) return true;
      this.#taken.delete(item);
      this.#letGo(item);
      return false;
    });
    this.#free = this.#all.toSorted(
      (a, b) => (this.#taken.get(a) ?? 0) - (this.#taken.get(b) ?? 0),
    );
  }
}

/** Transitions that run into each other on a track: what one makes is the side before of the next. */
type Chain = readonly RenderJoin[];

/** Frames without taking it after which a canvas for transitions goes, to give back its memory. */
const KEEP_FRAMES = 300;

const isOn = (transition: PlannedTransition | undefined, seconds: number) =>
  transition !== undefined && showsAt(transition, seconds) ? transition : undefined;

/** Gives the memory of a canvas back now, instead of whenever it goes. */
function letGo(canvas: OffscreenCanvas): void {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Joins at the same moment that follow each other, as they are joined: a join whose side before is
 * the side after of another one comes after that one, whenever they start and whatever their ids.
 */
function chainsOf(joins: readonly RenderJoin[]): readonly Chain[] {
  const after = new Map(joins.map((join) => [join.from, join]));
  const ends = new Set(joins.map(({ to }) => to));
  const chains: RenderJoin[][] = [];
  const used = new Set<RenderJoin>();
  for (const first of joins) {
    // A chain starts at a join that no other one leads to.
    if (ends.has(first.from)) continue;
    const chain: RenderJoin[] = [];
    for (let join: RenderJoin | undefined = first; join && !used.has(join);) {
      used.add(join);
      chain.push(join);
      join = after.get(join.to);
    }
    chains.push(chain);
  }
  // Joins that only lead to each other cannot be on a timeline, but each still gets drawn once.
  for (const join of joins) if (!used.has(join)) chains.push([join]);
  return chains;
}

/**
 * Puts the layers of a moment on the picture, track by track, with their transitions. What has
 * none is drawn straight onto the picture, as it always was, and so is a fade, which is the layer
 * with less opacity. Any other transition gets the layers it is about as pictures of their own,
 * each as large as the picture, and what it makes goes onto the picture in their place. A join
 * gets the two layers of its cut, and what it makes goes where the later of them is: everything
 * of a track before it is behind it. Transitions at the edges of a layer come first, on its own
 * picture, and joins after that.
 *
 * Pictures go back for the next thing to take as soon as nothing needs them, so that a frame takes
 * as few whole pictures as it can: a dissolve one, or none when it is the first thing on a black
 * picture, a transition of a layer two, a join three, see the project format for more. What no
 * frame took for a while goes with its memory.
 */
export class Composer {
  readonly #buffers = new Pool<Buffer>(({ canvas }) => letGo(canvas));
  readonly #instances = new Map<string, Pool<Instance>>();
  readonly #scratches = new Pool<OffscreenCanvas>(letGo);
  /** What a run of code took for its steps in between, which goes back when it is done. */
  #lent: OffscreenCanvas[] = [];
  #nothing: OffscreenCanvas | undefined;
  /** The frame nothing was last taken in. */
  #nothingTaken = 0;
  /** How many frames there were. */
  #frame = 0;
  #width = 1;
  #height = 1;
  #pixelRatio = 1;

  /**
   * Puts the layers that show at this moment on a picture that has the background of the plan on
   * it and nothing else yet.
   */
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
    // The picture has its background on it when it comes. Adding onto black leaves what is added
    // as it is, and so does putting it over black, so while that is all there is on the picture
    // the two are the same.
    let black = /^#000000(?:ff)?$/i.test(plan.background);
    try {
      showing.forEach((layer, at) => {
        const chain = placed.get(at);
        if (chain) {
          if (!this.#dissolve(target, black, chain, byId, seconds, paintLayer)) {
            this.#composite(target, this.#chain(chain, byId, seconds, paintLayer));
          }
          black = false;
          return;
        }
        if (joined.has(layer.id)) return;
        black = false;
        if (!this.#needsPicture(layer, seconds)) {
          paintLayer(target, layer, shownAt(layer, seconds));
          return;
        }
        this.#composite(target, this.#own(layer, seconds, paintLayer));
      });
    } finally {
      this.#end();
    }
  }

  /** Whether a layer has a transition at this moment that works on its picture. */
  #needsPicture(layer: RenderLayer, seconds: number): boolean {
    const enter = isOn(layer.enter, seconds);
    const exit = isOn(layer.exit, seconds);
    return (enter !== undefined && !isFade(enter)) || (exit !== undefined && !isFade(exit));
  }

  /**
   * Draws a dissolve between two layers that need no picture of their own the quick way, and says
   * whether that is what this is: each layer drawn once, added up with its share, which is what
   * the code of `fade` does with their pictures. Their sum goes onto the picture like any other
   * picture of a transition, or straight onto it, when all that is on it is black.
   */
  #dissolve(
    target: Context2D,
    black: boolean,
    chain: Chain,
    layers: ReadonlyMap<string, RenderLayer>,
    seconds: number,
    paintLayer: LayerPainter,
  ): boolean {
    const [join, more] = chain;
    if (!join || more || !isFade(join)) return false;
    const sides = [layers.get(join.from), layers.get(join.to)];
    if (sides.some((layer) => layer && this.#needsPicture(layer, seconds))) return false;
    const progress = progressAt(join, seconds);
    const [from, to] = sides;
    const addUp = (onto: Context2D) => {
      if (from) paintLayer(onto, from, shownAt(from, seconds) * (1 - progress), "lighter");
      if (to) paintLayer(onto, to, shownAt(to, seconds) * progress, "lighter");
    };
    if (black) {
      addUp(target);
      return true;
    }
    const buffer = this.#buffer();
    addUp(buffer.context);
    this.#composite(target, this.#drawnOf(buffer, null));
    return true;
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
    let drawn = this.#drawnOf(buffer, box);
    if (enter && entersOtherwise) drawn = this.#run(enter, "enter", this.#empty(), drawn, seconds);
    if (exit && !isFade(exit)) drawn = this.#run(exit, "exit", drawn, this.#empty(), seconds);
    else if (exit && !fadesNow)
      drawn = { ...drawn, alpha: drawn.alpha * fadeLeftAt(exit, seconds) };
    return drawn;
  }

  /**
   * Runs the code of a transition on two pictures, into a canvas of its own. The pictures go back
   * as soon as it is done with them, and so does what it took for its steps in between.
   */
  #run(
    transition: PlannedTransition,
    use: TransitionUse,
    before: Drawn,
    after: Drawn,
    seconds: number,
  ): Drawn {
    const from = this.#solid(before);
    const to = this.#solid(after);
    const type = transition.how.type;
    const instance = this.#instance(type);
    try {
      instance.draw({
        from: from.canvas,
        to: to.canvas,
        progress: progressAt(transition, seconds),
        time: seconds - transition.start,
        duration: transition.duration,
        use,
        boxes: { from: from.box, to: to.box },
        values: transition.how.values ?? {},
        width: this.#width,
        height: this.#height,
        pixelRatio: this.#pixelRatio,
        canvas: instance.canvas,
      });
    } finally {
      for (const scratch of this.#lent) this.#scratches.give(scratch);
      this.#lent = [];
      from.done();
      to.done();
    }
    const pool = this.#instances.get(type);
    return { canvas: instance.canvas, box: null, alpha: 1, done: () => pool?.give(instance) };
  }

  /** A picture with all of it showing as it does, which is what code gets. */
  #solid(drawn: Drawn): Drawn {
    if (drawn.alpha === 1) return drawn;
    const buffer = this.#buffer();
    buffer.context.globalAlpha = Math.min(Math.max(drawn.alpha, 0), 1);
    buffer.context.drawImage(drawn.canvas, 0, 0);
    buffer.context.globalAlpha = 1;
    drawn.done();
    return this.#drawnOf(buffer, drawn.box);
  }

  #composite(target: Context2D, drawn: Drawn): void {
    if (drawn.alpha > 0) {
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.globalCompositeOperation = "source-over";
      target.globalAlpha = Math.min(drawn.alpha, 1);
      target.drawImage(drawn.canvas, 0, 0);
      target.globalAlpha = 1;
    }
    drawn.done();
  }

  /**
   * Nothing, as a picture: where there is nothing on a side of a transition. A single clear pixel,
   * which is nothing at whatever size it is drawn or read.
   */
  #empty(): Drawn {
    this.#nothingTaken = this.#frame;
    const nothing = (this.#nothing ??= new OffscreenCanvas(1, 1));
    return { canvas: nothing, box: null, alpha: 1, done: () => {} };
  }

  #drawnOf(buffer: Buffer, box: Corners | null): Drawn {
    return { canvas: buffer.canvas, box, alpha: 1, done: () => this.#buffers.give(buffer) };
  }

  /** A clear canvas as large as the picture, for this frame. */
  #buffer(): Buffer {
    const buffer = this.#buffers.take(this.#frame, () => {
      const canvas = new OffscreenCanvas(this.#width, this.#height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No 2D context");
      return { canvas, context };
    });
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
   * A clear canvas of this size, which code takes for its steps in between while it draws a frame,
   * see `TransitionHost.scratch`.
   */
  #scratch(width: number, height: number): OffscreenCanvas {
    const wide = Math.max(Math.ceil(width), 1);
    const high = Math.max(Math.ceil(height), 1);
    const canvas = this.#scratches.take(this.#frame, () => new OffscreenCanvas(wide, high));
    if (canvas.width !== wide || canvas.height !== high) {
      canvas.width = wide;
      canvas.height = high;
    } else {
      const context = canvas.getContext("2d");
      context?.setTransform(1, 0, 0, 1, 0, 0);
      context?.clearRect(0, 0, wide, high);
    }
    this.#lent.push(canvas);
    return canvas;
  }

  /**
   * The code of a transition that is free for this frame. The same code at two places at once has
   * two of them. What they make only depends on what they get, so any of them can do any place.
   */
  #instance(type: string): Instance {
    let pool = this.#instances.get(type);
    if (!pool) {
      pool = new Pool<Instance>(({ canvas }) => letGo(canvas));
      this.#instances.set(type, pool);
    }
    const instance = pool.take(this.#frame, () => {
      const canvas = new OffscreenCanvas(this.#width, this.#height);
      let draw: ((frame: TransitionFrame) => void) | undefined;
      codeOf(type)({
        canvas,
        render: (given) => {
          draw = given;
        },
        scratch: (width, height) => this.#scratch(width, height),
      });
      return { canvas, draw: (frame) => draw?.(frame) };
    });
    const { canvas } = instance;
    if (canvas.width !== this.#width || canvas.height !== this.#height) {
      canvas.width = this.#width;
      canvas.height = this.#height;
    }
    return instance;
  }

  /** What one frame took is free for the next. What no frame took for a while goes. */
  #end(): void {
    this.#lent = [];
    this.#frame += 1;
    this.#buffers.end(this.#frame, KEEP_FRAMES);
    this.#scratches.end(this.#frame, KEEP_FRAMES);
    for (const [type, pool] of this.#instances) {
      pool.end(this.#frame, KEEP_FRAMES);
      if (pool.size === 0) this.#instances.delete(type);
    }
    if (this.#nothing && this.#frame - this.#nothingTaken > KEEP_FRAMES) {
      letGo(this.#nothing);
      this.#nothing = undefined;
    }
  }
}
