import "dockview-react/dist/styles/dockview.css";
import "./dock.css";
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewGroupPanel,
  type IDockviewPanel,
  type IDockviewPanelProps,
} from "dockview-react";
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { PopupMenu, type MenuItem } from "../app/Menu.tsx";
import type { TabStrip } from "../workbench/layout.ts";
import { createDock } from "./dock.ts";
import { EmptyDock } from "./EmptyDock.tsx";
import { GroupStrip } from "./GroupStrip.tsx";
import { PanelHost } from "./PanelHost.tsx";
import { PanelTab } from "./PanelTab.tsx";
import { StripsContext } from "./strips-context.ts";
import { ICONS_WIDTH, TabStrips } from "./strips.ts";
import { PANEL_COMPONENT, type PanelParams } from "./toDockview.ts";

const COMPONENTS = {
  [PANEL_COMPONENT]: PanelHost as (props: IDockviewPanelProps<PanelParams>) => React.JSX.Element,
};

const STRIPS: readonly TabStrip[] = ["top", "left", "right"];
/** How far the mouse goes before pressing on the strip becomes dragging it. */
const DRAG_START = 6;
/** How tall a strip across the top is. Matches dock.css. */
const TOP_HEIGHT = 35;

/** The tab strip of a group: its tabs and the empty part after them, with the marks of ours. */
const HEADER = ".dv-tabs-and-actions-container";

interface MenuPlace {
  readonly x: number;
  readonly y: number;
  readonly group: DockviewGroupPanel;
  /** The tab that was right-clicked, when it was one. */
  readonly panel?: IDockviewPanel;
}

interface DropHint {
  readonly box: { left: number; top: number; width: number; height: number };
  readonly side: TabStrip;
}

/** The side of a group nearest to a point inside it. */
function sideAt(box: DOMRect, x: number, y: number): TabStrip | undefined {
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return undefined;
  const distances: [TabStrip, number][] = [
    ["left", x - box.left],
    ["right", box.right - x],
    ["top", y - box.top],
  ];
  return distances.reduce((nearest, next) => (next[1] < nearest[1] ? next : nearest))[0];
}

