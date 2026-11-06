import {
  BookOpen,
  CodeXml,
  Diamond,
  Diff,
  Files,
  Gauge,
  Grid3x3,
  HardDrive,
  History,
  Images,
  Keyboard,
  MessageSquareText,
  MessagesSquare,
  Mic,
  MonitorPlay,
  Music,
  Rows3,
  SlidersHorizontal,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { TimelinePanel } from "../timeline/TimelinePanel.tsx";
import type { PanelArea, PanelDefinition } from "../workbench/panels.ts";
import type zhCN from "../i18n/zh-CN.json";
import { KeybindingsPanel } from "./KeybindingsPanel.tsx";
import styles from "./Placeholder.module.css";

type Type = {
  [K in keyof typeof zhCN.panel]: (typeof zhCN.panel)[K] extends { title: string } ? K : never;
}[keyof typeof zhCN.panel];

type Extra = Pick<PanelDefinition, "activity" | "keepAlive" | "keys">;

/** A panel whose real content comes in a later stage. */
function planned(
  type: Exclude<Type, "unknown" | "keybindings" | "timeline">,
  area: PanelArea,
  icon: PanelDefinition["icon"],
  extra: Extra = {},
): PanelDefinition {
  const Icon = icon;
  function Placeholder() {
    const { t } = useTranslation();
    return (
      <div className={styles.placeholder}>
        <Icon size={32} />
        <h2>{t(`panel.${type}.title`)}</h2>
        <p>{t(`panel.${type}.hint`)}</p>
      </div>
    );
  }
  return {
    type,
    title: (t) => t(`panel.${type}.title`),
    icon,
    area,
    component: Placeholder,
    ...extra,
  };
}

export const builtinPanels: readonly PanelDefinition[] = [
  planned("files", "left", Files, { activity: true, keys: ["mod+shift+e"] }),
  planned("assets", "left", Images, { activity: true }),
  planned("notes", "left", BookOpen, { activity: true }),
  planned("history", "left", History, { activity: true }),
  planned("preview", "center", MonitorPlay, { keepAlive: true }),
  planned("code", "center", CodeXml, { keepAlive: true }),
  planned("music", "center", Music),
  planned("recording", "center", Mic),
  planned("versions", "center", Grid3x3),
  {
    type: "keybindings",
    title: (t) => t("panel.keybindings.title"),
    icon: Keyboard,
    area: "center",
    component: KeybindingsPanel,
  },
  planned("properties", "right", SlidersHorizontal),
  planned("chat", "right", MessagesSquare, { activity: true, keepAlive: true }),
  planned("annotations", "right", MessageSquareText),
  {
    type: "timeline",
    title: (t) => t("panel.timeline.title"),
    icon: Rows3,
    area: "bottom",
    component: TimelinePanel,
  },
  planned("keyframes", "bottom", Diamond),
  planned("differences", "bottom", Diff),
  planned("problems", "bottom", TriangleAlert, { keys: ["mod+shift+m"] }),
  planned("terminal", "bottom", SquareTerminal, { keepAlive: true, keys: ["mod+`"] }),
  planned("cache", "bottom", HardDrive),
  planned("performance", "bottom", Gauge),
];
