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

const noSubscription = () => () => {};
const noProgress = () => NO_PROGRESS;

/**
 * The assets of the project to find and use: videos, pictures, sounds, fonts, scenes and sounds
 * made by code, dragged onto the timeline or put there with a double click. Bringing files in
 * happens here too; looking after them happens in the explorer. See docs/design/resource-panels.md,
 * section 2.
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
    data.kind === "asset" && data.asset.kind === "font"
      ? { reason: t("assetPanel.why.font"), draggable: false }
      : undefined;

  const addToTimeline = (resource: Resource<ProjectItem>) => {
    const { data } = resource;
    if (data.kind === "asset") timeline.addAsset(data.id);
    else if (data.kind === "scene") timeline.addScene(data.id);
    else timeline.addSound(data.id);
    habits.used(resource.id);
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
          activateOn="double-click"
          onActivate={addToTimeline}
          onDragStart={(resource, event) => {
            event.dataTransfer.setData(DRAG_TYPES[resource.data.kind], resource.data.id);
            event.dataTransfer.effectAllowed = "copy";
          }}
          onDragEnd={(resource, dropped) => {
            if (dropped) habits.used(resource.id);
          }}
        />
      </div>
    </div>
  );
}
