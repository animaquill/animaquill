import type { WindowPlace } from "@animaquill/host";

/** How long to wait before trying again when reading or writing failed and nothing else happens. */
const RETRY_AFTER_MS = 5000;

export interface KeeperMessages {
  /** What was kept could not be read. It stays where it is, and gets tried again. */
  readFailed(): void;
  /** This device cannot hold it, so that a reload would lose it. */
  keepFailed(): void;
  keepRecovered(): void;
}

/**
 * Brings back what a window kept, and puts what it has now on the device as soon as it changes, one
 * write at a time. Nothing gets written before what was kept has been read: that would replace it.
 */
export class PlaceKeeper {
  readonly #stored: () => unknown;
  readonly #open: () => Promise<WindowPlace>;
  readonly #messages: KeeperMessages;
  readonly #onRead: (kept: unknown) => void;
  #place: WindowPlace | undefined;
  #working: Promise<void> | undefined;
  #hasRead = false;
  /** What is here is not on the device yet. */
  #isBehind = false;
  #isPaused = false;
  /** This window has left: what was kept is for the next one. */
  #hasLeft = false;
  #isClosed = false;
  #retry: ReturnType<typeof setTimeout> | undefined;
  /** Saying it once is enough, until it works again. */
  failed = false;

  constructor(
    stored: () => unknown,
    open: () => Promise<WindowPlace>,
    messages: KeeperMessages,
    onRead: (kept: unknown) => void,
  ) {
    this.#stored = stored;
    this.#open = open;
    this.#messages = messages;
    this.#onRead = onRead;
    this.#start();
  }

  keep(): void {
    this.#isBehind = true;
    this.#start();
  }

  /** Whether something is still on its way to the device. */
  get isBusy(): boolean {
    return this.#working !== undefined || this.#isBehind;
  }

  /** Nothing gets written from here on, which leaves what is on the device as it is. */
  pause(): void {
    this.#isPaused = true;
  }

  resume(): void {
    if (!this.#isPaused) return;
    this.#isPaused = false;
    if (this.#isBehind) this.#start();
  }

  #start(): void {
    if (this.#isPaused || this.#isClosed) return;
    this.#working ??= this.#work().finally(() => {
      this.#working = undefined;
    });
  }

  /** Says it once, and keeps trying: whatever it was can pass while the project is open. */
  #fail(what: string, error: unknown, tell: () => void): void {
    if (!this.failed) {
      console.warn(what, error);
      tell();
    }
    this.failed = true;
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => this.#start(), RETRY_AFTER_MS);
  }

  async #getPlace(): Promise<WindowPlace | undefined> {
    try {
      this.#place ??= await this.#open();
    } catch (error) {
      this.#fail("There is no place to keep this", error, () => {
        this.#messages.keepFailed();
      });
    }
    return this.#place;
  }

  async #read(place: WindowPlace): Promise<void> {
    try {
      const kept = await place.load();
      if (this.#hasLeft) return;
      this.#hasRead = true;
      // Only writing can say that it works again.
      this.#isBehind ||= this.failed;
      this.#onRead(kept);
    } catch (error) {
      this.#fail("What was kept could not be read", error, () => {
        this.#messages.readFailed();
      });
    }
  }

  async #write(place: WindowPlace): Promise<void> {
    while (this.#isBehind && !this.#isPaused) {
      this.#isBehind = false;
      try {
        await place.save(this.#stored());
        if (this.failed) this.#messages.keepRecovered();
        this.failed = false;
      } catch (error) {
        this.#isBehind = true;
        this.#fail("This could not be kept", error, () => {
          this.#messages.keepFailed();
        });
        return;
      }
    }
  }

  async #work(): Promise<void> {
    const place = await this.#getPlace();
    if (!place) return;
    if (!this.#hasRead) await this.#read(place);
    if (this.#hasRead) await this.#write(place);
  }

  /**
   * Resolves to whether all of it is on the device, which is worth another try: the disk may have
   * room again by now, and nobody should be told otherwise on the way out.
   */
  async settled(): Promise<boolean> {
    if (this.failed) this.#start();
    while (this.#working) await this.#working;
    return !this.failed;
  }

  /** Writes what is left, and only then lets go of the place: the next window finds it all there. */
  async close(): Promise<void> {
    this.#hasLeft = true;
    await this.settled();
    this.#isClosed = true;
    clearTimeout(this.#retry);
    this.#place?.close();
  }
}
