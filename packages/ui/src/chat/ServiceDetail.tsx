import { urlHasSecret } from "@animaquill/host";
import {
  bulkActions,
  checkBaseUrl,
  enabledCountOf,
  filterModels,
  isLastEnabled,
  kindOf,
  type ReasoningLevel,
  type ServiceConfig,
} from "@animaquill/agent";
import { REASONING, usePack } from "@animaquill/tools";
import { ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { ServiceAvatar, TestPill, useDraft } from "./aiParts.tsx";
import styles from "./AiSettings.module.css";
import { failureText } from "./failure.ts";
import { contextLabel, priceLabel } from "./modelText.ts";
import { testKey, type ServiceModel } from "./settings.ts";

/** From how many models on the list a filter shows. */
const FILTER_FROM = 8;
/** Models that GPT-6 names, which call no tools through Chat Completions. */
const GPT6 = /gpt-6/i;

/**
 * One service in the settings: its name, its key (written, never read back: only its last
 * characters show), a test of the connection, its models to turn on, the default among them, and
 * where it is and how it is reached, folded away.
 */
export function ServiceDetail({ service }: { readonly service: ServiceConfig }) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const kind = kindOf(service.kind);
  const models = ai.modelsFor(service.id);
  const held = snapshot.held !== undefined;
  const relayed = service.route === "relay";

  const gpt6 = kind?.id === "openai-compatible" && models.some((model) => GPT6.test(model.id));

  return (
    <div className={styles.wall} data-testid="ai-service">
      <Header service={service} />
      <KeySection service={service} known={models.length} />

      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          disabled={held || snapshot.tests.get(service.id)?.state === "running"}
          title={t("ai.testCostTitle")}
          onClick={() => void ai.test(service.id)}
        >
          {t("ai.test")}
        </button>
        <span className={styles.muted}>{t("ai.testCost")}</span>
      </div>
      <TestPill test={snapshot.tests.get(service.id)} relayed={relayed} canRelay={ai.canRelay} />

      {gpt6 && (
        <p className={styles.note} data-testid="ai-gpt6">
          {t("ai.gpt6Completions")}
        </p>
      )}

      <ModelsSection service={service} models={models} />
      <Advanced service={service} />
    </div>
  );
}

function Header({ service }: { readonly service: ServiceConfig }) {
  const { ai, dialogs } = useWorkbench();
  const { t } = useTranslation();
  const kind = kindOf(service.kind);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useDraft(service.name);

  const rename = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== service.name) ai.update(service.id, { name: trimmed });
    setRenaming(false);
  };
  const remove = async () => {
    const sure = await dialogs.confirm({
      title: t("ai.remove"),
      message: t("ai.removeConfirm", { name: service.name }),
      confirm: t("ai.remove"),
      danger: true,
    });
    if (sure) await ai.remove(service.id);
  };

  return (
    <div className={styles.row}>
      <ServiceAvatar kind={service.kind} name={service.name} large />
      {renaming ? (
        <input
          className={styles.input}
          aria-label={t("ai.name")}
          value={name}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onBlur={rename}
          onKeyDown={(event) => {
            if (event.key === "Enter") rename();
            if (event.key === "Escape") setRenaming(false);
          }}
        />
      ) : (
        <>
          <span className={styles.title}>{service.name}</span>
          <button
            type="button"
            className={styles.link}
            title={t("ai.rename")}
            aria-label={t("ai.rename")}
            onClick={() => setRenaming(true)}
          >
            <Pencil size={12} aria-hidden />
          </button>
        </>
      )}
      {kind && kind.name !== service.name && <span className={styles.muted}>{kind.name}</span>}
      <span className={styles.grow} />
      <button
        type="button"
        className={`${styles.link} ${styles.danger}`}
        onClick={() => void remove()}
      >
        {t("ai.remove")}
      </button>
    </div>
  );
}

