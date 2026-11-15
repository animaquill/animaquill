import type { ModelPack } from "@animaquill/tools";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./PackLabel.module.css";
import type { PackSource } from "./packs.ts";
import { labelParts, labelText, originIn, originOf } from "./packText.ts";

/**
 * The label of a model pack: its name, which an ellipsis shortens where it is long, and where it is
 * from, "(内置)", "(pipi)", always whole and dimmer (docs/design/settings-and-properties.md 7.3).
 * Where it is from only the editor says, and a name has no brackets or colons, so no name can make
 * up a second one. `auto` puts "自动：" before it, for the pack a model gets when people choose none.
 * `source` is for a pack not installed yet, as the install dialog has it.
 */
export function PackLabel(props: {
  readonly pack: Pick<ModelPack, "id" | "name" | "builtin">;
  readonly auto?: boolean;
  readonly source?: PackSource | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}) {
  const { packs } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const { pack } = props;
  const origin = props.source ? originOf(pack, props.source) : originIn(pack, snapshot);
  const parts = labelParts(t, pack, origin, snapshot);
  const text = labelText(t, parts, props.auto);
  return (
    <span
      className={`${styles.label} ${props.className ?? ""}`}
      title={parts.allowed ? text : `${text}\n${t("ai.packs.nameNotAllowedHelp")}`}
      data-testid={props.testId}
      data-pack-label={text}
    >
      {props.auto && <span className={styles.auto}>{t("ai.packs.autoPrefix")}</span>}
      <span className={styles.name} data-allowed={parts.allowed ? undefined : "no"}>
        {parts.name}
      </span>
      <span className={styles.origin}>({parts.origin})</span>
    </span>
  );
}
