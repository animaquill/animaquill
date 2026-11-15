import type { AttachedImage, ImageRef } from "@animaquill/agent";
import { memoryChatImages, type ChatImageStore, type WindowMemory } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { ADDED_SIDE, MOST_PICTURES, pictureNote, shotOf, type FrameOf } from "./shots.ts";

/**
 * The pictures that go with the next message of a conversation: frames of the project and pictures
 * people add, kept with its draft in the memory of the window (which picture, see `ImageRef`) and
 * the pictures themselves where the host keeps the pictures of conversations, so that they are
 * there again after a reload.
 */

/** A picture of a draft, as the window keeps it. */
export interface DraftPicture {
  readonly id: string;
  readonly ref: ImageRef;
  /** For people: "画面 0:12/05", or the name of the file. */
  readonly label: string;
  /** Of a frame: which one. */
  readonly frame?: FrameOf;
}

export type Attachment =
  | {
      readonly id: string;
      readonly state: "working";
      readonly label: string;
      readonly cancel: () => void;
    }
  | { readonly id: string; readonly state: "ready"; readonly picture: DraftPicture }
  | {
      readonly id: string;
      readonly state: "failed";
      readonly label: string;
      /** The frame did not render, or the picture is not here any more. */
      readonly why: "render" | "missing";
    };

/** A frame to make a picture of, as the editor renders it. */
export interface FrameShot {
  readonly image: ImageBitmap;
  readonly frame: FrameOf;
}

export interface AttachmentsOptions {
  readonly memory?: WindowMemory | undefined;
  readonly images?: ChatImageStore | undefined;
  /** Renders the frame at the playhead; rejects where it cannot. Nothing where there is no project. */
  readonly shoot?: (signal: AbortSignal) => Promise<FrameShot | undefined>;
  /** How large a frame goes at most on its longer side; nothing for as it is. */
  readonly side: () => number | undefined;
  /** How many bytes a picture has at most, for the model of the conversation. */
  readonly maxBytes: () => number;
}

const keyOf = (project: string, chat: string) => `chat.pictures\n${project}\n${chat}`;

const isFrame = (value: unknown): value is FrameOf => {
  const frame = value as Partial<FrameOf> | undefined;
  return (
    typeof frame?.timeline === "string" &&
    typeof frame.t === "string" &&
    typeof frame.timecode === "string"
  );
};

