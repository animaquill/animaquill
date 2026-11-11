import type { FolderStatus } from "@animaquill/host";
import {
  ChevronDown,
  Clock,
  Cloud,
  Ellipsis,
  Folder,
  FolderOpen,
  HardDrive,
  Layers,
  LayoutGrid,
  List,
  Plus,
  Search,
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
  composeCards,
  coverColorOf,
  DANGEROUS,
  gitHubAddress,
  initialOf,
  type CardAction,
  type ProjectCard,
} from "../start/cards.ts";
import {
  DEFAULT_HABITS,
  filtersOf,
  groupOfView,
  isWelcome,
  remoteCards,
  sectionsOf,
  SORTS,
  sortOfView,
  viewCards,
  viewThere,
  type Display,
  type Filter,
  type StartSection,
  type ViewId,
} from "../start/views.ts";
import type { ProjectFoldersSnapshot, WaitingFolder } from "../workbench/project-folders.ts";
import type { Workbench } from "../workbench/workbench.ts";
import { useWorkbench } from "./context.ts";
import { Menu, PopupMenu, type MenuItem } from "./Menu.tsx";
import styles from "./StartPage.module.css";
import { agoText, durationText } from "./start-view.ts";

const noSubscription = () => () => {};
const NO_FOLDERS: ProjectFoldersSnapshot = { open: undefined, waiting: undefined, moves: 0 };
const noFolders = () => NO_FOLDERS;
const noAccount = () => undefined;
/** How often the times on the page move on. */
const TICK_MS = 60_000;
/** What a card carries while it is dragged onto a group. */
const CARD_TYPE = "application/x-animaquill-card";

const plain = { interpolation: { escapeValue: false } } as const;

/** What the page knows of where it runs, which decides what it offers, see the design, 6.5. */
interface Situation {
  /** The editor is hosted on a platform. */
  readonly hasPlatform: boolean;
  /** This browser can write folders. */
  readonly canFolders: boolean;
  /** Somebody is signed in on the platform; undefined where that is not known yet. */
  readonly signedIn: boolean | undefined;
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
    if (go && !(await organizer.deleteGroup(id))) notifications.push(t("start.group.failed"));
  };
  const items = (): MenuItem[][] => [
    [
      { id: "rename", label: t("start.group.rename"), run: () => setRenaming(true) },
      { id: "delete", label: t("start.group.delete"), danger: true, run: () => void remove() },
    ],
  ];
  const isCard = (event: DragEvent) => event.dataTransfer.types.includes(CARD_TYPE);

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
            if (outcome === true) {
              setRenaming(false);
              setProblem(undefined);
            } else if (outcome === undefined) {
              notifications.push(t("start.group.failed"));
              setRenaming(false);
            } else {
              setProblem(t(`start.group.problem.${outcome}`));
            }
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
      onDragOver={(event) => {
        if (!isCard(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setIsOver(true);
      }}
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
  onCommit: (name: string) => Promise<void> | void;
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
    void onCommit(value);
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
                if (made === undefined) {
                  notifications.push(t("start.group.failed"));
                  setCreating(false);
                } else if ("problem" in made) {
                  setProblem(t(`start.group.problem.${made.problem}`));
                } else {
                  setCreating(false);
                  setProblem(undefined);
                }
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
      <Account situation={situation} />
    </nav>
  );
}