export function DockArea() {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const [strips] = useState(() => new TabStrips());
  const api = useRef<DockviewApi>(undefined);
  const [menu, setMenu] = useState<MenuPlace>();
  const [hint, setHint] = useState<DropHint>();
  const stopDragging = useRef<() => void>(undefined);
  useEffect(() => () => stopDragging.current?.(), []);

  const groupAt = (target: Element): DockviewGroupPanel | undefined =>
    api.current?.groups.find((group) => group.element.contains(target));

  const panelOf = (target: Element): IDockviewPanel | undefined => {
    const type = target.closest('[role="tab"]')?.querySelector<HTMLElement>("[data-tab]")?.dataset[
      "tab"
    ];
    return type === undefined ? undefined : api.current?.getPanel(type);
  };

  /** What can be done with a group, and with the tab people clicked, if they clicked one. */
  const menuOf = ({ group, panel }: MenuPlace): MenuItem[][] => {
    const strip = strips.stripOf(group);
    const { pinned, peek } = strips.lookOf(group);
    const groups: MenuItem[][] = [];
    if (panel) {
      const tabs = group.panels;
      const later = tabs.slice(tabs.indexOf(panel) + 1);
      const close = (items: readonly IDockviewPanel[]) => () =>
        items.forEach((item) => item.api.close());
      groups.push([
        { id: "close", label: t("tab.close"), run: close([panel]) },
        {
          id: "closeOthers",
          label: t("tab.closeOthers"),
          run: close(tabs.filter((item) => item !== panel)),
          disabled: tabs.length === 1,
        },
        {
          id: "closeLater",
          label: t(strip === "top" ? "tab.closeRight" : "tab.closeBelow"),
          run: close(later),
          disabled: later.length === 0,
        },
        { id: "closeAll", label: t("tab.closeAll"), run: close([...tabs]) },
      ]);
    }
    groups.push(
      STRIPS.map((choice) => ({
        id: choice,
        label: t(`strip.${choice}`),
        selected: choice === strip,
        run: () => strips.setStrip(group, choice),
      })),
    );
    if (strip !== "top") {
      groups.push([
        {
          id: "pin",
          label: t("strip.pin"),
          checked: pinned,
          run: () => strips.setPinned(group, !pinned),
        },
        {
          id: "peek",
          label: t("strip.peek"),
          checked: peek,
          // With the names showing there is nothing to come out.
          disabled: pinned,
          run: () => strips.setPeek(group, !peek),
        },
      ]);
    }
    return groups;
  };

  /** Our menu for tabs and for the rest of the strip, which dockview has none for. */
  const openMenu = (event: MouseEvent) => {
    const target = event.target as Element;
    if (!target.closest(HEADER)) return;
    const group = groupAt(target);
    if (!group) return;
    event.preventDefault();
    const panel = panelOf(target);
    setMenu({ x: event.clientX, y: event.clientY, group, ...(panel && { panel }) });
  };

  /**
   * Pressing on the empty part of a strip and moving the mouse to a side of the group puts the
   * tabs there. Dockview would start dragging the whole group from there, which `createDock` turns
   * down, so the mouse keeps coming here. Tabs are dragged by dockview, and are not this.
   */
  const pressStrip = (event: PointerEvent) => {
    const target = event.target as Element;
    if (target.closest('[role="tab"]') && target.closest(HEADER)) strips.rest(groupAt(target));
    if (event.button !== 0 || !target.closest(HEADER)) return;
    if (target.closest('[role="tab"], [role="separator"], button')) return;
    const group = groupAt(target);
    if (!group) return;
    const from = { x: event.clientX, y: event.clientY };
    let dragging = false;
    let side: TabStrip | undefined;

    const move = (moved: globalThis.PointerEvent) => {
      if (!dragging && Math.hypot(moved.clientX - from.x, moved.clientY - from.y) < DRAG_START) {
        return;
      }
      dragging = true;
      const box = group.element.getBoundingClientRect();
      side = sideAt(box, moved.clientX, moved.clientY);
      if (!side) {
        setHint(undefined);
        return;
      }
      const across = side === "top";
      setHint({
        side,
        box: {
          left: side === "right" ? box.right - ICONS_WIDTH : box.left,
          top: box.top,
          width: across ? box.width : ICONS_WIDTH,
          height: across ? TOP_HEIGHT : box.height,
        },
      });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("keydown", cancel, true);
      stopDragging.current = undefined;
      setHint(undefined);
    };
    const drop = () => {
      if (dragging && side) strips.setStrip(group, side);
      stop();
    };
    const cancel = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopPropagation();
      stop();
    };
    stopDragging.current?.();
    stopDragging.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("keydown", cancel, true);
  };

  /**
   * Down a side, the keys that move along the tabs also switch to them, as in Edge. Dockview moves
   * the focus. Clicks and Tab land on the tab that is showing already.
   */
  const followFocus = (event: FocusEvent) => {
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "tab") return;
    const panel = panelOf(target);
    if (!panel || panel.group.activePanel === panel || strips.stripOf(panel.group) === "top")
      return;
    panel.api.setActive();
  };

  return (
    <StripsContext value={strips}>
      <div
        className="aq-dock"
        onFocus={followFocus}
        onContextMenu={openMenu}
        onPointerDown={pressStrip}
        onPointerOut={(event) => {
          // The names come out again once the mouse has left the strip it clicked on, also into
          // the page of a preview, which keeps its moves to itself.
          const header = (event.target as Element).closest(HEADER);
          const into = event.relatedTarget as Node | null;
          if (header && !(into && header.contains(into))) strips.rest(undefined);
        }}
        onPointerLeave={() => strips.rest(undefined)}
      >
        <DockviewReact
          theme={themeDark}
          components={COMPONENTS}
          defaultTabComponent={PanelTab}
          watermarkComponent={EmptyDock}
          rightHeaderActionsComponent={GroupStrip}
          disableFloatingGroups
          // Dockview's own scrollbar restores an old position over the one a new tab needs.
          scrollbars="native"
          onReady={(event) => {
            api.current = event.api;
            workbench.layout.attach(createDock(event.api, workbench.panels, strips, t));
          }}
        />
        {hint && (
          <div
            className="aq-strip-target"
            data-side={hint.side}
            style={{ ...hint.box }}
            role="presentation"
          />
        )}
      </div>
      {menu && (
        <PopupMenu
          label={t("strip.menu")}
          x={menu.x}
          y={menu.y}
          groups={menuOf(menu)}
          onClose={() => setMenu(undefined)}
        />
      )}
    </StripsContext>
  );
}
