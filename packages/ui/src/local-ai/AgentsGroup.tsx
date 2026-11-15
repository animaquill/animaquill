import { INSTRUCTIONS_FILE, type ProjectStore } from "@animaquill/core";
import { useTranslation } from "react-i18next";
import { useProject, useWorkbench } from "../app/context.ts";
import { Group, Row } from "../project/parts.tsx";
import type { Locked } from "../project/ProjectDialog.tsx";
import settings from "../settings/Settings.module.css";

/** Whether the project has its instructions for AI. */
export const hasInstructions = (files: Readonly<Record<string, unknown>> | undefined): boolean =>
  files !== undefined && Object.hasOwn(files, INSTRUCTIONS_FILE);

/**
 * 给 AI 的说明 (docs/design/settings-and-properties.md of AnimaQuill Cloud, 5.2): whether the project
 * has AGENTS.md, opening it in the code tab, and adding one to a project that has none. A project
 * that has none gets none by itself: its folder is people's.
 */
export function AgentsGroup({
  store,
  locked,
}: {
  readonly store: ProjectStore;
  readonly locked: Locked;
}) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const state = useProject(store);
  if (!state) return null;
  const has = hasInstructions(state.files);
  return (
    <Group title={t("projectProps.groups.agents")}>
      <Row
        id="agents"
        name={INSTRUCTIONS_FILE}
        below={
          <span className={settings.status} data-testid="project-agents">
            {has ? t("localAi.agents.has") : t("localAi.agents.none")}
          </span>
        }
      >
        {has ? (
          <button
            type="button"
            className={settings.button}
            onClick={() => workbench.openInstructions()}
          >
            {t("localAi.agents.open")}
          </button>
        ) : (
          <button
            type="button"
            className={settings.button}
            disabled={locked.locked}
            onClick={() => workbench.addInstructions()}
          >
            {t("localAi.agents.add")}
          </button>
        )}
      </Row>
    </Group>
  );
}
