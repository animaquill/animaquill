import type { IDockviewPanelHeaderProps } from "dockview-react";
import { CircleHelp, X } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./PanelTab.module.css";
import type { PanelParams } from "./toDockview.ts";

export function PanelTab({ api, params }: IDockviewPanelHeaderProps<PanelParams>) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const definition = workbench.panels.get(params.type);
  const Icon = definition?.icon ?? CircleHelp;
  const title = definition ? definition.title(t) : t("panel.unknown.title");

  const closeOnMiddleClick = (event: MouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    api.close();
  };

  return (
    <div className={styles.tab} data-tab={params.type} onAuxClick={closeOnMiddleClick}>
      <Icon size={14} />
      <span className={styles.title}>{title}</span>
      <button
        type="button"
        className={styles.close}
        aria-label={`${t("tab.close")} ${title}`}
        onPointerDown={(event: PointerEvent) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          api.close();
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
