import type { ReasoningLevel } from "@animaquill/agent";
import { closenessFor, REASONING, usePack as packFor, type ModelPack } from "@animaquill/tools";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Search,
  Star,
} from "lucide-react";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { stateOf } from "./aiParts.tsx";
import { CapabilityIcon, capabilityOf } from "./CapabilityIcon.tsx";
import styles from "./ChatPanel.module.css";
import menuStyles from "./ModelPicker.module.css";
import { contextLabel, priceLabel } from "./modelText.ts";
import { PackLabel } from "./PackLabel.tsx";
import { labelParts, originIn, packLabel } from "./packText.ts";
import { OpenPackView, type PackViewRequest } from "./PackViews.tsx";
import type { ChatSession } from "./session.ts";
import type { ServiceModel } from "./settings.ts";

/**
 * Where a conversation picks its model, under the input box (docs/design/settings-and-properties.md
 * of AnimaQuill Cloud, 7): a button with the name of the model (and of the model pack where people
 * chose one for it), which opens a bubble of the models that are on, by service in the order of the
 * settings, to find by name, service or id. Only models: the tick is the model of this conversation,
 * with the pack it uses in a line under it; the star the default (which only the star changes,
 * pi-web's way). The model packs of a model are a menu beside its row, as a desktop's submenus are:
 * it opens when the pointer rests on the row, with → or with the row's "›", and where there is no
 * room beside the bubble it goes over it, one level in. How hard the model reasons is the button
 * beside, `ReasoningPicker`.
 */

interface Row {
  readonly service: string;
  readonly model: ServiceModel;
}

interface Group {
  readonly service: string;
  readonly name: string;
  /** No key, or its test failed: the group shows dim, and says where to go. */
  readonly dim: "noKey" | "failed" | undefined;
  readonly rows: readonly Row[];
}

/** The models that are on, by service, that a search finds: by name, service or id, any case. */
export function findModels(groups: readonly Group[], query: string): readonly Group[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter(({ model }) =>
        `${model.name ?? ""} ${model.id} ${group.name}`.toLocaleLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.rows.length > 0);
}

/** Shortens a name of a model for the button where the chat is narrow. */
const SHORT_NAME = 14;
/** How long the pointer rests on a row before its menu opens, as desktops have it. */
const HOVER_MS = 150;
/** How long it may rest while it heads for the menu open, before another row's opens. */
const HEADING_MS = 400;
/** The chat narrower than this: the menu goes over the bubble, one level in. */
const NARROW = 400;
/** How wide a menu beside the bubble is, to know whether it fits. */
const MENU_WIDTH = 320;

/**
 * The model packs people can choose for a model, as the menu lists them: "自动" first (the pack the
 * rules choose, not people), then those made for the model, then the others there are, under an
 * item of their own. The pack the rules choose shows again only where people chose it themselves.
 */
export function packChoicesOf(chat: ChatSession, model: string) {
  const options = chat.packOptions(model);
  const { recommended, current, chosen } = options;
  const listed = options.packs
    .map(({ pack }) => pack)
    .filter((pack) => pack.id !== recommended.id || (chosen && current.id === pack.id));
  const fits = listed.filter((pack) => closenessFor(pack, model) !== undefined);
  const others = listed.filter((pack) => !fits.includes(pack));
  return { options, fits, others };
}

