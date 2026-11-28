import {
  ChevronLeft,
  ChevronRight,
  Diamond,
  Download,
  HardDrive,
  Info,
  Keyboard,
  Library,
  Laptop,
  MessageSquareText,
  Pencil,
  Play,
  Search,
  Server,
  Settings,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { AiModelsPage } from "../chat/AiModelsPage.tsx";
import { ModelPacksSettings } from "../chat/ModelPacksSettings.tsx";
import { labelParts, originIn } from "../chat/packText.ts";
import { OnlineOnly } from "../app/OnlineOnly.tsx";
import {
  SETTINGS_SECTIONS,
  type SettingsGroup,
  type SettingsPlace,
} from "../workbench/settings-nav.ts";
import {
  AboutGroup,
  AccountGroup,
  ServerGroup,
  ChatGroup,
  EditingGroup,
  ExportGroup,
  GeneralGroup,
  PlaybackGroup,
  StorageGroup,
} from "./groups.tsx";
import { KeybindingsPage } from "./KeybindingsPage.tsx";
import { LocalAiGroup } from "../local-ai/LocalAiSettings.tsx";
import { GroupWhere, useGroups, useLockedGroups } from "./parts.tsx";
import { searchSettings } from "./registry.ts";
import { DialogFrame, useLevelsInHistory, useNarrow, useNoStepsWhenClosed } from "./shell.tsx";
import styles from "./Settings.module.css";

const ICONS: Readonly<Record<SettingsGroup, ComponentType<{ size?: number }>>> = {
  general: Settings,
  editing: Pencil,
  playback: Play,
  export: Download,
  keys: Keyboard,
  models: Diamond,
  packs: Library,
  chat: MessageSquareText,
  localAi: Laptop,
  account: UserRound,
  server: Server,
  storage: HardDrive,
  about: Info,
};

/** Where the settings keep their steps in the browser's history, see `useLevelsInHistory`. */
const SETTINGS_STEP = "aqSettings";

/**
 * The settings, as a dialog over whatever the window shows, the editor or the start page
 * (docs/design/settings-and-properties.md of AnimaQuill Cloud, 4): groups on the left, the group on
 * the right, and a search across all of them. Changes take at once; there is nothing to save.
 */
export function SettingsHost() {
  const { settingsNav } = useWorkbench();
  const shown = useSyncExternalStore(settingsNav.shown.subscribe, settingsNav.shown.getSnapshot);
  useNoStepsWhenClosed(SETTINGS_STEP, shown);
  return shown ? <SettingsDialog /> : null;
}

function SettingsDialog() {
  const workbench = useWorkbench();
  const { settingsNav } = workbench;
  const { t } = useTranslation();
  const place = useSyncExternalStore(settingsNav.subscribe, settingsNav.getSnapshot);
  // The names of a service and a model in the crumbs follow them as they are renamed.
  useSyncExternalStore(workbench.ai.subscribe, workbench.ai.getSnapshot);
  useSyncExternalStore(workbench.packs.subscribe, workbench.packs.getSnapshot);
  const shownGroups = useGroups();
  const locked = useLockedGroups();
  // What is grey can be seen, not opened or searched.
  const groups = shownGroups.filter((each) => !locked.has(each));
  const narrow = useNarrow();
  const [query, setQuery] = useState("");
  const pageRef = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  const group = groups.includes(place.group) ? place.group : "general";
  const depth = narrow ? place.depth : Math.max(place.depth, 1);
  const go = (next: SettingsPlace) => settingsNav.go(next);
  const back = useLevelsInHistory(SETTINGS_STEP, settingsNav, narrow, place.depth);

  // A setting to go to, as one found by searching: in view, and standing out for a moment.
  useEffect(() => {
    const id = place.item;
    if (id === undefined) return;
    const target = pageRef.current?.querySelector<HTMLElement>(
      `[data-setting="${CSS.escape(id)}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.dataset.flash = "";
    const timer = setTimeout(() => delete target.dataset.flash, 1600);
    return () => {
      clearTimeout(timer);
      delete target.dataset.flash;
    };
  }, [place]);

  const close = () => settingsNav.close();

  const found = query.trim() === "" ? undefined : searchSettings(t, query, groups);
  // What belongs to the project, not to the settings, which people look for here all the same.
  const words = query.trim().toLowerCase().split(/\s+/);
  const elsewhere =
    found !== undefined &&
    t("settings.elsewhereWords.project")
      .split(" ")
      .some((word) =>
        words.some(
          (typed) => typed.includes(word) || (typed.length >= 2 && word.startsWith(typed)),
        ),
      );
  const title = t(`settings.groups.${group}`);
  const service =
    group === "models" && place.depth >= 2 && place.service !== undefined
      ? workbench.ai.getSnapshot().services.find(({ id }) => id === place.service)?.name
      : undefined;
  const model =
    service !== undefined && place.depth === 3 && place.model !== undefined
      ? (workbench.ai.modelOf(place.service ?? "", place.model)?.name ?? place.model)
      : undefined;
  // The page of a model pack: its name, as its label has it.
  const pack =
    group === "packs" && place.depth >= 2 && place.adding !== undefined
      ? t("ai.packs.install")
      : group === "packs" && place.depth >= 2 && place.pack !== undefined
        ? (() => {
            const shown = workbench.packs.packOf(place.pack);
            return shown
              ? labelParts(t, shown, originIn(shown, workbench.packs.getSnapshot())).name
              : place.pack;
          })()
        : undefined;
  const opened = service ?? pack;
  const showList = !narrow || (depth === 0 && found === undefined);
  const showPage = found === undefined && (!narrow || depth > 0);

  return (
    <DialogFrame
      label={t("settings.title")}
      testId="settings"
      narrow={narrow}
      onClose={close}
      initialFocus={searchBox}
      searchBox={searchBox}
    >
      <div className={styles.box}>
        <header className={styles.head}>
          {narrow && depth > 0 && found === undefined ? (
            <>
              <button
                type="button"
                className={styles.up}
                data-testid="settings-back"
                onClick={back}
              >
                <ChevronLeft size={16} aria-hidden />
                {depth === 3 ? (service ?? title) : depth === 2 ? title : t("settings.title")}
              </button>
              <h2 className={styles.title}>
                {depth === 3 ? (model ?? title) : depth === 2 ? (opened ?? title) : title}
              </h2>
            </>
          ) : (
            <>
              <h2 className={styles.title}>{t("settings.title")}</h2>
              {!narrow && (
                <span className={styles.crumb} data-testid="settings-crumb">
                  {found === undefined ? (
                    <>
                      {"› "}
                      {/* The AI settings are the backend's as a whole, online. */}
                      {(group === "models" || group === "packs") && (
                        <GroupWhere where="account" className={styles.crumbWhere} />
                      )}
                      {`${title}${opened === undefined ? "" : ` › ${opened}`}${model === undefined ? "" : ` › ${model}`}`}
                    </>
                  ) : (
                    `› ${t("settings.searchResults")}`
                  )}
                </span>
              )}
            </>
          )}
          {(!narrow || depth === 0 || found !== undefined) && (
            <label className={styles.search}>
              <Search size={14} aria-hidden />
              <input
                ref={searchBox}
                type="search"
                aria-label={t("settings.searchLabel")}
                placeholder={t(narrow ? "settings.searchShort" : "settings.search")}
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query !== "") {
                    // Esc empties the search first, and only then closes.
                    event.preventDefault();
                    setQuery("");
                  }
                }}
              />
            </label>
          )}
          <button
            type="button"
            className={styles.close}
            aria-label={t("settings.close")}
            onClick={close}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className={styles.body}>
          {showList && (
            <nav className={styles.nav} aria-label={t("settings.pagesLabel")}>
              {SETTINGS_SECTIONS.map(([section, all]) => {
                const shown = all.filter((each) => shownGroups.includes(each));
                if (shown.length === 0) return null;
                return (
                  <div key={section} className={styles.section}>
                    {section !== "editor" && (
                      <span className={styles.sectionName}>
                        {t(`settings.sections.${section}`)}
                      </span>
                    )}
                    {shown.map((each) => {
                      const Icon = ICONS[each];
                      if (locked.has(each))
                        return (
                          <OnlineOnly
                            key={each}
                            className={styles.navItem}
                            what={t(`settings.groups.${each}`)}
                          >
                            <Icon size={15} aria-hidden />
                            <span>{t(`settings.groups.${each}`)}</span>
                          </OnlineOnly>
                        );
                      return (
                        <button
                          key={each}
                          type="button"
                          className={styles.navItem}
                          aria-current={
                            !narrow && found === undefined && each === group ? "page" : undefined
                          }
                          data-group={each}
                          onClick={() => {
                            setQuery("");
                            go({ group: each, depth: 1 });
                          }}
                        >
                          <Icon size={15} aria-hidden />
                          <span>{t(`settings.groups.${each}`)}</span>
                          {narrow && <ChevronRight size={14} className={styles.more} aria-hidden />}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </nav>
          )}
          {found !== undefined && (
            <div className={styles.results} role="list" aria-label={t("settings.searchResults")}>
              {elsewhere && (
                <p className={styles.elsewhere} data-testid="settings-elsewhere">
                  {t("settings.elsewhere.project")}
                  {workbench.session.store && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className={styles.link}
                        onClick={() => workbench.openProjectProperties()}
                      >
                        {t("projectProps.action")}
                      </button>
                    </>
                  )}
                </p>
              )}
              {found.length === 0 ? (
                <p className={styles.none}>{t("settings.searchNone", { query: query.trim() })}</p>
              ) : (
                found.map(({ item, name, group: groupName }) => (
                  <button
                    key={item.id}
                    type="button"
                    role="listitem"
                    className={styles.result}
                    data-testid="settings-result"
                    data-setting={item.id}
                    onClick={() => {
                      setQuery("");
                      go({ group: item.group, depth: 1, item: item.id });
                    }}
                  >
                    <span className={styles.resultGroup}>{groupName} ›</span> {name}
                    <span className={styles.resultHelp}>
                      {t(`settings.items.${item.id}.help`, { defaultValue: "" })}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          {showPage && (
            <div
              ref={pageRef}
              className={styles.page}
              data-group={group}
              data-testid={`settings-${group}`}
            >
              <GroupPage group={group} />
            </div>
          )}
        </div>
      </div>
    </DialogFrame>
  );
}

/** A group, each in the shape it has: rows of settings, or a page of its own. */
function GroupPage({ group }: { readonly group: SettingsGroup }) {
  switch (group) {
    case "models":
      return (
        <div className={styles.whole} data-group="models">
          <AiModelsPage />
        </div>
      );
    case "packs":
      return (
        <div className={styles.whole} data-group="packs">
          <ModelPacksSettings />
        </div>
      );
    case "keys":
      return <KeybindingsPage />;
    case "general":
      return <GeneralGroup />;
    case "editing":
      return <EditingGroup />;
    case "playback":
      return <PlaybackGroup />;
    case "export":
      return <ExportGroup />;
    case "chat":
      return <ChatGroup />;
    case "localAi":
      return <LocalAiGroup />;
    case "account":
      return <AccountGroup />;
    case "server":
      return <ServerGroup />;
    case "storage":
      return <StorageGroup />;
    case "about":
      return <AboutGroup />;
  }
}
