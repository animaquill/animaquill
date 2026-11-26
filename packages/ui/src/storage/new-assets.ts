import type { TFunction } from "i18next";
import type { NotificationAction, NotificationOptions } from "../workbench/notifications.ts";
import { formatSize } from "../transfer/transfer.ts";
import { Emitter } from "../workbench/emitter.ts";
import { planImport, type DefaultPlace } from "./default-place.ts";

/**
 * Assets just imported into the open project go where its default storage says
 * (docs/design/online-offline.md of AnimaQuill Cloud, 1.7): into the large file storage of its
 * repository by themselves, once people said they know what that means. Until then they wait here,
 * gathered into one notification that asks, and stay here unless people say so. A large file is
 * told of, with a way to keep it here; one too large for the storage stays here, which people hear.
 * One import, at most one notification. No DOM.
 *
 * Only imports come here: an asset whose upload people cancelled, or that was too large, is not
 * sent again by itself; "把已有的也换过去…" and the place of each asset still can.
 */

type Assets = Readonly<
  Record<
    string,
    | {
        readonly hash?: string | undefined;
        readonly size?: number | undefined;
        readonly name?: string | undefined;
        readonly path: string;
      }
    | undefined
  >
>;

export interface NewAssetsOptions {
  readonly t: TFunction;
  /**
   * The open project, as far as uploads go: its key and default here, or none to send to. `local`:
   * its repository is one of the server's own, whose disk costs people nothing of GitHub's: nothing
   * is asked first, and nobody hears of how large files are.
   */
  readonly project: () =>
    { readonly key: string; readonly place: DefaultPlace; readonly local?: boolean } | undefined;
  readonly assets: () => Assets;
  /** Whether people said they know what the storage means, asking the backend where not known. */
  readonly acknowledged: () => Promise<boolean>;
  /** People said so now: kept for their account. Resolves to whether it took. */
  readonly acknowledge: () => Promise<boolean>;
  readonly send: (assets: readonly string[]) => Promise<unknown>;
  readonly cancel: (asset: string) => Promise<void>;
  /** The default of the open project becomes this computer, as a step that undo takes back. */
  readonly keepHere: () => void;
  /** Shows a notification, or another text in place of one still there. Resolves to its id. */
  readonly notify: (message: string, options: NotificationOptions, instead?: number) => number;
  readonly dismiss: (id: number) => void;
  readonly failed: (message: string) => void;
  /**
   * `large`: a file told of; `most`: the largest the storage takes; `batch`: one import, all its
   * files together, told of.
   */
  readonly sizes: { readonly large: number; readonly most: number; readonly batch: number };
}

/** What waits for people to say they know, for one project. */
interface Waiting {
  readonly key: string;
  readonly send: Set<string>;
  readonly large: Set<string>;
  readonly tooLarge: Set<string>;
  notice: number | undefined;
}

/** What is said of one file, and of more. */
const TEXTS = {
  ask: ["storage.uploads.notice.askOne", "storage.uploads.notice.askMany"],
  askLarge: ["storage.uploads.notice.askLargeOne", "storage.uploads.notice.askLargeMany"],
  large: ["storage.uploads.notice.largeOne", "storage.uploads.notice.largeMany"],
  tooLarge: ["storage.uploads.notice.tooLargeOne", "storage.uploads.notice.tooLargeMany"],
} as const;

export class NewAssets {
  readonly #options: NewAssetsOptions;
  readonly #emitter = new Emitter();
  #waiting: Waiting | undefined;
  #shown: ReadonlySet<string> = new Set();

  subscribe = this.#emitter.subscribe;
  /** The assets that wait for people to say they know, in this window: shown as such. */
  getSnapshot = (): ReadonlySet<string> => this.#shown;

  #changed(): void {
    const now = this.#waiting?.send ?? new Set<string>();
    if (now.size === this.#shown.size && [...now].every((id) => this.#shown.has(id))) return;
    this.#shown = new Set(now);
    this.#emitter.emit();
  }

  constructor(options: NewAssetsOptions) {
    this.#options = options;
  }

  /** What waits right now, for tests and for nobody else. */
  get waiting(): readonly string[] {
    return [...(this.#waiting?.send ?? [])];
  }

  /**
   * People said they know elsewhere, as in the dialog of where assets go: what waited goes, and
   * the notification that asked is over.
   */
  knownNow(): void {
    const waiting = this.#waiting;
    if (!waiting) return;
    if (waiting.notice !== undefined) this.#options.dismiss(waiting.notice);
    this.#waiting = undefined;
    this.#changed();
    if (this.#options.project()?.key === waiting.key) void this.#options.send([...waiting.send]);
  }

  /** The project closed: what waited stays here, as it is. */
  reset(): void {
    if (this.#waiting?.notice !== undefined) this.#options.dismiss(this.#waiting.notice);
    this.#waiting = undefined;
    this.#changed();
  }

  /** Assets just imported into the open project. */
  async imported(ids: readonly string[]): Promise<void> {
    const { project, assets } = this.#options;
    const open = project();
    if (!open || ids.length === 0) return;
    const sizes = this.#sizesFor(open);
    const plan = planImport(ids, assets(), open.place.effective, sizes);
    if (plan.send.length === 0 && plan.tooLarge.length === 0) return;
    const knows =
      plan.send.length > 0 && open.local !== true ? await this.#options.acknowledged() : true;
    // Another project meanwhile: these are not its assets.
    if (project()?.key !== open.key) return;
    if (!knows) {
      this.#wait(open.key, plan);
      return;
    }
    if (plan.send.length > 0) await this.#options.send(plan.send);
    this.#tell(open.key, plan, sizes);
  }

  /** What is told of, for a project: of a repository of the server's own, only what it does not take. */
  #sizesFor(open: { readonly local?: boolean }): NewAssetsOptions["sizes"] {
    const { sizes } = this.#options;
    return open.local === true ? { ...sizes, large: Infinity, batch: Infinity } : sizes;
  }

  #bytes(ids: Iterable<string>): number {
    const all = this.#options.assets();
    let bytes = 0;
    for (const id of ids) bytes += all[id]?.size ?? 0;
    return bytes;
  }

  #names(ids: Iterable<string>): { count: number; name: string; size: string } {
    const all = this.#options.assets();
    const list = [...ids];
    const first = list[0] === undefined ? undefined : all[list[0]];
    const bytes = list.reduce((sum, id) => sum + (all[id]?.size ?? 0), 0);
    return {
      count: list.length,
      name: first?.name ?? first?.path ?? "",
      size: formatSize(bytes),
    };
  }

  #text(key: keyof typeof TEXTS, ids: Iterable<string>): string {
    const { t } = this.#options;
    const said = this.#names(ids);
    return t(TEXTS[key][said.count === 1 ? 0 : 1], {
      ...said,
      interpolation: { escapeValue: false },
    });
  }

