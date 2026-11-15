import {
  MODEL_APIS,
  THINKING_VALUE_LENGTH,
  checkBaseUrl,
  levelEntry,
  levelSupported,
  levelText,
  markOf,
  type FieldMark,
  type ModelApi,
  type ModelCompat,
  type ModelConfig,
  type ModelCost,
  type ModelField,
  type ReasoningLevel,
  type ServiceConfig,
} from "@animaquill/agent";
import { REASONING, usePack } from "@animaquill/tools";
import { ChevronDown, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { TestPill, useDraft } from "./aiParts.tsx";
import styles from "./AiSettings.module.css";
import { failureText } from "./failure.ts";
import { HeadersEditor, Marked } from "./modelParts.tsx";
import { priceLabel } from "./modelText.ts";
import { protocolOf, testKey, type ServiceModel } from "./settings.ts";

/** Bytes in a megabyte, as the largest picture is shown. */
const MB = 1024 * 1024;
/** Where the open catalog of models is, for its link beside "按目录填写". */
const MODELS_DEV = "https://models.dev";

/** Where a cell's value comes from, and the way back to the catalog's where people set it. */
interface CellMark {
  readonly mark: FieldMark;
  readonly onRevert: (() => void) | undefined;
  readonly testId: string;
}

/**
 * One model of a service, as pi-web shows one (docs/design/settings-and-properties.md of
 * AnimaQuill Cloud, 6.2): a test, the default and removing on top; then one column down, its id and
 * name, filling it in from the catalogs, what it can do and how hard it reasons by default, how
 * much it reads and writes, its prices; folded under "高级", what it has apart from its service and
 * the steps of reasoning. A thin line left of a cell says whether a catalog filled it in or people
 * set it. Every change takes at once; a cell that is not right is marked, says why on hovering it,
 * and is not taken.
 */
export function ModelDetail(props: { readonly service: ServiceConfig; readonly model: string }) {
  const { service } = props;
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const row = ai.modelOf(service.id, props.model);
  // The open catalog, to say what it knows of this model.
  useEffect(() => {
    void ai.loadCatalog();
  }, [ai]);
  return (
    <div className={styles.wall} data-testid="ai-model-detail" data-model={props.model}>
      {row ? (
        <Details service={service} row={row} />
      ) : (
        <p className={styles.muted}>{t("ai.detail.gone")}</p>
      )}
    </div>
  );
}

/**
 * A model being added by hand, as "＋ 模型" starts one: only its id, which is filled in from the
 * catalogs as it leaves the cell, and then it is a model like the others.
 */
export function NewModel(props: {
  readonly service: ServiceConfig;
  readonly onAdded: (id: string) => void;
}) {
  const { service } = props;
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [text, setText] = useState("");
  const id = text.trim();
  const taken =
    id !== "" &&
    ai
      .modelsFor(service.id)
      .some(
        (model) =>
          model.id === id && (model.enabled || service.paused?.includes(model.id) === true),
      );
  const problem = taken
    ? t("ai.invalid.idTaken")
    : id.length > 200
      ? t("ai.invalid.id")
      : undefined;
  const add = () => {
    if (id === "" || problem) return;
    ai.addModels(service.id, [{ id, added: "hand" }]);
    props.onAdded(id);
  };
  return (
    <div className={styles.wall} data-testid="ai-model-detail" data-new="">
      <div className={styles.detailHead}>
        <span className={styles.kicker}>{t("ai.model")}</span>
      </div>
      <div className={styles.column}>
        <label className={styles.field}>
          <span>{t("ai.detail.id")}</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            value={text}
            spellCheck={false}
            autoFocus
            disabled={snapshot.held !== undefined}
            aria-invalid={problem !== undefined}
            title={problem}
            data-testid="ai-model-id"
            onChange={(event) => setText(event.target.value)}
            onBlur={add}
            onKeyDown={(event) => event.key === "Enter" && add()}
          />
        </label>
      </div>
    </div>
  );
}

function Details({
  service,
  row,
}: {
  readonly service: ServiceConfig;
  readonly row: ServiceModel;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const held = snapshot.held !== undefined;
  const { config, live, values } = row;
  const edit = (field: ModelField, value: unknown) =>
    ai.editModel(service.id, row.id, field, value);
  const markFor = (field: ModelField): CellMark => ({
    mark: markOf(config, field, live),
    onRevert: config?.edited?.includes(field)
      ? () => void ai.revertField(service.id, row.id, field)
      : undefined,
    testId: `ai-mark-${field}`,
  });

  return (
    <>
      <TitleRow service={service} row={row} />
      <div className={styles.column}>
        <IdField service={service} row={row} />
        <TextCell
          label={t("ai.name")}
          value={config?.name ?? live?.name ?? ""}
          placeholder={row.id}
          mark={markFor("name")}
          disabled={held}
          testId="ai-model-name"
          onCommit={(text) => {
            const name = text.trim();
            if (name.length > 200) return "long";
            edit("name", name === "" ? undefined : name);
            return undefined;
          }}
        />
        <FillRow service={service} row={row} />
        <div className={styles.row} style={{ gap: 18 }}>
          <Marked {...markFor("reasoning")}>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={values.reasoning === true}
                disabled={held}
                onChange={(event) => edit("reasoning", event.target.checked)}
              />
              {t("ai.detail.reasoning")}
            </label>
          </Marked>
          <Marked {...markFor("image")}>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={values.image === true}
                disabled={held}
                onChange={(event) => edit("image", event.target.checked)}
              />
              {t("ai.detail.image")}
            </label>
          </Marked>
          <span className={styles.grow} />
          <DefaultReasoning row={row} />
        </div>
        <NumberCell
          label={t("ai.detail.context")}
          value={values.contextWindow}
          mark={markFor("contextWindow")}
          disabled={held}
          testId="ai-model-context"
          onCommit={(value) => edit("contextWindow", value)}
        />
        <NumberCell
          label={t("ai.detail.maxTokens")}
          value={values.maxTokens}
          mark={markFor("maxTokens")}
          disabled={held}
          testId="ai-model-max-tokens"
          onCommit={(value) => edit("maxTokens", value)}
        />
        {values.image === true && (
          <NumberCell
            label={t("ai.detail.imageMax")}
            value={values.imageMaxBytes === undefined ? undefined : values.imageMaxBytes / MB}
            decimals
            disabled={held}
            testId="ai-model-image-max"
            onCommit={(value) =>
              ai.setModelOwn(
                service.id,
                row.id,
                "imageMaxBytes",
                value === undefined ? undefined : Math.round(value * MB),
              )
            }
          />
        )}
        {/* Anew as the prices saved change, such as in another window. */}
        <PriceCells
          key={JSON.stringify(values.cost ?? null)}
          service={service}
          row={row}
          mark={markFor("cost")}
        />
      </div>
      <Advanced service={service} row={row} />
    </>
  );
}

function TitleRow({
  service,
  row,
}: {
  readonly service: ServiceConfig;
  readonly row: ServiceModel;
}) {
  const { ai, settingsNav } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const held = snapshot.held !== undefined;
  const isDefault = snapshot.default?.service === service.id && snapshot.default.model === row.id;
  const where = testKey(service.id, row.id);
  const test = snapshot.tests.get(where);
  const picture = snapshot.pictureTests.get(where);
  // The last model on anywhere stays: it cannot be removed, nor turned off.
  const last = row.enabled && service.enabled.length + otherOn(snapshot.services, service) <= 1;
  const relay = { relayed: service.route === "relay", canRelay: ai.canRelay };
  return (
    <div className={styles.detailHead}>
      <span className={styles.kicker}>{t("ai.model")}</span>
      <span className={styles.grow} />
      {picture && picture.state !== "ok" && row.values.image === true ? (
        <>
          <span
            className={styles.pill}
            data-state="failed"
            data-testid="ai-picture-test"
            data-state-of={picture.state}
            title={
              picture.state === "wrong"
                ? t("ai.picture.wrong", { said: picture.said })
                : failureText(t, picture.failure, relay).advice
            }
          >
            {t("ai.picture.failedShort")}
          </span>
          <button
            type="button"
            className={styles.button}
            onClick={() => ai.editModel(service.id, row.id, "image", false)}
          >
            {t("ai.picture.uncheck")}
          </button>
        </>
      ) : (
        <TestPill test={test} {...relay} />
      )}
      <button
        type="button"
        className={styles.button}
        data-testid="ai-model-test-button"
        disabled={held || test?.state === "running"}
        title={t("ai.testCostTitle")}
        onClick={() => void ai.test(service.id, row.id)}
      >
        {t("ai.test")}
      </button>
      <button
        type="button"
        className={styles.button}
        aria-pressed={isDefault}
        data-testid="ai-model-default"
        disabled={held}
        onClick={() => ai.setDefault({ service: service.id, model: row.id })}
      >
        <span className={styles.star} data-on={isDefault ? "" : undefined} aria-hidden>
          {isDefault ? "★" : "☆"}
        </span>{" "}
        {t("ai.detail.default")}
      </button>
      {row.inCatalog ? (
        <input
          type="checkbox"
          role="switch"
          className={styles.switch}
          aria-label={t("ai.enableModel", { model: row.name ?? row.id })}
          title={last ? t("ai.lastModel") : undefined}
          checked={row.enabled}
          disabled={held || last}
          onChange={(event) => ai.setEnabled(service.id, row.id, event.target.checked)}
        />
      ) : (
        <button
          type="button"
          className={`${styles.button} ${styles.dangerButton}`}
          disabled={held || last}
          title={last ? t("ai.lastModel") : undefined}
          onClick={() => {
            if (ai.removeModel(service.id, row.id) !== "last")
              settingsNav.go({ group: "models", depth: 2, service: service.id });
          }}
        >
          {t("ai.detail.remove")}
        </button>
      )}
    </div>
  );
}

/** How many models are on in the other services. */
const otherOn = (services: readonly ServiceConfig[], service: ServiceConfig) =>
  services.reduce((count, each) => count + (each.id === service.id ? 0 : each.enabled.length), 0);

/**
 * Filling the model in from the catalogs (only cells that are empty, or that a catalog filled), and
 * undoing that; on the right where the catalog is, which says on hovering what it filled.
 */
function FillRow({
  service,
  row,
}: {
  readonly service: ServiceConfig;
  readonly row: ServiceModel;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [busy, setBusy] = useState(false);
  const held = snapshot.held !== undefined;
  const filled = row.config?.filled;
  const known = ai.catalogEntryOf(service.id, row.id);
  const fill = async () => {
    setBusy(true);
    await ai.fillModels(service.id, [row.id], true);
    setBusy(false);
  };
  const said = filled
    ? t("ai.fill.done", {
        count: filled.fields.length,
        from: filled.from.map((source) => t(`ai.fill.from.${source}`)).join("、"),
        by:
          filled.by && filled.from.includes("models.dev")
            ? t(`ai.fill.by.${filled.by}`, { name: filled.matched ?? "" })
            : "",
        price: filled.fields.includes("cost")
          ? t("ai.fill.priceOk")
          : filled.priceDoubt
            ? t(`ai.fill.priceDoubt.${filled.priceDoubt}`)
            : "",
      })
    : undefined;
  const modelsDev = known !== undefined || filled?.from.includes("models.dev") === true;
  return (
    <div className={styles.row} data-testid="ai-fill" data-filled={filled ? "" : undefined}>
      <button
        type="button"
        className={styles.button}
        disabled={held || busy}
        onClick={() => void fill()}
      >
        {busy ? t("ai.fill.loading") : t("ai.fill.again")}
      </button>
      {filled && (
        <button
          type="button"
          className={styles.button}
          disabled={held || busy}
          onClick={() => ai.undoFill(service.id, row.id)}
        >
          {t("ai.fill.undo")}
        </button>
      )}
      <span className={styles.grow} />
      {modelsDev ? (
        <a
          className={styles.source}
          href={MODELS_DEV}
          target="_blank"
          rel="noreferrer"
          title={said}
          data-testid="ai-fill-source"
        >
          models.dev <ExternalLink size={11} aria-hidden />
        </a>
      ) : (
        (row.inCatalog || filled) && (
          <span className={styles.source} title={said} data-testid="ai-fill-source">
            {t("ai.fill.from.pi")}
          </span>
        )
      )}
    </div>
  );
}

/** The id of the model, which renaming carries over to everything that names it. */
function IdField({
  service,
  row,
}: {
  readonly service: ServiceConfig;
  readonly row: ServiceModel;
}) {
  const { ai, settingsNav } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [text, setText, reset] = useDraft(row.id);
  const [problem, setProblem] = useState<string | undefined>();
  // pi's own models are known by their id: another id is another model, added by hand.
  const fixed = row.inCatalog;
  const commit = () => {
    const id = text.trim();
    if (id === row.id) return setProblem(undefined);
    if (id === "" || id.length > 200) return setProblem(t("ai.invalid.id"));
    if (ai.renameModel(service.id, row.id, id) === "taken")
      return setProblem(t("ai.invalid.idTaken"));
    setProblem(undefined);
    settingsNav.go({ group: "models", depth: 3, service: service.id, model: id });
  };
  return (
    <label className={styles.field}>
      <span>{t("ai.detail.id")}</span>
      <input
        className={`${styles.input} ${styles.mono}`}
        value={text}
        spellCheck={false}
        readOnly={fixed}
        disabled={snapshot.held !== undefined}
        aria-invalid={problem !== undefined}
        title={problem}
        data-testid="ai-model-id"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape" && text !== row.id) {
            event.preventDefault();
            reset();
            setProblem(undefined);
          }
        }}
      />
    </label>
  );
}

