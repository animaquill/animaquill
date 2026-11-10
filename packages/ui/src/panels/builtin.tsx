import {
  Blend,
  BookOpen,
  CodeXml,
  Diamond,
  Diff,
  Download,
  Files,
  FolderTree,
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
  Settings,
  SlidersHorizontal,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { FxIcon } from "./FxIcon.tsx";
import { ChatPanel } from "../chat/ChatPanel.tsx";
import { CodePanel } from "../code/CodePanel.tsx";
import { FilesPanel } from "../code/FilesPanel.tsx";
import { ProblemsPanel } from "../problems/ProblemsPanel.tsx";
import { TimelinePanel } from "../timeline/TimelinePanel.tsx";
import type { PanelArea, PanelDefinition } from "../workbench/panels.ts";
import type zhCN from "../i18n/zh-CN.json";
import { DiagnosticsPanel } from "../diagnostics/DiagnosticsPanel.tsx";
import { ExportsPanel } from "../export/ExportsPanel.tsx";
import { KeyframesPanel } from "../keyframes/KeyframesPanel.tsx";
import { PropertiesPanel } from "../properties/PropertiesPanel.tsx";
import { AssetsPanel } from "./AssetsPanel.tsx";
import { KeybindingsPanel } from "./KeybindingsPanel.tsx";
import { PreviewPanel } from "./PreviewPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { EffectsPanel } from "./EffectsPanel.tsx";
import { ExplorerPanel } from "./ExplorerPanel.tsx";
import { TransitionsPanel } from "./TransitionsPanel.tsx";
import styles from "./Placeholder.module.css";

type Type = {
  [K in keyof typeof zhCN.panel]: (typeof zhCN.panel)[K] extends { title: string } ? K : never;
}[keyof typeof zhCN.panel];

type Extra = Pick<PanelDefinition, "keepAlive" | "keys">;

/** A panel whose real content comes in a later stage. */
function planned(
  type: Exclude<
    Type,
    | "unknown"
    | "code"
    | "files"
    | "keybindings"
    | "timeline"
    | "preview"
    | "assets"
    | "performance"
    | "problems"
    | "properties"
    | "settings"
    | "keyframes"
    | "exports"
    | "transitions"
    | "effects"
    | "explorer"
    | "chat"
  >,
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
    planned: true,
    ...extra,
  };
}

export const builtinPanels: readonly PanelDefinition[] = [
  {
    type: "files",
    title: (t) => t("panel.files.title"),
    icon: Files,
    area: "left",
    component: FilesPanel,
    keys: ["mod+shift+e"],
  },
  {
    type: "explorer",
    title: (t) => t("panel.explorer.title"),
    icon: FolderTree,
    area: "left",
    component: ExplorerPanel,
  },
  {
    type: "assets",
    title: (t) => t("panel.assets.title"),
    icon: Images,
    area: "left",
    component: AssetsPanel,
  },
  {
    type: "transitions",
    title: (t) => t("panel.transitions.title"),
    icon: Blend,
    area: "left",
    component: TransitionsPanel,
  },
  {
    type: "effects",
    title: (t) => t("panel.effects.title"),
    icon: FxIcon,
    area: "left",
    component: EffectsPanel,
  },
  {
    type: "preview",
    title: (t) => t("panel.preview.title"),
    icon: MonitorPlay,
    area: "center",
    component: PreviewPanel,
    keepAlive: true,
  },
  {
    type: "code",
    title: (t) => t("panel.code.title"),
    icon: CodeXml,
    area: "center",
    component: CodePanel,
    keepAlive: true,
    beside: "preview",
  },
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
  {
    type: "settings",
    title: (t) => t("panel.settings.title"),
    icon: Settings,
    area: "center",
    component: SettingsPanel,
  },
  {
    type: "properties",
    title: (t) => t("panel.properties.title"),
    icon: SlidersHorizontal,
    area: "right",
    component: PropertiesPanel,
  },
  {
    type: "chat",
    title: (t) => t("panel.chat.title"),
    icon: MessagesSquare,
    area: "right",
    component: ChatPanel,
    keepAlive: true,
  },
  planned("history", "right", History),
  planned("notes", "right", BookOpen),
  planned("annotations", "right", MessageSquareText),
  {
    type: "timeline",
    title: (t) => t("panel.timeline.title"),
    icon: Rows3,
    area: "bottom",
    component: TimelinePanel,
  },
  {
    type: "keyframes",
    title: (t) => t("panel.keyframes.title"),
    icon: Diamond,
    area: "bottom",
    component: KeyframesPanel,
  },
  planned("differences", "bottom", Diff),
  {
    type: "problems",
    title: (t) => t("panel.problems.title"),
    icon: TriangleAlert,
    area: "bottom",
    component: ProblemsPanel,
    keys: ["mod+shift+m"],
  },
  {
    type: "exports",
    title: (t) => t("panel.exports.title"),
    icon: Download,
    area: "bottom",
    component: ExportsPanel,
  },
  planned("terminal", "bottom", SquareTerminal, { keepAlive: true, keys: ["mod+`"] }),
  planned("cache", "bottom", HardDrive),
  {
    type: "performance",
    title: (t) => t("panel.performance.title"),
    icon: Gauge,
    area: "bottom",
    component: DiagnosticsPanel,
  },
];
