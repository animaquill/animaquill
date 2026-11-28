import { favoritesOf, type ModelRef } from "@animaquill/agent";
import { Check, GripVertical, Search, Star } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { stateOf, useUnreadableKeys } from "../aiParts.tsx";
import { CapabilityIcon, capabilityOf } from "../CapabilityIcon.tsx";
import { contextLabel, priceLabel } from "../modelText.ts";
import { PackLabel } from "../PackLabel.tsx";
import { EffortBar } from "./EffortBar.tsx";
import type { Effort } from "./effort.ts";
import styles from "./model.module.css";
import { findModels, keyOf, refKey, type Group, type Row } from "./models.ts";

/** The id of the group of favorites, which no service has. */
const FAVORITES = "";

/**
 * The bubble of the model tag (docs/design/chat-panel.md of AnimaQuill Cloud, 4): how hard the
 * model reasons at its top; then a search, the favorites (people's order, the first one is what a
 * new conversation uses; dragged, or `Alt+↑`/`↓`, to change it) and the models that are on by
 * service, in the order of the settings. Choosing a model closes it, the caret back in the box.
 * Model packs are not here: only where the model uses the general words, a line says so at the
 * bottom, and a pack people chose for a model shows under its name.
 */
export function ModelBubble(props: {
  readonly effort: Effort | undefined;
  /** Only those that take pictures light up. */
  readonly pictures: boolean;
  readonly onClose: (back: boolean) => void;
}) {
  const workbench = useWorkbench();
  const { ai, chat, packs } = workbench;
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const unreadable = useUnreadableKeys();
  useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [said, setSaid] = useState("");
  const [dragging, setDragging] = useState<string | undefined>();
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const now = chat.modelNow();
  const { onClose } = props;

  // Names and sizes of models come from what pi knows of each kind.
  const kinds = [...new Set(settings.services.map(({ kind }) => kind))].join(" ");
  useEffect(() => {
    for (const kind of kinds.split(" ")) if (kind) void ai.loadKnown(kind);
  }, [ai, kinds]);

  const favorites = useMemo(() => favoritesOf(settings), [settings]);
  // The models that are on, by service; a search goes through these, favorites with the rest.
  const searchable = useMemo(
    () =>
      settings.services.map((service): Group => {
        const state = stateOf(settings, service, unreadable);
        return {
          service: service.id,
          name: service.name,
          dim:
            state === "noKey" || state === "unreadable"
              ? "noKey"
              : state === "failed"
                ? state
                : undefined,
          rows: ai
            .modelsFor(service.id)
            .filter((model) => model.enabled)
            .map((model) => ({ service: service.id, model })),
        };
      }),
    [ai, settings, unreadable],
  );
  const groups = useMemo((): readonly Group[] => {
    const services = searchable;
    const rows = favorites.flatMap((ref) => {
      const row = services
        .find((group) => group.service === ref.service)
        ?.rows.find((each) => each.model.id === ref.model);
      return row ? [row] : [];
    });
    const favoriteGroup: Group = {
      service: FAVORITES,
      name: t("chat.picker.favorites"),
      dim: undefined,
      rows,
    };
    if (rows.length === 0) return services;
    // A favorite is listed once, among the favorites; its service lists the others.
    const starred = new Set(rows.map(keyOf));
    const rest = services
      .map((group) => ({ ...group, rows: group.rows.filter((row) => !starred.has(keyOf(row))) }))
      .filter((group) => group.rows.length > 0);
    return [favoriteGroup, ...rest];
  }, [searchable, favorites, t]);
  const found = query.trim() ? findModels(searchable, query) : groups;
  // A favorite is as dim as its service.
  const dimOf = new Map(searchable.map((group) => [group.service, group.dim]));
  /** The favorites as shown: those turned off or gone are not. */
  const shownFavorites = groups[0]?.service === FAVORITES ? groups[0].rows : [];
  /** Each row as the cursor goes through them: a favorite is in two groups. */
  const cursorOf = (group: Group, row: Row) =>
    `${group.service === FAVORITES ? "★" : ""}${keyOf(row)}`;
  const rows = found.flatMap((group) => group.rows.map((row) => ({ group, row })));
  const current = now ? refKey(now.ref) : undefined;
  const at =
    rows.find((each) => cursorOf(each.group, each.row) === cursor) ??
    rows.find((each) => keyOf(each.row) === current) ??
    (query.trim() ? rows[0] : undefined);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const picker = list.current?.closest("[data-model-tag]");
      if (picker?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  // The row the cursor is on stays in sight.
  const atKey = at && cursorOf(at.group, at.row);
  useEffect(() => {
    if (atKey === undefined) return;
    list.current
      ?.querySelector(`[data-cursor="${CSS.escape(atKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [atKey]);

  const choose = (row: Row) => {
    chat.chooseModel({ service: row.service, model: row.model.id });
    onClose(true);
  };
  const nameOf = (ref: ModelRef) => ai.modelOf(ref.service, ref.model)?.name ?? ref.model;
  /** A favorite just before or after another shown one; says where it went, for those who listen. */
  const move = (row: Row, target: Row, side: "before" | "after") => {
    const ref = { service: row.service, model: row.model.id };
    ai.moveFavorite(ref, { service: target.service, model: target.model.id }, side);
    const others = shownFavorites.filter((each) => keyOf(each) !== keyOf(row));
    const by = others.findIndex((each) => keyOf(each) === keyOf(target));
    const place = side === "before" ? by : by + 1;
    setSaid(
      place === 0
        ? t("chat.picker.movedFirst", { model: nameOf(ref) })
        : t("chat.picker.moved", { model: nameOf(ref), place: place + 1 }),
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    // The steps of reasoning have their own keys.
    if ((event.target as HTMLElement).closest('[role="radiogroup"]')) return;
    if (event.key === "Enter") {
      if (!(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      if (at) choose(at.row);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    // A favorite moves among them with Alt.
    if (event.altKey && at?.group.service === FAVORITES) {
      const index = shownFavorites.findIndex((row) => keyOf(row) === keyOf(at.row));
      const down = event.key === "ArrowDown";
      const target = shownFavorites[index + (down ? 1 : -1)];
      if (index >= 0 && target) move(at.row, target, down ? "after" : "before");
      return;
    }
    if (rows.length === 0) return;
    const index = at ? rows.indexOf(at) : -1;
    const next =
      event.key === "ArrowDown"
        ? rows[(index + 1) % rows.length]
        : rows[(index - 1 + rows.length) % rows.length];
    if (next) setCursor(cursorOf(next.group, next.row));
  };
  const settingsOf = (service: string) => {
    workbench.openSettings({ group: "models", depth: 2, service });
    onClose(false);
  };

  // Only where the model of the conversation has no pack of its own: it says so, and where to get one.
  const generic = now?.state === "ok" && chat.choiceFor(now.ref.model).note.by === "fallback";
  const activeId = at ? `chat-model-row-${rows.indexOf(at)}` : undefined;

  return (
    <div
      className={styles.bubble}
      role="dialog"
      aria-label={t("chat.picker.label")}
      data-testid="chat-model-bubble"
      onKeyDown={onKeyDown}
      // Tab out of it, it closes: what has the focus next is what people are at.
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next)) onClose(false);
      }}
    >
      {props.effort && <EffortBar effort={props.effort} />}
      <label className={styles.search}>
        <Search size={12} aria-hidden />
        <input
          ref={search}
          autoFocus
          value={query}
          role="combobox"
          aria-expanded
          aria-controls="chat-model-list"
          aria-activedescendant={activeId}
          placeholder={t("chat.picker.search")}
          aria-label={t("chat.picker.search")}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(undefined);
          }}
        />
      </label>
      <div
        className={styles.list}
        id="chat-model-list"
        role="listbox"
        aria-label={t("chat.picker.label")}
        ref={list}
      >
        {props.pictures && (
          <p className={styles.note} data-testid="chat-picker-pictures">
            {t("chat.picker.pictures")}
          </p>
        )}
        {found.length === 0 && <p className={styles.note}>{t("chat.picker.none")}</p>}
        {found.map((group) => (
          <div
            key={group.service || "favorites"}
            role="group"
            aria-label={group.name}
            data-testid="chat-model-group"
            data-group={group.service === FAVORITES ? "favorites" : undefined}
            data-dim={group.dim}
          >
            <div className={styles.groupName}>
              <span>{group.name}</span>
              {group.dim && (
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => settingsOf(group.service)}
                >
                  {t(`chat.picker.${group.dim}`)}
                </button>
              )}
            </div>
            {group.rows.map((row, index) => {
              const key = cursorOf(group, row);
              const favorite = group.service === FAVORITES;
              const drop = (event: DragEvent) => {
                event.preventDefault();
                const from = dragging;
                setDragging(undefined);
                const moved = group.rows.findIndex((each) => keyOf(each) === from);
                const which = group.rows[moved];
                if (which && from !== keyOf(row))
                  move(which, row, moved < index ? "after" : "before");
              };
              return (
                <ModelRow
                  key={key}
                  id={`chat-model-row-${rows.findIndex((each) => cursorOf(each.group, each.row) === key)}`}
                  cursorKey={key}
                  row={row}
                  current={keyOf(row) === current}
                  active={at !== undefined && cursorOf(at.group, at.row) === key}
                  dim={
                    dimOf.get(row.service) !== undefined ||
                    (props.pictures && row.model.image !== true)
                  }
                  favorite={favorites.some((ref) => refKey(ref) === keyOf(row))}
                  first={favorite && index === 0}
                  draggable={favorite && !query.trim()}
                  dragging={favorite && dragging === keyOf(row)}
                  onHover={() => setCursor(key)}
                  onChoose={() => choose(row)}
                  onFavorite={() => {
                    ai.toggleFavorite({ service: row.service, model: row.model.id });
                    search.current?.focus();
                  }}
                  onDragStart={() => setDragging(keyOf(row))}
                  onDragEnd={() => setDragging(undefined)}
                  onDrop={drop}
                />
              );
            })}
          </div>
        ))}
      </div>
      <p className={styles.said} aria-live="polite">
        {said}
      </p>
      {generic && (
        <p className={styles.generic} data-testid="chat-picker-generic">
          <span>{t("chat.picker.generic")}</span>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => {
              workbench.openSettings({ group: "packs", depth: 1 });
              onClose(false);
            }}
          >
            {t("chat.picker.getPack")}
          </button>
        </p>
      )}
      <div className={styles.foot}>
        <button
          type="button"
          className={styles.textButton}
          data-testid="chat-picker-manage"
          onClick={() => {
            workbench.openSettings({ group: "models", depth: 1 });
            onClose(false);
          }}
        >
          {t("chat.picker.manage")}
        </button>
        <span className={styles.grow} />
        <button
          type="button"
          className={styles.textButton}
          data-testid="chat-picker-local-ai"
          onClick={() => {
            onClose(false);
            workbench.openLocalAiGuide();
          }}
        >
          {t("localAi.entry.picker")}
        </button>
      </div>
    </div>
  );
}

function ModelRow(props: {
  readonly id: string;
  readonly cursorKey: string;
  readonly row: Row;
  readonly current: boolean;
  readonly active: boolean;
  readonly dim: boolean;
  readonly favorite: boolean;
  /** The first favorite: what a new conversation uses. */
  readonly first: boolean;
  readonly draggable: boolean;
  readonly dragging: boolean;
  readonly onHover: () => void;
  readonly onChoose: () => void;
  readonly onFavorite: () => void;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  readonly onDrop: (event: DragEvent) => void;
}) {
  const { ai, packs } = useWorkbench();
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const { row } = props;
  const { model } = row;
  const name = model.name ?? model.id;
  const size = contextLabel(model.contextWindow);
  const capability = capabilityOf(model);
  const price = model.cost
    ? t("chat.picker.price", {
        input: priceLabel(model.cost.input),
        output: priceLabel(model.cost.output),
      })
    : undefined;
  const title = [name, size, capability && t(`ai.capability.${capability}`), price]
    .filter(Boolean)
    .join(" · ");
  // A pack people chose for the model in the settings, under its name; the rules' choice is not said.
  const packId = settings.packFor?.[model.id];
  const pack = packId === undefined ? undefined : packs.packOf(packId);
  return (
    <div
      className={styles.row}
      data-testid="chat-model-option"
      data-model={model.id}
      data-cursor={props.cursorKey}
      data-active={props.active ? "" : undefined}
      data-dim={props.dim ? "" : undefined}
      data-dragging={props.dragging ? "" : undefined}
      draggable={props.draggable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        props.onDragStart();
      }}
      onDragEnd={props.onDragEnd}
      onDragOver={(event) => {
        if (props.draggable) event.preventDefault();
      }}
      onDrop={props.onDrop}
      onPointerEnter={props.onHover}
    >
      {props.draggable && <GripVertical size={11} aria-hidden className={styles.grip} />}
      <button
        type="button"
        role="option"
        id={props.id}
        tabIndex={-1}
        aria-selected={props.current}
        className={styles.choose}
        title={title}
        onClick={props.onChoose}
      >
        <span className={styles.tick}>{props.current && <Check size={12} aria-hidden />}</span>
        <span className={styles.rowText}>
          <span className={styles.rowName}>
            {name}
            {props.first && (
              <span className={styles.firstTag} data-testid="chat-model-first">
                {t("chat.picker.newUses")}
              </span>
            )}
          </span>
          {pack && (
            <span className={styles.rowPack} data-testid="chat-model-row-pack">
              {t("chat.picker.packOf")}
              <PackLabel pack={pack} />
            </span>
          )}
        </span>
        <span className={styles.meta}>
          {size}
          <span className={styles.capability}>
            <CapabilityIcon capability={capability} size={14} />
          </span>
        </span>
      </button>
      {/* Only the star of the row the cursor is on is a stop of Tab, after the search. */}
      <button
        type="button"
        tabIndex={props.active ? 0 : -1}
        className={styles.star}
        data-on={props.favorite ? "" : undefined}
        data-testid="chat-model-fav"
        aria-pressed={props.favorite}
        aria-label={
          props.favorite
            ? t("chat.picker.unfavorite", { model: name })
            : t("chat.picker.favorite", { model: name })
        }
        title={
          props.favorite
            ? t("chat.picker.unfavorite", { model: name })
            : t("chat.picker.favorite", { model: name })
        }
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onFavorite}
      >
        <Star size={12} fill={props.favorite ? "currentColor" : "none"} aria-hidden />
      </button>
    </div>
  );
}
