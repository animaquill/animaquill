import { Watchdog, WATCHDOG_RULES, type ScenePhase, type WatchdogRules } from "@animaquill/scene";

/** How often the watchdog looks. It decides by itself when to ask. */
const WATCH_EVERY_MS = 200;

/**
 * Longer than for a scene: when the compositor really hangs nothing is lost by waiting, and starting
 * it again for no reason costs the picture. Loading depends on the network.
 */
export const COMPOSITOR_RULES: WatchdogRules = {
  ...WATCHDOG_RULES,
  limitMs: { hello: 30000, loading: 30000, running: 8000 },
};

/** A number that only something that read the message can know. */
const randomNonce = () => crypto.getRandomValues(new Uint32Array(1))[0] as number;

/**
 * Keeps an eye on the compositor. Scenes run below it, and in a browser that does not keep them
 * apart a scene that hangs takes it along, which leaves people looking at a picture that stands
 * still with nothing that says why. A crash looks the same from here.
 */
export class CompositorWatch {
  readonly #dog: Watchdog;
  readonly #ping: (nonce: number) => void;
  readonly #silent: (phase: ScenePhase) => void;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(
    ping: (nonce: number) => void,
    silent: (phase: ScenePhase) => void,
    rules: WatchdogRules = COMPOSITOR_RULES,
  ) {
    this.#dog = new Watchdog(performance.now(), rules);
    this.#ping = ping;
    this.#silent = silent;
    this.#timer = setInterval(this.#check, WATCH_EVERY_MS);
  }

  dispose(): void {
    clearInterval(this.#timer);
  }

  /** It said hello. */
  ready(): void {
    this.#dog.enter("running");
  }

  pong(nonce: number): void {
    this.#dog.answered(nonce);
  }

  #check = (): void => {
    const verdict = this.#dog.check(performance.now(), document.visibilityState === "visible");
    if (verdict === "silent" || verdict === "stuck") {
      this.dispose();
      this.#silent(this.#dog.phase);
    } else if (verdict === "ping") {
      const nonce = randomNonce();
      this.#dog.pinged(nonce);
      this.#ping(nonce);
    }
  };
}
