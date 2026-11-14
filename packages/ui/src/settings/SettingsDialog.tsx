import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  Diamond,
  Download,
  HardDrive,
  Info,
  Keyboard,
  Laptop,
  Library,
  MessageSquareText,
  Pencil,
  Play,
  Search,
  Settings,
  UserRound,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { AiModelsPage } from "../chat/AiModelsPage.tsx";
import { ModelPacksSettings } from "../chat/ModelPacksSettings.tsx";
import { CloudSyncPage } from "../cloud/CloudSyncPage.tsx";
import { useAccount } from "../cloud/CloudParts.tsx";
import {
  SETTINGS_SECTIONS,
  visibleGroups,
  type SettingsGroup,
  type SettingsPlace,
} from "../workbench/settings-nav.ts";
import {
  AboutGroup,
  AccountGroup,
  ChatGroup,
  EditingGroup,
  ExportGroup,
  GeneralGroup,
  PlaybackGroup,
  StorageGroup,
  ToolsGroup,
} from "./groups.tsx";
import { KeybindingsPage } from "./KeybindingsPage.tsx";
import { GroupWhere } from "./parts.tsx";
import { searchSettings } from "./registry.ts";
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
  tools: Laptop,
  account: UserRound,
  cloud: Cloud,
  storage: HardDrive,
  about: Info,
};

/** Below this the settings fill the window and show one level at a time (4.2). */
const NARROW = "(max-width: 719px)";

/**
 * The settings, as a dialog over whatever the window shows, the editor or the start page
 * (docs/design/settings-and-properties.md of AnimaQuill Cloud, 4): groups on the left, the group on
 * the right, and a search across all of them. Changes take at once; there is nothing to save.
 */
export function SettingsHost() {
  const { settingsNav } = useWorkbench();
  const shown = useSyncExternalStore(settingsNav.shown.subscribe, settingsNav.shown.getSnapshot);
  useNoStepsWhenClosed(shown);
  return shown ? <SettingsDialog /> : null;
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const query = matchMedia(NARROW);
    const follow = () => setNarrow(query.matches);
    query.addEventListener("change", follow);
    follow();
    return () => query.removeEventListener("change", follow);
  }, []);
  return narrow;
}

/** The groups there are now: the account's only with a platform, cloud sync only signed in. */
export function useGroups(): readonly SettingsGroup[] {
  const { cloudSync, account } = useWorkbench();
  const { available } = useSyncExternalStore(cloudSync.subscribe, cloudSync.getSnapshot);
  const signedIn = useAccount(account).status === "signedIn";
  return visibleGroups({ account: account !== undefined, cloud: available && signedIn });
}

/** How many steps of the browser's history the settings have put on, by what each step says. */
const SETTINGS_STEP = "aqSettings";
const stepsNow = (): number => {
  const state: unknown = history.state;
  const step =
    typeof state === "object" && state !== null
      ? (state as Record<string, unknown>)[SETTINGS_STEP]
      : undefined;
  return typeof step === "number" ? step : 0;
};

/**
 * Takes the steps of the settings off the history, as they close: see `useLevelsInHistory`. Not as
 * the dialog goes away, which React also does to try it out.
 */
function useNoStepsWhenClosed(shown: boolean): void {
  useEffect(() => {
    const steps = stepsNow();
    if (!shown && steps > 0) history.go(-steps);
  }, [shown]);
}

/**
 * Where the settings are narrow, they and each level in are a step of the browser's history, so
 * that its back button goes up a level, as the "‹" does, and from the list of groups closes them.
 * Each step says how many there are up to it (`SETTINGS_STEP`), so that whatever moves the history,
 * the settings follow what it says. Levels the settings leave in another way are taken off the
 * history again. (The settings are not a modal `<dialog>`: browsers take going back in the history
 * for closing one of those, and the history would not move.)
 */
