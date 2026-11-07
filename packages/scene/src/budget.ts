/**
 * How much a frame may say. Anything a scene posts lands on the main thread of the page it is posted
 * to, and the content of a message only gets built when somebody reads `event.data`. So a scene that
 * talks too much can stop that page without ever being asked anything, and one big message can take
 * all its memory. The decision has to come before the reading, and it has to be per sender, or a
 * scene would use up what its neighbours have.
 *
 * Whoever receives messages from a frame needs this: the compositor from a scene, the editor from
 * anything, because a scene can reach `top` as easily as `parent`.
 */

/** A rate that allows for bursts. All times are in milliseconds. */
export class TokenBucket {
  readonly #capacity: number;
  readonly #perSecond: number;
  #tokens: number;
  #last: number;

  constructor(capacity: number, perSecond: number, now: number) {
    this.#capacity = capacity;
    this.#perSecond = perSecond;
    this.#tokens = capacity;
    this.#last = now;
  }

  /** Whether there is enough left. If so it is gone, and if not nothing changes. */
  take(cost: number, now: number): boolean {
    const elapsed = Math.max(now - this.#last, 0);
    this.#last = now;
    this.#tokens = Math.min(this.#tokens + (elapsed / 1000) * this.#perSecond, this.#capacity);
    if (cost > this.#tokens) return false;
    this.#tokens -= cost;
    return true;
  }
}

export interface MessageRules {
  /** Messages at once, and in the long run. A playing scene sends one for each frame. */
  readonly burstMessages: number;
  readonly messagesPerSecond: number;
  /** One message that weighs more than this is not one that the protocol has. */
  readonly maxMessageBytes: number;
  /** Bytes at once, and in the long run. */
  readonly burstBytes: number;
  readonly bytesPerSecond: number;
  /**
   * Pictures at once, and in the long run. A scene sends one when a frame of the screen came along,
   * so this is more than any screen does, and far less than a picture costs to make for no reason.
   */
  readonly burstPictures: number;
  readonly picturesPerSecond: number;
}

export const MESSAGE_RULES: MessageRules = {
  burstMessages: 2000,
  messagesPerSecond: 1000,
  maxMessageBytes: 64 * 1024,
  burstBytes: 4 * 1024 * 1024,
  bytesPerSecond: 1024 * 1024,
  burstPictures: 600,
  picturesPerSecond: 300,
};

/** What the structure around a value costs, as a rough figure. */
const NODE_BYTES = 16;
const BYTES_PER_PIXEL = 4;

/**
 * About how many bytes a message takes up. It stops looking at `limit`, so the time it takes has
 * nothing to do with what a sender made up, and a structure that refers to itself just gets heavy.
 */
export function weightOf(data: unknown, limit: number): number {
  const waiting: unknown[] = [data];
  let weight = 0;
  while (waiting.length > 0 && weight <= limit) {
    const value = waiting.pop();
    weight += NODE_BYTES;
    if (typeof value === "string") weight += value.length * 2;
    // As large as it likes, and nothing in the protocol is one.
    else if (typeof value === "bigint") return Number.POSITIVE_INFINITY;
    else if (typeof value !== "object" || value === null) continue;
    else if (value instanceof Blob) weight += value.size;
    else if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) {
      // Nothing about one shows otherwise, and a picture has no business being anywhere else.
      weight += value.width * value.height * BYTES_PER_PIXEL;
    } else if (value instanceof ArrayBuffer) weight += value.byteLength;
    else if (ArrayBuffer.isView(value)) weight += value.byteLength;
    else if (Array.isArray(value)) {
      for (const entry of value) {
        waiting.push(entry);
        weight += NODE_BYTES;
        if (weight > limit) break;
      }
    } else if (value instanceof Map) {
      for (const entry of value) {
        waiting.push(entry);
        weight += NODE_BYTES;
        if (weight > limit) break;
      }
    } else if (value instanceof Set) {
      for (const entry of value) {
        waiting.push(entry);
        weight += NODE_BYTES;
        if (weight > limit) break;
      }
    } else if (isPlain(value)) {
      for (const key of Object.keys(value)) {
        waiting.push(key, (value as Record<string, unknown>)[key]);
        weight += NODE_BYTES;
        if (weight > limit) break;
      }
    } else {
      // An error, a pattern, a wrapped string: whatever else can be sent hides what it holds, and
      // looking would cost what is being kept out. None of it is part of the protocol.
      return Number.POSITIVE_INFINITY;
    }
  }
  return weight;
}

const isPlain = (value: object) => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * For a page that nothing has any business writing to but one frame. Nothing in a scene needs to
 * write to the editor, so a few messages are a mistake and more than that are an attack. They are
 * not looked at, so their size cannot count, and a big one still takes hundreds of milliseconds just
 * to arrive. That makes how few it takes to find out the only thing that shortens an attack.
 */
export const FOREIGN_MESSAGE_RULES: MessageRules = {
  ...MESSAGE_RULES,
  burstMessages: 10,
  messagesPerSecond: 1,
};

/**
 * The child of a page that a window is in, however deep: a frame can hold frames without end, and
 * each of them can write. Going up always ends, at the top.
 */
export function childFrameOf(page: Window, source: Window | null): Window | undefined {
  let window = source;
  while (window) {
    const { parent } = window;
    if (parent === page) return window;
    if (!parent || parent === window) return undefined;
    window = parent;
  }
  return undefined;
}

/**
 * Where that child is among the frames of the page. The editor can use this to tell the compositor
 * which frame is writing to it: the index is the same seen from both.
 */
export function childFrameIndex(page: Window, source: Window | null): number | undefined {
  const child = childFrameOf(page, source);
  if (!child) return undefined;
  for (let index = 0; index < page.length; index += 1) if (page[index] === child) return index;
  return undefined;
}

export type MessageVerdict = "ok" | "flood" | "oversized";

/** What one sender has left. */
export class MessageBudget {
  readonly #rules: MessageRules;
  readonly #messages: TokenBucket;
  readonly #bytes: TokenBucket;

  constructor(now: number, rules: MessageRules = MESSAGE_RULES) {
    this.#rules = rules;
    this.#messages = new TokenBucket(rules.burstMessages, rules.messagesPerSecond, now);
    this.#bytes = new TokenBucket(rules.burstBytes, rules.bytesPerSecond, now);
  }

  /** Comes before anything reads `event.data`. Reading it is what is being protected. */
  admit(now: number): MessageVerdict {
    return this.#messages.take(1, now) ? "ok" : "flood";
  }

  /** Comes right after reading it. One big message is reason enough, however few came before. */
  weigh(data: unknown, now: number): MessageVerdict {
    const weight = weightOf(data, this.#rules.maxMessageBytes);
    if (weight > this.#rules.maxMessageBytes) return "oversized";
    return this.#bytes.take(weight, now) ? "ok" : "flood";
  }
}