function KeySection(props: { readonly service: ServiceConfig; readonly known: number }) {
  const { service } = props;
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const kind = kindOf(service.kind);
  const hint = snapshot.hints.get(service.id);
  const keyed = snapshot.keyed.has(service.id);
  const [changing, setChanging] = useState(false);
  // What people type stays in the field: React never renders a key, which would put it in the
  // page as an attribute.
  const field = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(false);

  const save = async () => {
    const key = field.current?.value.trim() ?? "";
    if (!key) return;
    await ai.setKey(service.id, key);
    if (field.current) field.current.value = "";
    setTyped(false);
    setChanging(false);
  };

  return (
    <>
      <h3 className={styles.sectionTitle}>{t("ai.key")}</h3>
      {keyed && !changing ? (
        <div className={styles.row}>
          <span
            className={`${styles.keyMask} ${styles.mono}`}
            data-testid="ai-key-saved"
            title={t("ai.keySaved", { hint })}
          >
            ••••••••••••{hint}
          </span>
          <button type="button" className={styles.button} onClick={() => setChanging(true)}>
            {t("ai.keyChange")}
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => void ai.removeKey(service.id)}
          >
            {t("ai.keyRemove")}
          </button>
        </div>
      ) : (
        <div className={styles.row}>
          <input
            className={`${styles.input} ${styles.grow}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={t("ai.key")}
            placeholder={t("ai.keyPlaceholder")}
            ref={field}
            defaultValue=""
            onChange={(event) => setTyped(event.target.value.trim() !== "")}
            onKeyDown={(event) => event.key === "Enter" && void save()}
          />
          <button
            type="button"
            className={styles.button}
            disabled={!typed}
            onClick={() => void save()}
          >
            {t("ai.keySave")}
          </button>
          {changing && (
            <button type="button" className={styles.button} onClick={() => setChanging(false)}>
              {t("ai.keyCancel")}
            </button>
          )}
        </div>
      )}
      {!keyed && (
        <p className={styles.help}>
          {kind?.custom
            ? t("ai.keyOptional")
            : props.known > 0
              ? t("ai.keyEmpty", { count: props.known })
              : t("ai.keyEmptyNone")}
        </p>
      )}
      <p className={styles.help}>
        {snapshot.keysWhere
          ? t("ai.keysWhere", { where: snapshot.keysWhere })
          : t("ai.keysNowhere")}{" "}
        {kind?.id === "anthropic" ? t("ai.noSubscriptionAnthropic") : ""}
      </p>
    </>
  );
}

function ModelsSection(props: {
  readonly service: ServiceConfig;
  readonly models: readonly ServiceModel[];
}) {
  const { service, models } = props;
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [refused, setRefused] = useState(false);
  const held = snapshot.held !== undefined;
  const listing = snapshot.listings.get(service.id);
  const total = enabledCountOf(snapshot);
  const shown = filterModels(models, query);
  const bulk = bulkActions(total, shown);
  const allOn = shown.length > 0 && bulk.enable.length === 0;
  const kind = kindOf(service.kind);

  const say = (result: "last" | undefined) => setRefused(result === "last");

  return (
    <>
      <div className={styles.row}>
        <h3 className={styles.sectionTitle}>{t("ai.models")}</h3>
        <span className={styles.muted} data-testid="ai-models-count">
          {t("ai.modelsEnabled", { enabled: service.enabled.length, total: models.length })}
        </span>
        <span className={styles.grow} />
        <button
          type="button"
          className={`${styles.button} ${styles.small}`}
          disabled={held || listing?.state === "loading"}
          onClick={() => void ai.fetchModels(service.id)}
        >
          {listing?.state === "loading" ? t("ai.fetchingModels") : t("ai.fetchModels")}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.small}`}
          disabled={held || (allOn ? !bulk.canDisable : !bulk.canEnable)}
          title={allOn && !bulk.canDisable ? t("ai.lastModel") : undefined}
          onClick={() =>
            say(ai.setAllEnabled(service.id, allOn ? bulk.disable : bulk.enable, !allOn))
          }
        >
          {allOn ? t("ai.disableAll") : t("ai.enableAll")}
        </button>
      </div>
      {listing?.state === "ok" && (
        <p className={styles.help} data-testid="ai-models-listed">
          {kind?.catalog
            ? t("ai.fetchedModels", { count: listing.models.length })
            : t("ai.fetchedModelsPlain", { count: listing.models.length })}
        </p>
      )}
      {listing?.state === "failed" && (
        <p className={styles.warning} data-testid="ai-models-failed">
          {
            failureText(t, listing.failure, {
              relayed: service.route === "relay",
              canRelay: ai.canRelay,
            }).advice
          }{" "}
          {
            failureText(t, listing.failure, {
              relayed: service.route === "relay",
              canRelay: ai.canRelay,
            }).detail
          }
        </p>
      )}
      {listing?.state === "held" && (
        <p className={styles.warning} data-testid="ai-models-failed">
          {t(`chat.hold.${listing.hold}`)}
        </p>
      )}
      {refused && (
        <p className={styles.warning} role="status">
          {t("ai.lastModel")}
        </p>
      )}
      {models.length > FILTER_FROM && (
        <input
          className={styles.input}
          type="search"
          aria-label={t("ai.filter")}
          placeholder={t("ai.filter")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {models.length === 0 ? (
        <p className={styles.help}>{t("ai.noModels")}</p>
      ) : shown.length === 0 ? (
        <p className={styles.help}>{t("ai.noMatch")}</p>
      ) : (
        <div className={styles.models} data-testid="ai-models">
          {shown.map((model) => (
            <ModelRow
              key={model.id}
              service={service}
              model={model}
              last={isLastEnabled(total, model)}
              onRefused={say}
            />
          ))}
        </div>
      )}
      {adding ? (
        <AddModel service={service} onDone={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          className={styles.link}
          style={{ alignSelf: "flex-start" }}
          disabled={held}
          onClick={() => setAdding(true)}
        >
          + {t("ai.addModel")}
        </button>
      )}
    </>
  );
}

function ModelRow(props: {
  readonly service: ServiceConfig;
  readonly model: ServiceModel;
  /** It is the last model on, which cannot go off. */
  readonly last: boolean;
  readonly onRefused: (result: "last" | undefined) => void;
}) {
  const { service, model, last } = props;
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [open, setOpen] = useState(false);
  const held = snapshot.held !== undefined;
  const isDefault = snapshot.default?.service === service.id && snapshot.default.model === model.id;
  const test = snapshot.tests.get(testKey(service.id, model.id));
  const size = contextLabel(model.contextWindow);
  const name = model.name ?? model.id;

  return (
    <div className={styles.model} data-testid="ai-model" data-model={model.id}>
      <input
        type="checkbox"
        role="switch"
        className={styles.switch}
        aria-label={t("ai.enableModel", { model: name })}
        checked={model.enabled}
        disabled={held || last}
        title={last ? t("ai.lastModel") : undefined}
        onChange={(event) =>
          props.onRefused(ai.setEnabled(service.id, model.id, event.target.checked))
        }
      />
      <div className={styles.modelName}>
        <div className={model.enabled ? undefined : styles.muted}>{name}</div>
        {model.name && model.name !== model.id && (
          <div className={`${styles.modelId} ${styles.mono}`}>{model.id}</div>
        )}
      </div>
      <div className={styles.modelInfo}>
        <span
          title={
            model.cost
              ? t("ai.priceTitle", {
                  input: priceLabel(model.cost.input),
                  output: priceLabel(model.cost.output),
                })
              : undefined
          }
        >
          {size ?? t("ai.contextUnknown")} ·{" "}
          {model.cost
            ? t("ai.price", {
                input: priceLabel(model.cost.input),
                output: priceLabel(model.cost.output),
              })
            : t("ai.priceUnknown")}
        </span>
        <span className={styles.tags}>
          {model.reasoning && <span className={styles.tag}>{t("ai.modelThinking")}</span>}
          {model.image && <span className={styles.tag}>{t("ai.modelImage")}</span>}
          {model.fresh && (
            <span className={styles.tag} data-kind="new" title={t("ai.modelNewTitle")}>
              {t("ai.modelNew")}
            </span>
          )}
          {model.custom && <span className={styles.tag}>{t("ai.modelCustom")}</span>}
        </span>
      </div>
      <div className={styles.modelEnd}>
        <button
          type="button"
          className={styles.starButton}
          aria-pressed={isDefault}
          aria-label={isDefault ? t("ai.isDefault") : t("ai.setDefault")}
          title={isDefault ? t("ai.isDefault") : t("ai.setDefault")}
          disabled={held}
          onClick={() => ai.setDefault({ service: service.id, model: model.id })}
        >
          {isDefault ? "★" : "☆"}
        </button>
        {test && test.state !== "running" ? (
          <button
            type="button"
            className={styles.link}
            title={t("ai.testModelTitle", { model: name })}
            onClick={() => void ai.test(service.id, model.id)}
          >
            <TestPill
              test={test}
              relayed={service.route === "relay"}
              canRelay={ai.canRelay}
              short
              testId="ai-model-test"
            />
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.button} ${styles.small}`}
            title={t("ai.testModelTitle", { model: name })}
            disabled={held || test?.state === "running"}
            onClick={() => void ai.test(service.id, model.id)}
          >
            {test?.state === "running" ? t("ai.testing") : t("ai.testModel")}
          </button>
        )}
        <button
          type="button"
          className={styles.link}
          aria-expanded={open}
          aria-label={t("ai.modelMore", { model: name })}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        </button>
      </div>
      {open && <ModelMore service={service} model={model} />}
    </div>
  );
}

/** What a model has besides: how hard it reasons by default, and taking away one people named. */
function ModelMore(props: { readonly service: ServiceConfig; readonly model: ServiceModel }) {
  const { service, model } = props;
  const { ai, chat } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const chosen = snapshot.reasoningFor?.[model.id];
  const byPack = usePack(chat.choiceFor(model.id).pack, model.id).call.reasoning;
  const levels: readonly ReasoningLevel[] = model.levels ?? REASONING;
  return (
    <div className={styles.modelMore}>
      <label className={styles.row}>
        <span className={styles.muted}>{t("ai.modelReasoning")}</span>
        <select
          className={styles.input}
          aria-label={t("ai.modelReasoning")}
          value={chosen ?? ""}
          disabled={snapshot.held !== undefined}
          onChange={(event) =>
            ai.setReasoning(
              model.id,
              event.target.value === "" ? undefined : (event.target.value as ReasoningLevel),
            )
          }
        >
          <option value="">
            {byPack
              ? t("ai.reasoningAuto", { level: t(`ai.packs.value.reasoning.${byPack}`) })
              : t("ai.reasoningAutoNone")}
          </option>
          {levels.map((level) => (
            <option key={level} value={level}>
              {t(`ai.packs.value.reasoning.${level}`)}
            </option>
          ))}
        </select>
      </label>
      <span className={styles.muted}>{t("ai.reasoningHelp")}</span>
      {model.custom && (
        <button
          type="button"
          className={`${styles.link} ${styles.danger}`}
          onClick={() => ai.removeModel(service.id, model.id)}
        >
          {t("ai.removeModel")}
        </button>
      )}
    </div>
  );
}

function AddModel(props: { readonly service: ServiceConfig; readonly onDone: () => void }) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [size, setSize] = useState("");
  const tokens = size.trim() === "" ? undefined : Number(size);
  const valid =
    name.trim() !== "" && (tokens === undefined || (Number.isSafeInteger(tokens) && tokens > 0));
  const add = () => {
    if (!valid) return;
    ai.addModel(props.service.id, {
      id: name.trim(),
      ...(tokens !== undefined && { contextWindow: tokens }),
    });
    props.onDone();
  };
  return (
    <div className={styles.form} data-testid="ai-add-model">
      <label className={styles.field}>
        <span>{t("ai.addModelName")}</span>
        <input
          className={`${styles.input} ${styles.mono}`}
          value={name}
          spellCheck={false}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && add()}
        />
      </label>
      <label className={styles.field}>
        <span>{t("ai.addModelWindow")}</span>
        <input
          className={styles.input}
          inputMode="numeric"
          placeholder={t("ai.addModelWindowHelp")}
          value={size}
          aria-invalid={tokens !== undefined && !valid}
          onChange={(event) => setSize(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && add()}
        />
      </label>
      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={!valid}
          onClick={add}
        >
          {t("ai.addModelConfirm")}
        </button>
        <button type="button" className={styles.button} onClick={props.onDone}>
          {t("ai.keyCancel")}
        </button>
      </div>
    </div>
  );
}

/** Where the service is and how it is reached: folded, with one line of what it is now. */
function Advanced({ service }: { readonly service: ServiceConfig }) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const kind = kindOf(service.kind);
  const [url, setUrl] = useDraft(service.baseUrl);
  const held = snapshot.held !== undefined;
  const urlInvalid = url.trim() !== "" && checkBaseUrl(url) === undefined;
  const changed = kind !== undefined && !kind.custom && service.baseUrl !== kind.baseUrl;

  const saveUrl = () => {
    const checked = checkBaseUrl(url);
    if (checked !== undefined && checked !== service.baseUrl)
      ai.update(service.id, { baseUrl: checked });
  };

  return (
    <details className={styles.advanced} data-testid="ai-advanced">
      <summary>
        {t("ai.advanced")}{" "}
        <span className={styles.muted}>
          · {t(`ai.routeShort.${service.route}`)} · {service.baseUrl || "—"}
        </span>
      </summary>
      <div className={styles.wall}>
        <label className={styles.field}>
          <span>{t("ai.baseUrl")}</span>
          <input
            className={styles.input}
            value={url}
            placeholder="https://"
            spellCheck={false}
            disabled={held}
            aria-invalid={urlInvalid}
            onChange={(event) => setUrl(event.target.value)}
            onBlur={saveUrl}
            onKeyDown={(event) => event.key === "Enter" && saveUrl()}
          />
        </label>
        {urlInvalid && (
          <p className={styles.warning} data-testid="ai-url-problem">
            {t(urlHasSecret(url) ? "ai.baseUrlSecret" : "ai.baseUrlInvalid")}
          </p>
        )}
        {changed && (
          <p className={styles.help}>
            {t("ai.baseUrlChanged")}{" "}
            <button
              type="button"
              className={styles.link}
              onClick={() => ai.update(service.id, { baseUrl: kind.baseUrl })}
            >
              {t("ai.baseUrlRestore")}
            </button>
          </p>
        )}
        <label className={styles.field}>
          <span>{t("ai.route")}</span>
          <select
            className={styles.input}
            value={service.route}
            disabled={held}
            onChange={(event) =>
              ai.update(service.id, { route: event.target.value === "relay" ? "relay" : "direct" })
            }
          >
            <option value="direct">{t("ai.routeDirect")}</option>
            {/* Where there is none, people who chose it can still see that and change it. */}
            <option value="relay" disabled={!ai.canRelay}>
              {ai.canRelay ? t("ai.routeRelay") : t("ai.routeRelayNone")}
            </option>
          </select>
        </label>
        {service.route === "relay" &&
          (ai.canRelay ? (
            <p className={styles.help} data-testid="ai-relay-hint">
              {t("ai.routeRelayHint")}
            </p>
          ) : (
            <p className={styles.warning} data-testid="ai-relay-hint">
              {t("ai.routeRelayMissing")}
            </p>
          ))}
        {service.route === "direct" && kind?.route === "relay" && (
          <p className={styles.warning}>
            {ai.canRelay ? t("ai.needsRelay") : t("ai.needsRelayLocal")}
          </p>
        )}
        {service.route === "direct" && kind && !kind.tested && !kind.custom && (
          <p className={styles.help}>{ai.canRelay ? t("ai.untested") : t("ai.untestedLocal")}</p>
        )}
      </div>
    </details>
  );
}
