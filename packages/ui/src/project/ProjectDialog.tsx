import type { ProjectStore } from "@animaquill/core";
import {
  BookImage,
  Bot,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  FileText,
  Globe,
  HardDrive,
  Library,
  Lock,
  Monitor,
  Music,
  Type,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { unusableLine } from "../cloud/unusable.ts";
import {
  DialogFrame,
  useLevelsInHistory,
  useNarrow,
  useNoStepsWhenClosed,
} from "../settings/shell.tsx";
import settings from "../settings/Settings.module.css";
import { PROJECT_GROUPS, type ProjectGroup } from "../workbench/project-nav.ts";
import {
  CoverGroup,
  FontsGroup,
  GeneralGroup,
  LanguagesGroup,
  LibrariesGroup,
  PictureGroup,
  SoundGroup,
  TimelinesGroup,
} from "./ProjectGroups.tsx";
import { StorageGroup } from "./StorageGroup.tsx";
import { AgentsGroup } from "../local-ai/AgentsGroup.tsx";
import styles from "./Project.module.css";

const ICONS: Readonly<Record<ProjectGroup, ComponentType<{ size?: number }>>> = {
  general: FileText,
  picture: Monitor,
  sound: Music,
  timelines: Clapperboard,
  languages: Globe,
  cover: BookImage,
  fonts: Type,
  libraries: Library,
  agents: Bot,
  storage: HardDrive,
};

/** Where the project properties keep their steps in the browser's history, see `shell.tsx`. */
const PROPERTIES_STEP = "aqProperties";

/**
 * The project properties (docs/design/settings-and-properties.md of AnimaQuill Cloud, 5): the
 * shell of the settings, for what the open project says about itself. Only while a project is
 * open; they close with it.
 */
export function ProjectPropertiesHost() {
  const workbench = useWorkbench();
  const { projectNav } = workbench;
  const { store } = useSession();
  const shown = useSyncExternalStore(projectNav.shown.subscribe, projectNav.shown.getSnapshot);
  const open = shown && store !== undefined;
  useNoStepsWhenClosed(PROPERTIES_STEP, open);
  useEffect(() => {
    if (!store) projectNav.close();
  }, [store, projectNav]);
  // Another project is another dialog: nothing of what it read is kept.
  return open ? <ProjectDialog key={workbench.session.key} store={store} /> : null;
}

/** Whether the project cannot be changed now, and why: a locked tag, or the platform. */
export interface Locked {
  readonly locked: boolean;
  /** Only the tags can be changed: a locked tag is how the project is locked. */
  readonly why: "tag" | "platform" | undefined;
}

function useLocked(store: ProjectStore): Locked {
  const workbench = useWorkbench();
  const state = useProject(store);
  const readOnly = useSyncExternalStore(
    workbench.readOnly.subscribe,
    workbench.readOnly.getSnapshot,
  );
  const tagged = state?.manifest.tags?.some((tag) => tag.locked) === true;
  if (readOnly) return { locked: true, why: "platform" };
  if (tagged) return { locked: true, why: "tag" };
  return { locked: false, why: undefined };
}

function ProjectDialog({ store }: { readonly store: ProjectStore }) {
  const workbench = useWorkbench();
  const { projectNav } = workbench;
  const { t } = useTranslation();
  const place = useSyncExternalStore(projectNav.subscribe, projectNav.getSnapshot);
  const state = useProject(store);
  const narrow = useNarrow();
  const locked = useLocked(store);
  const pageRef = useRef<HTMLDivElement>(null);
  const back = useLevelsInHistory(PROPERTIES_STEP, projectNav, narrow, place.depth);
  const group = place.group;
  const depth = narrow ? place.depth : 1;
  const name = state?.manifest.name ?? "";
  const close = () => projectNav.close();

  // Narrow, they begin with the list of groups, unless they open at something in one (4.2).
  useLayoutEffect(() => {
    const { group: shown, depth: at, item } = projectNav.getSnapshot();
    if (narrow && at === 1 && item === undefined) projectNav.go({ group: shown, depth: 0 });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only as they open
  }, []);

  // Something to go to, such as the name as "重命名项目" opens them: in view, standing out for a
  // moment, and ready to type in.
  useEffect(() => {
    const id = place.item;
    if (id === undefined) return;
    const target = pageRef.current?.querySelector<HTMLElement>(
      `[data-property="${CSS.escape(id)}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    const input = target.querySelector<HTMLElement>("input, textarea, select");
    if (input && !input.matches(":disabled")) {
      input.focus();
      if (input instanceof HTMLInputElement) input.select();
    }
    target.dataset.flash = "";
    const timer = setTimeout(() => delete target.dataset.flash, 1600);
    return () => {
      clearTimeout(timer);
      delete target.dataset.flash;
    };
  }, [place]);

  const title = t(`projectProps.groups.${group}`);
  return (
    <DialogFrame
      label={t("projectProps.title")}
      testId="project-properties"
      kind="properties"
      narrow={narrow}
      onClose={close}
    >
      <div className={settings.box}>
        <header className={settings.head}>
          {narrow && depth > 0 ? (
            <>
              <button
                type="button"
                className={settings.up}
                data-testid="project-properties-back"
                onClick={back}
              >
                <ChevronLeft size={16} aria-hidden />
                {t("projectProps.title")}
              </button>
              <h2 className={settings.title}>{title}</h2>
            </>
          ) : (
            <>
              <h2 className={settings.title}>{t("projectProps.title")}</h2>
              <span className={settings.crumb} data-testid="project-properties-name">
                · {name}
              </span>
            </>
          )}
          <button
            type="button"
            className={`${settings.close} ${styles.closeEnd}`}
            aria-label={t("projectProps.close")}
            onClick={close}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className={settings.body}>
          {(!narrow || depth === 0) && (
            <nav className={settings.nav} aria-label={t("projectProps.groupsLabel")}>
              <div className={settings.section}>
                {PROJECT_GROUPS.map((each) => {
                  const Icon = ICONS[each];
                  return (
                    <button
                      key={each}
                      type="button"
                      className={settings.navItem}
                      aria-current={!narrow && each === group ? "page" : undefined}
                      data-group={each}
                      onClick={() => projectNav.go({ group: each, depth: 1 })}
                    >
                      <Icon size={15} aria-hidden />
                      <span>{t(`projectProps.groups.${each}`)}</span>
                      {narrow && <ChevronRight size={14} className={settings.more} aria-hidden />}
                    </button>
                  );
                })}
              </div>
            </nav>
          )}
          {(!narrow || depth > 0) && (
            <div
              ref={pageRef}
              className={settings.page}
              data-group={group}
              data-testid={`project-properties-${group}`}
            >
              {locked.locked && <LockedBar locked={locked} />}
              <GroupPage group={group} store={store} locked={locked} />
            </div>
          )}
        </div>
      </div>
    </DialogFrame>
  );
}

/**
 * Why nothing can be changed here now, in yellow, as the bar above the editor says it: a locked
 * tag, with the way out right here; or the platform, with the panel that has the ways out.
 */
function LockedBar({ locked }: { readonly locked: Locked }) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const unusable = workbench.cloud?.unusable;
  const [now] = useState(() => Date.now());
  return (
    <div className={styles.lockedBar} role="status" data-testid="project-properties-locked">
      <Lock size={14} aria-hidden />
      <span>
        {locked.why === "tag"
          ? t("projectProps.locked.tag")
          : unusable
            ? t("cloud.unusable.bar", {
                what: unusableLine(unusable, now, t),
                interpolation: { escapeValue: false },
              })
            : t("projectProps.locked.platform")}
      </span>
      {locked.why === "tag" ? (
        <button
          type="button"
          onClick={() => workbench.projectNav.go({ group: "general", depth: 1, item: "tags" })}
        >
          {t("projectProps.locked.toTags")}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            workbench.projectNav.close();
            workbench.cloudPanel.set(true);
          }}
        >
          {t("cloud.unusable.showWays")}
        </button>
      )}
    </div>
  );
}

function GroupPage(props: {
  readonly group: ProjectGroup;
  readonly store: ProjectStore;
  readonly locked: Locked;
}) {
  switch (props.group) {
    case "general":
      return <GeneralGroup store={props.store} locked={props.locked} />;
    case "picture":
      return <PictureGroup store={props.store} locked={props.locked} />;
    case "sound":
      return <SoundGroup store={props.store} />;
    case "timelines":
      return <TimelinesGroup store={props.store} locked={props.locked} />;
    case "languages":
      return <LanguagesGroup store={props.store} locked={props.locked} />;
    case "cover":
      return <CoverGroup store={props.store} locked={props.locked} />;
    case "fonts":
      return <FontsGroup store={props.store} />;
    case "libraries":
      return <LibrariesGroup store={props.store} />;
    case "agents":
      return <AgentsGroup store={props.store} locked={props.locked} />;
    case "storage":
      return <StorageGroup store={props.store} locked={props.locked.locked} />;
  }
}