function readKept(text: string | undefined): readonly DraftPicture[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item: Partial<DraftPicture>) =>
      typeof item?.id === "string" &&
      typeof item.label === "string" &&
      typeof item.ref?.image === "string"
        ? [
            {
              id: item.id,
              ref: item.ref,
              label: item.label,
              ...(isFrame(item.frame) && { frame: item.frame }),
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

let counter = 0;
const newId = () => `p${Date.now().toString(36)}${(counter += 1)}`;

/** Why a picture could not be added. */
export type AttachRefusal = "full" | "notPicture" | "unreadable" | "failed";

export class ChatAttachments {
  readonly #options: AttachmentsOptions;
  readonly #images: ChatImageStore;
  readonly #emitter = new Emitter();
  /** By draft: what the window keeps, and what is being made now. */
  readonly #lists = new Map<string, readonly Attachment[]>();
  /** Addresses of pictures to show, by their hash, for as long as the page. */
  readonly #urls = new Map<string, Promise<string | undefined>>();

  constructor(options: AttachmentsOptions) {
    this.#options = options;
    this.#images = options.images ?? memoryChatImages();
  }

  subscribe = this.#emitter.subscribe;

  /** The pictures of the draft of a conversation, in order. The same list while nothing changes. */
  list(project: string, chat: string): readonly Attachment[] {
    const key = keyOf(project, chat);
    const known = this.#lists.get(key);
    if (known) return known;
    const kept = readKept(this.#options.memory?.read(key)).map((picture): Attachment => ({
      id: picture.id,
      state: "ready",
      picture,
    }));
    this.#lists.set(key, kept);
    return kept;
  }

  /** The pictures of the drafts this window has read, which a clearing leaves. */
  draftImages(): ReadonlySet<string> {
    const found = new Set<string>();
    for (const list of this.#lists.values()) {
      for (const item of list) if (item.state === "ready") found.add(item.picture.ref.image);
    }
    return found;
  }

  /** Whether a draft has pictures, ready or on their way. */
  has(project: string, chat: string): boolean {
    return this.list(project, chat).length > 0;
  }

  #set(project: string, chat: string, list: readonly Attachment[]): void {
    const key = keyOf(project, chat);
    this.#lists.set(key, list);
    const ready = list.flatMap((item) => (item.state === "ready" ? [item.picture] : []));
    this.#options.memory?.write(key, ready.length > 0 ? JSON.stringify(ready) : "");
    this.#emitter.emit();
  }

  #change(project: string, chat: string, id: string, next: Attachment | undefined): void {
    const list = this.list(project, chat);
    if (!list.some((item) => item.id === id)) return;
    this.#set(
      project,
      chat,
      next === undefined
        ? list.filter((item) => item.id !== id)
        : list.map((item) => (item.id === id ? next : item)),
    );
  }

  /** Room for one more, at most `MOST_PICTURES`. */
  #full(project: string, chat: string): boolean {
    return this.list(project, chat).length >= MOST_PICTURES;
  }

  /**
   * Renders the frame at the playhead and adds it: the picture shows as it is made, and can be
   * cancelled meanwhile. Resolves to why it was not added, if it was not.
   */
  async shoot(project: string, chat: string, label: string): Promise<AttachRefusal | undefined> {
    const shoot = this.#options.shoot;
    if (!shoot) return "failed";
    if (this.#full(project, chat)) return "full";
    const id = newId();
    const controller = new AbortController();
    this.#set(project, chat, [
      ...this.list(project, chat),
      { id, state: "working", label, cancel: () => controller.abort() },
    ]);
    try {
      const shot = await shoot(controller.signal);
      controller.signal.throwIfAborted();
      if (!shot) {
        this.#change(project, chat, id, undefined);
        return "failed";
      }
      const made = await shotOf(shot.image, this.#options.side(), this.#options.maxBytes());
      shot.image.close();
      controller.signal.throwIfAborted();
      const ref = await this.#images.save(made.blob, made);
      this.#change(project, chat, id, {
        id,
        state: "ready",
        picture: { id, ref, label: `${label} ${shot.frame.timecode}`, frame: shot.frame },
      });
      return undefined;
    } catch (error) {
      if (controller.signal.aborted) {
        this.#change(project, chat, id, undefined);
        return undefined;
      }
      console.warn("No frame for the chat", error);
      this.#change(project, chat, id, { id, state: "failed", label, why: "render" });
      return "failed";
    }
  }

  /** Adds pictures people pasted, dropped or chose: each made to fit what models take. */
  async add(
    project: string,
    chat: string,
    files: readonly File[],
  ): Promise<AttachRefusal | undefined> {
    let refused: AttachRefusal | undefined;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        refused = "notPicture";
        continue;
      }
      if (this.#full(project, chat)) return "full";
      const id = newId();
      this.#set(project, chat, [
        ...this.list(project, chat),
        { id, state: "working", label: file.name, cancel: () => {} },
      ]);
      try {
        const image = await createImageBitmap(file);
        // A picture with transparency stays PNG where it fits, else goes on white.
        const made = await shotOf(image, ADDED_SIDE, this.#options.maxBytes(), true);
        image.close();
        const ref = await this.#images.save(made.blob, made);
        this.#change(project, chat, id, {
          id,
          state: "ready",
          picture: { id, ref, label: file.name || "image" },
        });
      } catch (error) {
        console.warn("A picture could not be read", error);
        this.#change(project, chat, id, undefined);
        // An image the browser cannot read, such as HEIC.
        refused = "unreadable";
      }
    }
    return refused;
  }

  remove(project: string, chat: string, id: string): void {
    const item = this.list(project, chat).find((each) => each.id === id);
    if (item?.state === "working") item.cancel();
    this.#change(project, chat, id, undefined);
  }

  clear(project: string, chat: string): void {
    for (const item of this.list(project, chat)) if (item.state === "working") item.cancel();
    this.#set(project, chat, []);
  }

  /** The pictures ready, as they go with a message: each with its line for the model. */
  ready(project: string, chat: string): readonly AttachedImage[] {
    const ready = this.list(project, chat).flatMap((item) =>
      item.state === "ready" ? [item.picture] : [],
    );
    return ready.map((picture, index) => attachedOf(picture, index + 1));
  }

  /**
   * Reads each picture ready once more before it goes: one this browser lost meanwhile (its
   * storage cleared while the window kept the draft) is marked, and the message waits.
   */
  async verify(project: string, chat: string): Promise<boolean> {
    let all = true;
    for (const item of this.list(project, chat)) {
      if (item.state !== "ready") continue;
      const blob = await this.#images.read(item.picture.ref.image).catch(() => undefined);
      if (blob) continue;
      all = false;
      this.#change(project, chat, item.id, {
        id: item.id,
        state: "failed",
        label: item.picture.label,
        why: "missing",
      });
    }
    return all;
  }

  /** Whether a picture is still being made. */
  busy(project: string, chat: string): boolean {
    return this.list(project, chat).some((item) => item.state === "working");
  }

  /** Pictures of a message that did not go out go back to its draft, ahead of any there. */
  restore(project: string, chat: string, images: readonly AttachedImage[]): void {
    if (images.length === 0) return;
    const back = images.map((image): Attachment => ({
      id: newId(),
      state: "ready",
      picture: draftOf(image),
    }));
    const have = this.list(project, chat).filter(
      (item) =>
        item.state !== "ready" || !images.some((image) => image.image === item.picture.ref.image),
    );
    this.#set(project, chat, [...back, ...have].slice(0, MOST_PICTURES));
  }

  /** The bytes of a picture, as base64, to send it. */
  async base64Of(
    ref: ImageRef,
  ): Promise<{ readonly data: string; readonly mimeType: string } | undefined> {
    const blob = await this.#images.read(ref.image);
    if (!blob) return undefined;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return { data: btoa(binary), mimeType: blob.type || ref.type };
  }

  /** An address to show a picture kept here at; nothing where it is not here. */
  urlOf(image: string): Promise<string | undefined> {
    let url = this.#urls.get(image);
    if (!url) {
      url = this.#images.read(image).then(
        (blob) => (blob ? URL.createObjectURL(blob) : undefined),
        () => undefined,
      );
      this.#urls.set(image, url);
    }
    return url;
  }
}

/** A picture of a draft as it goes with a message, the `number`th of it. */
export function attachedOf(picture: DraftPicture, number: number): AttachedImage {
  const { ref, label, frame } = picture;
  return {
    ...ref,
    note: pictureNote(number, { width: ref.width, height: ref.height, ...(frame && { frame }) }),
    label,
    ...(frame && { frame }),
  };
}

/** A picture of a message, as a draft keeps it again. */
function draftOf(image: AttachedImage): DraftPicture {
  const { image: hash, type, width, height, bytes, label, frame } = image;
  return {
    id: newId(),
    ref: { image: hash, type, width, height, bytes },
    label: label ?? "image",
    ...(frame && { frame }),
  };
}