export function ModelPicker() {
  const workbench = useWorkbench();
  const { ai, chat, packs } = workbench;
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const [open, setOpen] = useState(false);
  const now = chat.modelNow();
  const info = now && ai.modelOf(now.ref.service, now.ref.model);
  const name = info?.name ?? now?.ref.model;
  const label = !now
    ? t("chat.modelNone")
    : now.state === "gone"
      ? t("chat.picker.gone", { model: name })
      : now.state === "off"
        ? t("chat.picker.off", { model: name })
        : (name ?? "");
  // A pack people chose for the model, which the button says too.
  const chosenId = now ? settings.packFor?.[now.ref.model] : undefined;
  const chosenPack = chosenId === undefined ? undefined : packs.packOf(chosenId);
  const chosen =
    now?.state === "ok" && chosenPack
      ? labelParts(t, chosenPack, originIn(chosenPack, snapshot), snapshot)
      : undefined;
  const packText =
    now?.state === "ok"
      ? packLabel(t, chat.packOptions(now.ref.model).current, snapshot, chosen === undefined)
      : undefined;
  return (
    <div className={styles.pickerWrap}>
      <button
        type="button"
        className={styles.pick}
        data-testid="chat-model"
        data-state={now?.state}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          !now?.service
            ? t("chat.modelNoneTitle")
            : packText
              ? t("chat.picker.titlePack", {
                  service: now.service.name,
                  model: name,
                  pack: packText,
                })
              : t("chat.picker.title", { service: now.service.name, model: name })
        }
        onClick={() => setOpen(!open)}
      >
        <span className={styles.pickName} data-short={label.slice(0, SHORT_NAME)}>
          {label}
        </span>
        {chosen && (
          <span className={styles.pickPack} data-testid="chat-model-pack-name">
            {t("chat.picker.withPack", { name: chosen.name })}
          </span>
        )}
        {open ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
      </button>
      {open && <Bubble onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Which row's menu of packs is open, and whether the menu of the other packs is open in it. */
interface OpenMenu {
  readonly key: string;
  readonly others: boolean;
  /** Opened from the keyboard: the focus goes into it. */
  readonly focus: boolean;
}

/** A menu of packs as it is on the page: beside the bubble it is not in it. */
const levelOf = (which: 1 | 2) =>
  document.querySelector<HTMLElement>(`[data-pack-menu][data-level="${which}"]`);

/** Where menus go: beside the bubble, to the right or the left, or over it, one level in. */
type Side = "right" | "left" | "over";

const keyOf = (row: Row) => `${row.service}\n${row.model.id}`;

/** Whether a point is in the triangle of three others: the pointer heading for an open menu. */
function inTriangle(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): boolean {
  const sign = (p1: typeof p, p2: typeof p, p3: typeof p) =>
    (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

function Bubble({ onClose }: { readonly onClose: () => void }) {
  const workbench = useWorkbench();
  const { ai, chat, packs } = workbench;
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [menu, setMenu] = useState<OpenMenu | undefined>();
  const [side, setSide] = useState<Side>("right");
  const openView = useContext(OpenPackView);
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The row under the pointer, and where the pointer was a move ago. */
  const hovered = useRef<string | undefined>(undefined);
  const before = useRef<{ x: number; y: number } | undefined>(undefined);
  const now = chat.modelNow();

  // Names and sizes of models come from what pi knows of each kind.
  const kinds = [...new Set(settings.services.map(({ kind }) => kind))].join(" ");
  useEffect(() => {
    for (const kind of kinds.split(" ")) if (kind) void ai.loadKnown(kind);
  }, [ai, kinds]);

  // Beside the bubble where the window has room and the chat is wide enough, else over it.
  useLayoutEffect(() => {
    const place = () => {
      const bubble = ref.current;
      const panel = bubble?.closest<HTMLElement>('[data-testid="chat"]');
      if (!bubble || !panel) return;
      const box = bubble.getBoundingClientRect();
      setSide(
        panel.clientWidth < NARROW
          ? "over"
          : box.right + MENU_WIDTH <= innerWidth
            ? "right"
            : box.left - MENU_WIDTH >= 0
              ? "left"
              : "over",
      );
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const groups = useMemo((): readonly Group[] => {
    return settings.services.map((service) => {
      const state = stateOf(settings, service);
      return {
        service: service.id,
        name: service.name,
        dim: state === "noKey" || state === "failed" ? state : undefined,
        rows: ai
          .modelsFor(service.id)
          .filter((model) => model.enabled)
          .map((model) => ({ service: service.id, model })),
      };
    });
  }, [ai, settings]);
  const found = findModels(groups, query);
  const rows = found.flatMap((group) => group.rows);
  const current = now ? `${now.ref.service}\n${now.ref.model}` : undefined;
  // The row the cursor is on: else this conversation's, else the first one found.
  const at =
    rows.find((row) => keyOf(row) === cursor) ??
    rows.find((row) => keyOf(row) === current) ??
    (query.trim() ? rows[0] : undefined);
  const menuRow = menu ? rows.find((row) => keyOf(row) === menu.key) : undefined;

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const picker = ref.current?.parentElement;
      if (picker?.contains(target) || target?.closest?.("[data-pack-menu]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  const choose = (row: Row) => {
    chat.chooseModel({ service: row.service, model: row.model.id });
    onClose();
  };
  /** A model and a pack for it, from the menu: this conversation takes both from its next turn. */
  const choosePack = (row: Row, pack: string | undefined) => {
    chat.chooseModel({ service: row.service, model: row.model.id });
    chat.choosePack(row.model.id, pack, "now");
    onClose();
  };
  const openMenu = (key: string, focus: boolean) => {
    clearTimeout(timer.current);
    setCursor(key);
    setMenu({ key, others: false, focus });
  };
  const closeMenu = () => {
    clearTimeout(timer.current);
    setMenu(undefined);
    search.current?.focus();
  };

  /** Whether the pointer heads for the menu open: then a row it crosses waits a little longer. */
  const heading = (point: { x: number; y: number }) => {
    const element = levelOf(1);
    const from = before.current;
    if (!element || !from || side === "over") return false;
    const box = element.getBoundingClientRect();
    const edge = side === "right" ? box.left : box.right;
    return inTriangle(point, from, { x: edge, y: box.top - 8 }, { x: edge, y: box.bottom + 8 });
  };
  /** The pointer rests on a row: its menu opens, unless it is on its way to the one open. */
  const rest = (key: string, point: { x: number; y: number }) => {
    if (side === "over") return;
    clearTimeout(timer.current);
    if (menu?.key === key) return;
    const wait = menu && heading(point) ? HEADING_MS : HOVER_MS;
    timer.current = setTimeout(() => {
      if (hovered.current === key) setMenu({ key, others: false, focus: false });
    }, wait);
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const point = { x: event.clientX, y: event.clientY };
    const key = hovered.current;
    if (key !== undefined && menu?.key !== key) rest(key, point);
    before.current = point;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    // The keys of the menus of packs are theirs.
    if ((event.target as HTMLElement).closest("[data-pack-menu]")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (at) choose(at);
      return;
    }
    if (event.key === "ArrowRight") {
      const input = event.target instanceof HTMLInputElement ? event.target : undefined;
      // In the search, → moves through the words until it is at their end.
      if (input && (input.selectionStart ?? 0) < input.value.length) return;
      if (!at) return;
      event.preventDefault();
      openMenu(keyOf(at), true);
      return;
    }
    if (event.key === "ArrowLeft" && menu) {
      const input = event.target instanceof HTMLInputElement ? event.target : undefined;
      if (input && input.value !== "") return;
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (rows.length === 0) return;
    const index = at ? rows.indexOf(at) : -1;
    const next =
      event.key === "ArrowDown"
        ? rows[(index + 1) % rows.length]
        : rows[(index - 1 + rows.length) % rows.length];
    if (next) {
      setCursor(keyOf(next));
      // The menu open follows the cursor, as it does the pointer.
      if (menu) setMenu({ key: keyOf(next), others: false, focus: false });
    }
  };
  const settingsOf = (service: string) => {
    workbench.openSettings({ group: "models", depth: 2, service });
    onClose();
  };
  const view = (request: PackViewRequest) => {
    onClose();
    openView?.(request);
  };

  const pushed = side === "over" && menuRow !== undefined;
  const packMenu = menuRow && (
    <PackMenus
      row={menuRow}
      open={menu as OpenMenu}
      side={side}
      anchor={() =>
        ref.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(menu?.key ?? "")}"]`) ??
        undefined
      }
      bubble={() => ref.current ?? undefined}
      onOthers={(others, focus) => setMenu({ key: menuRow ? keyOf(menuRow) : "", others, focus })}
      onBack={closeMenu}
      onChoose={(pack) => choosePack(menuRow, pack)}
      onView={view}
      onEnter={() => clearTimeout(timer.current)}
    />
  );

  return (
    <div
      ref={ref}
      className={styles.bubble}
      role="dialog"
      aria-label={t("chat.picker.label")}
      data-testid="chat-model-bubble"
      data-side={side}
      onKeyDown={onKeyDown}
    >
      {pushed ? (
        packMenu
      ) : (
        <>
          <label className={styles.bubbleSearch}>
            <Search size={12} aria-hidden />
            <input
              ref={search}
              autoFocus
              value={query}
              placeholder={t("chat.picker.search")}
              aria-label={t("chat.picker.search")}
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(undefined);
                setMenu(undefined);
              }}
            />
          </label>
          <div
            className={styles.bubbleList}
            role="listbox"
            aria-label={t("chat.picker.label")}
            onPointerMove={onPointerMove}
            onPointerLeave={() => {
              hovered.current = undefined;
              clearTimeout(timer.current);
            }}
          >
            {found.length === 0 && <p className={styles.bubbleNone}>{t("chat.picker.none")}</p>}
            {found.map((group) => (
              <div key={group.service} data-testid="chat-model-group" data-dim={group.dim}>
                <div className={styles.bubbleGroup}>
                  <span>{group.name}</span>
                  {group.dim && (
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => settingsOf(group.service)}
                    >
                      · {t(`chat.picker.${group.dim}`)}
                    </button>
                  )}
                </div>
                {group.rows.map((row) => (
                  <ModelRow
                    key={row.model.id}
                    row={row}
                    current={keyOf(row) === current}
                    active={at !== undefined && keyOf(row) === keyOf(at)}
                    menuOpen={menu?.key === keyOf(row)}
                    dim={group.dim !== undefined}
                    isDefault={
                      settings.default?.service === row.service &&
                      settings.default.model === row.model.id
                    }
                    onHover={(event) => {
                      setCursor(keyOf(row));
                      hovered.current = keyOf(row);
                      if (event.pointerType === "mouse") {
                        rest(keyOf(row), { x: event.clientX, y: event.clientY });
                      }
                    }}
                    onChoose={() => choose(row)}
                    onMenu={() => openMenu(keyOf(row), false)}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className={styles.bubbleFoot}>
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                workbench.openSettings({ group: "models", depth: 1 });
                onClose();
              }}
            >
              {t("chat.picker.manage")}
            </button>
            <span className={styles.grow} />
            <button
              type="button"
              className={styles.link}
              data-testid="chat-picker-packs"
              onClick={() => {
                workbench.openSettings({ group: "packs", depth: 1 });
                onClose();
              }}
            >
              {t("chat.picker.packs")}
            </button>
          </div>
          {side !== "over" && packMenu}
        </>
      )}
    </div>
  );
}

function ModelRow(props: {
  readonly row: Row;
  readonly current: boolean;
  readonly active: boolean;
  readonly menuOpen: boolean;
  readonly dim: boolean;
  readonly isDefault: boolean;
  readonly onHover: (event: ReactPointerEvent) => void;
  readonly onChoose: () => void;
  readonly onMenu: () => void;
}) {
  const { ai, chat } = useWorkbench();
  const { t } = useTranslation();
  const { row, current, active, isDefault } = props;
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
  const options = current ? chat.packOptions(model.id) : undefined;
  const title = [name, size, capability && t(`ai.capability.${capability}`), price]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className={styles.modelRow}
      data-testid="chat-model-option"
      data-model={model.id}
      data-row={keyOf(row)}
      data-active={active ? "" : undefined}
      data-menu={props.menuOpen ? "" : undefined}
      data-dim={props.dim ? "" : undefined}
      onPointerEnter={props.onHover}
    >
      <button
        type="button"
        role="option"
        aria-selected={current}
        className={styles.modelChoose}
        title={title}
        onClick={props.onChoose}
      >
        <span className={styles.tick}>{current && <Check size={12} aria-hidden />}</span>
        <span className={styles.modelRowText}>
          <span className={styles.modelRowName}>{name}</span>
          {options && (
            <span className={styles.modelRowPack} data-testid="chat-model-row-pack">
              {t("chat.picker.packOf")}
              <PackLabel pack={options.current} auto={!options.chosen} />
            </span>
          )}
        </span>
        <span className={styles.modelMeta}>
          {size}
          <span className={styles.capability}>
            <CapabilityIcon capability={capability} size={14} />
          </span>
        </span>
      </button>
      <button
        type="button"
        className={styles.star}
        data-on={isDefault ? "" : undefined}
        data-active={active ? "" : undefined}
        aria-pressed={isDefault}
        aria-label={
          isDefault ? t("chat.picker.isDefault") : t("chat.picker.setDefault", { model: name })
        }
        title={
          isDefault ? t("chat.picker.isDefault") : t("chat.picker.setDefault", { model: name })
        }
        onClick={() => {
          if (!isDefault) ai.setDefault({ service: row.service, model: model.id });
        }}
      >
        <Star size={12} fill={isDefault ? "currentColor" : "none"} aria-hidden />
      </button>
      <button
        type="button"
        className={styles.more}
        data-testid="chat-model-more"
        aria-haspopup="menu"
        aria-expanded={props.menuOpen}
        aria-label={t("chat.picker.packsOf", { model: name })}
        title={t("chat.picker.packsOf", { model: name })}
        onClick={props.onMenu}
      >
        <ChevronRight size={12} aria-hidden />
      </button>
    </div>
  );
}

/**
 * The menu of model packs of a model, and in it the menu of the other packs: beside the bubble
 * (`side`), in the page's top layer so that the chat does not cut them off, or over the bubble one
 * level in, each with the way back. Choosing a pack chooses the model too, and the conversation takes
 * both from its next turn.
 */
function PackMenus(props: {
  readonly row: Row;
  readonly open: OpenMenu;
  readonly side: Side;
  readonly anchor: () => HTMLElement | undefined;
  readonly bubble: () => HTMLElement | undefined;
  readonly onOthers: (open: boolean, focus: boolean) => void;
  readonly onBack: () => void;
  readonly onChoose: (pack: string | undefined) => void;
  readonly onView: (request: PackViewRequest) => void;
  readonly onEnter: () => void;
}) {
  const { chat, packs } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const { row, open, side } = props;
  const model = row.model.id;
  const name = row.model.name ?? model;
  const { options, fits, others } = packChoicesOf(chat, model);
  const conversation = chat.getSnapshot().conversation;
  const pending =
    chat.repicking(model) && (conversation?.getSnapshot().entries.length ?? 0) > 0
      ? t("chat.picker.packNext", {
          name: packLabel(t, options.current, snapshot, !options.chosen),
        })
      : t("chat.picker.packWhen");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Beside the bubble the menu of the other packs opens as the pointer rests on its item, and
  // closes as it rests on another one; on its way there it may cross other items.
  const hover: MenuHover = {
    others: () => {
      if (side === "over" || open.others) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => props.onOthers(true, false), HOVER_MS);
    },
    item: () => {
      clearTimeout(timer.current);
      if (side === "over" || !open.others) return;
      timer.current = setTimeout(() => props.onOthers(false, false), HEADING_MS);
    },
    enter: (which) => {
      props.onEnter();
      if (which === 2) clearTimeout(timer.current);
    },
  };
  const details = (pack: ModelPack) => () => props.onView({ view: "readme", pack: pack.id, model });
  const item = (pack: ModelPack, auto: boolean): MenuEntry => ({
    kind: "pack",
    pack,
    auto,
    checked: auto ? !options.chosen : options.chosen && options.current.id === pack.id,
    mine: !auto && options.chosen && options.current.id === pack.id,
    onChoose: () => props.onChoose(auto ? undefined : pack.id),
    onDetails: details(pack),
  });
  const entries: MenuEntry[] = [
    item(options.recommended, true),
    ...fits.map((pack) => item(pack, false)),
    ...(others.length > 0
      ? [
          {
            kind: "others",
            count: others.length,
            open: open.others,
            onOpen: (focus: boolean) => props.onOthers(true, focus),
          } as const,
        ]
      : []),
  ];
  const otherEntries = others.map((pack) => item(pack, false));

  // Beside the bubble: next to the row, kept in the window.
  useLayoutEffect(() => {
    if (side === "over") return;
    const place = (
      element: HTMLElement | null,
      by: HTMLElement | null | undefined,
      next: DOMRect | undefined,
    ) => {
      if (!element || !by || !next) return;
      const box = element.getBoundingClientRect();
      const line = by.getBoundingClientRect();
      const left = side === "right" ? next.right + 2 : next.left - box.width - 2;
      element.style.left = `${Math.max(4, Math.min(left, innerWidth - box.width - 4))}px`;
      element.style.top = `${Math.max(4, Math.min(line.top - 5, innerHeight - box.height - 4))}px`;
    };
    const first = levelOf(1);
    place(first, props.anchor(), props.bubble()?.getBoundingClientRect());
    place(
      levelOf(2),
      first?.querySelector<HTMLElement>('[data-testid="chat-pack-others-open"]'),
      first?.getBoundingClientRect(),
    );
  });

  // Opened from the keyboard: the focus goes to its first item.
  useEffect(() => {
    if (!open.focus) return;
    levelOf(open.others ? 2 : 1)
      ?.querySelector<HTMLElement>("[data-item]")
      ?.focus();
  }, [open]);

  const level = (which: 1 | 2, list: readonly MenuEntry[], title: ReactNode) => (
    <MenuLevel
      level={which}
      over={side === "over"}
      title={title}
      back={
        side === "over"
          ? which === 1
            ? { label: t("chat.picker.backModels"), run: props.onBack, name }
            : { label: t("chat.picker.backPacks"), run: () => props.onOthers(false, true), name }
          : undefined
      }
      entries={list}
      foot={pending}
      testId={which === 1 ? "chat-pack-menu" : "chat-pack-others"}
      onLeft={() => (which === 1 ? props.onBack() : props.onOthers(false, true))}
      hover={hover}
    />
  );
  const one = level(1, entries, t("chat.picker.packFor", { model: name }));
  const two = open.others ? level(2, otherEntries, t("chat.picker.othersTitle")) : null;
  if (side === "over") return open.others ? two : one;
  return createPortal(
    <>
      {one}
      {two}
    </>,
    document.body,
  );
}

type MenuEntry =
  | {
      readonly kind: "pack";
      readonly pack: ModelPack;
      readonly auto: boolean;
      readonly checked: boolean;
      readonly mine: boolean;
      readonly onChoose: () => void;
      readonly onDetails: () => void;
    }
  | {
      readonly kind: "others";
      readonly count: number;
      readonly open: boolean;
      readonly onOpen: (focus: boolean) => void;
    };

/** The pointer in the menus of packs: on the item of the other packs, on another item, in a menu. */
interface MenuHover {
  readonly others: () => void;
  readonly item: () => void;
  readonly enter: (level: 1 | 2) => void;
}

/** One menu of packs: its title, its items with their details, and when the choice counts. */
function MenuLevel(props: {
  readonly level: 1 | 2;
  readonly over: boolean;
  readonly title: ReactNode;
  readonly back:
    { readonly label: string; readonly run: () => void; readonly name: string } | undefined;
  readonly entries: readonly MenuEntry[];
  readonly foot: string;
  readonly testId: string;
  readonly onLeft: () => void;
  readonly hover: MenuHover;
}) {
  const { t } = useTranslation();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-item]")];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const next =
        event.key === "ArrowDown"
          ? items[(index + 1) % items.length]
          : items[(index - 1 + items.length) % items.length];
      next?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      props.onLeft();
    } else if (event.key === "ArrowRight") {
      const others = props.entries.find((entry) => entry.kind === "others");
      const active = document.activeElement as HTMLElement | null;
      if (others && active?.dataset.testid === "chat-pack-others-open") {
        event.preventDefault();
        event.stopPropagation();
        others.onOpen(true);
      }
    }
  };
  return (
    <div
      className={props.over ? menuStyles.over : menuStyles.menu}
      role="menu"
      data-level={props.level}
      aria-label={typeof props.title === "string" ? props.title : undefined}
      data-pack-menu=""
      data-testid={props.testId}
      onKeyDown={onKeyDown}
      onPointerEnter={() => props.hover.enter(props.level)}
    >
      {props.back && (
        <div className={menuStyles.backBar}>
          <button
            type="button"
            className={menuStyles.back}
            data-testid="chat-pack-menu-back"
            onClick={props.back.run}
          >
            <ChevronLeft size={12} aria-hidden />
            {props.back.label}
          </button>
          <span className={menuStyles.backName}>{props.back.name}</span>
        </div>
      )}
      <div className={menuStyles.title}>{props.title}</div>
      {props.entries.map((entry) =>
        entry.kind === "others" ? (
          <div
            key="others"
            className={menuStyles.item}
            data-open={entry.open ? "" : undefined}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") props.hover.others();
            }}
          >
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={entry.open}
              data-item=""
              data-testid="chat-pack-others-open"
              className={menuStyles.choose}
              onClick={() => entry.onOpen(true)}
            >
              <span className={menuStyles.tick} />
              <span className={menuStyles.name}>
                {t("chat.picker.others", { count: entry.count })}
              </span>
              <ChevronRight size={12} aria-hidden />
            </button>
          </div>
        ) : (
          <div
            key={`${entry.auto ? "auto" : "pack"}-${entry.pack.id}`}
            className={menuStyles.item}
            data-testid="chat-pack-item"
            data-pack={entry.auto ? "" : entry.pack.id}
            data-checked={entry.checked ? "" : undefined}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse" && props.level === 1) props.hover.item();
            }}
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={entry.checked}
              data-item=""
              className={menuStyles.choose}
              onClick={entry.onChoose}
            >
              <span className={menuStyles.tick}>
                {entry.checked && <Check size={12} aria-hidden />}
              </span>
              <span className={menuStyles.name}>
                <PackLabel pack={entry.pack} auto={entry.auto} />
              </span>
              {entry.mine && (
                <span className={styles.tag} data-kind="mine">
                  {t("chat.picker.packChosen")}
                </span>
              )}
            </button>
            <button
              type="button"
              className={menuStyles.details}
              data-testid="chat-pack-details"
              title={t("chat.picker.packDetailsTitle")}
              onClick={entry.onDetails}
            >
              {t("chat.picker.packDetails")}
            </button>
          </div>
        ),
      )}
      <p className={menuStyles.foot} data-testid="chat-pack-when">
        {props.foot}
      </p>
    </div>
  );
}

/**
 * How hard the model of this conversation reasons (the default for the model in the settings, else
 * as its pack says): a menu of the steps the model takes, each with a star that makes it the
 * default for the model, as pi-web has it. Kept with the conversation; the default for the model
 * is in the settings.
 */
export function ReasoningPicker() {
  const { ai, chat } = useWorkbench();
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const now = chat.modelNow();
  const model = now?.ref.model ?? "";
  const byPack = packFor(chat.choiceFor(model).pack, model).call.reasoning;
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  if (!now || now.state !== "ok") return null;
  const info = ai.modelOf(now.ref.service, model);
  if (info?.reasoning === false) return null;
  const levels: readonly ReasoningLevel[] = info?.levels ?? REASONING;
  const starred = settings.reasoningFor?.[model];
  const auto = starred ?? byPack;
  const level = (value: ReasoningLevel) => t(`ai.packs.value.reasoning.${value}`);
  const chosen = snapshot.reasoning;
  const label = chosen
    ? t("chat.reasoning.level", { level: level(chosen) })
    : auto
      ? t("chat.reasoning.auto", { level: level(auto) })
      : t("chat.reasoning.autoNone");
  const choose = (value: ReasoningLevel | undefined) => {
    chat.chooseReasoning(value);
    setOpen(false);
  };
  return (
    <div className={styles.reasoningBox} ref={box}>
      <button
        type="button"
        className={styles.reasoning}
        data-testid="chat-reasoning"
        aria-label={t("chat.reasoning.label")}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("chat.reasoning.title")}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {label}
        <ChevronUp size={11} aria-hidden />
      </button>
      {open && (
        <div
          className={styles.reasoningMenu}
          role="listbox"
          aria-label={t("chat.reasoning.label")}
          data-testid="chat-reasoning-menu"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className={styles.reasoningItem}>
            <button
              type="button"
              role="option"
              aria-selected={chosen === undefined}
              className={styles.reasoningChoice}
              onClick={() => choose(undefined)}
            >
              <Check size={12} aria-hidden style={{ opacity: chosen === undefined ? 1 : 0 }} />
              {auto
                ? t("chat.reasoning.auto", { level: level(auto) })
                : t("chat.reasoning.autoNone")}
            </button>
          </div>
          {levels.map((each) => (
            <div key={each} className={styles.reasoningItem} data-level={each}>
              <button
                type="button"
                role="option"
                aria-selected={chosen === each}
                className={styles.reasoningChoice}
                onClick={() => choose(each)}
              >
                <Check size={12} aria-hidden style={{ opacity: chosen === each ? 1 : 0 }} />
                {level(each)}
              </button>
              <button
                type="button"
                className={styles.reasoningStar}
                aria-pressed={starred === each}
                aria-label={
                  starred === each
                    ? t("chat.reasoning.isDefault", { level: level(each) })
                    : t("chat.reasoning.setDefault", { level: level(each) })
                }
                title={
                  starred === each
                    ? t("chat.reasoning.isDefault", { level: level(each) })
                    : t("chat.reasoning.setDefault", { level: level(each) })
                }
                onClick={() => ai.setReasoning(model, starred === each ? undefined : each)}
              >
                <Star size={12} aria-hidden fill={starred === each ? "currentColor" : "none"} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