/** A cell of text, taken as it loses the focus or on Enter. `onCommit` says why it is not taken. */
function TextCell(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly mark: CellMark;
  readonly disabled: boolean;
  readonly testId: string;
  readonly onCommit: (text: string) => "long" | undefined;
}) {
  const { t } = useTranslation();
  const [text, setText] = useDraft(props.value);
  const [problem, setProblem] = useState<"long" | undefined>();
  const commit = () => {
    if (text === props.value) return setProblem(undefined);
    setProblem(props.onCommit(text));
  };
  return (
    <label className={styles.field}>
      <span>{props.label}</span>
      <Marked {...props.mark}>
        <input
          className={styles.input}
          value={text}
          placeholder={props.placeholder}
          spellCheck={false}
          disabled={props.disabled}
          aria-invalid={problem !== undefined}
          title={problem && t(`ai.invalid.${problem}`)}
          data-testid={props.testId}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === "Enter" && commit()}
        />
      </Marked>
    </label>
  );
}

/** A number of tokens, or of megabytes with `decimals`: a positive one, or empty for none. */
function NumberCell(props: {
  readonly label: string;
  readonly value: number | undefined;
  readonly mark?: CellMark;
  readonly decimals?: boolean;
  readonly disabled: boolean;
  readonly testId: string;
  readonly onCommit: (value: number | undefined) => void;
}) {
  const { t } = useTranslation();
  const saved = props.value === undefined ? "" : String(props.value);
  const [text, setText] = useDraft(saved);
  const [problem, setProblem] = useState(false);
  const commit = () => {
    const trimmed = text.trim().replaceAll(",", "");
    if (trimmed === saved) return setProblem(false);
    if (trimmed === "") {
      setProblem(false);
      return props.onCommit(undefined);
    }
    const value = Number(trimmed);
    const ok = props.decimals
      ? Number.isFinite(value) && value > 0 && value <= 1024
      : Number.isSafeInteger(value) && value > 0;
    setProblem(!ok);
    if (ok) props.onCommit(value);
  };
  return (
    <label className={styles.field}>
      <span>{props.label}</span>
      <Marked mark={undefined} testId={props.testId} {...props.mark}>
        <input
          className={`${styles.input} ${styles.mono}`}
          inputMode={props.decimals ? "decimal" : "numeric"}
          value={text}
          placeholder={props.decimals ? undefined : t("ai.unknown")}
          disabled={props.disabled}
          aria-invalid={problem}
          title={
            problem ? t(props.decimals ? "ai.invalid.megabytes" : "ai.invalid.integer") : undefined
          }
          data-testid={props.testId}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === "Enter" && commit()}
        />
      </Marked>
    </label>
  );
}