  /**
   * What went, as one notification, if anything is to be said: an import larger than `batch` all
   * together, with a way to keep this project's assets here; else large files, with a way to keep
   * those here; and files too large, which stay here.
   */
  #tell(
    key: string,
    { send, large, tooLarge }: ReturnType<typeof planImport>,
    sizes: NewAssetsOptions["sizes"],
  ): void {
    const { t, notify, cancel } = this.#options;
    const batch = send.length > 1 && this.#bytes(send) > sizes.batch;
    const lines = [
      ...(batch
        ? [
            t("storage.uploads.notice.batch", {
              count: send.length,
              size: formatSize(this.#bytes(send)),
            }),
          ]
        : large.length > 0
          ? [this.#text("large", large)]
          : []),
      ...(tooLarge.length > 0 ? [this.#text("tooLarge", tooLarge)] : []),
    ];
    if (lines.length === 0) return;
    const ok = { label: t("storage.uploads.notice.ok"), run: () => {} };
    const actions: NotificationAction[] = batch
      ? [
          {
            label: t("storage.uploads.notice.keepHere"),
            run: () => {
              void Promise.all(send.map((id) => cancel(id)));
              if (this.#options.project()?.key === key) this.#options.keepHere();
            },
          },
          ok,
        ]
      : large.length > 0
        ? [
            {
              label: t(`storage.uploads.notice.${large.length === 1 ? "notThis" : "notThese"}`),
              run: () => void Promise.all(large.map((id) => cancel(id))),
            },
            ok,
          ]
        : [];
    notify(lines.join(""), { stays: batch || large.length > 0, actions });
  }

  #wait(key: string, plan: ReturnType<typeof planImport>): void {
    if (this.#waiting?.key !== key) {
      this.reset();
      this.#waiting = {
        key,
        send: new Set(),
        large: new Set(),
        tooLarge: new Set(),
        notice: undefined,
      };
    }
    const waiting = this.#waiting as Waiting;
    for (const id of plan.send) waiting.send.add(id);
    for (const id of plan.large) waiting.large.add(id);
    for (const id of plan.tooLarge) waiting.tooLarge.add(id);
    this.#ask(waiting);
    this.#changed();
  }

  /** The one notification that asks, with everything that waits so far. */
  #ask(waiting: Waiting): void {
    const { t, notify } = this.#options;
    const total = this.#bytes(waiting.send);
    const lines = [
      this.#text("ask", waiting.send),
      // Why the large ones are named: they take much of the room.
      ...(waiting.large.size > 0
        ? [this.#text("askLarge", waiting.large)]
        : waiting.send.size > 1 && total > this.#options.sizes.batch
          ? [t("storage.uploads.notice.askTotal", { size: formatSize(total) })]
          : []),
      t("storage.uploads.notice.cost"),
      ...(waiting.tooLarge.size > 0 ? [this.#text("tooLarge", waiting.tooLarge)] : []),
      t("storage.uploads.notice.untilThen"),
    ];
    waiting.notice = notify(
      lines.join(""),
      {
        stays: true,
        actions: [
          { label: t("storage.uploads.notice.agree"), run: () => void this.#agree(waiting) },
          {
            label: t("storage.uploads.notice.keepHere"),
            run: () => {
              if (this.#waiting === waiting) this.#waiting = undefined;
              this.#changed();
              if (this.#options.project()?.key === waiting.key) this.#options.keepHere();
            },
          },
        ],
      },
      waiting.notice,
    );
  }

  async #agree(waiting: Waiting): Promise<void> {
    if (this.#waiting === waiting) this.#waiting = undefined;
    this.#changed();
    if (this.#options.project()?.key !== waiting.key) return;
    if (!(await this.#options.acknowledge())) {
      this.#options.failed(this.#options.t("storage.uploads.dialog.failed"));
      // Still waiting, and asked again, unless more came meanwhile and asks already.
      if (this.#waiting === undefined && this.#options.project()?.key === waiting.key) {
        waiting.notice = undefined;
        this.#waiting = waiting;
        this.#ask(waiting);
        this.#changed();
      }
      return;
    }
    // What was taken away meanwhile is not there to send; `send` leaves it out.
    await this.#options.send([...waiting.send]);
  }
}
