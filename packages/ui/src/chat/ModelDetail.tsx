import {
  MODEL_APIS,
  THINKING_VALUE_LENGTH,
  checkBaseUrl,
  levelEntry,
  levelSupported,
  levelText,
  markOf,
  type ModelApi,
  type ModelCompat,
  type ModelConfig,
  type ModelCost,
  type ModelField,
  type ReasoningLevel,
  type ServiceConfig,
} from "@animaquill/agent";
import { REASONING, usePack } from "@animaquill/tools";
import { ChevronLeft } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { TestPill, useDraft } from "./aiParts.tsx";
import styles from "./AiSettings.module.css";
import { CapabilityIcon } from "./CapabilityIcon.tsx";
import { failureText } from "./failure.ts";
import { HeadersEditor, Mark } from "./modelParts.tsx";
import { protocolOf, testKey, type ServiceModel } from "./settings.ts";

/** Bytes in a megabyte, as the largest picture is shown. */
const MB = 1024 * 1024;

/**
 * One model of a service, one level in from its list (docs/design/settings-and-properties.md of
 * AnimaQuill Cloud, 6.2): its id and name, what it can do and how hard it reasons by default, how
 * much it reads and writes, its prices, how each step of reasoning is sent, and on its own where
 * it is and how it is talked to. Each cell says whether a catalog filled it in or people set it;
 * what people set a catalog leaves alone. Every change takes at once; a cell that is not right is
 * marked and not taken.
 */
