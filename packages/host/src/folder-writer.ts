import type { FolderWriter, WriterClaim } from "./index.ts";

/**
 * Which window of a browser writes a folder. Web Locks give the turn to one window at a time and to
 * the next one once it lets go, also when it goes away. A browser can put a window to sleep with its
 * turn, which is why the others can ask whether it still answers, and take over when it does not.
 */
const PREFIX = "animaquill.folder-writer.";

interface Word {
  readonly kind: "ping" | "pong";
  readonly id: string;
}

type Channel = (name: string) => BroadcastChannel | undefined;

const newId = () => crypto.getRandomValues(new Uint32Array(2)).join("-");

const isWord = (data: unknown, kind: Word["kind"]): data is Word =>
  typeof data === "object" && data !== null && (data as Partial<Word>).kind === kind;

/** Answers whoever asks whether the window that writes is still there. Returns how to stop. */
function answering(line: BroadcastChannel | undefined): () => void {
  if (!line) return () => {};
  const onMessage = ({ data }: MessageEvent<unknown>) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
    if (isWord(data, "ping")) line.postMessage({ kind: "pong", id: data.id } satisfies Word);
  };
  line.addEventListener("message", onMessage);
  return () => {
    line.removeEventListener("message", onMessage);
    line.close();
  };
}

/** Without Web Locks every window writes: there is nothing that could keep them apart. */
const ALONE: WriterClaim = { lost: new Promise(() => {}), release: () => {} };

export function browserFolderWriter(
  folder: string,
  locks: () => LockManager | undefined,
  channel: Channel = (name) =>
    typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(name),
): FolderWriter {
  const name = `${PREFIX}${folder}`;
  return {
    async claim({ signal, steal = false, onWaiting } = {}) {
      const manager = locks();
      if (!manager) return ALONE;
      if (!steal && onWaiting) {
        const { held = [] } = await manager.query().catch(() => ({ held: undefined }));
        if (held.some((lock) => lock.name === name)) onWaiting();
      }
      return new Promise<WriterClaim>((resolve, reject) => {
        let lose = () => {};
        const lost = new Promise<void>((settle) => {
          lose = settle;
        });
        let stopAnswering = () => {};
        let isGranted = false;
        // Taking over cannot wait, and so it cannot be stopped either.
        const options: LockOptions = steal ? { steal: true } : signal ? { signal } : {};
        manager
          .request(name, options, () => {
            isGranted = true;
            stopAnswering = answering(channel(name));
            return new Promise<void>((release) => {
              resolve({
                lost,
                release: () => {
                  stopAnswering();
                  release();
                },
              });
            });
          })
          .then(
            () => {
              stopAnswering();
              lose();
            },
            (error: unknown) => {
              // Another window took over, which only says so here.
              stopAnswering();
              if (isGranted) lose();
              else reject(error);
            },
          );
      });
    },
    async answers(timeoutMs) {
      const manager = locks();
      const line = manager && channel(name);
      if (!line) return true;
      const { held = [] } = await manager.query().catch(() => ({ held: undefined }));
      if (!held.some((lock) => lock.name === name)) {
        line.close();
        return true;
      }
      const id = newId();
      return new Promise<boolean>((resolve) => {
        const done = (answer: boolean) => {
          clearTimeout(timer);
          line.close();
          resolve(answer);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        line.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
          if (isWord(data, "pong") && data.id === id) done(true);
        });
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
        line.postMessage({ kind: "ping", id } satisfies Word);
      });
    },
  };
}

/** A page of a browser in memory, as far as writing folders goes. */
export interface WriterPage {
  /** Whether the page is still there: one ends when its browser goes away. */
  readonly isAlive: () => boolean;
  /** Asleep, as a browser puts a page to sleep: it holds on to its turn and answers nobody. */
  asleep: boolean;
}

interface Holder {
  readonly page: WriterPage;
  readonly lose: () => void;
}

interface Waiter {
  readonly page: WriterPage;
  readonly grant: () => void;
}

interface Turns {
  holder: Holder | undefined;
  readonly waiting: Waiter[];
}

/** For tests: the turns to write folders of all pages of a browser in memory, as Web Locks give them. */
export class MemoryWriters {
  readonly #turns = new Map<string, Turns>();

  /** Lets go of the turns of pages that went away, as the browser does. */
  sweep(): void {
    for (const turns of this.#turns.values()) {
      if (turns.holder && !turns.holder.page.isAlive()) {
        const { lose } = turns.holder;
        turns.holder = undefined;
        lose();
      }
      this.#next(turns);
    }
  }

  writer(folder: string, page: WriterPage): FolderWriter {
    const turns = this.#turnsOf(folder);
    return {
      claim: ({ signal, steal = false, onWaiting } = {}) =>
        new Promise<WriterClaim>((resolve, reject) => {
          if (!page.isAlive()) {
            reject(new DOMException("The page went away", "AbortError"));
            return;
          }
          signal?.throwIfAborted();
          const grant = () => {
            let lose = () => {};
            const lost = new Promise<void>((settle) => {
              lose = settle;
            });
            const holder: Holder = { page, lose };
            turns.holder = holder;
            resolve({
              lost,
              release: () => {
                if (turns.holder !== holder) return;
                turns.holder = undefined;
                lose();
                this.#next(turns);
              },
            });
          };
          if (steal) {
            const before = turns.holder;
            turns.holder = undefined;
            before?.lose();
            grant();
            return;
          }
          if (!turns.holder && turns.waiting.length === 0) {
            grant();
            return;
          }
          const waiter: Waiter = { page, grant };
          turns.waiting.push(waiter);
          onWaiting?.();
          signal?.addEventListener("abort", () => {
            const index = turns.waiting.indexOf(waiter);
            if (index < 0) return;
            turns.waiting.splice(index, 1);
            reject(signal.reason);
          });
        }),
      answers: (timeoutMs) => {
        const { holder } = turns;
        if (!holder?.page.asleep || !holder.page.isAlive()) return Promise.resolve(true);
        return new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs));
      },
    };
  }

  #turnsOf(folder: string): Turns {
    let turns = this.#turns.get(folder);
    if (!turns) {
      turns = { holder: undefined, waiting: [] };
      this.#turns.set(folder, turns);
    }
    return turns;
  }

  #next(turns: Turns): void {
    while (!turns.holder) {
      const waiter = turns.waiting.shift();
      if (!waiter) return;
      if (waiter.page.isAlive()) waiter.grant();
    }
  }
}
