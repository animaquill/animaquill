import { urlHasSecret } from "@animaquill/host";
import {
  MODEL_APIS,
  bulkActions,
  checkBaseUrl,
  enabledCountOf,
  filterModels,
  isLastEnabled,
  kindOf,
  type ModelApi,
  type ServiceConfig,
} from "@animaquill/agent";
import { ChevronRight, GripVertical } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { agoText } from "../app/start-view.ts";
import { ServiceAvatar, TestPill, useDraft } from "./aiParts.tsx";
import styles from "./AiSettings.module.css";
import { CapabilityIcon, capabilityOf } from "./CapabilityIcon.tsx";
import { FetchModelsDialog } from "./FetchModelsDialog.tsx";
import { HeadersEditor, dropIndex } from "./modelParts.tsx";
import { contextLabel, priceLabel } from "./modelText.ts";
import { protocolOf, testKey, type ServiceModel } from "./settings.ts";

/** From how many models on the list a filter shows. */
const FILTER_FROM = 8;
/** Models that GPT-6 names, which call no tools through Chat Completions. */
const GPT6 = /gpt-6/i;

/**
 * One service in the settings (docs/design/settings-and-properties.md of AnimaQuill Cloud, 6.1):
 * the service itself above (name, key, address, how it is reached; for a server of one's own how
 * it is talked to; headers), with a test of the connection; its models below, to turn on, order,
 * test, and open for their details.
 */
export function ServiceDetail({ service }: { readonly service: ServiceConfig }) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const models = ai.modelsFor(service.id);
  const kind = kindOf(service.kind);
  const gpt6 =
    kind?.id === "openai-compatible" &&
    protocolOf(service) === "openai-completions" &&
    models.some((model) => GPT6.test(model.id));

  return (
    <div className={styles.wall} data-testid="ai-service">
      <Header service={service} />
      <ServiceFields service={service} known={models.length} />
      {gpt6 && (
        <p className={styles.note} data-testid="ai-gpt6">
          {t("ai.gpt6Completions")}
        </p>
      )}
      <ModelsSection service={service} models={models} />
    </div>
  );
}

function Header({ service }: { readonly service: ServiceConfig }) {
  const { ai, dialogs } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const kind = kindOf(service.kind);
  const held = snapshot.held !== undefined;
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
      <span className={styles.title}>{service.name}</span>
      {kind && (
        <span className={styles.muted}>
          {kind.custom ? kind.name : t("ai.kindOfficial", { name: kind.name })}
        </span>
      )}
      <span className={styles.grow} />
      <button
        type="button"
        className={styles.button}
        disabled={held || snapshot.tests.get(service.id)?.state === "running"}
        title={t("ai.testCostTitle")}
        onClick={() => void ai.test(service.id)}
      >
        {t("ai.test")}
      </button>
      <TestPill
        test={snapshot.tests.get(service.id)}
        relayed={service.route === "relay"}
        canRelay={ai.canRelay}
      />
      <button
        type="button"
        className={`${styles.link} ${styles.danger}`}
        disabled={held}
        onClick={() => void remove()}
      >
        {t("ai.remove")}
      </button>
    </div>
  );
}

