import {
  LfsRefused,
  type LfsAccess,
  type LfsAccount,
  type LfsAccountAccess,
  type LfsUpload,
} from "@animaquill/host";
import { createHash } from "@animaquill/media/hash";

/**
 * For the browser tests and for looking at the pages (`?cloud=fake`): the large file storage of the
 * pretend repositories, as the platform takes files into it (apps/api/src/lfs of AnimaQuill Cloud):
 * pieces at their offset, the file checked against its hash once all of it is there, a few
 * questions later in the storage. It lives as long as the page. A test sets up what it needs
 * through `window.aqCloud.lfs`: how long each piece takes, what the next requests say, and what
 * the storage has.
 */
export class LabLfs implements LfsAccess {
  /** What the storage has, by oid: its size. */
  readonly stored = new Map<string, number>();
  readonly uploads = new Map<
    string,
    { upload: LfsUpload; hash: ReturnType<typeof createHash>; asked: number }
  >();
  /** Milliseconds each piece takes, as on a slow line. */
  pieceMs = 0;
  /** The largest piece. */
  chunk = 256 * 1024;
  /** What the next requests say, in place of what they would. */
  faults: ("busy" | "unavailable" | "githubQuota" | "changed" | "tooLarge")[] = [];
  /** How many questions the storage takes to have a file, once it is checked. */
  pushingFor = 2;
  /** Pieces the platform took, by their size. */
  readonly pieces: number[] = [];
  #next = 0;
  readonly #repoOf: (project: string) => string;

  constructor(repoOf: (project: string) => string) {
    this.#repoOf = repoOf;
  }

  #fault(): void {
    const fault = this.faults[0];
    if (fault === undefined || fault === "changed") return;
    this.faults.shift();
    throw new LfsRefused(fault, fault === "busy" ? { retryAfter: 1 } : {});
  }

  async begin(project: string, { oid, size }: { oid: string; size: number }): Promise<LfsUpload> {
    this.#fault();
    const base = { repo: this.#repoOf(project), oid, size, chunk: this.chunk, minChunk: 1024 };
    if (this.faults[0] === "changed") {
      this.faults.shift();
      return { ...base, id: `x${this.#next++}`, state: "failed", received: 0, error: "changed" };
    }
    if (this.stored.get(oid) === size) return { ...base, state: "present", received: size };
    for (const each of this.uploads.values())
      if (
        each.upload.oid === oid &&
        ["receiving", "received", "pushing"].includes(each.upload.state)
      )
        return each.upload;
    const id = `upload-${this.#next++}`;
    const upload: LfsUpload = { ...base, id, state: "receiving", received: 0 };
    this.uploads.set(id, { upload, hash: createHash(), asked: 0 });
    return upload;
  }

  async send(id: string, offset: number, piece: Blob, { signal }: { signal?: AbortSignal } = {}) {
    if (this.pieceMs > 0)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.pieceMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
    this.#fault();
    const each = this.uploads.get(id);
    if (!each) throw new LfsRefused("notFound");
    const { upload } = each;
    if (upload.state !== "receiving") return upload;
    if (offset + piece.size <= upload.received) return upload;
    if (offset !== upload.received) throw new LfsRefused("offset", { received: upload.received });
    each.hash.update(new Uint8Array(await piece.arrayBuffer()));
    this.pieces.push(piece.size);
    each.upload = { ...upload, received: upload.received + piece.size };
    return each.upload;
  }

  async state(id: string): Promise<LfsUpload> {
    this.#fault();
    const each = this.uploads.get(id);
    if (!each) throw new LfsRefused("notFound");
    const { upload } = each;
    if (upload.state === "receiving" && upload.received === upload.size) {
      // `sha256-` and base64: Git LFS goes by hexadecimal.
      const digest = each.hash.digest().slice("sha256-".length);
      const hex = [...atob(digest.replaceAll("-", "+").replaceAll("_", "/"))]
        .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("");
      each.upload =
        hex === upload.oid
          ? { ...upload, state: "received" }
          : { ...upload, state: "failed", error: "changed" };
    } else if (upload.state === "received") each.upload = { ...upload, state: "pushing" };
    else if (upload.state === "pushing" && (each.asked += 1) >= this.pushingFor) {
      each.upload = { ...upload, state: "done" };
      this.stored.set(upload.oid, upload.size);
    }
    return each.upload;
  }

  async cancel(id: string): Promise<void> {
    const each = this.uploads.get(id);
    if (each) each.upload = { ...each.upload, state: "failed", error: "cancelled" };
  }
}

/** What the person has in the storage, and how they go about it, in this tab. */
export class LabLfsAccount implements LfsAccountAccess {
  acknowledgedAt: number | undefined;
  readonly auto = new Set<string>();
  /** What the storage page lists, as a test sets it up. */
  repositories: LfsAccount["repositories"] = [];
  readonly #account: () => string | undefined;

  constructor(account: () => string | undefined) {
    this.#account = account;
  }

  #now(): LfsAccount {
    return {
      account: this.#account() ?? "",
      ...(this.acknowledgedAt !== undefined && { acknowledgedAt: this.acknowledgedAt }),
      auto: [...this.auto],
      repositories: this.repositories,
    };
  }

  async read(): Promise<LfsAccount> {
    return this.#now();
  }

  async change(
    _account: string,
    changes: { acknowledged?: true; auto?: { project: string; on: boolean } },
  ): Promise<LfsAccount> {
    if (changes.acknowledged) this.acknowledgedAt ??= Date.now();
    // As the platform: only for someone who said they know what it means.
    if (changes.auto?.on && this.acknowledgedAt === undefined)
      throw new Error("The platform answered 409");
    if (changes.auto) {
      if (changes.auto.on) this.auto.add(changes.auto.project);
      else this.auto.delete(changes.auto.project);
    }
    return this.#now();
  }
}
