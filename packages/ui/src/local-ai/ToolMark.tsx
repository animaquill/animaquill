import { useTranslation } from "react-i18next";
import { knownTool, type ToolClient } from "../folder/tool-notes.ts";
import { toolName } from "../workbench/tool-activity.ts";
import styles from "./LocalAi.module.css";

/** A small mark of an AI tool: the first letter of its name, in a colour of its own. */
export function ToolMark({ client }: { readonly client: ToolClient | undefined }) {
  const { t } = useTranslation();
  const name = toolName(t, client);
  return (
    <span className={styles.toolMark} data-tool={knownTool(client) ?? "other"} aria-hidden>
      {[...name][0]?.toUpperCase()}
    </span>
  );
}
