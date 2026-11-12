import type { ReasoningLevel } from "@animaquill/agent";
import { DEFAULT_PACK, REASONING, usePack as packFor } from "@animaquill/tools";
import { Brain, Check, ChevronDown, ChevronUp, Image, Search, Star } from "lucide-react";
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { stateOf } from "./aiParts.tsx";
import styles from "./ChatPanel.module.css";
import { contextLabel, priceLabel } from "./modelText.ts";
import { packLabel } from "./packText.ts";
import { PackSelect } from "./PackSelect.tsx";
import { OpenPackView } from "./PackViews.tsx";
import type { ServiceModel } from "./settings.ts";

/**
 * Where a conversation picks its model, under the input box: a button with the name of the model,
 * which opens a bubble of the models that are on, by service in the order of the settings, to find
 * by name, service or id. The tick is the model of this conversation, the star the default (which
 * only the star changes, pi-web's way). Under the models, the model pack of the model the cursor is
 * on: its details, another one, back to the one recommended (`PackPart`). How hard the model
 * reasons is the button beside, `ReasoningPicker`.
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

export function ModelPicker() {
  const workbench = useWorkbench();
  const { ai, chat } = workbench;
  const { t } = useTranslation();
  useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  useSyncExternalStore(chat.subscribe, chat.getSnapshot);
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
  return (
    <div className={styles.pickerWrap}>
      <button
        type="button"
        className={styles.pick}
        data-testid="chat-model"
        data-state={now?.state}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={
          now?.service
            ? t("chat.picker.title", { service: now.service.name, model: name })
            : t("chat.modelNoneTitle")
        }
        onClick={() => setOpen(!open)}
      >
        <span className={styles.pickName} data-short={label.slice(0, SHORT_NAME)}>
          {label}
        </span>
        {open ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
      </button>
      {open && <Bubble onClose={() => setOpen(false)} />}
    </div>
  );
}

function Bubble({ onClose }: { readonly onClose: () => void }) {
  const workbench = useWorkbench();
  const { ai, chat } = workbench;
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const openView = useContext(OpenPackView);
  const ref = useRef<HTMLDivElement>(null);
  const now = chat.modelNow();

  // Names and sizes of models come from what pi knows of each kind.
  const kinds = [...new Set(settings.services.map(({ kind }) => kind))].join(" ");
  useEffect(() => {
    for (const kind of kinds.split(" ")) if (kind) void ai.loadKnown(kind);
  }, [ai, kinds]);

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
  const keyOf = (row: Row) => `${row.service}\n${row.model.id}`;
  const current = now ? `${now.ref.service}\n${now.ref.model}` : undefined;
  // The row the cursor is on: else this conversation's, else the first one found.
  const at =
    rows.find((row) => keyOf(row) === cursor) ??
    rows.find((row) => keyOf(row) === current) ??
    (query.trim() ? rows[0] : undefined);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      const picker = ref.current?.parentElement;
      if (!picker?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  const choose = (row: Row) => {
    chat.chooseModel({ service: row.service, model: row.model.id });
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    // The keys of the list of packs, and of the buttons by it, are theirs.
    if ((event.target as HTMLElement).closest("[data-pack-part]")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (at) choose(at);
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
    if (next) setCursor(keyOf(next));
  };
  const settingsOf = (service: string) => {
    workbench.openSettings({ page: "models", depth: 2, service });
    onClose();
  };

  return (
    <div
      ref={ref}
      className={styles.bubble}
      role="dialog"
      aria-label={t("chat.picker.label")}
      data-testid="chat-model-bubble"
      onKeyDown={onKeyDown}
    >
      <label className={styles.bubbleSearch}>
        <Search size={12} aria-hidden />
        <input
          autoFocus
          value={query}
          placeholder={t("chat.picker.search")}
          aria-label={t("chat.picker.search")}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(undefined);
          }}
        />
      </label>
      <div className={styles.bubbleList} role="listbox" aria-label={t("chat.picker.label")}>
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
                dim={group.dim !== undefined}
                isDefault={
                  settings.default?.service === row.service &&
                  settings.default.model === row.model.id
                }
                onHover={() => setCursor(keyOf(row))}
                onChoose={() => choose(row)}
              />
            ))}
          </div>
        ))}
      </div>
      {at && (
        <PackPart
          model={at.model.id}
          name={at.model.name ?? at.model.id}
          onView={(view) => {
            onClose();
            openView?.(view);
          }}
        />
      )}
      <div className={styles.bubbleFoot}>
        <button
          type="button"
          className={styles.link}
          onClick={() => {
            workbench.openSettings({ page: "models", depth: 1 });
            onClose();
          }}
        >
          {t("chat.picker.manage")}
        </button>
      </div>
    </div>
  );
}

function ModelRow(props: {
  readonly row: Row;
  readonly current: boolean;
  readonly active: boolean;
  readonly dim: boolean;
  readonly isDefault: boolean;
  readonly onHover: () => void;
  readonly onChoose: () => void;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const { row, current, active, isDefault } = props;
  const { model } = row;
  const name = model.name ?? model.id;
  const size = contextLabel(model.contextWindow);
  const price = model.cost
    ? t("chat.picker.price", {
        input: priceLabel(model.cost.input),
        output: priceLabel(model.cost.output),
      })
    : undefined;
  return (
    <div
      className={styles.modelRow}
      data-testid="chat-model-option"
      data-model={model.id}
      data-active={props.active ? "" : undefined}
      data-dim={props.dim ? "" : undefined}
      onPointerEnter={props.onHover}
    >
      <button
        type="button"
        role="option"
        aria-selected={current}
        className={styles.modelChoose}
        title={price}
        onClick={props.onChoose}
      >
        <span className={styles.tick}>{current && <Check size={12} aria-hidden />}</span>
        <span className={styles.modelRowName}>{name}</span>
        <span className={styles.modelMeta}>
          {size}
          {model.reasoning && <Brain size={11} aria-label={t("chat.picker.thinking")} role="img" />}
          {model.image && <Image size={11} aria-label={t("chat.picker.image")} role="img" />}
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
    </div>
  );
}

/**
 * The model pack of a model: the one it has (whose, recommended or chosen), which opens its details;
 * the one recommended, with a way back to it, where people chose another; and the list to choose
 * another. Chosen here, the conversation open takes it from its next turn (`ChatSession.choosePack`
 * "now"), and says so; so do new conversations, as the choice is the model's, as in the settings.
 */
