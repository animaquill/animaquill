import type { TFunction } from "i18next";
import type { NotificationAction, NotificationOptions } from "../workbench/notifications.ts";
import { formatSize } from "../transfer/transfer.ts";
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
  /** The open project, as far as uploads go: its key and default here, or none to send to. */
  readonly project: () => { readonly key: string; readonly place: DefaultPlace } | undefined;
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
  readonly sizes: { readonly large: number; readonly most: number };
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
  #waiting: Waiting | undefined;

  constructor(options: NewAssetsOptions) {
    this.#options = options;
  }

  /** What waits right now, for tests and for nobody else. */
  get waiting(): readonly string[] {
    return [...(this.#waiting?.send ?? [])];
  }

  /** The project closed: what waited stays here, as it is. */
  reset(): void {
    if (this.#waiting?.notice !== undefined) this.#options.dismiss(this.#waiting.notice);
    this.#waiting = undefined;
  }

  /** Assets just imported into the open project. */
  async imported(ids: readonly string[]): Promise<void> {
    const { project, assets, sizes } = this.#options;
    const open = project();
    if (!open || ids.length === 0) return;
    const plan = planImport(ids, assets(), open.place.effective, sizes);
    if (plan.send.length === 0 && plan.tooLarge.length === 0) return;
    const knows = plan.send.length > 0 ? await this.#options.acknowledged() : true;
    // Another project meanwhile: these are not its assets.
    if (project()?.key !== open.key) return;
    if (!knows) {
      this.#wait(open.key, plan);
      return;
    }
    if (plan.send.length > 0) await this.#options.send(plan.send);
    this.#tell(plan.large, plan.tooLarge);
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

  /** Large files that go, and files too large that stay: one notification, if any. */
  #tell(large: readonly string[], tooLarge: readonly string[]): void {
    const { t, notify, cancel } = this.#options;
    const lines = [
      ...(large.length > 0 ? [this.#text("large", large)] : []),
      ...(tooLarge.length > 0 ? [this.#text("tooLarge", tooLarge)] : []),
    ];
    if (lines.length === 0) return;
    const actions: NotificationAction[] =
      large.length > 0
        ? [
            {
              label: t(`storage.uploads.notice.${large.length === 1 ? "notThis" : "notThese"}`),
              run: () => void Promise.all(large.map((id) => cancel(id))),
            },
            { label: t("storage.uploads.notice.ok"), run: () => {} },
          ]
        : [];
    notify(lines.join(""), { stays: large.length > 0, actions });
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
  }

  /** The one notification that asks, with everything that waits so far. */
  #ask(waiting: Waiting): void {
    const { t, notify } = this.#options;
    const lines = [
      this.#text("ask", waiting.send),
      t("storage.uploads.notice.cost"),
      ...(waiting.large.size > 0 ? [this.#text("askLarge", waiting.large)] : []),
      ...(waiting.tooLarge.size > 0 ? [this.#text("tooLarge", waiting.tooLarge)] : []),
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
    if (this.#options.project()?.key !== waiting.key) return;
    if (!(await this.#options.acknowledge())) {
      this.#options.failed(this.#options.t("storage.uploads.dialog.failed"));
      // Still waiting, and asked again, unless more came meanwhile and asks already.
      if (this.#waiting === undefined && this.#options.project()?.key === waiting.key) {
        waiting.notice = undefined;
        this.#waiting = waiting;
        this.#ask(waiting);
      }
      return;
    }
    // What was taken away meanwhile is not there to send; `send` leaves it out.
    await this.#options.send([...waiting.send]);
  }
}
