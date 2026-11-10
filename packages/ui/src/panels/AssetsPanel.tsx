import { Plus, Upload } from "lucide-react";
import { useMemo, useState, useSyncExternalStore, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { NO_PROGRESS } from "../folder/assets.ts";
import { ProjectIcon } from "../resources/ProjectIcon.tsx";
import { ResourceBrowser } from "../resources/ResourceBrowser.tsx";
import {
  ASSETS_TAB_TYPES,
  PROJECT_TYPES,
  projectResources,
  type ProjectItem,
} from "../resources/project-resources.ts";
import { resourceTypeName } from "../resources/type-names.ts";
import type { Resource } from "../resources/resources.ts";
import { useNotice } from "../resources/notice.ts";
import { formatTimecode, type FrameRate } from "../timeline/frames.ts";
import { mediaDrag } from "../timeline/media-drag.ts";
import styles from "./AssetsPanel.module.css";

/** What a drag from this list carries. */
export const ASSET_DRAG_TYPE = "application/x-animaquill-asset";
export const SCENE_DRAG_TYPE = "application/x-animaquill-scene";
export const SOUND_DRAG_TYPE = "application/x-animaquill-sound";

const DRAG_TYPES: Readonly<Record<ProjectItem["kind"], string>> = {
  asset: ASSET_DRAG_TYPE,
  scene: SCENE_DRAG_TYPE,
  sound: SOUND_DRAG_TYPE,
};

/** A moment as people read it, without the frame when it is on a whole second: 0:12. */
function shortTimecode(frame: number, rate: FrameRate | undefined): string {
  if (!rate) return "";
  const full = formatTimecode(frame, rate);
  return frame % rate.nominal === 0 ? full.replace(/\/\d+$/, "") : full;
}

/** Whether a resource of the project can go onto the timeline: fonts are used by captions and scenes. */
export const canDragProjectItem = (item: ProjectItem): boolean =>
  !(item.kind === "asset" && item.asset.kind === "font");

/** What a drag of a resource of the project carries, from any tab that lists them. */
export function startProjectItemDrag(item: ProjectItem, event: DragEvent<HTMLElement>): void {
  event.dataTransfer.setData(DRAG_TYPES[item.kind], item.id);
  event.dataTransfer.effectAllowed = "copy";
  mediaDrag.start({ kind: item.kind, id: item.id });
}

const noSubscription = () => () => {};
const noProgress = () => NO_PROGRESS;

/**
 * The assets of the project to find and use: videos, pictures, sounds, fonts, scenes and sounds
 * made by code, dragged onto the timeline or put there with a click, at the playhead, see
 * `TimelineEditor.addAsset`. Bringing files in happens here too; looking after them happens in the
 * explorer. See docs/design/resource-panels.md, section 2.
 */
export function AssetsPanel() {
  const workbench = useWorkbench();
  const { media, timeline, resourceHabits: habits } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const project = useProject(store);
  const importing = useSyncExternalStore(media.subscribe, media.getImporting);
  const copying = useSyncExternalStore(media.subscribe, media.getCopying);
  const folders = workbench.projectFolders;
  const inFolder = useSyncExternalStore(
    folders?.subscribe ?? noSubscription,
    () => folders?.getSnapshot().open !== undefined,
  );
  const progress = useSyncExternalStore(
    folders?.subscribeProgress ?? noSubscription,
    folders?.getProgress ?? noProgress,
  );
  const [reading] = progress.reading;
  const [over, setOver] = useState(false);
  const [notice, say] = useNotice();

  const resources = useMemo(
    () =>
      project
        ? projectResources(project, project.manifest.id).filter(({ type }) =>
            ASSETS_TAB_TYPES.has(type),
          )
        : [],
    [project],
  );

  const unavailable = ({ data }: Resource<ProjectItem>) =>
    canDragProjectItem(data) ? undefined : { reason: t("assetPanel.why.font"), draggable: false };

  /** A click puts it at the playhead, and says where it went, or why it did not. */
  const addToTimeline = (resource: Resource<ProjectItem>) => {
    const { data } = resource;
    const added = timeline.addMedia({ kind: data.kind, id: data.id });
    if (!added) {
      say(resource.id, t("assetPanel.failed"), undefined, true);
      return;
    }
    habits.used(resource.id);
    const where = t("assetPanel.added", {
      tracks: added.tracks
        .map(({ kind, number, name }) => name ?? t(`timeline.track.${kind}`, { number }))
        .join("、"),
      start: shortTimecode(added.frame, timeline.model?.rate),
    });
    say(resource.id, `${resource.name}${where}`, `✓ ${where}`);
  };

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

  return (
    <div
      className={over ? styles.dropping : styles.panel}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setOver(false);
        void workbench.importDropped(event.dataTransfer);
      }}
    >
      <div className={styles.toolbar}>
        <button type="button" onClick={() => void workbench.pickFiles()}>
          <Upload size={14} />
          {t("assets.import")}
        </button>
        <button type="button" onClick={() => timeline.createScene()}>
          <Plus size={14} />
          {t("assets.newScene")}
        </button>
        <button type="button" onClick={() => timeline.createSound()}>
          <Plus size={14} />
          {t("assets.newSound")}
        </button>
        {importing > 0 && !copying && (
          <span role="status">{t("assets.importing", { count: importing })}</span>
        )}
        {reading && (
          <span
            role="status"
            title={progress.reading.map(({ path, percent }) => `${path} ${percent}%`).join("\n")}
          >
            {progress.checked && t("folder.checking.progress", progress.checked)}{" "}
            {t("folder.checking.reading", {
              path: reading.path,
              percent: reading.percent,
              interpolation: { escapeValue: false },
            })}
          </span>
        )}
        {copying && (
          <span role="status">
            {t(`folder.copy.${copying.stage}`, { name: copying.name, percent: copying.percent })}
            <button type="button" onClick={copying.stop}>
              {t("folder.copy.stop")}
            </button>
          </span>
        )}
      </div>
      <div className={styles.browser}>
        <ResourceBrowser<ProjectItem>
          tab="assets"
          label={t("panel.assets.title")}
          searchLabel={t("assetPanel.search")}
          resources={resources}
          types={PROJECT_TYPES}
          defaultGrouping="type"
          typeName={(type) => resourceTypeName(t, type)}
          empty={t(inFolder ? "assets.emptyFolder" : "assets.empty")}
          unavailable={unavailable}
          Icon={ProjectIcon}
          onActivate={addToTimeline}
          notice={notice}
          onDragStart={(resource, event) => startProjectItemDrag(resource.data, event)}
          onDragEnd={(resource, dropped) => {
            if (dropped) habits.used(resource.id);
          }}
        />
      </div>
    </div>
  );
}
