import { childFrameIndex, FOREIGN_MESSAGE_RULES, MessageBudget } from "../../src/index.ts";
import { COMPOSITOR } from "../hosts.ts";
import type { Call, Reply } from "./messages.ts";

/**
 * The top of the page, standing in for the editor. It has nothing to do with scenes except what the
 * real one has: it is the only one that may talk to the compositor, and what comes from anywhere
 * else never gets read. A scene can write here as easily as to its parent, so this also has to keep
 * count, and tell the compositor which frame has to go. The same goes for the keyboard: a scene can
 * take it, and this takes it back and tells the compositor, which knows who that was.
 */
const frame = document.createElement("iframe");
frame.setAttribute("sandbox", "allow-scripts");
frame.style.cssText = "position:fixed;left:0;top:0;width:1400px;height:800px;border:0";
frame.src = `${COMPOSITOR}/compositor.html`;

let nextCall = 1;
const waiting = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
/** How many messages reached this page from anybody but the compositor. They must change nothing. */
let foreign = 0;
/** How many of those got read. Reading is what builds a message, so this has to stay at nothing. */
let foreignReads = 0;
const readData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")?.get;
Object.defineProperty(MessageEvent.prototype, "data", {
  get(this: MessageEvent) {
    if (this.source !== frame.contentWindow) foreignReads += 1;
    return readData?.call(this);
  },
});
const foreignBudgets = new WeakMap<object, MessageBudget>();
/** Once is enough: everything it wrote until it went arrives here too, and frames move up. */
const reported = new WeakSet<object>();
const { promise: compositorReady, resolve: compositorIsReady } = Promise.withResolvers<void>();

function checkForeign(source: MessageEventSource): void {
  const now = performance.now();
  foreign += 1;
  let budget = foreignBudgets.get(source);
  if (!budget) {
    budget = new MessageBudget(now, FOREIGN_MESSAGE_RULES);
    foreignBudgets.set(source, budget);
  }
  if (budget.admit(now) === "ok" || reported.has(source)) return;
  reported.add(source);
  const index = frame.contentWindow && childFrameIndex(frame.contentWindow, source as Window);
  if (index !== undefined && index !== null) void lab.call("evict", index);
}

addEventListener("message", (event: MessageEvent<Reply | { hello: true }>) => {
  // Reading the data is what builds a message. Nothing here reads it before it knows who wrote it.
  const { source } = event;
  if (source !== frame.contentWindow) {
    if (source) checkForeign(source);
    return;
  }
  const { data } = event;
  if ("hello" in data) {
    compositorIsReady();
    return;
  }
  const entry = waiting.get(data.reply);
  waiting.delete(data.reply);
  if (data.error !== undefined) entry?.reject(new Error(data.error));
  else entry?.resolve(data.value);
});

/** What the keyboard goes back to, if it was anywhere. */
let focused: HTMLElement | undefined;
document.addEventListener("focusin", ({ target }) => {
  if (target !== frame) focused = target as HTMLElement;
});

/** The compositor answers right away unless it hangs, and it should not cost the keyboard then. */
const NO_ANSWER_MS = 30;
let takingBack = false;

function takeBack(): void {
  takingBack = false;
  window.focus();
  if (focused?.isConnected) focused.focus();
}

addEventListener("blur", () => {
  if (document.activeElement !== frame || takingBack) return;
  takingBack = true;
  // Asking comes first. Only while the focus is in there can the compositor see who took it, and
  // taking it back in this very event would look as if it worked, while keys go on going to the
  // frame: the browser is still busy moving the focus.
  void Promise.race([
    lab.call("focusTaken"),
    new Promise((done) => setTimeout(done, NO_ANSWER_MS)),
  ]).then(takeBack, takeBack);
});

document.body.append(frame);

const lab = {
  async call(method: string, ...args: unknown[]): Promise<unknown> {
    await compositorReady;
    const call = nextCall;
    nextCall += 1;
    const message: Call = { call, method, args };
    frame.contentWindow?.postMessage(message, "*");
    return new Promise((resolve, reject) => waiting.set(call, { resolve, reject }));
  },
  foreign: () => foreign,
  foreignReads: () => foreignReads,
};

Object.assign(window, { lab });
