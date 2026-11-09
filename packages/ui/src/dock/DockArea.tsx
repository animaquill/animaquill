import "dockview-react/dist/styles/dockview.css";
import "./dock.css";
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type GetTabContextMenuItemsParams,
  type IDockviewPanelProps,
} from "dockview-react";
import { useRef, useState, type FocusEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import type { TabStrip } from "../workbench/layout.ts";
import { createDock } from "./dock.ts";
import { EmptyDock } from "./EmptyDock.tsx";
import { GroupActions } from "./GroupActions.tsx";
import { PanelHost } from "./PanelHost.tsx";
import { PanelTab } from "./PanelTab.tsx";
import { StripsContext } from "./strips-context.ts";
import { TabStrips } from "./strips.ts";
import { PANEL_COMPONENT, type PanelParams } from "./toDockview.ts";

const COMPONENTS = {
  [PANEL_COMPONENT]: PanelHost as (props: IDockviewPanelProps<PanelParams>) => React.JSX.Element,
};

const STRIPS: readonly TabStrip[] = ["top", "left", "right"];

export function DockArea() {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const [strips] = useState(() => new TabStrips());
  const api = useRef<DockviewApi>(undefined);

  const tabMenu = ({ panel, group }: GetTabContextMenuItemsParams) => {
    const tabs = group.panels;
    const later = tabs.slice(tabs.indexOf(panel) + 1);
    const close = (items: typeof tabs) => () => items.forEach((item) => item.api.close());
    const strip = strips.stripOf(group);
    const pinned = strips.isPinned(group);
    return [
      { label: t("tab.close"), action: close([panel]) },
      {
        label: t("tab.closeOthers"),
        action: close(tabs.filter((item) => item !== panel)),
        disabled: tabs.length === 1,
      },
      {
        label: t(strip === "top" ? "tab.closeRight" : "tab.closeBelow"),
        action: close(later),
        disabled: later.length === 0,
      },
      { label: t("tab.closeAll"), action: close([...tabs]) },
      "separator" as const,
      ...STRIPS.filter((other) => other !== strip).map((other) => ({
        label: t(`strip.${other}`),
        action: () => strips.setStrip(group, other),
      })),
      ...(strip === "top"
        ? []
        : [
            {
              label: t(pinned ? "strip.unpin" : "strip.pin"),
              action: () => strips.setPinned(group, !pinned),
            },
          ]),
    ];
  };

  /**
   * Down a side, the keys that move along the tabs also switch to them, as in Edge. Dockview moves
   * the focus. Clicks and Tab land on the tab that is showing already.
   */
  const followFocus = (event: FocusEvent) => {
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "tab") return;
    const type = target.querySelector<HTMLElement>("[data-tab]")?.dataset["tab"];
    const panel = type === undefined ? undefined : api.current?.getPanel(type);
    if (!panel || panel.group.activePanel === panel || strips.stripOf(panel.group) === "top")
      return;
    panel.api.setActive();
  };

  return (
    <StripsContext value={strips}>
      <div className="aq-dock" onFocus={followFocus}>
        <DockviewReact
          theme={themeDark}
          components={COMPONENTS}
          defaultTabComponent={PanelTab}
          watermarkComponent={EmptyDock}
          rightHeaderActionsComponent={GroupActions}
          getTabContextMenuItems={tabMenu}
          disableFloatingGroups
          // Dockview's own scrollbar restores an old position over the one a new tab needs.
          scrollbars="native"
          onReady={(event) => {
            api.current = event.api;
            workbench.layout.attach(createDock(event.api, workbench.panels, strips, t));
          }}
        />
      </div>
    </StripsContext>
  );
}
