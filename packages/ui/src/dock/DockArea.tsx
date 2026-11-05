import "dockview-react/dist/styles/dockview.css";
import "./dock.css";
import {
  DockviewReact,
  themeDark,
  type GetTabContextMenuItemsParams,
  type IDockviewPanelProps,
} from "dockview-react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { createDock } from "./dock.ts";
import { EmptyDock } from "./EmptyDock.tsx";
import { PanelHost } from "./PanelHost.tsx";
import { PanelTab } from "./PanelTab.tsx";
import { PANEL_COMPONENT, type PanelParams } from "./toDockview.ts";

const COMPONENTS = {
  [PANEL_COMPONENT]: PanelHost as (props: IDockviewPanelProps<PanelParams>) => React.JSX.Element,
};

export function DockArea() {
  const workbench = useWorkbench();
  const { t } = useTranslation();

  const tabMenu = ({ panel, group }: GetTabContextMenuItemsParams) => {
    const tabs = group.panels;
    const right = tabs.slice(tabs.indexOf(panel) + 1);
    const close = (items: typeof tabs) => () => items.forEach((item) => item.api.close());
    return [
      { label: t("tab.close"), action: close([panel]) },
      {
        label: t("tab.closeOthers"),
        action: close(tabs.filter((item) => item !== panel)),
        disabled: tabs.length === 1,
      },
      { label: t("tab.closeRight"), action: close(right), disabled: right.length === 0 },
      { label: t("tab.closeAll"), action: close([...tabs]) },
    ];
  };

  return (
    <DockviewReact
      theme={themeDark}
      components={COMPONENTS}
      defaultTabComponent={PanelTab}
      watermarkComponent={EmptyDock}
      getTabContextMenuItems={tabMenu}
      disableFloatingGroups
      onReady={({ api }) => workbench.layout.attach(createDock(api, workbench.panels, t))}
    />
  );
}
