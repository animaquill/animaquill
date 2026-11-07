import { installIntl, installMeasures, installTemporal, clockDate } from "./time.ts";
import { fillRandom, randomUuid, seededRandom } from "./random.ts";

/** What a worker gets to know about the scene it belongs to. */
interface WorkerSetup {
  /** Every file as a worker can use it, by its path. */
  readonly files: Readonly<Record<string, string>>;
  /** What paths in this worker are relative to. */
  readonly base: string;
  readonly seed: number;
  readonly epoch: number;
  readonly global: string;
}

/** What it takes from the runtime. These travel as text too, each of them on its own. */
interface WorkerTools {
  readonly preludeText: typeof preludeText;
  readonly installMeasures: typeof installMeasures;
  readonly seededRandom: typeof seededRandom;
  readonly fillRandom: typeof fillRandom;
  readonly randomUuid: typeof randomUuid;
  readonly clockDate: typeof clockDate;
  readonly installIntl: typeof installIntl;
  readonly installTemporal: typeof installTemporal;
}

interface WorkerTimer {
  readonly id: number;
  at: number;
  readonly every: number | undefined;
  readonly run: () => void;
}

/**
 * What runs in a worker before any of the project's code. A worker has a realm of its own, and has
 * neither the scene's clock nor its files.
 *
 * Time in here has its own clock, and everything that tells the time or runs on it goes by that
 * clock, so what a worker does in itself is the same on every run. A timer really waits, because a
 * worker with an endless timer loop must not run flat out, but its clock only moves by what the timer
 * said. Reading the clock moves it by a tiny step, so that code that waits in a loop gets out of it.
 *
 * When an answer of a worker arrives at the scene is another matter. That is real time, and nothing
 * here can change it. The scene reports it.
 *
 * This function travels as text, so it has to stay on its own, with nothing from outside.
 */