function PackPart(props: {
  readonly model: string;
  readonly name: string;
  readonly onView: (view: { view: "details"; pack: string; model: string }) => void;
}) {
  const { chat, packs } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const { model } = props;
  const options = chat.packOptions(model);
  const pack = options.current;
  const special = pack.id !== DEFAULT_PACK.id;
  const choose = (id: string | undefined) => chat.choosePack(model, id, "now");
  const conversation = chat.getSnapshot().conversation;
  const next =
    chat.repicking(model) && (conversation?.getSnapshot().entries.length ?? 0) > 0
      ? t("chat.picker.packNext", { name: packLabel(t, pack) })
      : t("chat.picker.packWhen");
  return (
    <div className={styles.packPart} data-testid="chat-model-pack" data-pack-part="">
      <div className={styles.bubbleGroup}>{t("chat.picker.pack", { model: props.name })}</div>
      <button
        type="button"
        className={styles.packRow}
        data-testid="chat-pack-details"
        title={t("chat.picker.packDetailsTitle")}
        onClick={() => props.onView({ view: "details", pack: pack.id, model })}
      >
        <span className={styles.packWhich}>
          <strong data-testid="chat-pack-name">{packLabel(t, pack)}</strong>
          <span
            className={styles.tag}
            data-kind={options.chosen ? "mine" : "recommended"}
            data-testid="chat-pack-by"
          >
            {options.chosen ? t("chat.picker.packChosen") : t("chat.picker.packRecommended")}
          </span>
          {!special && <span className={styles.muted}>{t("chat.picker.packNone")}</span>}
        </span>
        <span className={styles.muted}>{t("chat.picker.packDetails")}</span>
      </button>
      {options.chosen && (
        <div className={styles.packLine}>
          <span className={styles.packWhich}>
            <span className={styles.muted}>
              {options.recommended.id === DEFAULT_PACK.id
                ? t("chat.picker.packRecommendedNone")
                : t("chat.picker.packRecommendedIs", {
                    name: packLabel(t, options.recommended),
                  })}
            </span>
          </span>
          <button type="button" data-testid="chat-pack-reset" onClick={() => choose(undefined)}>
            {t("chat.picker.packReset")}
          </button>
        </div>
      )}
      <label className={styles.packLine}>
        <span className={styles.muted}>{t("chat.picker.packOther")}</span>
        <PackSelect model={model} onChoose={choose} testId="chat-pack-choose" />
      </label>
      <p className={styles.packWhen} data-testid="chat-pack-when">
        {next}
      </p>
    </div>
  );
}

/**
 * How hard the model of the conversation reasons: the steps it takes, first "as set up" (for the
 * model in the settings, else as its pack says). Kept with the conversation; the default for the
 * model is in the settings.
 */
export function ReasoningPicker() {
  const { ai, chat } = useWorkbench();
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const now = chat.modelNow();
  const model = now?.ref.model ?? "";
  const byPack = packFor(chat.choiceFor(model).pack, model).call.reasoning;
  if (!now || now.state !== "ok") return null;
  const info = ai.modelOf(now.ref.service, model);
  if (info?.reasoning === false) return null;
  const levels: readonly ReasoningLevel[] = info?.levels ?? REASONING;
  const auto = settings.reasoningFor?.[model] ?? byPack;
  const level = (value: ReasoningLevel) => t(`ai.packs.value.reasoning.${value}`);
  return (
    <select
      className={styles.reasoning}
      data-testid="chat-reasoning"
      aria-label={t("chat.reasoning.label")}
      title={t("chat.reasoning.title")}
      value={snapshot.reasoning ?? ""}
      onChange={(event) =>
        chat.chooseReasoning(
          event.target.value === "" ? undefined : (event.target.value as ReasoningLevel),
        )
      }
    >
      <option value="">
        {auto ? t("chat.reasoning.auto", { level: level(auto) }) : t("chat.reasoning.autoNone")}
      </option>
      {levels.map((each) => (
        <option key={each} value={each}>
          {t("chat.reasoning.level", { level: level(each) })}
        </option>
      ))}
    </select>
  );
}
