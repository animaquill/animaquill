import { Search } from "lucide-react";
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
import { PopupMenu } from "../app/Menu.tsx";
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
  /** What a click does now, over the list. */
  readonly hint?: string | undefined;
  readonly unavailable: (resource: Resource<T>) => Unavailable | undefined;
  /** What is selected is this one. */
  readonly isCurrent?: (resource: Resource<T>) => boolean;
  readonly Icon: ComponentType<ResourceIconProps<T>>;
  /** A click, or Enter: `anchor` is where the resource is on the page, for a menu. */
  readonly onActivate: (resource: Resource<T>, anchor: DOMRect) => void;
  readonly onDragStart?: (resource: Resource<T>, event: DragEvent<HTMLElement>) => void;
  /** Whether it was dropped somewhere that took it. */
  readonly onDragEnd?: (resource: Resource<T>, dropped: boolean) => void;
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
 * grouping, what was used recently first, moving previews, and what cannot be used here greyed out
 * with the reason. See docs/design/resource-panels.md, section 2. What a click and a drag do is up
 * to the tab.
 */
export function ResourceBrowser<T>(props: ResourceBrowserProps<T>) {
  const { tab, label, resources, types, firstType, defaultGrouping, typeName, hint } = props;
  const { unavailable, isCurrent, Icon, onActivate, onDragStart, onDragEnd } = props;
  const { t } = useTranslation();
  const { resourceHabits: habits } = useWorkbench();
  const saved = useSyncExternalStore(habits.subscribe, habits.getSnapshot);
  const grouping = saved.grouping[tab] ?? defaultGrouping;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>();
  const [pointed, setPointed] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const groups = useMemo(
    () => browse(resources, { query, grouping, recent: saved.recent, types, firstType }),
    [resources, query, grouping, saved.recent, types, firstType],
  );
  const entries: readonly Entry<T>[] = useMemo(
    () =>
      groups.flatMap((group) =>
        group.items.map((resource) => ({ key: `${group.id}/${resource.id}`, resource })),
      ),
    [groups],
  );
  const activeKey = entries.some(({ key }) => key === active) ? active : entries[0]?.key;
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

  // The menu has nothing to do yet, so nothing in it takes the keyboard, which would close it.
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

  const optionsOnPage = () => [
    ...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
  ];

  const focusEntry = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    setActive(entry.key);
    optionsOnPage()[index]?.focus();
    optionsOnPage()[index]?.scrollIntoView?.({ block: "nearest" });
  };

  const activate = (resource: Resource<T>, element: HTMLElement) => {
    if (unavailable(resource)) return;
    onActivate(resource, element.getBoundingClientRect());
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const box = (options[index] as HTMLElement).getBoundingClientRect();
      setMenu({ x: box.left, y: box.bottom });
    }
  };

  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  };

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
      {hint && <p className={styles.hint}>{hint}</p>}
      <div
        ref={list}
        className={styles.list}
        role="listbox"
        aria-label={label}
        onKeyDown={onListKeyDown}
      >
        {groups.map((group) => (
          <div
            key={group.id}
            role="group"
            aria-labelledby={`${id}-${group.id}`}
            className={styles.group}
            data-first={group.key.kind === "type" && group.key.type === firstType ? "" : undefined}
          >
            <div id={`${id}-${group.id}`} className={styles.heading}>
              {groupName(group.key)}
            </div>
            <div className={styles.grid}>
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
                    draggable={!off || off.draggable}
                    onFocus={() => setActive(key)}
                    onPointerEnter={() => setPointed(key)}
                    onPointerLeave={() => setPointed((was) => (was === key ? undefined : was))}
                    onClick={(event) => {
                      setActive(key);
                      activate(resource, event.currentTarget);
                    }}
                    onContextMenu={(event) => {
                      setActive(key);
                      onContextMenu(event);
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
                    {off && (
                      <span id={reasonId} className={styles.hidden}>
                        {off.reason}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {entries.length === 0 && (
          <p className={styles.empty}>
            {query.trim() ? t("resources.notFound", { query: query.trim() }) : t("resources.none")}
          </p>
        )}
      </div>
      <p className={styles.status} role="status">
        {why ? why.reason : ""}
      </p>
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label={t("resources.menu")}
          groups={[
            [
              {
                id: "reveal",
                // The explorer comes in a later step, see the design, section 5.
                label: t("resources.reveal"),
                disabled: true,
                run: () => {},
              },
            ],
          ]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}