function setUpWorker(setup: WorkerSetup, tools: WorkerTools): void {
  const FRAME_MS = 16;
  const { files, base, seed, epoch, global } = setup;
  const scope = self as unknown as Record<string, unknown> & {
    fetch: typeof fetch;
    importScripts?: (...urls: string[]) => void;
    requestAnimationFrame?: unknown;
    Worker?: typeof Worker;
  };

  /** A URL has more than one way of writing a path, and only the path itself says what it is. */
  const fileUrl = (address: string, from = base) => {
    try {
      const { protocol, pathname } = new URL(address, from);
      if (protocol !== "aq:") return undefined;
      const parts = pathname.split("/").map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
      return files[parts.slice(1).join("/")];
    } catch {
      return undefined;
    }
  };
  const realFetch = scope.fetch.bind(scope);
  scope.fetch = (input, init) => {
    const url = fileUrl(String(input instanceof Request ? input.url : input));
    return url === undefined ? realFetch(input, init) : realFetch(url, init);
  };
  const realImport = scope.importScripts?.bind(scope);
  if (realImport) {
    scope.importScripts = (...urls) => realImport(...urls.map((url) => fileUrl(url) ?? url));
  }
  const open = XMLHttpRequest.prototype.open as (...args: unknown[]) => void;
  XMLHttpRequest.prototype.open = function openFile(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    open.call(this, method, fileUrl(String(url)) ?? url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;

  // What a worker starts gets all of this too, or it would have the real time and real numbers.
  const RealWorker = scope.Worker;
  if (RealWorker) {
    scope.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        const address = String(url);
        const file = fileUrl(address);
        const from = file === undefined ? base : new URL(address, base).href;
        const first = tools.preludeText(setUpWorker, { ...setup, base: from }, tools);
        const then = JSON.stringify(file ?? address);
        const start =
          options?.type === "module" ? `${global}.start(${then});` : `importScripts(${then});`;
        const script = new Blob([first + start], { type: "text/javascript" });
        super(URL.createObjectURL(script), { ...options, type: "classic" });
      }
    };
  }
  scope[global] = {
    spec: (specifier: string, from: string) => fileUrl(specifier, from) ?? specifier,
    load: (module: unknown) => module,
    /** Runs a module in a classic worker, which is the only kind a scene can start. */
    start(url: string) {
      // A module arrives later than a classic script would, and messages would not wait for it.
      const early: MessageEvent[] = [];
      const keep = (event: Event) => early.push(event as MessageEvent);
      addEventListener("message", keep);
      void import(url).then(
        () => {
          removeEventListener("message", keep);
          for (const { data, ports } of early) {
            dispatchEvent(new MessageEvent("message", { data, ports: [...ports] }));
          }
        },
        (error: unknown) => {
          // Thrown from a task of its own, it reaches the worker's `error` event on the page. That
          // event only has room for a message, so the place has to travel in there.
          realSetTimeout(() => {
            throw new Error(String((error as Error)?.stack ?? error));
          }, 0);
        },
      );
    },
  };

  const numbers = tools.seededRandom(seed);
  const bytes = tools.seededRandom(seed ^ 0x5bd1e995);
  Math.random = numbers;
  Crypto.prototype.getRandomValues = function getRandomValues<T extends ArrayBufferView | null>(
    array: T,
  ): T {
    return array && tools.fillRandom(bytes, array);
  };
  if ("randomUUID" in Crypto.prototype) {
    Crypto.prototype.randomUUID = function randomUUID() {
      const uuid = tools.randomUuid(bytes, tools.fillRandom);
      return uuid as `${string}-${string}-${string}-${string}-${string}`;
    };
  }

  let clock = 0;
  const now = () => (clock += 0.001);
  const wall = () => epoch + now();
  performance.now = now;
  Object.defineProperty(Performance.prototype, "timeOrigin", { get: () => epoch });
  tools.installMeasures(() => clock);
  Object.defineProperty(Event.prototype, "timeStamp", { get: () => clock });
  scope.Date = tools.clockDate(Date, wall);
  tools.installIntl(wall);
  tools.installTemporal(wall);

  const realSetTimeout = setTimeout.bind(scope);
  const realClearTimeout = clearTimeout.bind(scope);
  const timers: WorkerTimer[] = [];
  let nextTimer = 1;
  let waiting: ReturnType<typeof setTimeout> | undefined;

  const wake = () => {
    if (waiting !== undefined) realClearTimeout(waiting);
    waiting = undefined;
    const [first] = timers;
    if (first) waiting = realSetTimeout(runFirst, Math.max(first.at - clock, 0));
  };
  const schedule = (timer: WorkerTimer) => {
    const after = timers.findIndex(({ at }) => at > timer.at);
    timers.splice(after === -1 ? timers.length : after, 0, timer);
  };
  function runFirst() {
    waiting = undefined;
    const timer = timers.shift();
    if (!timer) return;
    clock = Math.max(clock, timer.at);
    if (timer.every !== undefined) {
      // At least a little, or an interval of 0 would keep everything else from ever running.
      timer.at = clock + Math.max(timer.every, 1);
      schedule(timer);
    }
    wake();
    timer.run();
  }
  const setTimer = (handler: TimerHandler, delay: unknown, args: unknown[], repeat: boolean) => {
    const wait = Math.max(Number(delay) | 0, 0);
    const id = nextTimer;
    nextTimer += 1;
    schedule({
      id,
      at: clock + wait,
      every: repeat ? wait : undefined,
      run: () => {
        if (typeof handler === "function") (handler as (...all: unknown[]) => void)(...args);
        // oxlint-disable-next-line no-new-func -- a timer with a string is older than this rule
        else new Function(String(handler))();
      },
    });
    wake();
    return id;
  };
  const clearTimer = (id: unknown) => {
    const index = timers.findIndex((timer) => timer.id === Number(id));
    if (index !== -1) timers.splice(index, 1);
    wake();
  };
  scope.setTimeout = (handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    setTimer(handler, delay, args, false);
  scope.setInterval = (handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    setTimer(handler, delay, args, true);
  scope.clearTimeout = clearTimer;
  scope.clearInterval = clearTimer;
  if (scope.requestAnimationFrame) {
    scope.requestAnimationFrame = (run: (time: number) => void) =>
      setTimer(() => run(clock), FRAME_MS, [], false);
    scope.cancelAnimationFrame = clearTimer;
  }
}

/** The text of a script that does all that. A worker can start workers, so this travels as well. */
function preludeText(
  setUp: (setup: WorkerSetup, tools: WorkerTools) => void,
  setup: WorkerSetup,
  tools: WorkerTools,
): string {
  const list = Object.entries(tools).map(([name, tool]) => `${name}:${String(tool)}`);
  return `(${String(setUp)})(${JSON.stringify(setup)},{${list.join(",")}});`;
}

export function workerPrelude(setup: WorkerSetup): string {
  return preludeText(setUpWorker, setup, {
    preludeText,
    installMeasures,
    seededRandom,
    fillRandom,
    randomUuid,
    clockDate,
    installIntl,
    installTemporal,
  });
}
