import { ChevronDown, ChevronRight, Search } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu, type MenuItem } from "../app/Menu.tsx";
import { useWorkbench } from "../app/context.ts";
import { GROUPINGS, browse, type GroupKey, type Grouping, type Resource } from "./resources.ts";
import styles from "./ResourceBrowser.module.css";

/** Why a resource cannot be used where people are now. */
export interface Unavailable {
  /** In a sentence, for people. */
  readonly reason: string;
  /** It can still be dragged somewhere: where it goes says itself whether it can go there. */
  readonly draggable: boolean;
}

export interface ResourceIconProps<T> {
  readonly resource: Resource<T>;
  /** Under the pointer or the keyboard: a moving preview plays. */
  readonly playing: boolean;
}

export interface ResourceBrowserProps<T> {
  /** The type of the tab, which its way of grouping is kept by. */
  readonly tab: string;
  /** What the list is called, for screen readers. */
  readonly label: string;
  readonly searchLabel: string;
  readonly resources: readonly Resource<T>[];
  /** Types in the order they show when grouped by type. */
  readonly types: readonly string[];
  /** A type that what is selected is about, which comes first. */
  readonly firstType?: string | undefined;
  readonly defaultGrouping: Grouping;
  readonly typeName: (type: string) => string;
  readonly unavailable: (resource: Resource<T>) => Unavailable | undefined;
  /** What is selected is this one. */
  readonly isCurrent?: (resource: Resource<T>) => boolean;
  readonly Icon: ComponentType<ResourceIconProps<T>>;
  /**
   * A click or Enter: `anchor` is where the resource is on the page, for a menu. A double click is
   * one click, and a click with Ctrl or ⌘ only chooses, as the arrow keys do.
   */
  readonly onActivate: (resource: Resource<T>, anchor: DOMRect) => void;
  /** The resource chosen, by its id, where the tab keeps that itself, as the explorer does. */
  readonly selected?: string | undefined;
  readonly onSelect?: (resource: Resource<T>) => void;
  /** Goes up when the chosen resource was shown from elsewhere: the list goes to it. */
  readonly revealed?: number;
  /** What the menu of a resource has. Without it, the way to it in the explorer. */
  readonly menu?: (resource: Resource<T>) => readonly (readonly MenuItem[])[];
  /** What it says when there is nothing at all. */
  readonly empty?: string;
  /** What can be dragged, of what can be used here. Nothing can without `onDragStart`. */
  readonly canDrag?: (resource: Resource<T>) => boolean;
  readonly onDragStart?: (resource: Resource<T>, event: DragEvent<HTMLElement>) => void;
  /** Whether it was dropped somewhere that took it. */
  readonly onDragEnd?: (resource: Resource<T>, dropped: boolean) => void;
  /**
   * What a click just did, or why it did nothing, for a while: on the resource it is about, and in
   * the line under the list, where screen readers hear it. `at` tells two of the same apart.
   */
  readonly notice?: Notice | undefined;
}

/** Something that a tab says about a resource for a moment, see `ResourceBrowserProps.notice`. */
export interface Notice {
  readonly resource: string;
  readonly text: string;
  /** Short, on the resource itself, such as how many clips it went on. Without it, only below. */
  readonly badge?: string;
  readonly at: number;
}

interface Entry<T> {
  /** Unique in the list: a resource can be in more than one group. */
  readonly key: string;
  readonly resource: Resource<T>;
}

/** The option nearest across in the row above or below, by where they are on the page. */
function verticalNeighbor(options: readonly HTMLElement[], from: number, down: boolean): number {
  const origin = options[from]?.getBoundingClientRect();
  if (!origin) return from;
  const middle = origin.left + origin.width / 2;
  let best = from;
  let bestRow = Infinity;
  let bestAcross = Infinity;
  options.forEach((option, index) => {
    const box = option.getBoundingClientRect();
    const rowDistance = down ? box.top - origin.top : origin.top - box.top;
    if (rowDistance < origin.height / 2) return;
    const across = Math.abs(box.left + box.width / 2 - middle);
    if (
      rowDistance < bestRow - 1 ||
      (Math.abs(rowDistance - bestRow) <= 1 && across < bestAcross)
    ) {
      best = index;
      bestRow = rowDistance;
      bestAcross = across;
    }
  });
  return best;
}

/**
 * A list of resources to find and use, the same in every tab that has them: a search, a choice of
 * grouping, groups that close, what was used recently first, moving previews, and what cannot be
 * used here greyed out with the reason. See docs/design/resource-panels.md, section 2. What a click
 * and a drag do is up to the tab.
 */