function useLevelsInHistory(narrow: boolean, depth: number): () => void {
  const { settingsNav } = useWorkbench();

  useEffect(() => {
    if (!narrow) return;
    const onPop = () => {
      const steps = stepsNow();
      if (steps === 0) return settingsNav.close();
      while (settingsNav.getSnapshot().depth > steps - 1) settingsNav.back();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [narrow, settingsNav]);

  useEffect(() => {
    const wanted = narrow ? depth + 1 : 0;
    const steps = stepsNow();
    if (steps > wanted) history.go(wanted - steps);
    for (let step = steps + 1; step <= wanted; step += 1) {
      const state: unknown = history.state;
      const base = typeof state === "object" && state !== null ? state : {};
      history.pushState({ ...base, [SETTINGS_STEP]: step }, "");
    }
  }, [narrow, depth]);

  // The "‹": through the history where there is a step of it, so that both stay in step.
  return () => {
    if (stepsNow() > 1) history.back();
    else settingsNav.back();
  };
}

/** Inputs where people type, which take what they typed when they lose the focus or on Enter. */
const isTyping = (element: Element | null): element is HTMLInputElement | HTMLTextAreaElement =>
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLInputElement &&
    !["checkbox", "radio", "button", "range", "color", "file", "submit"].includes(element.type));

function SettingsDialog() {
  const workbench = useWorkbench();
  const { settingsNav } = workbench;
  const { t } = useTranslation();
  const place = useSyncExternalStore(settingsNav.subscribe, settingsNav.getSnapshot);
  const groups = useGroups();
  const narrow = useNarrow();
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  /** The input people are typing in, and what it had when they began: see `dirty`. */
  const typing = useRef<{ element: Element; value: string } | undefined>(undefined);
  /** Whether the press that may close the settings began outside of them. */
  const pressedOutside = useRef(false);

  const group = groups.includes(place.group) ? place.group : "general";
  const depth = narrow ? place.depth : Math.max(place.depth, 1);
  const go = (next: SettingsPlace) => settingsNav.go(next);
  const back = useLevelsInHistory(narrow, place.depth);

  // The focus goes in, and back to where it was as they close. The search first, as on any page of
  // settings; on a phone the keyboard would cover it all.
  useLayoutEffect(() => {
    const before = document.activeElement;
    if (matchMedia(NARROW).matches) dialog.current?.focus();
    else searchBox.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  // The focus stays in the settings, as in any dialog that is in the way of what is behind it: what
  // leaves them for the editor comes back. Dialogs over them, and the notifications, are not that.
  useEffect(() => {
    const keepFocus = (event: FocusEvent) => {
      const element = dialog.current;
      const target = event.target as Element | null;
      if (!element || !target || element.contains(target)) return;
      if (target.closest("dialog, [data-notifications]")) return;
      element.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => document.removeEventListener("focusin", keepFocus);
  }, []);

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
  /** Something typed that did not go in yet: a press outside does not throw it away. */
  const dirty = () => {
    const active = document.activeElement;
    const was = typing.current;
    return (
      isTyping(active) &&
      active !== searchBox.current &&
      was?.element === active &&
      active.value !== was.value
    );
  };

  const found = query.trim() === "" ? undefined : searchSettings(t, query, groups);
  const title = t(`settings.groups.${group}`);
  const service =
    group === "models" && place.depth === 2 && place.service !== undefined
      ? workbench.ai.getSnapshot().services.find(({ id }) => id === place.service)?.name
      : undefined;
  const showList = !narrow || (depth === 0 && found === undefined);
  const showPage = found === undefined && (!narrow || depth > 0);

  /** Esc closes them; what is open over them, or in them, such as a list or a recording, first. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") return keepTabIn(event);
    // Enter takes what was typed, as losing the focus does: nothing is left to keep then.
    if (event.key === "Enter" && isTyping(event.target as Element)) {
      const target = event.target as HTMLInputElement;
      typing.current = { element: target, value: target.value };
      return;
    }
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if ((event.target as Element).closest("dialog")) return;
    event.preventDefault();
    // Something typed that did not go in yet goes in first, as when the box loses the focus.
    const active = document.activeElement;
    if (dirty() && active instanceof HTMLElement) active.blur();
    else close();
  };
  /** Tab from the last thing in the settings goes to the first, and the other way round. */
  const keepTabIn = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = dialog.current;
    if (!element) return;
    const all = [
      ...element.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((each) => !each.matches(":disabled") && each.offsetParent !== null);
    const first = all[0];
    const last = all.at(-1);
    if (!first || !last) return;
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === element)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div
        className={styles.backdrop}
        data-testid="settings-backdrop"
        onMouseDown={(event) => {
          // Something typed that did not go in yet keeps the settings open, and the focus.
          pressedOutside.current = !dirty();
          if (!pressedOutside.current) event.preventDefault();
        }}
        onClick={() => {
          // A press that began and ended on the dim around the settings.
          if (pressedOutside.current && !dirty()) close();
          pressedOutside.current = false;
        }}
      />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={styles.dialog}
        data-testid="settings"
        data-narrow={narrow ? "" : undefined}
        aria-label={t("settings.title")}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          const target = event.target as Element;
          if (isTyping(target) && typing.current?.element !== target)
            typing.current = { element: target, value: target.value };
        }}
        onMouseDown={() => {
          pressedOutside.current = false;
        }}
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
                  {depth === 2 ? title : t("settings.title")}
                </button>
                <h2 className={styles.title}>{depth === 2 ? (service ?? title) : title}</h2>
              </>
            ) : (
              <>
                <h2 className={styles.title}>{t("settings.title")}</h2>
                {!narrow && (
                  <span className={styles.crumb} data-testid="settings-crumb">
                    › {title}
                    {service !== undefined && ` › ${service}`}
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
                  const shown = all.filter((each) => groups.includes(each));
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
                            {narrow && (
                              <ChevronRight size={14} className={styles.more} aria-hidden />
                            )}
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
                        {t(`settings.items.${item.id}.help`)}
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
      </div>
    </>
  );
}

/** A group, each in the shape it has: rows of settings, or a page of its own. */
function GroupPage({ group }: { readonly group: SettingsGroup }) {
  switch (group) {
    case "models":
      return (
        <div className={styles.whole} data-group="models">
          <GroupWhere where="ai" className={styles.wholeWhere} />
          <AiModelsPage />
        </div>
      );
    case "packs":
      return (
        <div className={styles.whole}>
          <GroupWhere where="ai" className={styles.wholeWhere} />
          <div className={styles.scroll}>
            <ModelPacksSettings />
          </div>
        </div>
      );
    case "cloud":
      return (
        <div className={styles.whole}>
          <GroupWhere where="account" className={styles.wholeWhere} />
          <CloudSyncPage />
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
    case "tools":
      return <ToolsGroup />;
    case "account":
      return <AccountGroup />;
    case "storage":
      return <StorageGroup />;
    case "about":
      return <AboutGroup />;
  }
}