/** The service itself: name, key, address, how it is reached, how it is talked to, headers. */
function ServiceFields(props: { readonly service: ServiceConfig; readonly known: number }) {
  const { service } = props;
  const { ai, aiSync } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const sync = useSyncExternalStore(aiSync.subscribe, aiSync.getSnapshot);
  const kind = kindOf(service.kind);
  const held = snapshot.held !== undefined;
  const [name, setName] = useDraft(service.name);
  const [url, setUrl] = useDraft(service.baseUrl);
  const urlInvalid = url.trim() !== "" && checkBaseUrl(url) === undefined;
  const official = kind !== undefined && !kind.custom && service.baseUrl === kind.baseUrl;
  const changed = kind !== undefined && !kind.custom && !official;
  const headers = Object.keys(service.headers ?? {}).length;

  const rename = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== service.name) ai.update(service.id, { name: trimmed });
    else setName(service.name);
  };
  const saveUrl = () => {
    const checked = checkBaseUrl(url);
    if (checked !== undefined && checked !== service.baseUrl)
      ai.update(service.id, { baseUrl: checked });
  };

  return (
    <>
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>{t("ai.name")}</span>
          <input
            className={styles.input}
            value={name}
            disabled={held}
            aria-label={t("ai.name")}
            onChange={(event) => setName(event.target.value)}
            onBlur={rename}
            onKeyDown={(event) => event.key === "Enter" && rename()}
          />
        </label>
        <KeyField service={service} known={props.known} synced={sync.account !== undefined} />
        <label className={styles.field} data-testid="ai-base-url">
          <span>
            {t("ai.baseUrl")}
            {official && <span className={styles.fieldNote}> · {t("ai.baseUrlOfficial")}</span>}
            {changed && <span className={styles.fieldNote}> · {t("ai.baseUrlChanged")}</span>}
          </span>
          <input
            className={`${styles.input} ${styles.mono}`}
            value={url}
            placeholder="https://"
            spellCheck={false}
            disabled={held}
            aria-label={t("ai.baseUrl")}
            aria-invalid={urlInvalid}
            onChange={(event) => setUrl(event.target.value)}
            onBlur={saveUrl}
            onKeyDown={(event) => event.key === "Enter" && saveUrl()}
          />
          {urlInvalid && (
            <span className={styles.warning} data-testid="ai-url-problem">
              {t(urlHasSecret(url) ? "ai.baseUrlSecret" : "ai.baseUrlInvalid")}
            </span>
          )}
          {changed && (
            <button
              type="button"
              className={styles.link}
              style={{ alignSelf: "flex-start" }}
              onClick={() => ai.update(service.id, { baseUrl: kind.baseUrl })}
            >
              {t("ai.baseUrlRestore")}
            </button>
          )}
        </label>
        <RouteField service={service} />
        <div className={styles.field}>
          <span>{t("ai.api")}</span>
          {kind?.custom ? (
            <select
              className={styles.input}
              aria-label={t("ai.api")}
              data-testid="ai-api"
              value={protocolOf(service)}
              disabled={held}
              onChange={(event) => ai.update(service.id, { api: event.target.value as ModelApi })}
            >
              {MODEL_APIS.map((api) => (
                <option key={api} value={api}>
                  {t(`ai.apiNames.${api}`)}
                </option>
              ))}
            </select>
          ) : (
            <span className={styles.fixed}>
              {t(`ai.apiNames.${kind?.protocol ?? "openai-completions"}`)}
              <span className={styles.muted}> · {t("ai.apiFixed")}</span>
            </span>
          )}
        </div>
      </div>
      {/* `data-setting`: what searching the settings goes to, see settings/registry.ts. */}
      <details className={styles.plainFold} data-setting="models.headers" data-testid="ai-headers">
        <summary>
          {t("ai.headers.title", { count: headers })}{" "}
          <span className={styles.muted}>· {t("ai.headers.help")}</span>
        </summary>
        <HeadersEditor
          headers={service.headers}
          disabled={held}
          onChange={(next) => ai.update(service.id, { headers: next })}
        />
        {headers > 0 && service.route === "direct" && ai.canRelay && (
          <p className={styles.help}>{t("ai.headers.relayHint")}</p>
        )}
      </details>
    </>
  );
}

function KeyField(props: {
  readonly service: ServiceConfig;
  readonly known: number;
  readonly synced: boolean;
}) {
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
    <div className={styles.field}>
      <span>
        {t("ai.key")}
        <span className={styles.fieldNote} title={t("ai.keysWhereShort")}>
          {" "}
          · {props.synced ? t("ai.keyWhere.account") : t("ai.keyWhere.device")}
        </span>
      </span>
      {keyed && !changing ? (
        <div className={styles.row}>
          <span
            className={`${styles.keyMask} ${styles.mono} ${styles.grow}`}
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
        <span className={styles.help}>
          {kind?.custom
            ? t("ai.keyOptional")
            : props.known > 0
              ? t("ai.keyEmpty", { count: props.known })
              : t("ai.keyEmptyNone")}{" "}
          {kind?.id === "anthropic" ? t("ai.noSubscriptionAnthropic") : ""}
        </span>
      )}
      {!snapshot.keysWhere && <span className={styles.warning}>{t("ai.keysNowhere")}</span>}
    </div>
  );
}

