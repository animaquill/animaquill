import { Boxes, Camera, Check, Clock, ImagePlus, ListChecks, Plus } from "lucide-react";
import { forwardRef, useImperativeHandle } from "react";
import { useTranslation } from "react-i18next";
import { Tip } from "../../app/Tip.tsx";
import styles from "./input.module.css";
import { useBoxMenu } from "./menu.ts";

/** One thing "+" puts in the box, as it is right now. */
export interface PlusItem {
  readonly id: "shoot" | "picture" | "time" | "selection";
  readonly name: string;
  /** Why it cannot be chosen now, where it cannot. */
  readonly why: string | undefined;
  readonly keys: string | undefined;
}

export interface PlusMenuHandle {
  /** Opens the menu from a key of the box: the focus goes into it, and back to the box after. */
  openFromBox(box: HTMLElement | null): void;
}

const ICONS = { shoot: Camera, picture: ImagePlus, time: Clock, selection: Boxes } as const;
const GROUPS: readonly (readonly PlusItem["id"][])[] = [
  ["shoot", "picture"],
  ["time", "selection"],
];

/**
 * "+" of the input box (docs/design/chat-panel.md of AnimaQuill Cloud, 3.3): one menu at every
 * width, each item saying what it puts in right now ("插入播放头时间 0:12"), and "先出方案" to tick
 * at its end. `Alt+A` opens it from the box.
 */
export const PlusMenu = forwardRef<
  PlusMenuHandle,
  {
    readonly items: readonly PlusItem[];
    readonly planFirst: boolean;
    readonly onRun: (which: PlusItem["id"]) => void;
    readonly onPlanFirst: () => void;
    readonly shortcut: string | undefined;
  }
>(function PlusMenu(props, ref) {
  const { t } = useTranslation();
  const { wrapRef, buttonRef, ...menu } = useBoxMenu();
  useImperativeHandle(ref, () => ({ openFromBox: (box) => menu.show(true, box) }), [menu]);
  const byId = new Map(props.items.map((item) => [item.id, item]));
  return (
    <div className={styles.menuWrap} ref={wrapRef}>
      <Tip name={t("chat.compose.plus")} usage="" shortcut={props.shortcut}>
        <button
          type="button"
          ref={buttonRef}
          className={styles.round}
          aria-label={t("chat.compose.plus")}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          data-testid="chat-plus"
          // A click of the mouse keeps the caret in the box: what goes in goes where it is.
          onPointerDown={(event) => event.preventDefault()}
          onClick={menu.onButtonClick}
          onKeyDown={menu.onButtonKeyDown}
        >
          <Plus size={14} aria-hidden />
        </button>
      </Tip>
      {menu.open && (
        <div
          className={styles.menu}
          role="menu"
          aria-label={t("chat.compose.plus")}
          data-testid="chat-plus-menu"
          onKeyDown={menu.onMenuKeyDown}
        >
          {GROUPS.map((group) => (
            <div key={group.join()} className={styles.menuGroup} role="group">
              {group.flatMap((id) => {
                const item = byId.get(id);
                if (!item) return [];
                const Icon = ICONS[id];
                return [
                  <button
                    key={id}
                    type="button"
                    role="menuitem"
                    disabled={item.why !== undefined}
                    title={item.why}
                    data-testid={`chat-plus-${id}`}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      menu.chosen();
                      props.onRun(id);
                    }}
                  >
                    <Icon size={13} aria-hidden />
                    <span className={styles.menuName}>{item.name}</span>
                    {item.keys && <kbd className={styles.menuKeys}>{item.keys}</kbd>}
                  </button>,
                ];
              })}
            </div>
          ))}
          <div className={styles.menuGroup} role="group">
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={props.planFirst}
              data-testid="chat-plus-plan"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                menu.chosen();
                props.onPlanFirst();
              }}
            >
              {props.planFirst ? (
                <Check size={13} aria-hidden className={styles.menuCheck} />
              ) : (
                <ListChecks size={13} aria-hidden />
              )}
              <span className={styles.menuName}>{t("chat.compose.planFirst")}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