const PRICES = ["input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * The four prices in a row, as pi-web shows them: read only, until "改价格" makes them cells. They
 * go together: all of them, or none; a gap counts as 0.
 */
function PriceCells(props: {
  readonly service: ServiceConfig;
  readonly row: ServiceModel;
  readonly mark: CellMark;
}) {
  const { service, row } = props;
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const cost = row.values.cost;
  const saved = PRICES.map((name) => (cost ? String(cost[name]) : ""));
  const [texts, setTexts] = useState(saved);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState(false);
  const key = saved.join(" ");
  const commit = (all: readonly string[]) => {
    const trimmed = all.map((each) => each.trim());
    if (trimmed.join(" ") === key) return setProblem(false);
    if (trimmed.every((each) => each === "")) {
      setProblem(false);
      return ai.editModel(service.id, row.id, "cost", undefined);
    }
    const numbers = trimmed.map((each) => (each === "" ? 0 : Number(each)));
    if (numbers.some((each) => !Number.isFinite(each) || each < 0 || each >= 1e6))
      return setProblem(true);
    setProblem(false);
    const [input = 0, output = 0, cacheRead = 0, cacheWrite = 0] = numbers;
    const next: ModelCost = { input, output, cacheRead, cacheWrite };
    ai.editModel(service.id, row.id, "cost", next);
  };
  return (
    <div className={styles.field} data-testid="ai-model-prices">
      <span className={styles.row}>
        <span className={styles.grow}>{t("ai.detail.price")}</span>
        <button
          type="button"
          className={styles.link}
          disabled={snapshot.held !== undefined}
          data-testid="ai-edit-prices"
          onClick={() => {
            if (editing) commit(texts);
            setEditing(!editing);
          }}
        >
          {editing ? t("ai.detail.pricesDone") : t("ai.detail.editPrices")}
        </button>
      </span>
      <Marked {...props.mark}>
        <span className={styles.prices}>
          {PRICES.map((name, index) => (
            <label key={name} className={styles.field}>
              <span className={styles.muted}>{t(`ai.detail.prices.${name}`)}</span>
              {editing ? (
                <input
                  className={`${styles.input} ${styles.mono}`}
                  inputMode="decimal"
                  value={texts[index] ?? ""}
                  placeholder={t("ai.unknown")}
                  aria-invalid={problem}
                  title={problem ? t("ai.invalid.price") : undefined}
                  data-testid={`ai-model-price-${name}`}
                  onChange={(event) =>
                    setTexts(texts.map((each, at) => (at === index ? event.target.value : each)))
                  }
                  onBlur={() => commit(texts)}
                  onKeyDown={(event) => event.key === "Enter" && commit(texts)}
                />
              ) : (
                <span className={styles.mono} data-testid={`ai-model-price-${name}`}>
                  {cost ? `$${priceLabel(cost[name])}` : t("ai.unknown")}
                </span>
              )}
            </label>
          ))}
        </span>
      </Marked>
    </div>
  );
}

/** How hard the model reasons in new conversations, of the steps it takes. */
function DefaultReasoning({ row }: { readonly row: ServiceModel }) {
  const { ai, chat } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const chosen = snapshot.reasoningFor?.[row.id];
  const byPack = usePack(chat.choiceFor(row.id).pack, row.id).call.reasoning;
  return (
    <label className={styles.check} data-setting="models.reasoning">
      <span>{t("ai.modelReasoning")}</span>
      <select
        className={styles.input}
        data-testid="ai-model-reasoning"
        value={chosen ?? ""}
        disabled={snapshot.held !== undefined}
        onChange={(event) =>
          ai.setReasoning(
            row.id,
            event.target.value === "" ? undefined : (event.target.value as ReasoningLevel),
          )
        }
      >
        <option value="">
          {byPack
            ? t("ai.reasoningAuto", { level: t(`ai.packs.value.reasoning.${byPack}`) })
            : t("ai.reasoningAutoNone")}
        </option>
        {row.levels.map((level) => (
          <option key={level} value={level}>
            {t(`ai.packs.value.reasoning.${level}`)}
          </option>
        ))}
        {/* One chosen before that is no longer taken still shows, to be changed. */}
        {chosen !== undefined && !row.levels.includes(chosen) && (
          <option value={chosen}>{t(`ai.packs.value.reasoning.${chosen}`)}</option>
        )}
      </select>
    </label>
  );
}

/**
 * The steps of reasoning, one row each, from "off" to "max", as pi-web's thinking level map: what
 * is sent for it (as pi does by default unless people give a value), and whether the model takes
 * it (the box at the end). Only the steps ticked show in the chat.
 */
function LevelMap({
  service,
  row,
}: {
  readonly service: ServiceConfig;
  readonly row: ServiceModel;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const current = row.values.thinkingLevelMap ?? {};
  const held = snapshot.held !== undefined;
  const set = (level: ReasoningLevel, supported: boolean, text: string) =>
    ai.editModel(service.id, row.id, `thinking.${level}`, levelEntry(level, supported, text));
  return (
    <div className={styles.field}>
      <span className={styles.row}>
        <span className={styles.grow}>{t("ai.map.title")}</span>
        <span className={styles.muted}>{t("ai.map.supported")}</span>
      </span>
      <div className={styles.levels} role="table" data-testid="ai-level-map">
        {REASONING.map((level) => {
          const field = `thinking.${level}` as const;
          return (
            <LevelRow
              key={level}
              level={level}
              supported={levelSupported(current, level)}
              text={levelText(current, level)}
              mark={markOf(row.config, field, row.live)}
              disabled={held}
              onRevert={
                row.config?.edited?.includes(field)
                  ? () => void ai.revertField(service.id, row.id, field)
                  : undefined
              }
              onChange={(nextSupported, text) => set(level, nextSupported, text)}
            />
          );
        })}
      </div>
    </div>
  );
}

function LevelRow(props: {
  readonly level: ReasoningLevel;
  readonly supported: boolean;
  readonly text: string;
  readonly mark: FieldMark;
  readonly disabled: boolean;
  readonly onRevert: (() => void) | undefined;
  readonly onChange: (supported: boolean, text: string) => void;
}) {
  const { t } = useTranslation();
  const { level, supported } = props;
  const [text, setText] = useDraft(props.text);
  // What people gave this step, kept while it is not ticked, to come back as it is ticked again.
  const [kept, setKept] = useState(props.text);
  if (props.text !== "" && props.text !== kept) setKept(props.text);
  const shown = supported ? text : kept;
  const invalid = text.trim() !== "" && !/^[\x21-\x7e]{1,10}$/.test(text.trim());
  const commit = () => {
    if (text.trim() === props.text || invalid) return;
    setKept(text.trim());
    props.onChange(supported, text);
  };
  const name = t(`ai.packs.value.reasoning.${level}`);
  return (
    <div
      className={styles.levelRow}
      role="row"
      data-level={level}
      data-mark={props.mark}
      data-supported={supported ? "" : undefined}
    >
      <span role="cell" className={styles.levelName}>
        <span className={styles.levelDot} data-dot={level} aria-hidden />
        {name}
      </span>
      <span role="cell">
        <Marked mark={props.mark} onRevert={props.onRevert} testId={`ai-mark-thinking.${level}`}>
          <input
            className={`${styles.input} ${styles.mono}`}
            value={shown}
            maxLength={THINKING_VALUE_LENGTH}
            placeholder={supported ? level : ""}
            spellCheck={false}
            disabled={props.disabled || !supported}
            aria-label={t("ai.map.valueOf", { level: name })}
            aria-invalid={invalid}
            title={invalid ? t("ai.map.invalid") : undefined}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => event.key === "Enter" && commit()}
          />
        </Marked>
      </span>
      <span role="cell">
        <input
          type="checkbox"
          aria-label={t("ai.map.supportedOf", { level: name })}
          checked={supported}
          disabled={props.disabled}
          onChange={(event) =>
            props.onChange(event.target.checked, event.target.checked ? kept : "")
          }
        />
      </span>
    </div>
  );
}

/**
 * What the model has on its own, apart from its service: its address, how it is talked to, its
 * headers, switches of the protocol, and the steps of reasoning. The same look as the rest, only
 * folded, as pi-web's "Advanced settings".
 */
function Advanced({
  service,
  row,
}: {
  readonly service: ServiceConfig;
  readonly row: ServiceModel;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const held = snapshot.held !== undefined;
  const config: ModelConfig | undefined = row.config;
  const serviceApi = protocolOf(service) ?? "openai-completions";
  const api = config?.api ?? serviceApi;
  const compat = config?.compat ?? {};
  const known = snapshot.known.get(service.kind)?.find((model) => model.id === row.id);
  const changed = [
    config?.baseUrl,
    config?.api,
    config?.headers && Object.keys(config.headers).length > 0 ? config.headers : undefined,
    ...Object.values(compat),
  ].filter((each) => each !== undefined).length;
  const [url, setUrl] = useDraft(config?.baseUrl ?? "");
  const urlInvalid = url.trim() !== "" && checkBaseUrl(url) === undefined;
  const fold = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const setCompat = (next: Readonly<Record<string, unknown>>) =>
    ai.setModelOwn(
      service.id,
      row.id,
      "compat",
      Object.fromEntries(
        Object.entries(next).filter(([, value]) => value !== undefined),
      ) as ModelCompat,
    );
  const saveUrl = () => {
    const text = url.trim();
    if (text === (config?.baseUrl ?? "")) return;
    if (text === "") return ai.setModelOwn(service.id, row.id, "baseUrl", undefined);
    const checked = checkBaseUrl(text);
    if (checked !== undefined) ai.setModelOwn(service.id, row.id, "baseUrl", checked);
  };
  const openAi = api === "openai-completions" || api === "openai-responses";
  // What pi has for the model, under what people set.
  const said = known?.compat?.supportsDeveloperRole;
  const piDeveloper = typeof said === "boolean" ? said : undefined;
  const developer = compat.supportsDeveloperRole ?? piDeveloper ?? true;
  const anyCompat = api === "anthropic-messages" || openAi;
  return (
    <details
      ref={fold}
      className={styles.plainFold}
      data-testid="ai-model-advanced"
      onToggle={() => setOpen(fold.current?.open === true)}
    >
      <summary>
        <span className={styles.foldTitle}>
          <span>{t("ai.advanced")}</span>
          <span className={styles.muted}>
            {changed > 0
              ? t("ai.detail.advancedSome", { count: changed })
              : t("ai.detail.advancedNone")}
          </span>
        </span>
        <ChevronDown size={14} className={styles.foldIcon} data-open={open ? "" : undefined} />
      </summary>
      <div className={styles.column}>
        <label className={styles.field}>
          <span>{t("ai.baseUrl")}</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            value={url}
            placeholder={service.baseUrl}
            spellCheck={false}
            disabled={held}
            aria-invalid={urlInvalid}
            title={urlInvalid ? t("ai.baseUrlInvalid") : undefined}
            data-testid="ai-model-base-url"
            onChange={(event) => setUrl(event.target.value)}
            onBlur={saveUrl}
            onKeyDown={(event) => event.key === "Enter" && saveUrl()}
          />
        </label>
        <label className={styles.field}>
          <span>{t("ai.api")}</span>
          <select
            className={styles.input}
            value={config?.api ?? ""}
            disabled={held}
            data-testid="ai-model-api"
            onChange={(event) =>
              ai.setModelOwn(
                service.id,
                row.id,
                "api",
                event.target.value === "" ? undefined : (event.target.value as ModelApi),
              )
            }
          >
            <option value="">{t("ai.detail.useService")}</option>
            {MODEL_APIS.map((each) => (
              <option key={each} value={each}>
                {t(`ai.apiNames.${each}`)}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.field}>
          <span>{t("ai.headers.title")}</span>
          <HeadersEditor
            headers={config?.headers}
            disabled={held}
            testId="ai-model-headers"
            onChange={(next) => ai.setModelOwn(service.id, row.id, "headers", next)}
          />
        </div>
        {anyCompat && (
          <div className={styles.field}>
            <span>{t("ai.detail.compat")}</span>
            <div className={styles.row} style={{ gap: 18 }}>
              {api === "anthropic-messages" && (
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={compat.forceAdaptiveThinking === true}
                    disabled={held}
                    onChange={(event) =>
                      setCompat({
                        ...compat,
                        forceAdaptiveThinking: event.target.checked || undefined,
                      })
                    }
                  />
                  {t("ai.compat.adaptive")}
                </label>
              )}
              {openAi && row.values.reasoning === true && (
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={compat.thinkingFormat === "deepseek"}
                    disabled={held}
                    onChange={(event) =>
                      setCompat(
                        event.target.checked
                          ? {
                              ...compat,
                              thinkingFormat: "deepseek",
                              requiresReasoningContentOnAssistantMessages: true,
                            }
                          : {
                              ...compat,
                              thinkingFormat: undefined,
                              requiresReasoningContentOnAssistantMessages: undefined,
                            },
                      )
                    }
                  />
                  {t("ai.compat.deepseek")}
                </label>
              )}
              {openAi && (
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={developer}
                    disabled={held}
                    onChange={(event) =>
                      setCompat({
                        ...compat,
                        supportsDeveloperRole:
                          event.target.checked === (piDeveloper ?? true)
                            ? undefined
                            : event.target.checked,
                      })
                    }
                  />
                  {t("ai.compat.developer")}
                </label>
              )}
            </div>
          </div>
        )}
        {row.values.reasoning === true && <LevelMap service={service} row={row} />}
      </div>
    </details>
  );
}
