import { CircleAlert } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { InputChoice } from "../workbench/input-mode.ts";
import { useLayout, useProject, useSession, useWorkbench } from "./context.ts";
import { PopupMenu } from "./Menu.tsx";
import styles from "./StatusBar.module.css";
import { Tip } from "./Tip.tsx";

const CHOICES = ["mouse", "trackpad", "touch"] as const;

/** Shows what the editor takes the input for, and lets people put it right, as VS Code does. */
function InputSwitch() {
  const { input } = useWorkbench();
  const { t } = useTranslation();
  const { choice, device } = useSyncExternalStore(input.subscribe, input.getSnapshot);
  const [place, setPlace] = useState<{ x: number; y: number }>();
  const item = (id: InputChoice, label: string) => ({
    id,
    label,
    selected: choice === id,
    run: () => input.choose(id),
  });

  return (
    <>
      <Tip name={t("input.label")} usage={t("input.usage")}>
        <button
          type="button"
          className={styles.name}
          aria-haspopup="menu"
          aria-label={`${t("input.label")}：${t(`input.${device}`)}`}
          onClick={(event) => {
            const { left, top } = event.currentTarget.getBoundingClientRect();
            setPlace({ x: left, y: top });
          }}
        >
          {t(`input.${device}`)}
        </button>
      </Tip>
      {place && (
        <PopupMenu
          {...place}
          label={t("input.label")}
          groups={[
            [item("auto", t("input.autoNow", { device: t(`input.${device}`) }))],
            CHOICES.map((id) => item(id, t(`input.${id}`))),
          ]}
          onClose={() => setPlace(undefined)}
        />
      )}
    </>
  );
}

export function StatusBar() {
  const workbench = useWorkbench();
  const { workspace } = useLayout();
  const { store, save } = useSession();
  const project = useProject(store);
  const { t } = useTranslation();
  const current = workbench.layout.workspaces.find((item) => item.id === workspace);

  const saveText = {
    saved: t("project.saved"),
    saving: t("project.saving"),
    failed: t("project.saveFailed"),
  }[save];

  return (
    <footer className={styles.bar}>
      {project ? (
        <button
          type="button"
          className={styles.name}
          onClick={() => void workbench.renameProject()}
        >
          {project.manifest.name}
        </button>
      ) : (
        <span>{t("app.noProject")}</span>
      )}
      {project && (
        <span className={save === "failed" ? styles.failed : undefined} role="status">
          {save === "failed" && <CircleAlert size={12} />}
          {saveText}
        </span>
      )}
      <span className={styles.spacer} />
      {project && current && <span>{current.title(t)}</span>}
      <InputSwitch />
      <span>{workbench.version}</span>
    </footer>
  );
}