export function ModelDetail(props: { readonly service: ServiceConfig; readonly model: string }) {
  const { service } = props;
  const { ai, settingsNav } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const row = ai.modelOf(service.id, props.model);
  // The open catalog, to say what it knows of this model.
  useEffect(() => {
    void ai.loadCatalog();
  }, [ai]);
  const back = () => settingsNav.go({ group: "models", depth: 2, service: service.id });

  return (
    <div className={styles.wall} data-testid="ai-model-detail" data-model={props.model}>
      <button type="button" className={styles.crumbBack} onClick={back}>
        <ChevronLeft size={14} aria-hidden /> {service.name}
      </button>
      {row ? (
        <Details service={service} row={row} />
      ) : (
        <p className={styles.help}>{t("ai.detail.gone")}</p>
      )}
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
  const mark = (field: ModelField) => markOf(config, field, live);
  const edit = (field: ModelField, value: unknown) =>
    ai.editModel(service.id, row.id, field, value);
  const revert = (field: ModelField) => () => void ai.revertField(service.id, row.id, field);
  const markFor = (field: ModelField) => (
    <Mark
      mark={mark(field)}
      onRevert={config?.edited?.includes(field) ? revert(field) : undefined}
      testId={`ai-mark-${field}`}
    />
  );

  return (
    <>
      <TitleRow service={service} row={row} />
      <FillBanner service={service} row={row} />

      <div className={styles.fields}>
        <IdField service={service} row={row} />
        <TextCell
          label={t("ai.detail.name")}
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
      </div>

      <h4 className={styles.fieldTitle}>{t("ai.detail.capabilities")}</h4>
      <div className={styles.row} style={{ gap: 18 }}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={values.reasoning === true}
            disabled={held}
            onChange={(event) => edit("reasoning", event.target.checked)}
          />
          <CapabilityIcon capability="thinking" />
          {t("ai.detail.reasoning")}
          {markFor("reasoning")}
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={values.image === true}
            disabled={held}
            onChange={(event) => edit("image", event.target.checked)}
          />
          <CapabilityIcon capability="image" />
          {t("ai.detail.image")}
          {markFor("image")}
        </label>
        <DefaultReasoning row={row} />
      </div>

      <div className={styles.fields3}>
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
            help={t("ai.detail.imageMaxHelp")}
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
      </div>

      {/* Anew as the prices saved change, such as in another window. */}
      <PriceCells
        key={JSON.stringify(values.cost ?? null)}
        service={service}
        row={row}
        mark={markFor("cost")}
      />

      {values.reasoning === true && <LevelMap service={service} row={row} />}

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
  const [refused, setRefused] = useState(false);
  const isDefault = snapshot.default?.service === service.id && snapshot.default.model === row.id;
  const where = testKey(service.id, row.id);
  const test = snapshot.tests.get(where);
  const picture = snapshot.pictureTests.get(where);
  const name = row.name ?? row.id;
  return (
    <>
      <div className={styles.row}>
        <span className={styles.title}>{name}</span>
        <button
          type="button"
          className={styles.starButton}
          aria-pressed={isDefault}
          aria-label={isDefault ? t("ai.isDefault") : t("ai.setDefault")}
          title={isDefault ? t("ai.isDefault") : t("ai.setDefault")}
          disabled={held}
          onClick={() => ai.setDefault({ service: service.id, model: row.id })}
        >
          {isDefault ? "★" : "☆"}
        </button>
        <label className={styles.check}>
          <input
            type="checkbox"
            role="switch"
            className={styles.switch}
            checked={row.enabled}
            disabled={held}
            onChange={(event) =>
              setRefused(ai.setEnabled(service.id, row.id, event.target.checked) === "last")
            }
          />
          <span className={styles.muted}>{t("ai.detail.enabled")}</span>
        </label>
        <span className={styles.grow} />
        <button
          type="button"
          className={styles.button}
          data-testid="ai-model-test-button"
          disabled={held || test?.state === "running"}
          title={t("ai.testCostTitle")}
          onClick={() => void ai.test(service.id, row.id)}
        >
          {t("ai.detail.test")}
        </button>
        <TestPill test={test} relayed={service.route === "relay"} canRelay={ai.canRelay} short />
        <button
          type="button"
          className={`${styles.button} ${styles.danger}`}
          disabled={held}
          onClick={() => {
            if (row.inCatalog) setRefused(ai.setEnabled(service.id, row.id, false) === "last");
            else if (ai.removeModel(service.id, row.id) === "last") setRefused(true);
            else settingsNav.go({ group: "models", depth: 2, service: service.id });
          }}
        >
          {row.inCatalog ? t("ai.detail.disable") : t("ai.detail.remove")}
        </button>
      </div>
      {test?.state === "failed" && (
        <details className={styles.failure} data-testid="ai-model-test-failure">
          <summary>
            {
              failureText(t, test.failure, {
                relayed: service.route === "relay",
                canRelay: ai.canRelay,
              }).advice
            }
          </summary>
          {
            failureText(t, test.failure, {
              relayed: service.route === "relay",
              canRelay: ai.canRelay,
            }).detail
          }
          {Object.keys(service.headers ?? {}).length +
            Object.keys(row.config?.headers ?? {}).length >
            0 &&
            service.route === "direct" &&
            ai.canRelay && <p className={styles.help}>{t("ai.headers.relayHint")}</p>}
        </details>
      )}
      {picture && (
        <p
          className={picture.state === "ok" ? styles.help : styles.warning}
          data-testid="ai-picture-test"
          data-state={picture.state}
        >
          {picture.state === "ok"
            ? t("ai.picture.ok")
            : picture.state === "wrong"
              ? t("ai.picture.wrong", { said: picture.said })
              : t("ai.picture.failed", {
                  advice: failureText(t, picture.failure, {
                    relayed: service.route === "relay",
                    canRelay: ai.canRelay,
                  }).advice,
                })}{" "}
          {picture.state !== "ok" && (
            <button
              type="button"
              className={styles.link}
              onClick={() => ai.editModel(service.id, row.id, "image", false)}
            >
              {t("ai.picture.uncheck")}
            </button>
          )}
        </p>
      )}
      {refused && (
        <p className={styles.warning} role="status">
          {t("ai.lastModel")}
        </p>
      )}
    </>
  );
}

/** What the catalogs filled in of the model, from where, and the ways to fill again or undo it. */
function FillBanner({
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
  const catalog = snapshot.catalog;
  const fill = async () => {
    setBusy(true);
    await ai.fillModels(service.id, [row.id], true);
    setBusy(false);
  };

  let text: ReactNode;
  let state: "ok" | "none" | "live";
  const unknown = !row.inCatalog && catalog.state === "ok" && !known;
  if (unknown && !filled?.from.some((source) => source !== "service")) {
    state = "none";
    text = `${t("ai.fill.none")}${filled ? ` ${t("ai.fill.serviceOnly", { count: filled.fields.length })}` : ""}`;
  } else if (filled) {
    state = "ok";
    const from = filled.from.map((source) => t(`ai.fill.from.${source}`)).join("、");
    const by =
      filled.by && filled.from.includes("models.dev")
        ? t(`ai.fill.by.${filled.by}`, { name: filled.matched ?? "" })
        : "";
    const price = filled.fields.includes("cost")
      ? t("ai.fill.priceOk")
      : filled.priceDoubt
        ? t(`ai.fill.priceDoubt.${filled.priceDoubt}`)
        : "";
    text = t("ai.fill.done", { count: filled.fields.length, from, by, price });
  } else if (row.inCatalog) {
    state = "live";
    text = t("ai.fill.live");
  } else if (catalog.state === "ok" && !known) {
    state = "none";
    text = t("ai.fill.none");
  } else if (catalog.state === "loading") {
    state = "live";
    text = t("ai.fill.loading");
  } else {
    state = "none";
    text = catalog.state === "failed" ? t("ai.fill.noCatalog") : t("ai.fill.nothing");
  }
  return (
    <div className={styles.fillBanner} data-testid="ai-fill" data-state={state}>
      <span className={styles.fillDot} data-state={state} aria-hidden />
      <span className={styles.grow}>{busy ? t("ai.fill.loading") : text}</span>
      <button
        type="button"
        className={`${styles.button} ${styles.small}`}
        disabled={held || busy}
        title={t("ai.fill.againTitle")}
        onClick={() => void fill()}
      >
        {t("ai.fill.again")}
      </button>
      {filled && (
        <button
          type="button"
          className={`${styles.button} ${styles.small}`}
          disabled={held || busy}
          onClick={() => ai.undoFill(service.id, row.id)}
        >
          {t("ai.fill.undo")}
        </button>
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
        title={fixed ? t("ai.detail.idFixed") : undefined}
        aria-invalid={problem !== undefined}
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
      {problem && <span className={styles.warning}>{problem}</span>}
    </label>
  );
}

/** A cell of text, taken as it loses the focus or on Enter. `onCommit` says why it is not taken. */
function TextCell(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly mark?: ReactNode;
  readonly disabled: boolean;
  readonly testId?: string;
  readonly mono?: boolean;
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
    <label className={styles.field} data-mark-of={props.testId}>
      <span>
        {props.label} {props.mark}
      </span>
      <input
        className={`${styles.input} ${props.mono ? styles.mono : ""}`}
        value={text}
        placeholder={props.placeholder}
        spellCheck={false}
        disabled={props.disabled}
        aria-invalid={problem !== undefined}
        data-testid={props.testId}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === "Enter" && commit()}
      />
      {problem && <span className={styles.warning}>{t(`ai.invalid.${problem}`)}</span>}
    </label>
  );
}

/** A number of tokens, or of megabytes with `decimals`: a positive one, or empty for none. */
function NumberCell(props: {
  readonly label: string;
  readonly value: number | undefined;
  readonly mark?: ReactNode;
  readonly decimals?: boolean;
  readonly help?: string;
  readonly disabled: boolean;
  readonly testId?: string;
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
      <span>
        {props.label} {props.mark}
      </span>
      <input
        className={`${styles.input} ${styles.mono}`}
        inputMode={props.decimals ? "decimal" : "numeric"}
        value={text}
        placeholder={props.decimals ? undefined : t("ai.unknown")}
        disabled={props.disabled}
        aria-invalid={problem}
        data-testid={props.testId}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === "Enter" && commit()}
      />
      {problem && (
        <span className={styles.warning}>
          {t(props.decimals ? "ai.invalid.megabytes" : "ai.invalid.integer")}
        </span>
      )}
      {props.help && !problem && <span className={styles.help}>{props.help}</span>}
    </label>
  );
}

const PRICES = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** The four prices, which go together: all of them, or none; a gap counts as 0. */
function PriceCells(props: {
  readonly service: ServiceConfig;
  readonly row: ServiceModel;
  readonly mark: ReactNode;
}) {
  const { service, row } = props;
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const cost = row.values.cost;
  const saved = PRICES.map((name) => (cost ? String(cost[name]) : ""));
  const [texts, setTexts] = useState(saved);
  const [problem, setProblem] = useState(false);
  const [partial, setPartial] = useState(false);
  const key = saved.join(" ");
  const commit = (all: readonly string[]) => {
    const trimmed = all.map((each) => each.trim());
    if (trimmed.join(" ") === key) return setProblem(false);
    if (trimmed.every((each) => each === "")) {
      setProblem(false);
      setPartial(false);
      return ai.editModel(service.id, row.id, "cost", undefined);
    }
    const numbers = trimmed.map((each) => (each === "" ? 0 : Number(each)));
    if (numbers.some((each) => !Number.isFinite(each) || each < 0 || each >= 1e6))
      return setProblem(true);
    setProblem(false);
    setPartial(trimmed.some((each) => each === ""));
    const [input = 0, output = 0, cacheRead = 0, cacheWrite = 0] = numbers;
    const next: ModelCost = { input, output, cacheRead, cacheWrite };
    ai.editModel(service.id, row.id, "cost", next);
  };
  return (
    <div>
      <h4 className={styles.fieldTitle}>
        {t("ai.detail.price")} {props.mark}
      </h4>
      <div className={styles.fields4}>
        {PRICES.map((name, index) => (
          <label key={name} className={styles.field}>
            <span>{t(`ai.detail.prices.${name}`)}</span>
            <input
              className={`${styles.input} ${styles.mono}`}
              inputMode="decimal"
              value={texts[index] ?? ""}
              placeholder={t("ai.unknown")}
              disabled={snapshot.held !== undefined}
              aria-invalid={problem}
              data-testid={`ai-model-price-${name}`}
              onChange={(event) =>
                setTexts(texts.map((each, at) => (at === index ? event.target.value : each)))
              }
              onBlur={() => commit(texts)}
              onKeyDown={(event) => event.key === "Enter" && commit(texts)}
            />
          </label>
        ))}
      </div>
      {problem && <p className={styles.warning}>{t("ai.invalid.price")}</p>}
      {!problem && partial && <p className={styles.help}>{t("ai.detail.pricePartial")}</p>}
      {!cost && !problem && <p className={styles.help}>{t("ai.detail.priceNone")}</p>}
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
      <span className={styles.muted}>{t("ai.modelReasoning")}</span>
      <select
        className={styles.input}
        aria-label={t("ai.modelReasoning")}
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
 * The steps of reasoning, one row each, from "off" to "max": whether the model takes it (the box
 * at the end), and what is sent for it, as pi does by default unless people give a value. Only the
 * steps ticked show in the chat.
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
  const map = row.values.thinkingLevelMap;
  const held = snapshot.held !== undefined;
  const current = map ?? {};
  const set = (level: ReasoningLevel, supported: boolean, text: string) =>
    ai.editModel(service.id, row.id, `thinking.${level}`, levelEntry(level, supported, text));
  return (
    <div>
      <h4 className={styles.fieldTitle}>
        {t("ai.map.title")} <span className={styles.muted}>· {t("ai.map.help")}</span>
      </h4>
      <div className={styles.levels} role="table" data-testid="ai-level-map">
        <div className={styles.levelHead} role="row">
          <span role="columnheader">{t("ai.map.level")}</span>
          <span role="columnheader">{t("ai.map.value")}</span>
          <span role="columnheader" />
          <span role="columnheader">{t("ai.map.supported")}</span>
        </div>
        {REASONING.map((level) => {
          const field = `thinking.${level}` as const;
          const supported = levelSupported(current, level);
          const mark = markOf(row.config, field, row.live);
          return (
            <LevelRow
              key={level}
              level={level}
              supported={supported}
              text={levelText(current, level)}
              mark={mark}
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
  readonly mark: ReturnType<typeof markOf>;
  readonly disabled: boolean;
  readonly onRevert: (() => void) | undefined;
  readonly onChange: (supported: boolean, text: string) => void;
}) {
  const { t } = useTranslation();
  const { level, supported } = props;
  const [text, setText] = useDraft(props.text);
  const invalid = text.trim() !== "" && !/^[\x21-\x7e]{1,10}$/.test(text.trim());
  const commit = () => {
    if (text.trim() === props.text || invalid) return;
    props.onChange(supported, text);
  };
  return (
    <div
      className={styles.levelRow}
      role="row"
      data-level={level}
      data-mark={props.mark}
      data-supported={supported ? "" : undefined}
    >
      <span role="cell">{t(`ai.packs.value.reasoning.${level}`)}</span>
      <span role="cell">
        <input
          className={`${styles.input} ${styles.mono}`}
          value={text}
          maxLength={THINKING_VALUE_LENGTH}
          placeholder={supported ? t("ai.map.default", { value: level }) : "—"}
          spellCheck={false}
          disabled={props.disabled || !supported}
          aria-label={t("ai.map.valueOf", { level: t(`ai.packs.value.reasoning.${level}`) })}
          aria-invalid={invalid}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === "Enter" && commit()}
        />
      </span>
      <span role="cell">
        <Mark mark={props.mark} onRevert={props.onRevert} />
      </span>
      <span role="cell">
        <input
          type="checkbox"
          aria-label={t("ai.map.supportedOf", { level: t(`ai.packs.value.reasoning.${level}`) })}
          checked={supported}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.checked, supported ? text : "")}
        />
      </span>
    </div>
  );
}

/**
 * What the model has on its own, apart from its service: its address, how it is talked to, its
 * headers, and switches of the protocol. The same look as the rest, only folded.
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
  return (
    <details className={styles.plainFold} data-testid="ai-model-advanced">
      <summary>
        {t("ai.advanced")}{" "}
        <span className={styles.muted}>
          ·{" "}
          {changed > 0
            ? t("ai.detail.advancedSome", { count: changed })
            : t("ai.detail.advancedNone")}
        </span>
      </summary>
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>{t("ai.detail.baseUrl")}</span>
          <input
            className={`${styles.input} ${styles.mono}`}
            value={url}
            placeholder={t("ai.detail.useService", { value: service.baseUrl })}
            spellCheck={false}
            disabled={held}
            aria-invalid={urlInvalid}
            data-testid="ai-model-base-url"
            onChange={(event) => setUrl(event.target.value)}
            onBlur={saveUrl}
            onKeyDown={(event) => event.key === "Enter" && saveUrl()}
          />
          {urlInvalid && <span className={styles.warning}>{t("ai.baseUrlInvalid")}</span>}
        </label>
        <label className={styles.field}>
          <span>{t("ai.detail.api")}</span>
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
            <option value="">
              {t("ai.detail.useService", { value: t(`ai.apiNames.${serviceApi}`) })}
            </option>
            {MODEL_APIS.map((each) => (
              <option key={each} value={each}>
                {t(`ai.apiNames.${each}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <h4 className={styles.fieldTitle}>{t("ai.detail.headers")}</h4>
      <HeadersEditor
        headers={config?.headers}
        disabled={held}
        testId="ai-model-headers"
        onChange={(next) => ai.setModelOwn(service.id, row.id, "headers", next)}
      />
      <h4 className={styles.fieldTitle}>{t("ai.detail.compat")}</h4>
      <div className={styles.row} style={{ gap: 18 }}>
        {api === "anthropic-messages" && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={compat.forceAdaptiveThinking === true}
              disabled={held}
              onChange={(event) =>
                setCompat({ ...compat, forceAdaptiveThinking: event.target.checked || undefined })
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
            {compat.supportsDeveloperRole === undefined && (
              <span className={styles.muted}>{t("ai.compat.asPi")}</span>
            )}
          </label>
        )}
        {api !== "anthropic-messages" && !openAi && (
          <span className={styles.muted}>{t("ai.compat.none")}</span>
        )}
      </div>
    </details>
  );
}
