import { bezierProgress } from "@animaquill/core";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bubble } from "../app/Bubble.tsx";
import { PopupMenu, type MenuItem } from "../app/Menu.tsx";
import type { Pointer } from "../timeline/gestures.ts";
import type { KeyArea, KeySpot } from "./area.ts";
import { EASE_PRESETS } from "./easing.ts";
import type { KeyframeEditor } from "./editor.ts";
import styles from "./KeyPopups.module.css";

/** What a stretch looks like, with room above and below for what overshoots. */
const CURVE_WIDTH = 36;
const CURVE_HEIGHT = 24;
const CURVE_MARGIN = 5;
const CURVE_POINTS = 24;

function EaseCurve({ ease }: { ease: (typeof EASE_PRESETS)[number]["ease"] }) {
  const room = CURVE_HEIGHT - CURVE_MARGIN * 2;
  const yOf = (progress: number) => CURVE_HEIGHT - CURVE_MARGIN - progress * room;
  let points = "";
  if (ease.interp === "hold") {
    points = `0,${yOf(0)} ${CURVE_WIDTH},${yOf(0)} ${CURVE_WIDTH},${yOf(1)}`;
  } else if (ease.interp === "linear") {
    points = `0,${yOf(0)} ${CURVE_WIDTH},${yOf(1)}`;
  } else {
    const [x1, y1] = ease.out;
    const [x2, y2] = ease.in;
    for (let step = 0; step <= CURVE_POINTS; step += 1) {
      const share = step / CURVE_POINTS;
      points += `${share * CURVE_WIDTH},${yOf(bezierProgress(x1, y1, x2, y2, share))} `;
    }
  }
  return (
    <svg className={styles.curve} width={CURVE_WIDTH} height={CURVE_HEIGHT} aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

interface InterpBubbleProps {
  readonly keyframes: KeyframeEditor;
  readonly anchor: DOMRect;
  readonly onClose: () => void;
}

/** How the selected keys go on. It stays open, so that people can try them one after the other. */
export function InterpBubble({ keyframes, anchor, onClose }: InterpBubbleProps) {
  const { t } = useTranslation();
  useSyncExternalStore(keyframes.subscribeView, () => keyframes.selectedPreset);
  const current = keyframes.selectedPreset;
  return (
    <Bubble anchor={anchor} title={t("keyframes.interp")} onClose={onClose}>
      <div className={styles.presets} role="radiogroup" aria-label={t("keyframes.interp")}>
        {EASE_PRESETS.map(({ id, ease }) => (
          <button
            key={id}
            type="button"
            role="radio"
            className={styles.preset}
            aria-checked={current === id}
            {...(current === id ? { "data-autofocus": true } : {})}
            onClick={() => keyframes.setEase(ease)}
          >
            <EaseCurve ease={ease} />
            {t(`keyframes.ease.${id}`)}
          </button>
        ))}
      </div>
    </Bubble>
  );
}

interface PopupState {
  readonly x: number;
  readonly y: number;
  readonly groups: readonly (readonly MenuItem[])[];
}

export interface KeyPopups {
  /** Opens what belongs to a place. Says whether there is anything. */
  open(pointer: Pointer, stage: DOMRect): boolean;
  doubleClick(pointer: Pointer): boolean;
  readonly element: ReactNode;
}

/** The right mouse button and the double click, the same on all lanes. */
export function useKeyPopups(area: KeyArea): KeyPopups {
  const { keyframes } = area;
  const { t } = useTranslation();
  const [menu, setMenu] = useState<PopupState>();
  const [anchor, setAnchor] = useState<DOMRect>();

  const openOnKey = (spot: KeySpot, x: number, y: number) => {
    if (!keyframes.selection.includes(spot.keys)) area.selectSpot(spot);
    const canMove = keyframes.canMove(spot.box.id);
    setMenu({
      x,
      y,
      groups: [
        [
          {
            id: "interp",
            label: t("keyframes.interpMore"),
            disabled: !canMove,
            run: () => setAnchor(new DOMRect(x, y, 0, 0)),
          },
        ],
        [
          {
            id: "copy",
            label: t("keyframes.action.copy"),
            run: () => keyframes.copySelected(),
          },
          {
            id: "paste",
            label: t("keyframes.action.paste"),
            disabled: !keyframes.getSnapshot().hasClipboard,
            run: () => keyframes.paste(),
          },
          {
            id: "delete",
            label: t("keyframes.action.delete"),
            disabled: !canMove,
            run: () => keyframes.deleteSelected(),
          },
        ],
        [
          {
            id: "row",
            label: t("keyframes.selectRow"),
            run: () => area.selectLane(spot.lane, false),
          },
          {
            id: "column",
            label: t("keyframes.selectColumn"),
            run: () => area.selectColumn(spot, false),
          },
        ],
      ],
    });
  };

  return {
    open(pointer, stage) {
      const hit = area.hitAt(pointer);
      if (hit.kind !== "key") return false;
      openOnKey(hit, stage.left + pointer.x, stage.top + pointer.y);
      return true;
    },
    doubleClick(pointer) {
      const hit = area.hitAt(pointer);
      const adding = pointer.shift || pointer.mod;
      if (hit.kind === "key") area.selectColumn(hit, adding);
      else if (hit.kind === "lane") area.selectLane(hit.lane, adding);
      return hit.kind === "key" || hit.kind === "lane";
    },
    element: (
      <>
        {menu && (
          <PopupMenu
            label={t("keyframes.keys")}
            x={menu.x}
            y={menu.y}
            groups={menu.groups}
            onClose={() => setMenu(undefined)}
          />
        )}
        {anchor && (
          <InterpBubble
            keyframes={keyframes}
            anchor={anchor}
            onClose={() => setAnchor(undefined)}
          />
        )}
      </>
    ),
  };
}
