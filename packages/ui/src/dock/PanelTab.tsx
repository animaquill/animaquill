import type { IDockviewPanelHeaderProps } from "dockview-react";
import { CircleHelp, X } from "lucide-react";
import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./PanelTab.module.css";
import { useStrips } from "./strips-context.ts";
import type { PanelParams } from "./toDockview.ts";

export function PanelTab({ api, params, tabLocation }: IDockviewPanelHeaderProps<PanelParams>) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const element = useRef<HTMLDivElement>(null);
  const strips = useStrips();
  const look = strips.lookOf(api.group);
  // Only icons, and nothing comes out under the mouse: the name has to come from somewhere.
  const iconOnly = strips.stripOf(api.group) !== "top" && !look.pinned && !look.peek;

  // Dockview reveals a new tab before this content exists, while the tab is still too narrow to
  // scroll to. A frame later the strip also knows whether it needs its list of hidden tabs.
  useEffect(() => {
    if (tabLocation !== "header" || !api.isVisible) return;
    const frame = requestAnimationFrame(() => {
      element.current?.closest(".dv-tab")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [api, tabLocation]);

  const definition = workbench.panels.get(params.type);
  const Icon = definition?.icon ?? CircleHelp;
  const title = definition ? definition.title(t) : t("panel.unknown.title");

  /** After a click people want to work in the panel. The keyboard stays in the tab strip. */
  const focusContent = (event: MouseEvent) => {
    if (event.detail === 0) return;
    const content = document.querySelector<HTMLElement>(`[data-panel="${params.type}"]`);
    content?.focus({ preventScroll: true });
  };

  const closeOnMiddleClick = (event: MouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    api.close();
  };

  return (
    <div
      ref={element}
      className={styles.tab}
      data-tab={params.type}
      {...(iconOnly && { title })}
      onClick={focusContent}
      onAuxClick={closeOnMiddleClick}
    >
      <Icon size={14} className={styles.icon} />
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
