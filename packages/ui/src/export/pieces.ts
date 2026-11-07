import type { ExportStore } from "@animaquill/host";
import type { EncodedFrame } from "@animaquill/media";

/** About this much of encoded media goes into one piece: a write is a transaction on the disk. */
const PIECE_BYTES = 1024 * 1024;

/** One packet in a piece: where it is, and what it is. Times are in seconds. */
export interface PacketEntry {
  readonly size: number;
  readonly timestamp: number;
  readonly duration: number;
  readonly key: boolean;
}

/**
 * Collects the packets of one track into pieces and keeps them in the store, in order. Nothing of it
 * stays in memory longer than it takes to fill a piece.
 */
export class PieceWriter {
  readonly #store: ExportStore;
  readonly #id: string;
  readonly #track: string;
  #seq: number;
  #parts: Uint8Array<ArrayBuffer>[] = [];
  #entries: PacketEntry[] = [];
  #bytes = 0;

  constructor(store: ExportStore, id: string, track: string, nextSeq = 0) {
    this.#store = store;
    this.#id = id;
    this.#track = track;
    this.#seq = nextSeq;
  }

  /** The number the next piece gets, which is how many there are. */
  get nextSeq(): number {
    return this.#seq;
  }

  /**
   * Forgets what it has not written yet, and goes on as if only the pieces before this one were
   * there. Taking those that are after it out of the store is up to whoever goes back.
   */
  rewind(seq: number): void {
    this.#seq = seq;
    this.#parts = [];
    this.#entries = [];
    this.#bytes = 0;
  }

  async add({ data, timestamp, duration, key }: EncodedFrame): Promise<void> {
    this.#parts.push(data as Uint8Array<ArrayBuffer>);
    this.#entries.push({ size: data.byteLength, timestamp, duration, key });
    this.#bytes += data.byteLength;
    if (this.#bytes >= PIECE_BYTES) await this.flush();
  }

  /** What was added is in the store once this is over. */
  async flush(): Promise<void> {
    if (this.#entries.length === 0) return;
    const piece = { seq: this.#seq, data: new Blob(this.#parts), index: this.#entries };
    this.#seq += 1;
    this.#parts = [];
    this.#entries = [];
    this.#bytes = 0;
    await this.#store.addPiece(this.#id, this.#track, piece);
  }
}

/** The packets of a track, in the order they were written, a piece at a time. */
export async function* packetsOf(
  store: ExportStore,
  id: string,
  track: string,
): AsyncGenerator<EncodedFrame> {
  for await (const { data, index } of store.pieces(id, track)) {
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await data.arrayBuffer());
    let at = 0;
    for (const { size, timestamp, duration, key } of index as readonly PacketEntry[]) {
      yield { data: bytes.slice(at, at + size), timestamp, duration, key };
      at += size;
    }
  }
}

/** Where both tracks go, in the order of their time. */
export interface TrackSink {
  add(frame: EncodedFrame): Promise<void>;
  addSound(frame: EncodedFrame): Promise<void>;
}

/**
 * Puts what was kept into a file: picture and sound in turns, by time, which is what lets a player
 * read the file front to back. Says how many packets are done as it goes.
 */
export async function writeTracks(
  store: ExportStore,
  id: string,
  sink: TrackSink,
  onPacket: () => void = () => {},
): Promise<void> {
  const video = packetsOf(store, id, "video");
  const sound = packetsOf(store, id, "sound");
  let picture = await video.next();
  let heard = await sound.next();
  while (!picture.done || !heard.done) {
    const soundFirst =
      !heard.done && (picture.done || heard.value.timestamp < picture.value.timestamp);
    if (soundFirst && !heard.done) {
      await sink.addSound(heard.value);
      heard = await sound.next();
    } else if (!picture.done) {
      await sink.add(picture.value);
      picture = await video.next();
    }
    onPacket();
  }
}
