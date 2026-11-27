import { ChevronDown } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu } from "../app/Menu.tsx";
import type { TimelineEditor } from "./editor.ts";
import type { FollowMode } from "./follow.ts";
import { FollowCenterIcon, FollowPageIcon } from "./ToolIcons.tsx";
import { ToolButton } from "./ToolButton.tsx";
import styles from "./TimelinePanel.module.css";

const MODES: readonly FollowMode[] = ["page", "center"];

/**
 * Whether the views follow the playhead, and a small arrow beside it to choose how. One setting
 * for the timeline and the keyframe tab, wherever it shows: it is the one of the timeline.
 */
export function FollowControl({ timeline }: { timeline: TimelineEditor }) {
  const { t } = useTranslation();
  const { follow } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const arrow = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number }>();

  const open = () => {
    const box = arrow.current?.getBoundingClientRect();
    if (box) setMenu({ x: box.left, y: box.bottom + 2 });
  };

  return (
    <span className={styles.follow} data-follow-control>
      <ToolButton
        name={t("timeline.follow")}
        usage={t("timeline.help.follow")}
        action="toggleFollow"
        icon={follow.mode === "center" ? FollowCenterIcon : FollowPageIcon}
        pressed={follow.on}
        isSwitch
        onClick={() => timeline.toggleFollow()}
      />
      <button
        ref={arrow}
        type="button"
        className={styles.followArrow}
        aria-label={t("timeline.followMode")}
        aria-haspopup="menu"
        aria-expanded={menu !== undefined}
        onClick={() => (menu ? setMenu(undefined) : open())}
      >
        <ChevronDown size={12} aria-hidden />
      </button>
      {menu && (
        <PopupMenu
          label={t("timeline.followMode")}
          x={menu.x}
          y={menu.y}
          groups={[
            MODES.map((mode) => ({
              id: mode,
              label: t(`timeline.followModes.${mode}`),
              selected: follow.on && follow.mode === mode,
              run: () => timeline.setFollowMode(mode),
            })),
          ]}
          onClose={() => {
            setMenu(undefined);
            arrow.current?.focus();
          }}
        />
      )}
    </span>
  );
}