/** Straight from the browser, or through the platform's relay: two buttons side by side. */
function RouteField({ service }: { readonly service: ServiceConfig }) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const kind = kindOf(service.kind);
  const held = snapshot.held !== undefined;
  return (
    <div className={styles.field}>
      <span>{t("ai.route")}</span>
      <div className={styles.segmented} role="group" aria-label={t("ai.route")}>
        <button
          type="button"
          aria-pressed={service.route === "direct"}
          disabled={held}
          onClick={() => ai.update(service.id, { route: "direct" })}
        >
          {t("ai.routeDirectShort")}
        </button>
        {/* Where there is none, people who chose it can still see that and change it. */}
        <button
          type="button"
          aria-pressed={service.route === "relay"}
          disabled={held || !ai.canRelay}
          title={ai.canRelay ? undefined : t("ai.routeRelayNone")}
          onClick={() => ai.update(service.id, { route: "relay" })}
        >
          {t("ai.routeRelayShort")}
        </button>
      </div>
      {service.route === "relay" ? (
        ai.canRelay ? (
          <span className={styles.help} data-testid="ai-relay-hint">
            {t("ai.routeRelayHint")}
          </span>
        ) : (
          <span className={styles.warning} data-testid="ai-relay-hint">
            {t("ai.routeRelayMissing")}
          </span>
        )
      ) : kind?.route === "relay" ? (
        <span className={styles.warning}>
          {ai.canRelay ? t("ai.needsRelay") : t("ai.needsRelayLocal")}
        </span>
      ) : kind && !kind.tested && !kind.custom ? (
        <span className={styles.help}>
          {ai.canRelay ? t("ai.untested") : t("ai.untestedLocal")}
        </span>
      ) : (
        <span className={styles.help}>{t("ai.routeDirectHint")}</span>
      )}
    </div>
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
  const [fetching, setFetching] = useState(false);
  const [refused, setRefused] = useState(false);
  const [dragged, setDragged] = useState<string | undefined>();
  const held = snapshot.held !== undefined;
  const total = enabledCountOf(snapshot);
  const shown = filterModels(models, query);
  const bulk = bulkActions(total, shown);
  const allOn = shown.length > 0 && bulk.enable.length === 0;
  const catalog = snapshot.catalog;
  const say = (result: "last" | undefined) => setRefused(result === "last");
  // "3 分钟前" moves on by itself.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const move = (id: string, to: number) => {
    const from = service.enabled.indexOf(id);
    if (from < 0) return;
    ai.moveModel(service.id, id, from < to ? to - 1 : to);
  };

  return (
    <>
      {/* `data-setting`: what searching the settings goes to, see settings/registry.ts. */}
      <div className={styles.modelsHead} data-setting="models.list">
        <h3 className={styles.sectionTitle}>{t("ai.models")}</h3>
        <span className={styles.muted} data-testid="ai-models-count">
          {t("ai.modelsEnabled", { enabled: service.enabled.length, total: models.length })}
        </span>
        <span className={styles.muted} data-testid="ai-catalog-state" data-setting="models.catalog">
          ·{" "}
          {catalog.state === "ok"
            ? t("ai.catalog.ok", {
                from: t(`ai.catalog.from.${catalog.from}`),
                ago: agoText(catalog.fetchedAt, Math.max(now, catalog.fetchedAt), t),
              })
            : t(`ai.catalog.${catalog.state}`)}{" "}
          <button
            type="button"
            className={styles.link}
            disabled={catalog.state === "loading"}
            onClick={() => void ai.refreshCatalog()}
          >
            {t("ai.catalog.refresh")}
          </button>
        </span>
        <span className={styles.grow} />
        {models.length > FILTER_FROM && (
          <input
            className={`${styles.input} ${styles.filter}`}
            type="search"
            aria-label={t("ai.filter")}
            placeholder={t("ai.filter")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        <button
          type="button"
          className={`${styles.button} ${styles.small}`}
          data-testid="ai-fetch-models"
          disabled={held}
          onClick={() => setFetching(true)}
        >
          {t("ai.fetch.open")}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.small}`}
          disabled={held}
          onClick={() => setAdding(true)}
        >
          {t("ai.addModel")}
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
        <button
          type="button"
          className={`${styles.button} ${styles.small}`}
          title={t("ai.sortTitle")}
          disabled={held || service.enabled.length < 2}
          onClick={() => ai.sortModels(service.id)}
        >
          {t("ai.sort")}
        </button>
      </div>
      {adding && <AddModel service={service} onDone={() => setAdding(false)} />}
      {refused && (
        <p className={styles.warning} role="status">
          {t("ai.lastModel")}
        </p>
      )}
      {models.length === 0 ? (
        <p className={styles.help}>{t("ai.noModels")}</p>
      ) : shown.length === 0 ? (
        <p className={styles.help}>{t("ai.noMatch")}</p>
      ) : (
        <div
          className={styles.table}
          data-testid="ai-models"
          data-setting="models.details"
          role="table"
        >
          <div className={styles.tableHead} role="row">
            <span role="columnheader" />
            <span role="columnheader">{t("ai.columns.enabled")}</span>
            <span role="columnheader">{t("ai.columns.model")}</span>
            <span role="columnheader">{t("ai.columns.context")}</span>
            <span role="columnheader">{t("ai.columns.maxTokens")}</span>
            <span role="columnheader">{t("ai.columns.price")}</span>
            <span role="columnheader">{t("ai.columns.capabilities")}</span>
            <span role="columnheader" />
          </div>
          {shown.map((model) => {
            const index = service.enabled.indexOf(model.id);
            return (
              <ModelRow
                key={model.id}
                service={service}
                model={model}
                last={isLastEnabled(total, model)}
                onRefused={say}
                dragging={dragged === model.id}
                drag={
                  index < 0 || held
                    ? undefined
                    : {
                        start: () => setDragged(model.id),
                        end: () => setDragged(undefined),
                        over: dragged !== undefined,
                        drop: (event) => {
                          if (dragged !== undefined) move(dragged, dropIndex(event, index));
                          setDragged(undefined);
                        },
                        up: () => index > 0 && ai.moveModel(service.id, model.id, index - 1),
                        down: () => ai.moveModel(service.id, model.id, index + 1),
                      }
                }
              />
            );
          })}
        </div>
      )}
      <p className={styles.help}>{t("ai.listFoot")}</p>
      {fetching && <FetchModelsDialog service={service} onClose={() => setFetching(false)} />}
    </>
  );
}

interface RowDrag {
  readonly start: () => void;
  readonly end: () => void;
  /** Something is being dragged over the list. */
  readonly over: boolean;
  readonly drop: (event: DragEvent<HTMLElement>) => void;
  readonly up: () => void;
  readonly down: () => void;
}

function ModelRow(props: {
  readonly service: ServiceConfig;
  readonly model: ServiceModel;
  /** It is the last model on, which cannot go off. */
  readonly last: boolean;
  readonly onRefused: (result: "last" | undefined) => void;
  /** Where it is on, how it is moved among those on. */
  readonly drag: RowDrag | undefined;
  readonly dragging: boolean;
}) {
  const { service, model, last, drag } = props;
  const { ai, settingsNav } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const held = snapshot.held !== undefined;
  const isDefault = snapshot.default?.service === service.id && snapshot.default.model === model.id;
  const test = snapshot.tests.get(testKey(service.id, model.id));
  const name = model.name ?? model.id;
  const cost = model.values.cost;
  const open = () =>
    settingsNav.go({ group: "models", depth: 3, service: service.id, model: model.id });

  return (
    <div
      className={styles.modelRow}
      role="row"
      data-testid="ai-model"
      data-model={model.id}
      data-enabled={model.enabled ? "" : undefined}
      data-dragging={props.dragging ? "" : undefined}
      draggable={drag !== undefined}
      onDragStart={(event) => {
        if (!drag) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", model.id);
        drag.start();
      }}
      onDragEnd={() => drag?.end()}
      onDragOver={(event) => {
        if (drag?.over) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        drag?.drop(event);
      }}
      onDoubleClick={(event) => {
        if (!(event.target as Element).closest("button, input")) open();
      }}
    >
      <span className={styles.grip} role="cell">
        {drag && (
          <button
            type="button"
            className={styles.gripButton}
            aria-label={t("ai.moveModel", { model: name })}
            title={t("ai.moveModelTitle")}
            onKeyDown={(event) => {
              if (!event.altKey && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              if (event.key === "ArrowUp") {
                event.preventDefault();
                drag.up();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                drag.down();
              }
            }}
          >
            <GripVertical size={12} aria-hidden />
          </button>
        )}
      </span>
      <span role="cell">
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
          onKeyDown={(event) => {
            if (!drag || !event.altKey) return;
            if (event.key === "ArrowUp") {
              event.preventDefault();
              drag.up();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              drag.down();
            }
          }}
        />
      </span>
      <span className={styles.modelName} role="cell">
        <span className={styles.row} style={{ gap: 4 }}>
          <span className={model.enabled ? styles.strong : undefined}>{name}</span>
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
          {model.custom && model.config?.added === "hand" && (
            <span className={styles.tag}>{t("ai.modelCustom")}</span>
          )}
        </span>
        {name !== model.id && (
          <span className={`${styles.modelId} ${styles.mono}`}>{model.id}</span>
        )}
      </span>
      <span role="cell" className={styles.num}>
        {contextLabel(model.values.contextWindow) ?? t("ai.unknown")}
      </span>
      <span role="cell" className={styles.num}>
        {contextLabel(model.values.maxTokens) ?? t("ai.unknown")}
      </span>
      <span
        role="cell"
        className={styles.num}
        title={
          cost
            ? t("ai.priceTitle", { input: priceLabel(cost.input), output: priceLabel(cost.output) })
            : undefined
        }
      >
        {cost
          ? t("ai.price", { input: priceLabel(cost.input), output: priceLabel(cost.output) })
          : t("ai.noPrice")}
      </span>
      <span role="cell" className={styles.caps}>
        <span className={styles.capSlot}>
          <CapabilityIcon capability={capabilityOf(model.values)} />
        </span>
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
            className={styles.link}
            title={t("ai.testModelTitle", { model: name })}
            disabled={held || test?.state === "running"}
            onClick={() => void ai.test(service.id, model.id)}
          >
            {test?.state === "running" ? t("ai.testing") : t("ai.testModel")}
          </button>
        )}
      </span>
      <span role="cell">
        <button
          type="button"
          className={styles.link}
          aria-label={t("ai.openModel", { model: name })}
          title={t("ai.openModel", { model: name })}
          data-testid="ai-model-open"
          onClick={open}
        >
          <ChevronRight size={14} aria-hidden />
        </button>
      </span>
    </div>
  );
}

/** A model named by hand: its id, which is filled in from the catalogs as it is added. */
function AddModel(props: { readonly service: ServiceConfig; readonly onDone: () => void }) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const taken = ai.modelsFor(props.service.id).some((model) => model.id === name.trim());
  const valid = name.trim() !== "" && name.trim().length <= 200;
  const add = () => {
    if (!valid) return;
    ai.addModels(props.service.id, [{ id: name.trim(), added: "hand" }]);
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
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
            if (event.key === "Escape") {
              // Only the adding: the settings around it stay open.
              event.preventDefault();
              props.onDone();
            }
          }}
        />
      </label>
      <p className={styles.help}>{taken ? t("ai.addModelTaken") : t("ai.addModelHelp")}</p>
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