export function ResourceBrowser<T>(props: ResourceBrowserProps<T>) {
  const { tab, label, resources, types, firstType, defaultGrouping, typeName } = props;
  const { unavailable, isCurrent, Icon, onActivate, canDrag, onDragStart, onDragEnd } = props;
  const { selected, onSelect, revealed, empty, notice } = props;
  const { t } = useTranslation();
  const workbench = useWorkbench();
  const { resourceHabits: habits } = workbench;
  const saved = useSyncExternalStore(habits.subscribe, habits.getSnapshot);
  const grouping = saved.grouping[tab] ?? defaultGrouping;
  const closedIds = saved.collapsed[tab];
  const collapsed = useMemo(() => new Set(closedIds), [closedIds]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>();
  const [pointed, setPointed] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; resource: Resource<T> }>();
  const list = useRef<HTMLElement>(null);
  const id = useId();

  const groups = useMemo(
    () => browse(resources, { query, grouping, recent: saved.recent, types, firstType }),
    [resources, query, grouping, saved.recent, types, firstType],
  );
  // What is in a closed group is not on the page, so the keys do not go there either.
  const entries: readonly Entry<T>[] = useMemo(
    () =>
      groups.flatMap((group) =>
        collapsed.has(group.id)
          ? []
          : group.items.map((resource) => ({ key: `${group.id}/${resource.id}`, resource })),
      ),
    [groups, collapsed],
  );
  // What the tab chose comes first, unless the keyboard is on another place of the same resource.
  const chosenKey =
    selected === undefined
      ? undefined
      : (entries.find(({ key, resource }) => resource.id === selected && key === active)?.key ??
        entries.find(({ resource }) => resource.id === selected)?.key);
  const activeKey =
    chosenKey ?? (entries.some(({ key }) => key === active) ? active : entries[0]?.key);
  const shown = entries.find(({ key }) => key === (pointed ?? activeKey));
  const why = shown && unavailable(shown.resource);

  const groupName = (key: GroupKey): string => {
    switch (key.kind) {
      case "recent":
        return t("resources.recent");
      case "source":
        return key.source.kind === "library"
          ? key.source.name
          : t(`resources.sources.${key.source.kind}`);
      case "tag":
        return key.tag ?? t("resources.untagged");
      case "type":
        return typeName(key.type);
    }
  };

  // A menu with nothing to do in it takes no keyboard, so it closes from here too.
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event.type === "keydown" && (event as globalThis.KeyboardEvent).key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      setMenu(undefined);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", close, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", close, true);
    };
  }, [menu]);

  // A resource shown from elsewhere comes into view, out of a closed group if it has to.
  const revealing = useRef(false);
  useEffect(() => {
    if (!revealed || selected === undefined) return;
    revealing.current = true;
    const holds = (group: (typeof groups)[number]) =>
      group.items.some((resource) => resource.id === selected);
    const closed = groups.filter((group) => holds(group) && collapsed.has(group.id));
    if (closed.length > 0 && !groups.some((group) => holds(group) && !collapsed.has(group.id))) {
      habits.setCollapsed(tab, (closed[0] as (typeof groups)[number]).id, false);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only when it is shown again
  }, [revealed]);
  useEffect(() => {
    if (!revealing.current || selected === undefined) return;
    const option = list.current?.querySelector<HTMLElement>(
      `[role="option"][data-resource="${CSS.escape(selected)}"]`,
    );
    if (!option) return;
    revealing.current = false;
    option.scrollIntoView?.({ block: "nearest" });
    option.focus({ preventScroll: true });
  });

  const choose = (key: string, resource: Resource<T>) => {
    setActive(key);
    if (resource.id !== selected) onSelect?.(resource);
  };

  const optionsOnPage = () => [
    ...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
  ];

  const focusEntry = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    choose(entry.key, entry.resource);
    optionsOnPage()[index]?.focus();
    optionsOnPage()[index]?.scrollIntoView?.({ block: "nearest" });
  };

  const activate = (resource: Resource<T>, element: HTMLElement) => {
    if (unavailable(resource)) return;
    onActivate(resource, element.getBoundingClientRect());
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const options = optionsOnPage();
    const index = options.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    const moves: Record<string, () => number> = {
      ArrowRight: () => Math.min(index + 1, options.length - 1),
      ArrowLeft: () => Math.max(index - 1, 0),
      ArrowDown: () => verticalNeighbor(options, index, true),
      ArrowUp: () => verticalNeighbor(options, index, false),
      Home: () => 0,
      End: () => options.length - 1,
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      focusEntry(move());
      return;
    }
    const entry = entries[index];
    if ((event.key === "Enter" || event.key === " ") && entry) {
      event.preventDefault();
      activate(entry.resource, options[index] as HTMLElement);
    } else if (entry && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      const box = (options[index] as HTMLElement).getBoundingClientRect();
      setMenu({ x: box.left, y: box.bottom, resource: entry.resource });
    }
  };

  const onContextMenu = (event: MouseEvent<HTMLElement>, resource: Resource<T>) => {
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    setMenu({ x: event.clientX, y: event.clientY, resource });
  };

  const menuGroups = (resource: Resource<T>): readonly (readonly MenuItem[])[] =>
    props.menu?.(resource) ?? [
      [
        {
          id: "reveal",
          label: t("resources.reveal"),
          disabled: !workbench.canRevealResource(resource.id),
          run: () => workbench.revealResource(resource.id),
        },
      ],
    ];

  return (
    <div className={styles.browser}>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={14} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder={t("resources.search")}
            aria-label={props.searchLabel}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                focusEntry(
                  Math.max(
                    entries.findIndex(({ key }) => key === activeKey),
                    0,
                  ),
                );
              }
            }}
          />
        </label>
        <div className={styles.groupings} role="radiogroup" aria-label={t("resources.grouping")}>
          {GROUPINGS.map((by) => (
            <button
              key={by}
              type="button"
              role="radio"
              aria-checked={grouping === by}
              className={styles.grouping}
              onClick={() => habits.setGrouping(tab, by)}
            >
              {t(`resources.groupBy.${by}`)}
            </button>
          ))}
        </div>
      </div>
      {/* Each group is a list of its own under a heading that opens and closes it. The keys go
          through all of them as through one list. */}
      <section ref={list} className={styles.list} aria-label={label} onKeyDown={onListKeyDown}>
        {groups.map((group) => {
          const closed = collapsed.has(group.id);
          const headingId = `${id}-${group.id}`;
          const Chevron = closed ? ChevronRight : ChevronDown;
          return (
            <div
              key={group.id}
              role="group"
              aria-labelledby={headingId}
              className={styles.group}
              data-group={group.id}
              data-first={
                group.key.kind === "type" && group.key.type === firstType ? "" : undefined
              }
            >
              <button
                type="button"
                className={styles.heading}
                aria-expanded={!closed}
                aria-controls={closed ? undefined : `${headingId}-items`}
                onClick={() => habits.setCollapsed(tab, group.id, !closed)}
              >
                <Chevron size={14} aria-hidden />
                <span id={headingId}>{groupName(group.key)}</span>
                <span className={styles.count} aria-hidden>
                  {group.items.length}
                </span>
              </button>
              {!closed && (
                <div
                  id={`${headingId}-items`}
                  className={styles.grid}
                  role="listbox"
                  aria-labelledby={headingId}
                >
                  {group.items.map((resource) => {
                    const key = `${group.id}/${resource.id}`;
                    const off = unavailable(resource);
                    const reasonId = `${id}-${key}-why`;
                    return (
                      <div
                        key={key}
                        role="option"
                        tabIndex={key === activeKey ? 0 : -1}
                        aria-label={resource.name}
                        aria-selected={key === activeKey}
                        aria-disabled={off ? true : undefined}
                        aria-current={isCurrent?.(resource) ? true : undefined}
                        aria-describedby={off ? reasonId : undefined}
                        className={styles.item}
                        data-resource={resource.id}
                        title={off ? `${resource.name}：${off.reason}` : resource.name}
                        draggable={
                          onDragStart !== undefined &&
                          (canDrag?.(resource) ?? true) &&
                          (!off || off.draggable)
                        }
                        onFocus={() => choose(key, resource)}
                        onPointerEnter={() => setPointed(key)}
                        onPointerLeave={() => setPointed((was) => (was === key ? undefined : was))}
                        onClick={(event) => {
                          choose(key, resource);
                          // The second click of a double click, or one that only chooses.
                          if (event.detail > 1 || event.ctrlKey || event.metaKey) return;
                          activate(resource, event.currentTarget);
                        }}
                        // A right click focuses the option after the menu opened, which would close it
                        // again: the menu focuses the option itself first.
                        onMouseDown={(event) => {
                          if (event.button === 2) event.preventDefault();
                        }}
                        onContextMenu={(event) => {
                          choose(key, resource);
                          onContextMenu(event, resource);
                        }}
                        onDragStart={(event) => {
                          setPointed(undefined);
                          onDragStart?.(resource, event);
                        }}
                        onDragEnd={(event) =>
                          onDragEnd?.(resource, event.dataTransfer.dropEffect !== "none")
                        }
                      >
                        <div className={styles.picture}>
                          <Icon resource={resource} playing={key === pointed} />
                        </div>
                        <span className={styles.name}>{resource.name}</span>
                        {notice?.badge !== undefined && notice.resource === resource.id && (
                          <span key={notice.at} className={styles.badge} aria-hidden>
                            {notice.badge}
                          </span>
                        )}
                        {off && (
                          <span id={reasonId} className={styles.hidden}>
                            {off.reason}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && (
          <p className={styles.empty}>
            {query.trim()
              ? t("resources.notFound", { query: query.trim() })
              : (empty ?? t("resources.none"))}
          </p>
        )}
      </section>
      <p className={styles.status} role="status" data-notice={notice ? "" : undefined}>
        {notice ? notice.text : why ? why.reason : ""}
      </p>
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label={menu.resource.name}
          groups={menuGroups(menu.resource)}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}