/** Who is signed in, at the bottom of the side bar, where there is a platform, see 6.1. */
function Account({ situation }: { situation: Situation }) {
  const workbench = useWorkbench();
  const { account } = workbench;
  const { t } = useTranslation();
  const who = useSyncExternalStore(
    account?.subscribe ?? noSubscription,
    account?.getSnapshot ?? noAccount,
  );
  if (!account || !who) return null;
  if (who.status !== "signedIn") {
    return (
      <div className={styles.account}>
        <span className={styles.accountWords}>
          <span className={styles.muted}>
            {t(who.status === "unknown" ? "start.account.unknown" : "start.account.signedOut")}
          </span>
        </span>
        {who.status === "signedOut" && (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => void workbench.signIn()}
          >
            {t("start.signIn")}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className={styles.account}>
      <span className={styles.avatar} aria-hidden="true">
        {initialOf(who.name)}
      </span>
      <span className={styles.accountWords}>
        <span className={styles.accountName}>{who.name}</span>
        <span className={styles.accountState}>
          {t(situation.canFolders ? "start.account.ready" : "start.account.cloudOnly")}
        </span>
      </span>
    </div>
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
  onNew: (kind: "cloud" | "local" | "open") => void;
}) {
  const { t } = useTranslation();
  const { hasPlatform, canFolders } = situation;
  const unsupported = canFolders ? undefined : t("start.new.unsupported");
  const card = (
    kind: "cloud" | "local" | "open",
    Icon: typeof Cloud,
    title: string,
    about: string,
    disabledBy?: string,
  ) => (
    <button
      type="button"
      className={styles.newCard}
      data-new={kind}
      disabled={disabledBy !== undefined}
      onClick={() => onNew(kind)}
    >
      <Icon size={large ? 32 : 26} className={styles.newIcon} aria-hidden="true" />
      <span className={styles.newWords}>
        <span className={styles.newTitle}>{title}</span>
        <span className={styles.newAbout}>{disabledBy ?? about}</span>
      </span>
    </button>
  );
  return (
    <section
      className={styles.newCards}
      data-large={large || undefined}
      aria-label={t("start.new.label")}
    >
      {hasPlatform && card("cloud", Cloud, t("start.new.cloud"), t("start.new.cloudAbout"))}
      {card("local", Folder, t("start.new.local"), t("start.new.localAbout"), unsupported)}
      {card("open", FolderOpen, t("start.new.open"), t("start.new.openAbout"), unsupported)}
    </section>
  );
}

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
}

/** What the page does for a card. */
interface CardActions {
  open(card: ProjectCard): void;
  run(card: ProjectCard, action: CardAction, at: HTMLElement | null): void;
  rename(card: ProjectCard, name: string): Promise<boolean>;
  renaming: string | undefined;
  stopRenaming(): void;
  star(card: ProjectCard): void;
}

function CardList(props: CardsProps) {
  const { t } = useTranslation();
  const { cards, display, label } = props;
  // A column that would be empty everywhere is left out.
  const hasDuration = cards.some((card) => card.durationMs !== undefined);
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
}: CardsProps & { card: ProjectCard }) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const more = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | undefined>();
  const folder = card.key === undefined ? undefined : statuses.get(card.key);
  const status = cardStatus(card, folder, t);
  const at = time === "opened" ? card.openedAt : card.updatedAt;
  const when = at === undefined ? undefined : agoText(at, now, t);
  const words = { name: card.name, ...plain };
  const href = card.key === undefined ? undefined : workbench.linkTo(card.key);
  const isRenaming = actions.renaming === card.id;
  const groups = cardActions(card, {
    hasPlatform: situation.hasPlatform,
    canFolders: situation.canFolders,
    folder,
    copies: card.key === undefined ? 0 : (copies.get(card.key) ?? 0),
  });
  const menu = (): MenuItem[][] =>
    groups.map((group) =>
      group.map((action): MenuItem => ({
        id: action,
        label: t(`start.menu.${action}`),
        ...(DANGEROUS.has(action) && { danger: true }),
        ...(busy && action !== "openOnGitHub" && { disabled: true }),
        run: () => actions.run(card, action, more.current),
      })),
    );
  const PlaceIcon =
    status.place === "cloud" ? Cloud : status.place === "folder" ? Folder : HardDrive;
  const onClick = (event: MouseEvent) => {
    // With Ctrl, Command or Shift the browser opens the link in a new tab or window, as people
    // expect, and so it does with the middle button, which is no click.
    if (href && (event.ctrlKey || event.metaKey || event.shiftKey)) return;
    event.preventDefault();
    actions.open(card);
  };
  const cover = (
    <span
      className={styles.cover}
      style={{ "--cover": `var(--aq-cover-${coverColorOf(card)})` } as CSSProperties}
      aria-hidden="true"
    >
      <span className={styles.initial}>{initialOf(card.name)}</span>
      {card.durationMs !== undefined && display === "cards" && (
        <span className={styles.duration}>{durationText(card.durationMs)}</span>
      )}
    </span>
  );
  const name = isRenaming ? (
    <NameInput
      className={styles.renameInput}
      label={t("start.card.renameLabel", words)}
      initial={card.name}
      problem={problem}
      onCancel={() => {
        setProblem(undefined);
        actions.stopRenaming();
      }}
      onCommit={async (next) => {
        const done = await actions.rename(card, next);
        if (done) actions.stopRenaming();
        else setProblem(t("start.rename.failed"));
      }}
    />
  ) : (
    <span className={styles.name} data-card-name="">
      {card.name}
    </span>
  );
  const statusLine = (
    <span className={styles.status} data-tone={status.tone} title={status.hint}>
      <PlaceIcon
        size={13}
        className={styles.placeIcon}
        data-place={status.place}
        aria-hidden="true"
      />
      <span
        className={styles.statusText}
        data-mark={status.tone === "warning" ? card.kind : undefined}
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
  const inside =
    display === "cards" ? (
      <>
        {cover}
        <span className={styles.words}>
          {name}
          {statusLine}
        </span>
      </>
    ) : (
      <>
        <span className={styles.cellName}>
          <span
            className={styles.swatch}
            style={{ "--cover": `var(--aq-cover-${coverColorOf(card)})` } as CSSProperties}
            aria-hidden="true"
          >
            {initialOf(card.name)}
          </span>
          {name}
        </span>
        <span className={styles.cell}>{cardPlace(card, t)}</span>
        <span className={styles.cell}>{statusLine}</span>
        {cards.some((each) => each.durationMs !== undefined) && (
          <span className={styles.cell}>
            {card.durationMs === undefined ? "" : durationText(card.durationMs)}
          </span>
        )}
        <span className={styles.cell}>{when ?? ""}</span>
      </>
    );
  const linkProps = {
    className: styles.cardLink,
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

// ---- the page

/** What the right side says where there is nothing it can do here, see 6.5. */
function noticeOf(situation: Situation): "signInOrSwitch" | "localUnsupported" | undefined {
  const { hasPlatform, canFolders, signedIn } = situation;
  if (canFolders) return undefined;
  if (!hasPlatform) return "localUnsupported";
  return signedIn === false ? "signInOrSwitch" : undefined;
}

/** What the start page does with the projects, as one place for every card and menu. */
function useCardActions(
  workbench: Workbench,
  refresh: () => void,
  setRenaming: (card: string | undefined) => void,
  renaming: string | undefined,
  setPicking: (picking: { card: ProjectCard; x: number; y: number } | undefined) => void,
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
  /** Opens the project, and does what can only be done to the open one. */
  const thenOpen = (card: ProjectCard, work: () => Promise<unknown>) =>
    run(async () => {
      await open(card);
      if (card.key !== undefined && workbench.session.key === card.key) await work();
    });
  const actions: CardActions = {
    open: (card) => run(() => open(card)),
    renaming,
    stopRenaming: () => setRenaming(undefined),
    rename: async (card, name) => {
      if (card.key === undefined) return false;
      return workbench.renameUnopened(card.key, name);
    },
    star: (card) => {
      if (card.marksKey === undefined) return;
      void workbench.organizer.star(card.marksKey, !card.starred).then((done) => {
        if (!done) workbench.notifications.push(t("start.group.markFailed"));
      });
    },
    run: (card, action, at) => {
      const { cloud, projectFolders } = workbench;
      const { source } = card;
      const record = source.kind === "local" ? source.row.record : undefined;
      const about =
        source.kind === "cloud" ? { name: card.name, copy: source.row.copy } : { name: card.name };
      switch (action) {
        case "open":
          actions.open(card);
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
        case "connect":
          thenOpen(card, () => workbench.connectToCloud());
          return;
        case "disconnect":
          thenOpen(card, () => cloud?.disconnect() ?? Promise.resolve());
          return;
        case "saveCopy":
          thenOpen(card, () => workbench.exportProject());
          return;
        case "linkFolder":
          // Right in the click: the browser lets the editor ask for a folder only then.
          if (card.project !== undefined && cloud)
            run(() => cloud.downloadToFolder(card.project as string, about));
          return;
        case "removeHere":
          if (card.key !== undefined && cloud)
            run(() => cloud.removeFromBrowser(card.key as string));
          return;
        case "openOnGitHub": {
          const address = gitHubAddress(card);
          if (address) window.open(address, "_blank", "noopener,noreferrer");
          return;
        }
        case "deleteCloud":
          if (card.project !== undefined && cloud)
            run(() => cloud.deleteFromCloud(card.project as string, card.name));
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
        case "moveToFolder":
          if (card.key !== undefined && projectFolders)
            run(() => projectFolders.moveToFolder(card.key as string));
          return;
        case "delete":
          if (source.kind === "browser") run(() => workbench.removeProject(source.summary));
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
  const who = useSyncExternalStore(
    workbench.account?.subscribe ?? noSubscription,
    workbench.account?.getSnapshot ?? noAccount,
  );
  const [now, setNow] = useState(() => Date.now());
  const [askedForCloud] = useState(() => workbench.cloudColumn.getSnapshot());
  const [view, setView] = useState<ViewId>(askedForCloud ? "all" : "recent");
  const [filter, setFilter] = useState<Filter>(askedForCloud ? "cloud" : "all");
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<string | undefined>();
  const [picking, setPicking] = useState<{ card: ProjectCard; x: number; y: number }>();
  const [exports, setExports] = useState<readonly UnfinishedExport[]>([]);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, FolderStatus>>(new Map());
  const [copies, setCopies] = useState<ReadonlyMap<string, number>>(new Map());
  const main = useRef<HTMLElement>(null);
  const refresh = useCallback(() => void start.refresh(), [start]);
  const readExports = useCallback(() => void videos.unfinished().then(setExports), [videos]);

  // A project that moved into a folder in another window is listed as a folder from then on.
  useEffect(refresh, [refresh, folders.waiting, folders.moves]);
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
    hasPlatform: cloud !== undefined,
    canFolders: projectFolders !== undefined,
    signedIn: who === undefined || who.status === "unknown" ? undefined : who.status === "signedIn",
  };
  const cards = useMemo(() => composeCards(lists, organized), [lists, organized]);
  const sections = sectionsOf({
    cards,
    groups: organized.groups,
    unfinishedExports: exports.length,
  });
  const current = viewThere(view, sections);
  const filters = filtersOf(situation);
  const shownFilter = filters.includes(filter) ? filter : "all";
  const habit = habits.get(current) ?? DEFAULT_HABITS;
  const sort = sortOfView(current, habit.sort);
  const listed = viewCards(cards, { view: current, filter: shownFilter, search, sort });
  const notice = noticeOf(situation);
  const { loading, failed, cloudState } = lists;
  const isUnread = failed.projects || failed.folders;
  const welcome = !loading && !isUnread && notice === undefined && isWelcome(cards, current);
  const group = groupOfView(current);
  const title =
    sections.find((section) => section.id === current)?.label ??
    ({ key: "start.view.recent" } as const);
  const { actions, busy } = useCardActions(workbench, refresh, setRenaming, renaming, setPicking);

  // "打开云端的项目…" of the menu means the projects of the platform, as they are now: asked
  // before the page was there, or while it is.
  useEffect(() => {
    const { cloudColumn } = workbench;
    const take = (isFirst: boolean) => {
      if (!cloudColumn.getSnapshot()) return;
      cloudColumn.set(false);
      if (!isFirst) {
        setView("all");
        setFilter("cloud");
        setSearch("");
      }
      refresh();
      main.current?.focus({ preventScroll: true });
    };
    take(true);
    return cloudColumn.subscribe(() => take(false));
  }, [workbench, refresh]);

  const newProject = (kind?: "cloud" | "local" | "open") => {
    // Made from a group, it goes into that group.
    const into = group;
    const before = workbench.session.key;
    const work =
      kind === "open"
        ? workbench.openFolder()
        : kind === "local" && !situation.hasPlatform
          ? (projectFolders?.create() ?? Promise.resolve())
          : workbench.newProject(kind);
    void work.then(async () => {
      const key = workbench.session.key;
      if (into !== undefined && key !== undefined && key !== before && kind !== "open") {
        const link = await cloud?.linkOf(key).catch(() => undefined);
        await organizer.moveToGroup(link ? `cloud:${link.project}` : key, into);
      }
      refresh();
    });
  };
  const dropOnGroup = (cardId: string, into: string) => {
    const card = cards.find((each) => each.id === cardId);
    if (card?.marksKey === undefined) return;
    void organizer.moveToGroup(card.marksKey, into).then((done) => {
      if (!done) workbench.notifications.push(t("start.group.markFailed"));
    });
  };
  const pickGroup = (card: ProjectCard): MenuItem[][] => {
    const marksKey = card.marksKey as string;
    const move = (into: string | undefined) =>
      void organizer.moveToGroup(marksKey, into).then((done) => {
        if (!done) workbench.notifications.push(t("start.group.markFailed"));
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
  } as const;
  const time = sort === "opened" ? "opened" : "updated";

  /** What the view says where it lists nothing, see 6.2. */
  const emptyText = (): string => {
    if (search.trim() !== "") return t("start.empty.search", { search: search.trim(), ...plain });
    if (cardsOfViewCount(cards, current) > 0) return t("start.empty.filter");
    if (current === "starred") return t("start.empty.starred");
    if (group !== undefined) return t("start.empty.group");
    return t("start.empty.view");
  };

  /** What is said about the projects of the platform where those are what people look at. */
  const cloudNote = (): ReactNode => {
    const looksAtCloud = shownFilter === "cloud" || (filters.length === 0 && situation.hasPlatform);
    if (!looksAtCloud || current === "exports" || notice !== undefined) return null;
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
          <h1>{"key" in title ? t(title.key as "start.view.all") : title.text}</h1>
          {!loading &&
            !welcome &&
            current !== "exports" &&
            !(notice !== undefined && cards.length === 0) && (
              <div className={styles.tools}>
                {filters.length > 0 && (
                  <div className={styles.filters} role="group" aria-label={t("start.filter.label")}>
                    {filters.map((each) => (
                      <button
                        key={each}
                        type="button"
                        aria-pressed={shownFilter === each}
                        onClick={() => setFilter(each)}
                      >
                        {t(`start.filter.${each}`)}
                      </button>
                    ))}
                  </div>
                )}
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
        {loading ? null : notice !== undefined ? (
          <section className={styles.notice} aria-label={t(`start.notice.${notice}`)}>
            <p>{t(`start.notice.${notice}`)}</p>
            {notice === "signInOrSwitch" && (
              <button
                type="button"
                className={styles.primary}
                onClick={() => void workbench.signIn()}
              >
                {t("start.signIn")}
              </button>
            )}
          </section>
        ) : welcome ? (
          <section className={styles.welcome} aria-label={t("start.welcome")}>
            <h2>{t("start.welcome")}</h2>
            <p className={styles.muted}>
              {t(situation.canFolders ? "start.welcomeAbout" : "start.welcomeCloudOnly")}
            </p>
            <NewCards situation={situation} large onNew={newProject} />
          </section>
        ) : (
          current !== "exports" && (
            <NewCards situation={situation} large={false} onNew={newProject} />
          )
        )}

        {(isUnread || failed.links) && (
          <p className={styles.note} role="alert">
            <TriangleAlert size={14} aria-hidden="true" className={styles.warningText} />
            <span>{t("project.listFailed")}</span>
          </p>
        )}
        {cloudNote()}

        {current === "exports" ? (
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
          !loading &&
          !(notice !== undefined && cards.length === 0) && (
            <p className={styles.empty}>{emptyText()}</p>
          )
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
    </div>
  );
}

/** How many cards a view has before filtering and searching. */
function cardsOfViewCount(cards: readonly ProjectCard[], view: ViewId): number {
  return viewCards(cards, { view, filter: "all", search: "", sort: "updated" }).length;
}
