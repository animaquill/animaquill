import type { TFunction } from "i18next";
import type { Dialogs } from "../../workbench/dialogs.ts";

/**
 * Asks people whether to delete the conversation: one whose task runs stops first, which they are
 * told. What AI changed stays, as for any conversation.
 */
export function sureToRemove(dialogs: Dialogs, t: TFunction, running: boolean): Promise<boolean> {
  return dialogs.confirm({
    title: t("chat.list.removeConfirm"),
    message: running
      ? `${t("chat.list.removeRunning")}${t("chat.list.removeNote")}`
      : t("chat.list.removeNote"),
    confirm: t("chat.list.remove"),
    danger: true,
  });
}
