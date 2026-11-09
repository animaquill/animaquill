import type { IDockviewHeaderActionsProps } from "dockview-react";
import { PanelLeft, PanelRight, PanelTop, Pin, PinOff } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu } from "../app/Menu.tsx";
import type { TabStrip } from "../workbench/layout.ts";
import styles from "./GroupActions.module.css";
import { useStrips } from "./strips-context.ts";

const ICONS = { top: PanelTop, left: PanelLeft, right: PanelRight } as const;
const STRIPS: readonly TabStrip[] = ["top", "left", "right"];

/** At the end of the tabs of each group: where its tabs go, and whether their names show. */
export function GroupActions({ group }: IDockviewHeaderActionsProps) {
  const strips = useStrips();
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const strip = strips.stripOf(group);
  const pinned = strips.isPinned(group);
  const StripIcon = ICONS[strip];

  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setMenu({ x: box.left, y: box.bottom });
  };

  return (
    // The look of the strip goes by these marks, see dock.css.
    <div className={styles.actions} data-strip={strip} data-pinned={pinned}>
      {strip !== "top" && (
        <button
          type="button"
          className={styles.button}
          aria-label={t("strip.pinned")}
          title={t("strip.pinned")}
          aria-pressed={pinned}
          onClick={() => strips.setPinned(group, !pinned)}
        >
          {pinned ? <Pin size={14} /> : <PinOff size={14} />}
        </button>
      )}
      <button
        type="button"
        className={styles.button}
        aria-label={t("strip.menu")}
        title={t("strip.menu")}
        aria-haspopup="menu"
        aria-expanded={menu !== undefined}
        onClick={openMenu}
      >
        <StripIcon size={14} />
      </button>
      {menu && (
        <PopupMenu
          label={t("strip.menu")}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(undefined)}
          groups={[
            STRIPS.map((choice) => ({
              id: choice,
              label: t(`strip.${choice}`),
              selected: choice === strip,
              run: () => strips.setStrip(group, choice),
            })),
            ...(strip === "top"
              ? []
              : [
                  [
                    {
                      id: "pin",
                      label: t(pinned ? "strip.unpin" : "strip.pin"),
                      run: () => strips.setPinned(group, !pinned),
                    },
                  ],
                ]),
          ]}
        />
      )}
    </div>
  );
}
