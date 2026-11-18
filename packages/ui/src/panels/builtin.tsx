import {
  AudioLines,
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
  MessageSquareText,
  MessagesSquare,
  Mic,
  MonitorPlay,
  Music,
  Rows3,
  SlidersHorizontal,
  SlidersVertical,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { FadeIcon } from "./FadeIcon.tsx";
import { FxIcon } from "./FxIcon.tsx";
import { ChatPanel } from "../chat/ChatPanel.tsx";
import { CodePanel } from "../code/CodePanel.tsx";
import { FilesPanel } from "../code/FilesPanel.tsx";
import { ProblemsPanel } from "../problems/ProblemsPanel.tsx";
import { TimelinePanel } from "../timeline/TimelinePanel.tsx";
import type { PanelArea, PanelDefinition, PanelSize } from "../workbench/panels.ts";
import type zhCN from "../i18n/zh-CN.json";
import { DiagnosticsPanel } from "../diagnostics/DiagnosticsPanel.tsx";
import { ExportsPanel } from "../export/ExportsPanel.tsx";
import { KeyframesPanel } from "../keyframes/KeyframesPanel.tsx";
import { PropertiesPanel } from "../properties/PropertiesPanel.tsx";
import { MixerPanel } from "../mixer/MixerPanel.tsx";
import { AssetsPanel } from "./AssetsPanel.tsx";
import { PreviewPanel } from "./PreviewPanel.tsx";
import { EffectsPanel, SoundEffectsPanel } from "./EffectsPanel.tsx";
import { ExplorerPanel } from "./ExplorerPanel.tsx";
import { FadesPanel, TransitionsPanel } from "./TransitionsPanel.tsx";
import styles from "./Placeholder.module.css";

type Type = {
  [K in keyof typeof zhCN.panel]: (typeof zhCN.panel)[K] extends { title: string } ? K : never;
}[keyof typeof zhCN.panel];

type Extra = Pick<PanelDefinition, "keepAlive" | "keys">;

const LARGE: readonly PanelSize[] = ["large"];
const TALL: readonly PanelSize[] = ["tall"];
const WIDE: readonly PanelSize[] = ["wide"];

/** A panel whose real content comes in a later stage. */
function planned(
  type: Exclude<
    Type,
    | "unknown"
    | "code"
    | "files"
    | "timeline"
    | "preview"
    | "assets"
    | "performance"
    | "problems"
    | "properties"
    | "keyframes"
    | "exports"
    | "transitions"
    | "fades"
    | "effects"
    | "soundEffects"
    | "explorer"
    | "chat"
    | "mixer"
  >,
  area: PanelArea,
  sizes: readonly PanelSize[],
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
    sizes,
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
    sizes: TALL,
    component: FilesPanel,
    keys: ["mod+shift+e"],
  },
  {
    type: "explorer",
    title: (t) => t("panel.explorer.title"),
    icon: FolderTree,
    area: "left",
    sizes: TALL,
    component: ExplorerPanel,
  },
  {
    type: "assets",
    title: (t) => t("panel.assets.title"),
    icon: Images,
    area: "left",
    sizes: ["tall", "large"],
    component: AssetsPanel,
  },
  {
    type: "transitions",
    title: (t) => t("panel.transitions.title"),
    icon: Blend,
    area: "left",
    sizes: ["tall", "large"],
    component: TransitionsPanel,
  },
  {
    type: "fades",
    title: (t) => t("panel.fades.title"),
    icon: FadeIcon,
    area: "left",
    sizes: ["tall", "large"],
    component: FadesPanel,
  },
  {
    type: "effects",
    title: (t) => t("panel.effects.title"),
    icon: FxIcon,
    area: "left",
    sizes: ["tall", "large"],
    component: EffectsPanel,
  },
  {
    type: "soundEffects",
    title: (t) => t("panel.soundEffects.title"),
    icon: AudioLines,
    area: "left",
    sizes: ["tall", "large"],
    component: SoundEffectsPanel,
  },
  {
    type: "preview",
    title: (t) => t("panel.preview.title"),
    icon: MonitorPlay,
    area: "center",
    sizes: LARGE,
    component: PreviewPanel,
    keepAlive: true,
  },
  {
    type: "code",
    title: (t) => t("panel.code.title"),
    icon: CodeXml,
    area: "center",
    sizes: LARGE,
    component: CodePanel,
    keepAlive: true,
    beside: "preview",
  },
  planned("music", "center", ["large", "tall"], Music),
  planned("recording", "center", LARGE, Mic),
  planned("versions", "center", LARGE, Grid3x3),
  {
    type: "properties",
    title: (t) => t("panel.properties.title"),
    icon: SlidersHorizontal,
    area: "right",
    sizes: TALL,
    component: PropertiesPanel,
  },
  {
    type: "mixer",
    title: (t) => t("panel.mixer.title"),
    icon: SlidersVertical,
    area: "right",
    sizes: TALL,
    component: MixerPanel,
  },
  {
    type: "chat",
    title: (t) => t("panel.chat.title"),
    icon: MessagesSquare,
    area: "right",
    sizes: TALL,
    component: ChatPanel,
    keepAlive: true,
  },
  planned("history", "right", TALL, History),
  planned("notes", "right", ["tall", "large"], BookOpen),
  planned("annotations", "right", TALL, MessageSquareText),
  {
    type: "timeline",
    title: (t) => t("panel.timeline.title"),
    icon: Rows3,
    area: "bottom",
    sizes: WIDE,
    component: TimelinePanel,
  },
  {
    type: "keyframes",
    title: (t) => t("panel.keyframes.title"),
    icon: Diamond,
    area: "bottom",
    sizes: WIDE,
    component: KeyframesPanel,
  },
  planned("differences", "bottom", WIDE, Diff),
  {
    type: "problems",
    title: (t) => t("panel.problems.title"),
    icon: TriangleAlert,
    area: "bottom",
    sizes: ["wide", "tall"],
    component: ProblemsPanel,
    keys: ["mod+shift+m"],
  },
  {
    type: "exports",
    title: (t) => t("panel.exports.title"),
    icon: Download,
    area: "bottom",
    sizes: ["wide", "tall"],
    component: ExportsPanel,
  },
  planned("terminal", "bottom", ["wide", "large"], SquareTerminal, {
    keepAlive: true,
    keys: ["mod+`"],
  }),
  planned("cache", "bottom", ["wide", "tall"], HardDrive),
  {
    type: "performance",
    title: (t) => t("panel.performance.title"),
    icon: Gauge,
    area: "bottom",
    sizes: WIDE,
    component: DiagnosticsPanel,
  },
];
