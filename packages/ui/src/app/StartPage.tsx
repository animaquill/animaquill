import { StorageSpace } from "../storage/StorageSpace.tsx";
import type { FolderStatus } from "@animaquill/host";
import {
  ChevronDown,
  Clock,
  Cloud,
  Ellipsis,
  FolderInput,
  FolderOpen,
  HardDrive,
  Layers,
  LayoutGrid,
  List,
  Plus,
  Search,
  Settings,
  Star,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { sizeOf, type UnfinishedExport } from "../export/video.ts";
import {
  cardActions,
  cardPlace,
  cardStatus,
  cloudMarksKey,
  isCloudKind,
  composeCards,
  coverColorOf,
  DANGEROUS,
  gitHubAddress,
  initialOf,
  isUnusable,
  marksTargetOf,
  unusableChoices,
  type CardAction,
  type MarksTarget,
  type ProjectCard,
} from "../start/cards.ts";
import {
  DEFAULT_HABITS,
  groupOfView,
  isWelcome,
  remoteCards,
  sectionsOf,
  SORTS,
  sortOfView,
  viewCards,
  viewThere,
  type Display,
  type StartSection,
  type ViewId,
} from "../start/views.ts";
import type { CoverTarget } from "../start/cover-choice.ts";
import type { CardCover } from "../start/covers.ts";
import type { RenameOutcome } from "../start/rename.ts";
import type { OnlineRenameOutcome } from "../start/online-names.ts";
import type { ProjectFoldersSnapshot, WaitingFolder } from "../workbench/project-folders.ts";
import type { Workbench } from "../workbench/workbench.ts";
import { useWorkbench } from "./context.ts";
import { Menu, PopupMenu, type MenuItem } from "./Menu.tsx";
import { OnlineOnly } from "./OnlineOnly.tsx";
import { PlaceIcon } from "./PlaceIcon.tsx";
import styles from "./StartPage.module.css";
import { agoText, durationText } from "./start-view.ts";
import { unusableFix, unusableLine } from "../cloud/unusable.ts";

/** Where there is no backend to keep the AI settings: nothing to say of it. */
const noAccountAi = () => undefined;
const noSubscription = () => () => {};
const NO_FOLDERS: ProjectFoldersSnapshot = { open: undefined, waiting: undefined };
const noFolders = () => NO_FOLDERS;
const noAccount = () => undefined;
/** How often the times on the page move on. */
const TICK_MS = 60_000;
/** What a card carries while it is dragged onto a group. */
const CARD_TYPE = "application/x-animaquill-card";

const plain = { interpolation: { escapeValue: false } } as const;

/**
 * What the page knows of where it runs, which decides what it offers (docs/design/
 * online-offline.md of AnimaQuill Cloud, 1.2 and 1.3).
 */
interface Situation {
  readonly mode: "online" | "offline";
  /** This browser can write folders. */
  readonly canFolders: boolean;
  /** Offline: there is an online mode to sign in to, see `Host.goOnline`. */
  readonly canGoOnline: boolean;
}

/** What exports that stopped halfway take on this device, which people can clear, see 6.1. */
function UnfinishedExports({
  found,
  nameOf,
  refresh,
}: {
  found: readonly UnfinishedExport[];
  nameOf: (project: string) => string;
  refresh: () => void;
}) {
  const { videos } = useWorkbench();
  const { t } = useTranslation();
  if (found.length === 0) return <p className={styles.muted}>{t("start.empty.view")}</p>;
  return (
    <section aria-label={t("export.unfinished.title")} className={styles.exports}>
      <p className={styles.muted}>{t("export.unfinished.about")}</p>
      <ul className={styles.exportList}>
        {found.map(({ id, project, name, bytes, status, done, total }) => (
          <li key={id}>
            <span className={styles.exportName}>
              {t("export.unfinished.item", {
                project: nameOf(project),
                file: name,
                status:
                  total > 0
                    ? t("export.unfinished.percent", {
                        status: t(`export.unfinished.status.${status}`),
                        percent: Math.floor((done / total) * 100),
                      })
                    : t(`export.unfinished.status.${status}`),
                size: sizeOf(bytes),
                ...plain,
              })}
            </span>
            <button
              type="button"
              className={styles.quiet}
              onClick={() => void videos.forget(id).then(refresh)}
            >
              {t("export.unfinished.clear")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A project folder that the address of this window asks for, which waits for people. */
/** The views that are a page of their own, not a list of projects. */
const isPage = (view: ViewId): boolean => view === "exports" || view === "storage";

function Waiting({ waiting }: { waiting: WaitingFolder }) {
  const { projectFolders } = useWorkbench();
  const { t } = useTranslation();
  const { record, status } = waiting;
  if (!projectFolders) return null;
  if (status === "ask") {
    return (
      <section className={styles.waiting} aria-label={t("folder.continue", { name: record.name })}>
        <button
          type="button"
          className={styles.primary}
          onClick={() => void projectFolders.openRecent(record)}
        >
          <FolderOpen size={16} />
          {t("folder.continue", { name: record.name })}
        </button>
        <p className={styles.muted}>{t("folder.continueHint")}</p>
      </section>
    );
  }
  return (
    <section className={styles.waiting} role="alert">
      <p>
        {status === "gone"
          ? t("folder.waitingGone", { name: record.name })
          : t("folder.waitingBlocked", { name: record.name })}
      </p>
      {status === "gone" && (
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void projectFolders.findAgain(record)}
        >
          {t("folder.findAgain")}
        </button>
      )}
    </section>
  );
}

// ---- the side bar

function SectionLabel({ section }: { section: StartSection }) {
  const { t } = useTranslation();
  return (
    <>{"key" in section.label ? t(section.label.key as "start.view.all") : section.label.text}</>
  );
}

const SECTION_ICONS: Partial<Record<string, typeof Clock>> = {
  recent: Clock,
  all: Layers,
  starred: Star,
  exports: TriangleAlert,
};

/** A group of the side bar: its view, a place to drop cards on, and what can be done to it. */
function GroupItem({
  section,
  current,
  onSelect,
  onDropCard,
}: {
  section: StartSection;
  current: boolean;
  onSelect: () => void;
  onDropCard: (card: string) => void;
}) {
  const { organizer, dialogs, notifications } = useWorkbench();
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [isOver, setIsOver] = useState(false);
  const [popup, setPopup] = useState<{ x: number; y: number } | undefined>();
  const id = groupOfView(section.id) as string;
  const name = "text" in section.label ? section.label.text : "";
  const words = { name, ...plain };

  const remove = async () => {
    const go = await dialogs.confirm({
      title: t("start.group.deleteTitle", words),
      message: t("start.group.deleteMessage"),
      confirm: t("start.group.deleteConfirm"),
      danger: true,
    });
    if (go && (await organizer.deleteGroup(id)) === false)
      notifications.push(t("start.group.failed"));
  };
  const items = (): MenuItem[][] => [
    [
      { id: "rename", label: t("start.group.rename"), run: () => setRenaming(true) },
      { id: "delete", label: t("start.group.delete"), danger: true, run: () => void remove() },
    ],
  ];
  const isCard = (event: DragEvent) => event.dataTransfer.types.includes(CARD_TYPE);
  // On entering too: the browser goes by the last of the two.
  const takeCard = (event: DragEvent) => {
    if (!isCard(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setIsOver(true);
  };

  if (renaming) {
    return (
      <div className={styles.navItem} data-group={id}>
        <NameInput
          label={t("start.group.nameLabel")}
          initial={name}
          problem={problem}
          onCancel={() => {
            setRenaming(false);
            setProblem(undefined);
          }}
          onCommit={async (next) => {
            const outcome = await organizer.renameGroup(id, next);
            if (outcome === true || outcome === "offline") {
              setRenaming(false);
              setProblem(undefined);
              return true;
            }
            if (outcome === undefined) {
              notifications.push(t("start.group.failed"));
              setRenaming(false);
              return true;
            }
            setProblem(t(`start.group.problem.${outcome}`));
            return false;
          }}
        />
      </div>
    );
  }
  return (
    <div
      className={styles.navItem}
      data-group={id}
      data-drop={isOver || undefined}
      onDragEnter={takeCard}
      onDragOver={takeCard}
      onDragLeave={() => setIsOver(false)}
      onDrop={(event) => {
        setIsOver(false);
        if (!isCard(event)) return;
        event.preventDefault();
        onDropCard(event.dataTransfer.getData(CARD_TYPE));
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setPopup({ x: event.clientX, y: event.clientY });
      }}
    >
      <button
        type="button"
        className={styles.navButton}
        aria-current={current ? "page" : undefined}
        onClick={onSelect}
      >
        <span className={styles.navName}>
          <SectionLabel section={section} />
        </span>
        <span className={styles.count}>{section.count}</span>
      </button>
      <Menu
        label={t("start.group.more", words)}
        trigger={<Ellipsis size={14} />}
        triggerClassName={styles.navMore}
        align="end"
        groups={items}
      />
      {popup && (
        <PopupMenu
          label={t("start.group.more", words)}
          groups={items()}
          x={popup.x}
          y={popup.y}
          onClose={() => setPopup(undefined)}
        />
      )}
    </div>
  );
}

/** A name typed where it shows: Enter keeps it, Escape goes back, leaving keeps it too. */
function NameInput({
  label,
  initial,
  problem,
  onCommit,
  onCancel,
  className,
}: {
  label: string;
  initial: string;
  problem: string | undefined;
  /** Resolves to whether it is over: where not, people can change the name and try again. */
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
  className?: string | undefined;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const isDone = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const commit = () => {
    if (isDone.current) return;
    if (value.trim() === "" || value.trim() === initial.trim()) {
      isDone.current = true;
      onCancel();
      return;
    }
    // Once: Enter, and then leaving the field while it is being kept, would do it twice.
    isDone.current = true;
    void onCommit(value).then((isOver) => {
      if (!isOver) isDone.current = false;
    });
  };
  return (
    <span className={`${styles.nameInput} ${className ?? ""}`}>
      <input
        ref={input}
        aria-label={label}
        aria-invalid={problem !== undefined}
        spellCheck={false}
        autoComplete="off"
        maxLength={200}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            isDone.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          // A name that cannot be is not kept by leaving: people see why, and go back.
          if (problem === undefined) commit();
          else {
            isDone.current = true;
            onCancel();
          }
        }}
      />
      {problem && (
        <span className={styles.problem} role="alert">
          {problem}
        </span>
      )}
    </span>
  );
}

function Sidebar({
  sections,
  view,
  onView,
  onNew,
  onDropCard,
  situation,
}: {
  sections: readonly StartSection[];
  view: ViewId;
  onView: (view: ViewId) => void;
  onNew: () => void;
  onDropCard: (card: string, group: string) => void;
  situation: Situation;
}) {
  const { organizer, notifications } = useWorkbench();
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const mine = sections.filter((section) => section.block === "projects");
  const groups = sections.filter((section) => section.block === "groups");
  return (
    <nav className={styles.nav} aria-label={t("start.sidebar")}>
      <button type="button" className={styles.newProject} onClick={onNew}>
        <Plus size={16} />
        {t("project.new")}
      </button>
      <div className={styles.block} role="group" aria-labelledby="start-block-projects">
        <span className={styles.blockLabel} id="start-block-projects">
          {t("start.block.projects")}
        </span>
        {mine.map((section) => {
          const Icon = SECTION_ICONS[section.id] ?? Layers;
          return (
            <button
              key={section.id}
              type="button"
              className={styles.navButton}
              aria-current={view === section.id ? "page" : undefined}
              data-view={section.id}
              onClick={() => onView(section.id)}
            >
              <Icon size={15} className={styles.navIcon} aria-hidden="true" />
              <span className={styles.navName}>
                <SectionLabel section={section} />
              </span>
              {section.count !== undefined && <span className={styles.count}>{section.count}</span>}
            </button>
          );
        })}
      </div>
      <div className={styles.block} role="group" aria-labelledby="start-block-groups">
        <span className={styles.blockLabel} id="start-block-groups">
          {t("start.block.groups")}
        </span>
        {groups.map((section) => (
          <GroupItem
            key={section.id}
            section={section}
            current={view === section.id}
            onSelect={() => onView(section.id)}
            onDropCard={(card) => onDropCard(card, groupOfView(section.id) as string)}
          />
        ))}
        {creating ? (
          <div className={styles.navItem}>
            <NameInput
              label={t("start.group.nameLabel")}
              initial=""
              problem={problem}
              onCancel={() => {
                setCreating(false);
                setProblem(undefined);
              }}
              onCommit={async (name) => {
                const made = await organizer.createGroup(name);
                if (made !== undefined && made !== "offline" && "problem" in made) {
                  setProblem(t(`start.group.problem.${made.problem}`));
                  return false;
                }
                if (made === undefined) notifications.push(t("start.group.failed"));
                setCreating(false);
                setProblem(undefined);
                return true;
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            className={`${styles.navButton} ${styles.newGroup}`}
            onClick={() => setCreating(true)}
          >
            <Plus size={14} className={styles.navIcon} aria-hidden="true" />
            <span className={styles.navName}>{t("start.group.new")}</span>
          </button>
        )}
      </div>
      <div className={styles.foot}>
        {situation.mode === "online" ? (
          <button
            type="button"
            className={styles.navButton}
            aria-current={view === "storage" ? "page" : undefined}
            data-view="storage"
            onClick={() => onView("storage")}
          >
            <HardDrive size={15} className={styles.navIcon} aria-hidden="true" />
            <span className={styles.navName}>{t("storage.uploads.space.nav")}</span>
          </button>
        ) : (
          situation.canGoOnline && (
            <OnlineOnly className={styles.navButton} what={t("storage.uploads.space.nav")}>
              <HardDrive size={15} className={styles.navIcon} aria-hidden="true" />
              <span className={styles.navName}>{t("storage.uploads.space.nav")}</span>
            </OnlineOnly>
          )
        )}
        <Account situation={situation} />
        <SettingsButton />
      </div>
    </nav>
  );
}

/** The settings, at the very bottom of the side bar: there is no title bar menu to look in here. */
function SettingsButton() {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={styles.navButton}
      data-testid="start-settings"
      onClick={() => workbench.openSettings()}
    >
      <Settings size={15} className={styles.navIcon} aria-hidden="true" />
      <span className={styles.navName}>{t("settings.title")}</span>
    </button>
  );
}

/**
 * Who is signed in, at the bottom of the side bar, with the way to the offline mode and out of the
 * account; offline, the way to sign in, see the design of the modes, 1.4.
 */
function Account({ situation }: { situation: Situation }) {
  const workbench = useWorkbench();
  const { account } = workbench;
  const { t } = useTranslation();
  const who = useSyncExternalStore(
    account?.subscribe ?? noSubscription,
    account?.getSnapshot ?? noAccount,
  );
  const unreachable = useSyncExternalStore(
    workbench.accountAi?.subscribe ?? noSubscription,
    workbench.accountAi?.getSnapshot ?? noAccountAi,
  );
  if (situation.mode === "offline") {
    if (!situation.canGoOnline) return null;
    return (
      <div className={styles.account} data-testid="start-offline">
        <span className={styles.accountWords}>
          <span className={styles.accountName}>{t("start.account.offline")}</span>
        </span>
        <button type="button" className={styles.secondary} onClick={() => workbench.goOnline()}>
          {t("start.signIn")}
        </button>
      </div>
    );
  }
  if (!account || !who) return null;
  const name = who.status === "signedIn" ? who.name : t("start.account.unknown");
  // The backend cannot be reached now: said where the mode is.
  const away = unreachable?.status === "offline";
  return (
    <Menu
      label={t("account.menu", { name, ...plain })}
      triggerClassName={`${styles.account} ${styles.accountButton}`}
      trigger={
        <>
          <span className={styles.avatar} aria-hidden="true">
            {initialOf(name)}
          </span>
          <span className={styles.accountWords}>
            <span className={styles.accountName}>{name}</span>
            <span className={styles.accountState}>
              {t(
                who.status === "signedOut"
                  ? "start.account.signedOut"
                  : away
                    ? "start.account.onlineAway"
                    : "start.account.online",
              )}
            </span>
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </>
      }
      groups={() => [
        [
          ...(who.status === "signedOut"
            ? [{ id: "signIn", label: t("start.signIn"), run: () => void workbench.signIn() }]
            : []),
          ...(workbench.canGoOffline
            ? [
                {
                  id: "offline",
                  label: t("account.goOffline"),
                  run: () => void workbench.goOffline(),
                },
              ]
            : []),
        ],
        ...(who.status === "signedIn"
          ? [[{ id: "signOut", label: t("account.signOut"), run: () => void workbench.signOut() }]]
          : []),
      ]}
    />
  );
}

// ---- making projects

function NewCards({
  situation,
  large,
  onNew,
}: {
  situation: Situation;
  large: boolean;
  onNew: (kind: NewKind) => void;
}) {
  const { t } = useTranslation();
  const { mode, canFolders } = situation;
  const card = (kind: NewKind, Icon: typeof Cloud, title: string, about: string) => (
    <button type="button" className={styles.newCard} data-new={kind} onClick={() => onNew(kind)}>
      <Icon size={large ? 32 : 26} className={styles.newIcon} aria-hidden="true" />
      <span className={styles.newWords}>
        <span className={styles.newTitle}>{title}</span>
        <span className={styles.newAbout}>{about}</span>
      </span>
    </button>
  );
  return (
    <section
      className={styles.newCards}
      data-large={large || undefined}
      aria-label={t("start.new.label")}
    >
      {mode === "online" ? (
        <>
          {card("new", Plus, t("start.new.project"), t("start.new.onlineAbout"))}
          {card("import", FolderInput, t("start.new.import"), t("start.new.importAbout"))}
        </>
      ) : canFolders ? (
        <>
          {card("new", Plus, t("start.new.project"), t("start.new.localAbout"))}
          {card("open", FolderOpen, t("start.new.open"), t("start.new.openAbout"))}
        </>
      ) : (
        <>
          {card("new", Plus, t("start.new.project"), t("start.new.browserAbout"))}
          {card("import", FolderInput, t("start.new.importHere"), t("start.new.importHereAbout"))}
        </>
      )}
    </section>
  );
}

/** What a card of the new ones does: a new project, one opened from a folder, or one imported. */
type NewKind = "new" | "open" | "import";

// ---- the projects

interface CardsProps {
  readonly cards: readonly ProjectCard[];
  readonly display: Display;
  /** Which time the cards say: when each was opened, or when it changed. */
  readonly time: "opened" | "updated";
  readonly now: number;
  readonly label: string;
  readonly actions: CardActions;
  readonly statuses: ReadonlyMap<string, FolderStatus>;
  readonly copies: ReadonlyMap<string, number>;
  readonly situation: Situation;
  readonly busy: boolean;
  /** The cover of each card, by its id, see `StartCovers`. */
  readonly covers: ReadonlyMap<string, CardCover>;
  /** Follows whether people can see a card, for its cover. Returns how to stop. */
  readonly watch: ((element: Element | null) => (() => void) | undefined) | undefined;
}

/** What the page does for a card. */
interface CardActions {
  open(card: ProjectCard): void;
  run(card: ProjectCard, action: CardAction, at: HTMLElement | null): void;
  rename(card: ProjectCard, name: string): Promise<RenameOutcome | OnlineRenameOutcome>;
  renaming: string | undefined;
  stopRenaming(): void;
  star(card: ProjectCard): void;
}

function CardList(props: CardsProps) {
  const { t } = useTranslation();
  const { cards, display, label, covers } = props;
  // A column that would be empty everywhere is left out.
  const hasDuration = cards.some((card) => durationOf(card, covers) !== undefined);
  return (
    <ul
      className={display === "list" ? styles.rows : styles.grid}
      aria-label={label}
      data-duration={hasDuration || undefined}
    >
      {display === "list" && (
        <li className={styles.rowHead} aria-hidden="true">
          <span>{t("start.list.name")}</span>
          <span>{t("start.list.place")}</span>
          <span>{t("start.list.status")}</span>
          {hasDuration && <span>{t("start.list.duration")}</span>}
          <span>{t(props.time === "opened" ? "start.list.opened" : "start.list.changed")}</span>
        </li>
      )}
      {cards.map((card) => (
        <CardItem key={card.id} card={card} {...props} />
      ))}
    </ul>
  );
}

function CardItem({
  card,
  cards,
  display,
  time,
  now,
  actions,
  statuses,
  copies,
  situation,
  busy,
  covers,
  watch,
}: CardsProps & { card: ProjectCard }) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const unfinishedUploads = useSyncExternalStore(
    workbench.uploads.subscribeUnfinished,
    workbench.uploads.getUnfinished,
  );
  const more = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | undefined>();
  const names = useSyncExternalStore(
    workbench.onlineNames.subscribe,
    workbench.onlineNames.getSnapshot,
  );
  // A name on its way to the platform shows at once, and says so where the status is.
  const pending = card.project === undefined ? undefined : names.pending.get(card.project);
  const shown = pending?.name ?? card.name;
  const folder = card.key === undefined ? undefined : statuses.get(card.key);
  const status = pending
    ? {
        ...cardStatus(card, folder, t, now),
        text: t(pending.state === "waking" ? "start.card.waking" : "start.card.renaming"),
        tone: "busy" as const,
        hint: undefined,
      }
    : cardStatus(card, folder, t, now);
  // Renamed on the platform: not while it does not answer, as the backend says it (never what the
  // browser says of its network).
  const renamesOnline = isCloudKind(card.kind) && workbench.onlineNames.available;
  const backendAway =
    useSyncExternalStore(
      workbench.accountAi?.subscribe ?? noSubscription,
      workbench.accountAi?.getSnapshot ?? noAccountAi,
    )?.status === "offline";
  const at = time === "opened" ? card.openedAt : card.updatedAt;
  const when = at === undefined ? undefined : agoText(at, now, t);
  const words = { name: shown, ...plain };
  const href = card.key === undefined ? undefined : workbench.linkTo(card.key);
  const isRenaming = actions.renaming === card.id;
  const groups = cardActions(card, {
    folder,
    copies: card.key === undefined ? 0 : (copies.get(card.key) ?? 0),
    covers: workbench.canChooseCovers,
    coverChosen: covers.get(card.id)?.chosen === true,
    renamesOnline,
  });
  const menu = (): MenuItem[][] =>
    groups.map((group) =>
      group.map((action): MenuItem => ({
        id: action,
        // One that cannot be edited does not open: it says why, and what helps.
        label: t(
          action === "open" && isUnusable(card) ? "start.menu.about" : `start.menu.${action}`,
        ),
        ...(DANGEROUS.has(action) && { danger: true }),
        ...(busy && action !== "openOnGitHub" && { disabled: true }),
        ...(action === "rename" &&
          renamesOnline &&
          backendAway && { disabled: true, note: t("start.menu.renameOffline") }),
        run: () => actions.run(card, action, more.current),
      })),
    );
  const onClick = (event: MouseEvent) => {
    // With Ctrl, Command or Shift the browser opens the link in a new tab or window, as people
    // expect, and so it does with the middle button, which is no click.
    if (href && (event.ctrlKey || event.metaKey || event.shiftKey)) return;
    event.preventDefault();
    actions.open(card);
  };
  const picture = covers.get(card.id)?.url;
  const durationMs = durationOf(card, covers);
  const cover = (
    <span
      className={styles.cover}
      style={{ "--cover": `var(--aq-cover-${coverColorOf(card)})` } as CSSProperties}
      data-picture={picture !== undefined || undefined}
      aria-hidden="true"
    >
      {picture === undefined ? (
        <span className={styles.initial}>{initialOf(shown)}</span>
      ) : (
        <img className={styles.picture} src={picture} alt="" draggable={false} />
      )}
      {durationMs !== undefined && display === "cards" && (
        <span className={styles.duration}>{durationText(durationMs)}</span>
      )}
      {card.description !== undefined && display === "cards" && (
        // What the project says about itself, over its cover while the pointer is on the card.
        <span className={styles.description} data-card-description="">
          {card.description}
        </span>
      )}
    </span>
  );
  const name = isRenaming ? (
    <NameInput
      className={styles.renameInput}
      label={t("start.card.renameLabel", words)}
      initial={shown}
      problem={problem}
      onCancel={() => {
        setProblem(undefined);
        actions.stopRenaming();
      }}
      onCommit={async (next) => {
        const outcome = await actions.rename(card, next);
        if (outcome === "renamed" || outcome === "unchanged") {
          actions.stopRenaming();
          return true;
        }
        // Said once, where people typed it.
        setProblem(t(`start.rename.${outcome}`));
        return false;
      }}
    />
  ) : (
    <span className={styles.name} data-card-name="" data-pending={pending ? "" : undefined}>
      {shown}
    </span>
  );
  const statusLine = (
    <span className={styles.status} data-tone={status.tone} title={status.hint}>
      {/* Online every project is of the platform: only offline do the two kinds need a sign. */}
      {situation.mode === "offline" && (
        <PlaceIcon
          place={status.place}
          size={14}
          className={styles.placeIcon}
          label={t(`saveStatus.place.${status.place}`)}
        />
      )}
      <span
        className={styles.statusText}
        data-mark={status.tone === "warning" ? card.kind : undefined}
        data-alert={status.alert}
      >
        {status.text}
      </span>
      {display === "cards" && when !== undefined && (
        <>
          <span aria-hidden="true">·</span>
          <span className={styles.when}>{when}</span>
        </>
      )}
    </span>
  );
  const unfinished =
    unfinishedUploads.get(card.key ?? "") ?? unfinishedUploads.get(card.project ?? "") ?? 0;
  const uploadsLine = unfinished > 0 && (
    <span className={styles.uploads} data-card-uploads={unfinished}>
      {t("storage.uploads.start.unfinished", { count: unfinished })}
    </span>
  );
  const inside =
    display === "cards" ? (
      <>
        {cover}
        <span className={styles.words}>
          {name}
          {statusLine}
          {uploadsLine}
        </span>
      </>
    ) : (
      <>
        <span className={styles.cellName}>
          <span
            className={styles.swatch}
            style={{ "--cover": `var(--aq-cover-${coverColorOf(card)})` } as CSSProperties}
            data-picture={picture !== undefined || undefined}
            aria-hidden="true"
          >
            {picture === undefined ? (
              initialOf(shown)
            ) : (
              <img className={styles.picture} src={picture} alt="" draggable={false} />
            )}
          </span>
          {name}
        </span>
        <span className={styles.cell}>{cardPlace(card, t)}</span>
        <span className={styles.cell}>
          {statusLine}
          {uploadsLine}
        </span>
        {cards.some((each) => durationOf(each, covers) !== undefined) && (
          <span className={styles.cell}>
            {durationMs === undefined ? "" : durationText(durationMs)}
          </span>
        )}
        <span className={styles.cell}>{when ?? ""}</span>
      </>
    );
  const linkProps = {
    className: styles.cardLink,
    // The cover is a picture to the screen reader: the description is said with the card.
    ...(card.description !== undefined && { "aria-description": card.description }),
    // In the list there is no cover to show it on.
    ...(card.description !== undefined && display !== "cards" && { title: card.description }),
    draggable: card.marksKey !== undefined && !isRenaming,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData(CARD_TYPE, card.id);
      event.dataTransfer.effectAllowed = "copyMove";
    },
    "aria-disabled": busy || undefined,
    onClick,
  };
  return (
    <li
      ref={watch}
      className={display === "cards" ? styles.card : styles.row}
      data-project={card.id}
      data-kind={card.kind}
      data-starred={card.starred || undefined}
    >
      {isRenaming ? (
        // No link around a field people type in.
        <div className={styles.cardLink}>{inside}</div>
      ) : href ? (
        <a {...linkProps} href={href}>
          {inside}
        </a>
      ) : (
        <button type="button" {...linkProps}>
          {inside}
        </button>
      )}
      {card.marksKey !== undefined && (
        <button
          type="button"
          className={styles.star}
          aria-pressed={card.starred}
          aria-label={t(card.starred ? "start.card.unstar" : "start.card.star", words)}
          title={t(card.starred ? "start.menu.unstar" : "start.menu.star")}
          onClick={() => actions.star(card)}
        >
          <Star size={15} aria-hidden="true" />
        </button>
      )}
      <div className={styles.more} ref={more}>
        <Menu
          label={t("start.more", words)}
          trigger={<Ellipsis size={16} />}
          triggerClassName={styles.moreButton}
          align="end"
          groups={menu}
        />
      </div>
    </li>
  );
}

/**
 * Where a cover people choose for a card goes: what this browser keeps the project by, or for one
 * of the platform never opened here `cloud:` and its id; and the platform, for one of its projects
 * of whoever is signed in. None for a project of another account.
 */
function coverTargetOf(
  card: ProjectCard,
  covers: ReadonlyMap<string, CardCover>,
): CoverTarget | undefined {
  const key = card.key ?? (card.project === undefined ? undefined : cloudMarksKey(card.project));
  if (key === undefined || card.marksKey === undefined) return undefined;
  const isCloud = isCloudKind(card.kind) && card.project !== undefined;
  return {
    key,
    project: isCloud ? card.project : undefined,
    durationMs: durationOf(card, covers),
  };
}

/** How long the main timeline of a card is: as its cover says, or the platform's list. */
const durationOf = (card: ProjectCard, covers: ReadonlyMap<string, CardCover>) =>
  covers.get(card.id)?.durationMs ?? card.durationMs;

// ---- the page

/**
 * What a card whose project cannot be edited says when people click it, in place of opening it:
 * why, until when, and what helps, see the design of the start page of AnimaQuill Cloud, 5.1.
 * What people choose goes as the same item of its menu would.
 */
async function explainUnusable(
  workbench: Workbench,
  card: ProjectCard,
  run: (action: CardAction) => void,
): Promise<void> {
  const { t } = workbench;
  const { source } = card;
  const unusable = source.kind === "cloud" ? source.row.unusable : undefined;
  if (!unusable) return;
  const choices = unusableChoices(card, { folder: undefined, copies: 0 });
  const words = { name: card.name, interpolation: { escapeValue: false } };
  const answer = await workbench.dialogs.choose({
    title: t("cloud.unusable.aboutTitle", words),
    message: [
      `${unusableLine(unusable, Date.now(), t)}。`,
      unusableFix(unusable, t),
      t("cloud.unusable.ways"),
    ].join(""),
    choices: choices.map((action) => ({
      id: action,
      label: t(`start.menu.${action}`),
      ...(DANGEROUS.has(action) && { kind: "danger" as const }),
    })),
  });
  const chosen = choices.find((action) => action === answer);
  if (chosen) run(chosen);
}

/** What the start page does with the projects, as one place for every card and menu. */
function useCardActions(
  workbench: Workbench,
  refresh: () => void,
  setRenaming: (card: string | undefined) => void,
  renaming: string | undefined,
  setPicking: (picking: { card: ProjectCard; x: number; y: number } | undefined) => void,
  covers: ReadonlyMap<string, CardCover>,
): { actions: CardActions; busy: boolean } {
  const { t } = useTranslation();
  /** One thing at a time: a project that is on its way here must not be asked for twice. */
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void work().finally(() => {
      setBusy(false);
      refresh();
    });
  };
  const open = (card: ProjectCard): Promise<unknown> => {
    const { cloud, projectFolders } = workbench;
    const { source } = card;
    if (source.kind === "local") {
      return projectFolders?.openRecent(source.row.record) ?? Promise.resolve();
    }
    if (source.kind === "cloud") {
      const { row } = source;
      return (
        cloud?.openCloudProject(row.project, { name: row.name, copy: row.copy }) ??
        Promise.resolve()
      );
    }
    return workbench.openProject(source.summary.id);
  };
  /**
   * Renames a project of the platform there, see `OnlineNames`: the input closes at once, as the
   * card shows the new name; where the platform does not take it, the old one is back and people
   * are told why, with a way to try again. Without a network nothing goes: said where they typed.
   */
  const renameOnline = async (project: string, was: string, name: string) => {
    const wanted = name.trim();
    if (wanted === was) return "unchanged" as const;
    void workbench.onlineNames.rename(project, wanted).then((outcome) => {
      // A later rename of it says what came of the name.
      if (outcome === "renamed" || outcome === "superseded") return;
      workbench.notifications.push(
        // Not reached: as everything else that changes something online says it.
        outcome === "unreachable"
          ? t("online.readOnly")
          : t("start.rename.notice", {
              from: was,
              name: wanted,
              why: t(
                outcome === "failed" ? "start.rename.serverFailed" : `start.rename.${outcome}`,
              ),
              ...plain,
            }),
        {
          // Only where trying again can help: not for what people have to do something about.
          ...((outcome === "failed" || outcome === "notBack" || outcome === "unreachable") && {
            actions: [
              {
                label: t("start.rename.retry"),
                run: () => void renameOnline(project, was, wanted),
              },
            ],
          }),
        },
      );
    });
    return "renamed" as const;
  };
  /** Opens the project, and does what can only be done to the open one. */
  const thenOpen = (card: ProjectCard, work: () => Promise<unknown>) =>
    run(async () => {
      await open(card);
      if (card.key !== undefined && workbench.session.key === card.key) await work();
    });
  const actions: CardActions = {
    open: (card) =>
      isUnusable(card)
        ? void explainUnusable(workbench, card, (action) => actions.run(card, action, null))
        : run(() => open(card)),
    renaming,
    stopRenaming: () => setRenaming(undefined),
    rename: async (card, name) => {
      // A project of the platform is renamed there: the card shows the new name at once, and the
      // old one again, with why, where the platform does not take it.
      if (isCloudKind(card.kind) && card.project !== undefined && workbench.onlineNames.available)
        return renameOnline(card.project, card.name, name);
      if (card.key === undefined) return "failed";
      return workbench.renameUnopened(card.key, name);
    },
    star: (card) => {
      const target = marksTargetOf(card);
      if (!target) return;
      void workbench.organizer.star(target, !card.starred).then((done) => {
        if (done === false) workbench.notifications.push(t("start.group.markFailed"));
      });
    },
    run: (card, action, at) => {
      const { cloud, projectFolders } = workbench;
      const { source } = card;
      const record = source.kind === "local" ? source.row.record : undefined;
      const target = coverTargetOf(card, covers);
      switch (action) {
        case "open":
          actions.open(card);
          return;
        case "saveToFolder":
          // Right in the click: the browser lets the editor ask for a folder only then.
          if (card.project !== undefined)
            run(() => workbench.saveToFolder(card.project, card.name));
          return;
        case "recheck":
          if (card.project !== undefined && cloud) run(() => cloud.recheck(card.project));
          return;
        case "reauthorize":
        case "reinstall":
        case "restoreApp":
          void workbench.installApp();
          return;
        case "switchRepository":
          if (card.project !== undefined && cloud)
            run(() => cloud.switchRepositoryOf(card.project as string, card.name));
          return;
        case "rename":
          setRenaming(card.id);
          return;
        case "star":
        case "unstar":
          actions.star(card);
          return;
        case "moveToGroup": {
          const box = at?.getBoundingClientRect();
          setPicking({ card, x: box ? box.right - 220 : 0, y: box ? box.bottom + 4 : 0 });
          return;
        }
        case "saveCopy":
          thenOpen(card, () => workbench.exportProject());
          return;
        case "openOnGitHub": {
          const address = gitHubAddress(card);
          if (address) window.open(address, "_blank", "noopener,noreferrer");
          return;
        }
        case "deleteCloud":
          if (card.project !== undefined)
            run(() => workbench.deleteFromCloud(card.project, card.name));
          return;
        case "findAgain":
          if (record && projectFolders) run(() => projectFolders.findAgain(record));
          return;
        case "saveElsewhere":
          if (record && projectFolders) run(() => projectFolders.saveElsewhere(record));
          return;
        case "releaseCopies":
          if (record && projectFolders) run(() => projectFolders.releaseCopies(record));
          return;
        case "removeFromList":
          if (record && projectFolders) run(() => projectFolders.remove(record));
          return;
        case "delete":
          if (source.kind === "browser") run(() => workbench.removeProject(source.summary));
          return;
        case "setCover":
          // Right in the click: the browser lets a page ask for a file only then.
          if (target) void workbench.chooseCover(target).finally(refresh);
          return;
        case "autoCover":
          if (target) run(() => workbench.restoreAutoCover(target));
          return;
      }
    },
  };
  return { actions, busy };
}

/**
 * What people see before a project is open: every panel needs a project to show anything. The
 * "作品墙" of the design of the start page (docs/design/start-and-cloud.md of AnimaQuill Cloud),
 * 6: a side bar of views and groups, and on the right the view, with ways to make a project and
 * a card for every project in it. What each card says and offers is in `start/cards.ts`, which
 * views list what in `start/views.ts`.
 */
export function StartPage() {
  const workbench = useWorkbench();
  const { projectFolders, start, organizer, startHabits, videos, cloud } = workbench;
  const { t } = useTranslation();
  const lists = useSyncExternalStore(start.subscribe, start.getSnapshot);
  const organized = useSyncExternalStore(organizer.subscribe, organizer.getSnapshot);
  const habits = useSyncExternalStore(startHabits.subscribe, startHabits.getSnapshot);
  const folders = useSyncExternalStore(
    projectFolders?.subscribe ?? noSubscription,
    projectFolders?.getSnapshot ?? noFolders,
  );
  const [now, setNow] = useState(() => Date.now());
  const [askedForCloud] = useState(() => workbench.cloudColumn.getSnapshot());
  const [view, setView] = useState<ViewId>(askedForCloud ? "all" : "recent");
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<string | undefined>();
  const [picking, setPicking] = useState<{ card: ProjectCard; x: number; y: number }>();
  const [exports, setExports] = useState<readonly UnfinishedExport[]>([]);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, FolderStatus>>(new Map());
  const [copies, setCopies] = useState<ReadonlyMap<string, number>>(new Map());
  const main = useRef<HTMLElement>(null);
  const refresh = useCallback(() => void start.refresh(), [start]);
  const readExports = useCallback(() => void videos.unfinished().then(setExports), [videos]);

  // A folder that people let the editor at again is listed as it is now.
  useEffect(refresh, [refresh, folders.waiting]);
  useEffect(readExports, [readExports]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // People come back to the window: what another window or another computer did meanwhile shows.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);
  // Looking at a folder can take a while, as on a network: the page does not wait for it.
  useEffect(() => {
    if (!projectFolders) return;
    let isCurrent = true;
    for (const { record } of lists.local) {
      void projectFolders.projects.statusOf(record).then((status) => {
        if (isCurrent) setStatuses((before) => new Map(before).set(record.id, status));
      });
      void projectFolders.copiesOf(record).then((size) => {
        if (isCurrent) setCopies((before) => new Map(before).set(record.id, size));
      });
    }
    return () => {
      isCurrent = false;
    };
  }, [projectFolders, lists.local]);

  const situation: Situation = {
    mode: workbench.mode,
    canFolders: workbench.canFolders,
    canGoOnline: workbench.canGoOnline,
  };
  const cards = useMemo(() => composeCards(lists, organized), [lists, organized]);
  const sections = sectionsOf({
    cards,
    groups: organized.groups,
    unfinishedExports: exports.length,
  });
  const current = viewThere(view, sections);
  const habit = habits.get(current) ?? DEFAULT_HABITS;
  const sort = sortOfView(current, habit.sort);
  const listed = viewCards(cards, { view: current, search, sort });
  const { loading, failed, cloudState } = lists;
  const isUnread = failed.projects || failed.folders;
  const welcome = !loading && !isUnread && isWelcome(cards, current);
  const group = groupOfView(current);
  const title =
    sections.find((section) => section.id === current)?.label ??
    ({ key: "start.view.recent" } as const);
  const { startCovers } = workbench;
  const covers = useSyncExternalStore(startCovers.subscribe, startCovers.getSnapshot);
  const { actions, busy } = useCardActions(
    workbench,
    refresh,
    setRenaming,
    renaming,
    setPicking,
    covers,
  );
  // Covers for the cards there are to see, fetched in their order where they have to be.
  const seen = isPage(current) ? [] : welcome ? remoteCards(cards) : listed;
  // Covers of the platform only for the cards on the screen, or nearly: not hundreds in a row.
  const watch = useMemo(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset["project"];
          if (id !== undefined) startCovers.seen(id, entry.isIntersecting);
        }
      },
      { rootMargin: "200px" },
    );
    return {
      observer,
      watch: (element: Element | null) => {
        if (!element) return undefined;
        observer.observe(element);
        return () => observer.unobserve(element);
      },
    };
  }, [startCovers]);
  useEffect(() => () => watch?.observer.disconnect(), [watch]);
  // After every render: it only works out what changed.
  useEffect(() => {
    startCovers.show(seen, { onlySeen: watch !== undefined, listedAt: lists.listedAt });
  });

  // "打开在线项目…" of the menu means the projects of the platform, as they are now: asked
  // before the page was there, or while it is.
  useEffect(() => {
    const { cloudColumn } = workbench;
    const take = (isFirst: boolean) => {
      if (!cloudColumn.getSnapshot()) return;
      cloudColumn.set(false);
      if (!isFirst) {
        setView("all");
        setSearch("");
      }
      refresh();
      main.current?.focus({ preventScroll: true });
    };
    take(true);
    return cloudColumn.subscribe(() => take(false));
  }, [workbench, refresh]);

  const newProject = (kind: NewKind = "new") => {
    // Made from a group, it goes into that group.
    const into = group;
    const before = workbench.session.key;
    const work =
      kind === "open"
        ? workbench.openFolder()
        : kind === "import"
          ? workbench.importProject()
          : workbench.newProject();
    void work.then(async () => {
      const key = workbench.session.key;
      if (into !== undefined && key !== undefined && key !== before && kind !== "open") {
        const link = await cloud?.linkOf(key).catch(() => undefined);
        const target: MarksTarget = link ? { key: cloudMarksKey(link.project) } : { key };
        await organizer.moveToGroup(target, into);
      }
      refresh();
    });
  };
  const dropOnGroup = (cardId: string, into: string) => {
    const card = cards.find((each) => each.id === cardId);
    const target = card && marksTargetOf(card);
    if (!target) return;
    void organizer.moveToGroup(target, into).then((done) => {
      if (done === false) workbench.notifications.push(t("start.group.markFailed"));
    });
  };
  const pickGroup = (card: ProjectCard): MenuItem[][] => {
    const target = marksTargetOf(card) as MarksTarget;
    const move = (into: string | undefined) =>
      void organizer.moveToGroup(target, into).then((done) => {
        if (done === false) workbench.notifications.push(t("start.group.markFailed"));
      });
    return [
      organized.groups.map((each) => ({
        id: each.id,
        label: each.name,
        selected: card.group === each.id,
        run: () => move(each.id),
      })),
      [
        {
          id: "none",
          label: t("start.group.none"),
          selected: card.group === undefined,
          run: () => move(undefined),
        },
        {
          id: "new",
          label: t("start.group.newEntry"),
          run: () =>
            void (async () => {
              const name = await workbench.dialogs.prompt({
                title: t("start.group.new"),
                confirm: t("project.create"),
              });
              if (!name) return;
              const made = await organizer.createGroup(name);
              if (made === undefined) workbench.notifications.push(t("start.group.failed"));
              else if (made === "offline") return;
              else if ("problem" in made)
                workbench.notifications.push(t(`start.group.problem.${made.problem}`));
              else move(made.id);
            })(),
        },
      ],
    ].filter((items) => items.length > 0);
  };

  const nameOf = (project: string) => cards.find((card) => card.key === project)?.name ?? "";
  const cardsProps = {
    now,
    actions,
    statuses,
    copies,
    situation,
    busy,
    covers,
    watch: watch?.watch,
  } as const;
  const time = sort === "opened" ? "opened" : "updated";

  /** What the view says where it lists nothing, see 6.2. */
  const emptyText = (): string => {
    if (search.trim() !== "") return t("start.empty.search", { search: search.trim(), ...plain });
    if (current === "starred") return t("start.empty.starred");
    if (group !== undefined) return t("start.empty.group");
    return t("start.empty.view");
  };

  /** What is said about the projects of the platform where those are what people look at. */
  const cloudNote = (): ReactNode => {
    if (situation.mode !== "online" || isPage(current)) return null;
    if (cloudState === "signedOut")
      return (
        <p className={styles.note} data-cloud-list={cloudState}>
          <span>{t("start.cloudSignedOut")}</span>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void workbench.signIn()}
          >
            {t("start.signIn")}
          </button>
        </p>
      );
    if (cloudState === "unreadable")
      return (
        <p className={styles.note} role="status" data-cloud-list={cloudState}>
          <span className={styles.warningText}>{t("start.cloudUnreadable")}</span>
          <button type="button" className={styles.secondary} onClick={refresh}>
            {t("start.readAgain")}
          </button>
        </p>
      );
    if (cloudState === "loading")
      return (
        <p className={styles.muted} data-cloud-list={cloudState}>
          {t("start.cloudLoading")}
        </p>
      );
    return null;
  };

  return (
    <div className={styles.page} data-cloud-list={cloudState}>
      <Sidebar
        sections={sections}
        view={current}
        onView={(next) => {
          setView(next);
          setRenaming(undefined);
        }}
        onNew={() => newProject()}
        onDropCard={dropOnGroup}
        situation={situation}
      />
      <main className={styles.main} ref={main} tabIndex={-1} data-view={current}>
        {folders.waiting && <Waiting waiting={folders.waiting} />}
        <div className={styles.head}>
          <h1>
            {current === "storage"
              ? t("storage.uploads.space.title")
              : "key" in title
                ? t(title.key as "start.view.all")
                : title.text}
          </h1>
          {!loading && !welcome && !isPage(current) && (
            <div className={styles.tools}>
              <label className={styles.search}>
                <Search size={15} aria-hidden="true" />
                <input
                  type="search"
                  placeholder={t("start.search")}
                  aria-label={t("start.search")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              {current !== "recent" && (
                <Menu
                  label={t("start.sort.label", { sort: t(`start.sort.${sort}`) })}
                  trigger={
                    <>
                      {t(`start.sort.${sort}`)}
                      <ChevronDown size={14} aria-hidden="true" />
                    </>
                  }
                  triggerClassName={styles.sort}
                  align="end"
                  groups={() => [
                    SORTS.map((each) => ({
                      id: each,
                      label: t(`start.sort.${each}`),
                      selected: each === sort,
                      run: () => startHabits.set(current, { sort: each }),
                    })),
                  ]}
                />
              )}
              <div className={styles.display} role="group" aria-label={t("start.display.label")}>
                <button
                  type="button"
                  aria-pressed={habit.display === "cards"}
                  aria-label={t("start.display.cards")}
                  title={t("start.display.cards")}
                  onClick={() => startHabits.set(current, { display: "cards" })}
                >
                  <LayoutGrid size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-pressed={habit.display === "list"}
                  aria-label={t("start.display.list")}
                  title={t("start.display.list")}
                  onClick={() => startHabits.set(current, { display: "list" })}
                >
                  <List size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Nothing until what this computer has is read: the page does not jump from one to
            the other as it comes, which people would see, and what they drop would miss. */}
        {loading ? null : welcome ? (
          <section className={styles.welcome} aria-label={t("start.welcome")}>
            <h2>{t("start.welcome")}</h2>
            <p className={styles.muted}>
              {t(
                situation.mode === "online"
                  ? "start.welcomeOnline"
                  : situation.canFolders
                    ? "start.welcomeAbout"
                    : "start.welcomeBrowser",
              )}
            </p>
            <NewCards situation={situation} large onNew={newProject} />
          </section>
        ) : (
          !isPage(current) && <NewCards situation={situation} large={false} onNew={newProject} />
        )}

        {(isUnread || failed.links) && (
          <p className={styles.note} role="alert">
            <TriangleAlert size={14} aria-hidden="true" className={styles.warningText} />
            <span>{t("project.listFailed")}</span>
          </p>
        )}
        {cloudNote()}

        {current === "storage" ? (
          <StorageSpace />
        ) : current === "exports" ? (
          <UnfinishedExports found={exports} nameOf={nameOf} refresh={readExports} />
        ) : welcome ? (
          remoteCards(cards).length > 0 && (
            <section className={styles.remote} aria-label={t("start.remote")}>
              <h2>{t("start.remote")}</h2>
              <p className={styles.muted}>{t("start.remoteAbout")}</p>
              <CardList
                cards={remoteCards(cards)}
                display="cards"
                time="updated"
                label={t("start.remote")}
                {...cardsProps}
              />
            </section>
          )
        ) : listed.length > 0 ? (
          <CardList
            cards={listed}
            display={habit.display}
            time={time}
            label={t("start.projects")}
            {...cardsProps}
          />
        ) : (
          !loading && !isUnread && <p className={styles.empty}>{emptyText()}</p>
        )}
      </main>
      {picking && picking.card.marksKey !== undefined && (
        <PopupMenu
          label={t("start.group.moveTitle", { name: picking.card.name, ...plain })}
          groups={pickGroup(picking.card)}
          x={picking.x}
          y={picking.y}
          onClose={() => setPicking(undefined)}
        />
      )}
      {/* Only where a dropped folder opens: online it is imported from the new project dialog. */}
      {projectFolders && <DropHint />}
    </div>
  );
}

/** How long a drag over the page counts as there without a word from it, see `DropHint`. */
const DRAG_GONE_MS = 1000;

/**
 * While files are dragged over the page: letting go opens a folder, see `mountEditor`. Nothing that
 * the pointer can land on, so that the page under it stays as it is.
 */
function DropHint() {
  const { dialogs } = useWorkbench();
  const { t } = useTranslation();
  const asking = useSyncExternalStore(dialogs.subscribe, dialogs.getSnapshot) !== undefined;
  const [over, setOver] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gone = () => {
      clearTimeout(timer);
      setOver(false);
    };
    const here = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      setOver(true);
      // The browser says when a drag leaves the window, but not always when it ends elsewhere.
      clearTimeout(timer);
      timer = setTimeout(gone, DRAG_GONE_MS);
    };
    const left = (event: globalThis.DragEvent) => {
      if (event.relatedTarget === null) gone();
    };
    window.addEventListener("dragenter", here);
    window.addEventListener("dragover", here);
    window.addEventListener("dragleave", left);
    window.addEventListener("drop", gone);
    window.addEventListener("dragend", gone);
    return () => {
      gone();
      window.removeEventListener("dragenter", here);
      window.removeEventListener("dragover", here);
      window.removeEventListener("dragleave", left);
      window.removeEventListener("drop", gone);
      window.removeEventListener("dragend", gone);
    };
  }, []);
  if (!over || asking) return null;
  return (
    <div className={styles.dropHint} role="status">
      <FolderOpen size={32} aria-hidden="true" />
      <p className={styles.dropHintTitle}>{t("start.dropHint")}</p>
      <p>{t("start.dropHintAbout")}</p>
    </div>
  );
}
