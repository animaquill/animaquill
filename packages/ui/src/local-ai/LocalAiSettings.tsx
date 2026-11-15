import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useSession, useWorkbench } from "../app/context.ts";
import { GroupPage, SettingRow, Toggle } from "../settings/parts.tsx";
import settings from "../settings/Settings.module.css";
import { toolName } from "../workbench/tool-activity.ts";
import { ToolMark } from "./ToolMark.tsx";
import styles from "./LocalAi.module.css";

const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** A time of today by its clock, of another day with its date. */
export function whenText(time: number, now = Date.now()): string {
  return new Date(time).toDateString() === new Date(now).toDateString()
    ? clock.format(time)
    : day.format(time);
}

/** Who is connected to the open project, and who wrote to it, as the editor looks every so often. */
export function useToolActivity() {
  const { tools } = useWorkbench();
  return useSyncExternalStore(tools.subscribe, tools.getSnapshot);
}

/**
 * 设置 › 电脑上的 AI 工具 (docs/design/settings-and-properties.md of AnimaQuill Cloud, 4.3): the way
 * to the guide, the AI tools that wrote to the open project, and whether new projects start with
 * AGENTS.md.
 */
export function LocalAiGroup() {
  const workbench = useWorkbench();
  const { tools, agentsFile } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const activity = useToolActivity();
  const agents = useSyncExternalStore(agentsFile.subscribe, agentsFile.getSnapshot);
  useEffect(() => {
    void tools.look({ batches: true });
  }, [tools]);
  const project = store?.getState().manifest.name;
  const connected = new Set(activity.connections.map(({ client }) => client?.name ?? ""));
  return (
    <GroupPage title={t("settings.groups.localAi")}>
      {/* The button says what it is: a row of its own, with no name beside it. */}
      <div className={settings.row} data-setting="localAi.connect">
        <div className={settings.words}>
          <button
            type="button"
            className={`${settings.button} ${settings.primary}`}
            style={{ justifySelf: "start", alignSelf: "flex-start" }}
            data-testid="local-ai-wizard"
            onClick={() => workbench.openLocalAiGuide()}
          >
            {t("localAi.settings.wizard")}
          </button>
        </div>
      </div>
      {project !== undefined && activity.folder && (
        <SettingRow
          id="localAi.recent"
          name={t("localAi.settings.recent")}
          help=""
          wide
          below={
            activity.uses.length === 0 ? (
              <span className={settings.note}>{t("localAi.settings.recentNone")}</span>
            ) : (
              <ul className={styles.uses} data-testid="local-ai-uses">
                {activity.uses.map((use) => (
                  <li key={use.client?.name ?? ""} className={settings.status}>
                    <ToolMark client={use.client} />
                    {t("localAi.settings.use", {
                      tool: toolName(t, use.client),
                      when: connected.has(use.client?.name ?? "")
                        ? t("localAi.settings.now")
                        : whenText(use.lastAt),
                      count: use.batches,
                      interpolation: { escapeValue: false },
                    })}
                  </li>
                ))}
              </ul>
            )
          }
        />
      )}
      <SettingRow id="localAi.agentsFile" help="">
        <Toggle
          label={t("settings.items.localAi.agentsFile.name")}
          checked={agents}
          onChange={(on) => agentsFile.set(on)}
        />
      </SettingRow>
    </GroupPage>
  );
}
