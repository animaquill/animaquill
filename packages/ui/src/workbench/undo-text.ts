import {
  USER,
  objectKey,
  objectOfPath,
  pathOfObject,
  type ChangeRecord,
  type Origin,
  type ProjectState,
  type UndoObstacle,
} from "@animaquill/core";
import type { TFunction } from "i18next";
import type { Dialogs } from "./dialogs.ts";
import type { Notifications } from "./notifications.ts";
import { fieldName } from "../chat/change-line.ts";
import { changeName } from "../chat/objectName.ts";

/**
 * A place of the project in a few words, as people know it: "片段「标题」 透明度", "项目 名称". For
 * the list of what stayed when something was taken back.
 */
export function placeText(t: TFunction, state: ProjectState, path: readonly string[]): string {
  const ref = objectOfPath(path);
  const kind = t(`chat.kinds.${ref.kind}`);
  const name = ref.kind === "project" ? undefined : changeName(t, ref, state);
  const what = name === undefined ? kind : `${kind}「${name}」`;
  const inner = path.slice(ref.kind === "project" ? 1 : pathOfObject(ref).length);
  const at = inner.indexOf("properties");
  const field =
    at >= 0 && inner[at + 1] !== undefined
      ? fieldName(t, `properties.${inner[at + 1]}`)
      : inner[0] !== undefined
        ? fieldName(t, inner[0])
        : undefined;
  return field === undefined ? what : `${what} ${field}`;
}

/**
 * Who changed the places that stayed when something was taken back, as far as this window keeps a
 * record: the person, one other conversation of the chat (by its title), or others.
 */
export type KeptBy =
  | { readonly kind: "you" }
  | { readonly kind: "chat"; readonly title: string }
  | { readonly kind: "others" };

const meets = (a: readonly string[], b: readonly string[]) =>
  a.length <= b.length ? a.every((key, at) => b[at] === key) : b.every((key, at) => a[at] === key);

/**
 * Who changed the places of `kept` after `origin` last did, from the records of changes: for each
 * place the last change of somebody else that wrote it, or above or below it. Several conversations
 * of the chat can change the project at once, so "you changed it" is said only where the person
 * did (docs/design/ai-teamwork.md of AnimaQuill Cloud, 4). `chatOf` names the conversation of an
 * origin of AI, where it is one of the chat; nothing where no record says (too long ago, or from
 * before the page was opened), which people hear as before: that they changed it.
 */
export function keptByOf(
  records: readonly ChangeRecord[],
  origin: Origin,
  kept: readonly (readonly string[])[],
  chatOf: (origin: Origin) => string | undefined,
): KeptBy | undefined {
  if (kept.length === 0) return undefined;
  const from = records.findLastIndex(
    (record) => record.origin === origin && record.takesBack === undefined,
  );
  const after = from < 0 ? [] : records.slice(from + 1);
  const who = new Set<string>();
  for (const path of kept) {
    const last = after.findLast(
      (record) => record.origin !== origin && record.paths.some((written) => meets(written, path)),
    );
    if (!last) return undefined;
    if (last.takesBack !== undefined || last.origin === USER) who.add("you");
    else {
      const title = chatOf(last.origin);
      who.add(title === undefined ? "others" : `chat:${title}`);
    }
  }
  if (who.size !== 1) return { kind: "others" };
  const [only] = who;
  if (only === "you") return { kind: "you" };
  if (only?.startsWith("chat:")) return { kind: "chat", title: only.slice("chat:".length) };
  return { kind: "others" };
}

/** Something taken back as a whole, or done again, as people hear of it, see `tellTakenBack`. */
export interface TakenBack {
  readonly direction: "undo" | "redo";
  /** Where it wrote, and where it stayed as it was, as it was changed since (`obstacle`). */
  readonly paths: readonly (readonly string[])[];
  readonly kept: readonly (readonly string[])[];
  readonly obstacle?: UndoObstacle | undefined;
  /** Who changed what stayed, where that is known, see `keptByOf`. */
  readonly keptBy?: KeptBy | undefined;
}

/**
 * What taking all of an AI task, a batch of files or a batch of the platform back came to, or doing
 * it again: how many places went back, and how many stayed because they were changed since, with
 * the way to see which, and to do it again (`again`).
 */
export function tellTakenBack(
  {
    t,
    notifications,
    dialogs,
  }: { readonly t: TFunction; readonly notifications: Notifications; readonly dialogs: Dialogs },
  state: ProjectState | undefined,
  taken: TakenBack,
  again: (() => void) | undefined,
): void {
  const objects = (paths: readonly (readonly string[])[]) =>
    new Set(paths.map((path) => objectKey(objectOfPath(path))));
  const kept = objects(taken.kept);
  const count = [...objects(taken.paths)].filter((key) => !kept.has(key)).length;
  if (taken.direction === "redo") {
    if (kept.size > 0)
      notifications.push(t("notice.takenBack.redonePartly", { count, kept: kept.size }));
    return;
  }
  const actions = again ? [{ label: t("notice.takenBack.redo"), run: again }] : [];
  if (kept.size === 0) {
    notifications.push(t("notice.takenBack.undone", { count }), { actions });
    return;
  }
  const why =
    taken.obstacle === "inUse"
      ? "inUse"
      : taken.keptBy?.kind === "chat"
        ? "changedByChat"
        : taken.keptBy?.kind === "others"
          ? "changedLater"
          : "changed";
  const title =
    taken.keptBy?.kind === "chat"
      ? { title: taken.keptBy.title, interpolation: { escapeValue: false } }
      : {};
  const places = state ? taken.kept.map((path) => placeText(t, state, path)) : [];
  notifications.push(t("notice.takenBack.undone", { count }), {
    stays: true,
    warning: {
      text: t(`notice.takenBack.kept.${why}`, { count: kept.size, ...title }),
      action: {
        label: t("notice.takenBack.showKept", { count: kept.size }),
        run: () =>
          void dialogs.confirm({
            title: t("notice.takenBack.keptTitle", { count: kept.size }),
            message: t(`notice.takenBack.kept.${why}`, { count: kept.size, ...title }),
            confirm: t("dialog.close"),
            noticeOnly: true,
            details: [{ title: t("notice.takenBack.keptList"), items: [...new Set(places)] }],
          }),
      },
    },
    actions,
  });
}
