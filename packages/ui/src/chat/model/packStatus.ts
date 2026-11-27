import type { AssistantEntry, ChatEntry } from "@animaquill/agent";
import { DEFAULT_PACK } from "@animaquill/tools";
import type { TFunction } from "i18next";
import type { ModelPacks } from "../packs.ts";
import { noteLabel, packLabel } from "../packText.ts";
import type { ChatSession } from "../session.ts";

/** A line of what the conversation's model pack is, and whether the conversation can take another. */
export interface PackLine {
  readonly text: string;
  readonly testId: string;
  /**
   * The settings now choose another pack (or version) for the model than the conversation has: it
   * can take it from its next answer.
   */
  readonly take?: { readonly model: string; readonly pack: string | undefined };
}

/**
 * What the information of a conversation says of its model pack: the pack of its first answer, or
 * of a new conversation the pack it would get; that a model has no pack of its own; and that the
 * pack chosen in the settings now comes with the next conversation, which this one can take too.
 */
export function packLinesOf(
  t: TFunction,
  entries: readonly ChatEntry[],
  model: string | undefined,
  chat: ChatSession,
  packs: ModelPacks,
): readonly PackLine[] {
  const answers = entries.filter((entry): entry is AssistantEntry => entry.role === "assistant");
  const lines: PackLine[] = [];
  /** What of a pack this version of the tools goes without, said once at the top. */
  const dropped = (id: string | undefined) => {
    const count = id === undefined ? 0 : (packs.installedOf(id)?.dropped.length ?? 0);
    if (count > 0)
      lines.push({ text: t("chat.packDropped", { count }), testId: "chat-pack-dropped" });
  };
  const first = answers.find((entry) => entry.pack && entry.texts);
  if (first?.pack) {
    lines.push({
      text:
        first.pack.by === "fallback"
          ? t("chat.packNone", {
              model: first.model,
              label: packLabel(t, DEFAULT_PACK, packs.getSnapshot(), true),
            })
          : t("chat.packLine", {
              name: noteLabel(t, first.pack, first.texts?.id, packs.getSnapshot()),
            }),
      testId: "chat-pack",
    });
    dropped(first.texts?.id);
  } else if (answers.length === 0 && model) {
    const { pack, note } = chat.choiceFor(model);
    lines.push({
      text:
        note.by === "fallback"
          ? t("chat.packNone", {
              model,
              label: packLabel(t, DEFAULT_PACK, packs.getSnapshot(), true),
            })
          : t("chat.packLine", { name: noteLabel(t, note, pack.id, packs.getSnapshot()) }),
      testId: "chat-pack",
    });
    dropped(pack.id);
  }
  const last = answers.at(-1);
  if (model && last?.pack && last.texts && last.model === model && last.pack.by !== "comparison") {
    const { pack, note } = chat.choiceFor(model);
    const options = chat.packOptions(model);
    const take = { model, pack: options.chosen ? options.current.id : undefined };
    if (chat.repicking(model) && (pack.id !== last.texts.id || pack.hash !== last.texts.hash)) {
      // Chosen where the model is picked: it comes with the next answer of this conversation.
      lines.push({
        text: t("chat.packNextAnswer", { name: noteLabel(t, note, pack.id, packs.getSnapshot()) }),
        testId: "chat-pack-next",
      });
    } else if (pack.id !== last.texts.id) {
      lines.push({
        text: t("chat.packNext", { model, name: noteLabel(t, note, pack.id, packs.getSnapshot()) }),
        testId: "chat-pack-next",
        take,
      });
    } else if (pack.hash !== last.texts.hash) {
      lines.push({
        text: t("chat.packNextVersion", {
          name: noteLabel(t, note, pack.id, packs.getSnapshot()),
          version: pack.version,
        }),
        testId: "chat-pack-next",
        take,
      });
    }
  }
  return lines;
}
