import { urlHasSecret } from "@animaquill/host";
import {
  MODEL_APIS,
  bulkActions,
  catalogValues,
  checkBaseUrl,
  enabledCountOf,
  filterModels,
  isLastEnabled,
  kindOf,
  type ListedModel,
  type ModelApi,
  type ServiceConfig,
} from "@animaquill/agent";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { TestPill, isServiceOn, useDraft } from "./aiParts.tsx";
import styles from "./AiSettings.module.css";
import { CapabilityIcon, capabilityOf } from "./CapabilityIcon.tsx";
import { failureText } from "./failure.ts";
import { HeadersEditor, StarButton, dropIndex } from "./modelParts.tsx";
import { contextLabel, priceLabel } from "./modelText.ts";
import { protocolOf, type ServiceModel } from "./settings.ts";

/** From how many models on the list a filter shows, as pi-web has it. */
const FILTER_FROM = 8;
/** How many of what a service lists show at once, as pi-web shows them. */
const MOST_SHOWN = 300;
/** What the key cell shows for a key that is saved, which is never read back: dots, and its end. */
const maskOf = (hint: string | undefined) => `••••••••••••${hint ?? ""}`;

const noop = () => () => {};
const nobody = () => undefined;

/**
 * One service, as pi-web shows a provider (docs/design/settings-and-properties.md of AnimaQuill
 * Cloud, 6.1): a test, a switch and deleting on top; then one column down, name, address, API key,
 * how it is talked to (for one's own), headers, how it is reached. For a service of the catalog, its models to
 * turn on below; for every one, getting its models at the bottom. Every change takes at once.
 */
export function ServiceDetail({ service }: { readonly service: ServiceConfig }) {
  const custom = kindOf(service.kind)?.custom === true;
  return (
    <div className={styles.wall} data-testid="ai-service">
      <Header service={service} />
      <ServiceFields service={service} />
      {!custom && (
        <>
          <hr className={styles.line} />
          <ModelSwitches service={service} />
        </>
      )}
      <hr className={styles.line} />
      <FetchModels service={service} />
    </div>
  );
}

function Header({ service }: { readonly service: ServiceConfig }) {
  const { ai, dialogs } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const held = snapshot.held !== undefined;
  const on = isServiceOn(service);
  // The last model on anywhere stays on: its service cannot go off.
  const last = service.enabled.length > 0 && enabledCountOf(snapshot) - service.enabled.length < 1;
  const test = snapshot.tests.get(service.id);
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
    <div className={styles.detailHead}>
      <span className={styles.kicker}>{t("ai.service")}</span>
      <span className={styles.grow} />
      <TestPill test={test} relayed={service.route === "relay"} canRelay={ai.canRelay} />
      <button
        type="button"
        className={styles.button}
        disabled={held || test?.state === "running"}
        title={t("ai.testCostTitle")}
        onClick={() => void ai.test(service.id)}
      >
        {t("ai.test")}
      </button>
      <input
        type="checkbox"
        role="switch"
        className={styles.switch}
        aria-label={t("ai.serviceOn")}
        title={last ? t("ai.lastModel") : t("ai.serviceOn")}
        data-testid="ai-service-switch"
        checked={on}
        disabled={held || last}
        onChange={(event) => ai.setServiceOn(service.id, event.target.checked)}
      />
      <button
        type="button"
        className={`${styles.button} ${styles.dangerButton}`}
        disabled={held}
        onClick={() => void remove()}
      >
        {t("ai.delete")}
      </button>
    </div>
  );
}

/** The service itself, one cell under another: name, address, key, interface, headers, route. */
function ServiceFields({ service }: { readonly service: ServiceConfig }) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const kind = kindOf(service.kind);
  const custom = kind?.custom === true;
  const held = snapshot.held !== undefined;
  const [name, setName] = useDraft(service.name);
  // A service of the catalog at its own address shows none: the official one, light, in its place.
  const official = kind?.baseUrl ?? "";
  const shownUrl = !custom && service.baseUrl === official ? "" : service.baseUrl;
  const [url, setUrl] = useDraft(shownUrl);
  const urlProblem =
    url.trim() === ""
      ? custom
        ? t("ai.add.urlRequired")
        : undefined
      : checkBaseUrl(url) === undefined
        ? t(urlHasSecret(url) ? "ai.baseUrlSecret" : "ai.baseUrlInvalid")
        : undefined;

  const rename = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== service.name) ai.update(service.id, { name: trimmed });
    else setName(service.name);
  };
  const saveUrl = () => {
    const text = url.trim();
    const next = text === "" ? (custom ? undefined : official) : checkBaseUrl(text);
    if (next !== undefined && next !== service.baseUrl) ai.update(service.id, { baseUrl: next });
  };

  return (
    <div className={styles.column}>
      <label className={styles.field}>
        <span>{t("ai.name")}</span>
        <input
          className={styles.input}
          value={name}
          disabled={held}
          onChange={(event) => setName(event.target.value)}
          onBlur={rename}
          onKeyDown={(event) => event.key === "Enter" && rename()}
        />
      </label>
      <label className={styles.field} data-testid="ai-base-url">
        <span>{t("ai.baseUrl")}</span>
        <input
          className={`${styles.input} ${styles.mono}`}
          value={url}
          placeholder={custom ? "https://" : official}
          spellCheck={false}
          disabled={held}
          aria-invalid={urlProblem !== undefined}
          title={urlProblem}
          onChange={(event) => setUrl(event.target.value)}
          onBlur={saveUrl}
          onKeyDown={(event) => event.key === "Enter" && saveUrl()}
        />
      </label>
      <KeyField service={service} />
      {/* A service of the catalog is talked to as it is: nothing to choose. */}
      {custom && (
        <label className={styles.field}>
          <span>{t("ai.api")}</span>
          <select
            className={styles.input}
            data-testid="ai-api"
            value={protocolOf(service) ?? "openai-completions"}
            disabled={held}
            onChange={(event) => ai.update(service.id, { api: event.target.value as ModelApi })}
          >
            {MODEL_APIS.map((api) => (
              <option key={api} value={api}>
                {t(`ai.apiNames.${api}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* `data-setting`: what searching the settings goes to, see settings/registry.ts. */}
      <div className={styles.field} data-setting="models.headers" data-testid="ai-headers">
        <span>{t("ai.headers.title")}</span>
        <HeadersEditor
          headers={service.headers}
          disabled={held}
          onChange={(next) => ai.update(service.id, { headers: next })}
        />
      </div>
      <RouteField service={service} />
    </div>
  );
}

/**
 * The key, as a password: a saved one is never read back, the cell shows dots and its last
 * characters. Typing another replaces it, emptying the cell takes it away; the eye shows what is
 * being typed. React never renders a key, which would put it in the page as an attribute.
 */
function KeyField({ service }: { readonly service: ServiceConfig }) {
  const workbench = useWorkbench();
  const { ai, settingsNav } = workbench;
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const keyed = snapshot.keyed.has(service.id);
  const mask = keyed ? maskOf(snapshot.hints.get(service.id)) : "";
  const field = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(false);
  // What the cell holds when nobody types in it: another window may change the key meanwhile.
  useEffect(() => {
    const element = field.current;
    if (element && document.activeElement !== element) element.value = mask;
  }, [mask]);

  const commit = async () => {
    const element = field.current;
    if (!element) return;
    const typed = element.value.trim();
    // What shows of a saved key is never a key, also while the cell has not caught up with it.
    if (typed === mask || typed.startsWith("••••")) return;
    if (typed === "") {
      if (keyed) await ai.removeKey(service.id);
      return;
    }
    element.value = maskOf(typed.slice(-4));
    setShown(false);
    await ai.setKey(service.id, typed);
    // Sent here from the chat to set a service up: back to it, ready to use.
    if (settingsNav.getSnapshot().back === "chat") {
      settingsNav.close();
      workbench.layout.openPanel("chat");
    }
  };

  return (
    <label className={styles.field}>
      <span>{t("ai.key")}</span>
      <span className={styles.secret}>
        <input
          ref={field}
          className={`${styles.input} ${styles.mono}`}
          type={shown ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          defaultValue={mask}
          disabled={snapshot.held !== undefined}
          title={snapshot.keysWhere ? undefined : t("ai.keysNowhere")}
          data-testid="ai-key"
          onFocus={(event) => {
            if (event.target.value === mask) event.target.select();
          }}
          onBlur={() => void commit()}
          onKeyDown={(event) => event.key === "Enter" && void commit()}
        />
        <button
          type="button"
          className={styles.eye}
          aria-label={shown ? t("ai.keyHide") : t("ai.keyShow")}
          aria-pressed={shown}
          title={shown ? t("ai.keyHide") : t("ai.keyShow")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setShown(!shown)}
        >
          {shown ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
        </button>
      </span>
    </label>
  );
}

/** Straight from the browser, or through the platform's relay: two buttons side by side. */
function RouteField({ service }: { readonly service: ServiceConfig }) {
  const { ai, account } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const signedIn =
    useSyncExternalStore(account?.subscribe ?? noop, account?.getSnapshot ?? nobody)?.status ===
    "signedIn";
  const held = snapshot.held !== undefined;
  const relay = ai.canRelay && signedIn;
  const why = ai.canRelay ? t("ai.routeRelaySignIn") : t("ai.routeRelayNone");
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
          aria-invalid={service.route === "relay" && !ai.canRelay}
          disabled={held || !relay}
          title={relay ? undefined : why}
          onClick={() => ai.update(service.id, { route: "relay" })}
        >
          {t("ai.routeRelayShort")}
        </button>
      </div>
    </div>
  );
}

/**
 * The models of a service of the catalog, as pi-web lists them: a switch each, a filter where they
 * are many, all on or off at once, how many are on. The last model on anywhere cannot go off. A
 * model's name opens it; those on move by dragging them, or with Alt+↑/↓.
 */
function ModelSwitches({ service }: { readonly service: ServiceConfig }) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [query, setQuery] = useState("");
  const [dragged, setDragged] = useState<string | undefined>();
  const held = snapshot.held !== undefined;
  const models = ai.modelsFor(service.id);
  const total = enabledCountOf(snapshot);
  const shown = filterModels(models, query);
  const bulk = bulkActions(total, shown);

  const move = (id: string, to: number) => {
    const from = service.enabled.indexOf(id);
    if (from < 0) return;
    ai.moveModel(service.id, id, from < to ? to - 1 : to);
  };

  return (
    // `data-setting`: what searching the settings goes to, see settings/registry.ts.
    <section className={styles.column} data-setting="models.list" data-testid="ai-model-list">
      <div className={styles.row}>
        <span className={styles.kicker}>{t("ai.models")}</span>
        <span className={`${styles.muted} ${styles.mono}`} data-testid="ai-models-count">
          {t("ai.modelsEnabled", { enabled: service.enabled.length, total: models.length })}
        </span>
        <span className={styles.grow} />
        <button
          type="button"
          className={styles.button}
          disabled={held || !bulk.canEnable}
          onClick={() => ai.setAllEnabled(service.id, bulk.enable, true)}
        >
          {t("ai.enableAll")}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={held || !bulk.canDisable}
          title={bulk.disable.length > 0 && !bulk.canDisable ? t("ai.lastModel") : undefined}
          onClick={() => ai.setAllEnabled(service.id, bulk.disable, false)}
        >
          {t("ai.disableAll")}
        </button>
      </div>
      {models.length > FILTER_FROM && (
        <input
          className={styles.input}
          type="search"
          aria-label={t("ai.filter")}
          placeholder={t("ai.filterCount", { count: models.length })}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {shown.length > 0 && (
        <div className={styles.switchList} data-testid="ai-models" role="list">
          {shown.map((model) => {
            const index = service.enabled.indexOf(model.id);
            const movable = !held && index >= 0;
            return (
              <SwitchRow
                key={model.id}
                service={service}
                model={model}
                last={isLastEnabled(total, model)}
                dragging={dragged === model.id}
                drag={
                  movable
                    ? {
                        start: () => setDragged(model.id),
                        end: () => setDragged(undefined),
                        over: dragged !== undefined,
                        drop: (at) => {
                          if (dragged !== undefined) move(dragged, at < 0 ? index : index + at);
                          setDragged(undefined);
                        },
                        up: () => index > 0 && ai.moveModel(service.id, model.id, index - 1),
                        down: () => ai.moveModel(service.id, model.id, index + 1),
                      }
                    : undefined
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

interface RowDrag {
  readonly start: () => void;
  readonly end: () => void;
  /** Something is being dragged over the list. */
  readonly over: boolean;
  /** Dropped on the row: before it (-1), or after it (1). */
  readonly drop: (at: -1 | 1) => void;
  readonly up: () => void;
  readonly down: () => void;
}

function SwitchRow(props: {
  readonly service: ServiceConfig;
  readonly model: ServiceModel;
  /** It is the last model on, which cannot go off. */
  readonly last: boolean;
  readonly drag: RowDrag | undefined;
  readonly dragging: boolean;
}) {
  const { service, model, last, drag } = props;
  const { ai, settingsNav } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const name = model.name ?? model.id;
  const cost = model.values.cost;
  const capability = capabilityOf(model.values);
  return (
    <div
      className={styles.switchRow}
      role="listitem"
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
        drag?.drop(dropIndex(event, 0) > 0 ? 1 : -1);
      }}
    >
      <button
        type="button"
        className={styles.switchName}
        data-testid="ai-model-open"
        aria-keyshortcuts={drag ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        onClick={() =>
          settingsNav.go({ group: "models", depth: 3, service: service.id, model: model.id })
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
      >
        <span className={styles.switchTitle}>{name}</span>
        <span className={`${styles.modelId} ${styles.mono}`}>{model.id}</span>
      </button>
      <span className={`${styles.num} ${styles.mono}`}>
        {contextLabel(model.values.contextWindow) ?? ""}
      </span>
      <span className={`${styles.num} ${styles.mono}`}>
        {cost
          ? t("ai.price", { input: priceLabel(cost.input), output: priceLabel(cost.output) })
          : ""}
      </span>
      <span className={styles.capSlot}>
        {capability && <CapabilityIcon capability={capability} size={13} />}
      </span>
      <StarButton service={service.id} model={model.id} name={name} />
      <input
        type="checkbox"
        role="switch"
        className={styles.switch}
        aria-label={t("ai.enableModel", { model: name })}
        checked={model.enabled}
        disabled={snapshot.held !== undefined || last}
        title={last ? t("ai.lastModel") : undefined}
        onChange={(event) => ai.setEnabled(service.id, model.id, event.target.checked)}
      />
    </div>
  );
}

/**
 * "获取模型…": what the service lists, below it, to tick and add (pi-web's import list): a filter,
 * ticking all those shown, those already there greyed. What holds no conversation (embeddings and
 * such) is not ticked with the rest. Anew each time; a change of the address, the key or the
 * interface closes it.
 */
function FetchModels({ service }: { readonly service: ServiceConfig }) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const listing = snapshot.listings.get(service.id);
  const known = snapshot.known.get(service.kind) ?? [];
  const held = snapshot.held !== undefined;
  // What it was asked with: where that changes, what it said is of something else.
  const asked = JSON.stringify([
    service.baseUrl,
    protocolOf(service),
    service.headers ?? {},
    service.route,
    snapshot.hints.get(service.id) ?? "",
  ]);
  const before = useRef(asked);
  useEffect(() => {
    if (before.current === asked) return;
    before.current = asked;
    setOpen(false);
    setPicked(new Set());
  }, [asked]);

  const fetch = () => {
    setOpen(true);
    setPicked(new Set());
    setQuery("");
    void ai.fetchModels(service.id);
    void ai.loadCatalog();
  };

  const listed = listing?.state === "ok" ? listing.models : [];
  // Those of a service of the catalog are all on its list already; of one's own, those added.
  const custom = kindOf(service.kind)?.custom === true;
  const have = new Set(
    ai
      .modelsFor(service.id)
      .filter((model) => !custom || model.enabled || service.paused?.includes(model.id))
      .map((model) => model.id),
  );
  const needle = query.trim().toLowerCase();
  const found = needle
    ? listed.filter(
        (model) =>
          model.id.toLowerCase().includes(needle) ||
          (model.name ?? "").toLowerCase().includes(needle),
      )
    : listed;
  const shown = found.slice(0, MOST_SHOWN);
  // Ticking all of them leaves out what holds no conversation: those are ticked one by one.
  const pickable = shown.filter((model) => !have.has(model.id) && model.chat !== false);
  const pickedShown = pickable.filter((model) => picked.has(model.id));
  const all = pickable.length > 0 && pickedShown.length === pickable.length;
  const some = pickedShown.length > 0 && !all;
  const adding = [...picked].filter((id) => !have.has(id));

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const add = () => {
    ai.addModels(
      service.id,
      adding.map((id) => ({ id, added: "service" as const })),
    );
    setOpen(false);
  };

  if (!open || listing === undefined)
    return (
      <button
        type="button"
        className={`${styles.button} ${styles.fetchButton}`}
        data-testid="ai-fetch-models"
        disabled={held}
        onClick={fetch}
      >
        {t("ai.fetch.open")}
      </button>
    );
  if (listing.state === "loading")
    return (
      <p className={styles.muted} data-testid="ai-fetch">
        {t("ai.fetch.loading")}
      </p>
    );
  if (listing.state !== "ok") {
    const say =
      listing.state === "held"
        ? { label: t("ai.testFailed.other"), title: t(`chat.hold.${listing.hold}`) }
        : {
            label: t(`ai.testFailed.${listing.failure.kind}`),
            title: Object.values(
              failureText(t, listing.failure, {
                relayed: service.route === "relay",
                canRelay: ai.canRelay,
              }),
            )
              .filter(Boolean)
              .join("\n"),
          };
    return (
      <div className={styles.row} data-testid="ai-fetch">
        <span
          className={styles.pill}
          data-state="failed"
          data-testid="ai-fetch-failed"
          title={say.title}
        >
          {say.label}
        </span>
        <button type="button" className={styles.button} onClick={fetch}>
          {t("ai.fetch.open")}
        </button>
      </div>
    );
  }
  return (
    <div className={styles.column} data-testid="ai-fetch">
      <input
        className={styles.input}
        type="search"
        aria-label={t("ai.filter")}
        placeholder={t("ai.filterCount", { count: listed.length })}
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className={styles.fetchList} role="list">
        <label className={`${styles.fetchRow} ${styles.fetchAll}`}>
          <input
            type="checkbox"
            checked={all}
            ref={(element) => {
              if (element) element.indeterminate = some;
            }}
            disabled={pickable.length === 0}
            onChange={() => {
              const next = new Set(picked);
              for (const model of pickable) {
                if (all) next.delete(model.id);
                else next.add(model.id);
              }
              setPicked(next);
            }}
          />
          <span>{t("ai.fetch.selectShown")}</span>
        </label>
        {shown.map((model) => (
          <FetchRow
            key={model.id}
            service={service}
            model={model}
            pi={known.find((each) => each.id === model.id)}
            added={have.has(model.id)}
            picked={picked.has(model.id)}
            onPick={(on) => toggle(model.id, on)}
          />
        ))}
      </div>
      <div className={styles.row}>
        <span className={styles.muted} data-testid="ai-fetch-count">
          {t("ai.fetch.found", { count: found.length })}
        </span>
        <span className={styles.grow} />
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          data-testid="ai-fetch-add"
          disabled={adding.length === 0}
          onClick={add}
        >
          {t("ai.fetch.add")}
        </button>
      </div>
    </div>
  );
}

function FetchRow(props: {
  readonly service: ServiceConfig;
  readonly model: ListedModel;
  readonly pi: ListedModel | undefined;
  readonly added: boolean;
  readonly picked: boolean;
  readonly onPick: (on: boolean) => void;
}) {
  const { service, model, added } = props;
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const say = catalogValues({
    service: model,
    pi: props.pi,
    modelsDev: ai.catalogEntryOf(service.id, model.id),
  });
  const name = say.values.get("name") as string | undefined;
  const size = contextLabel(say.values.get("contextWindow") as number | undefined);
  const cost = say.values.get("cost") as { input: number; output: number } | undefined;
  const capability = capabilityOf({
    reasoning: say.values.get("reasoning") as boolean | undefined,
    image: say.values.get("image") as boolean | undefined,
  });
  return (
    <label
      className={styles.fetchRow}
      role="listitem"
      data-testid="ai-fetch-row"
      data-model={model.id}
      data-added={added ? "" : undefined}
    >
      <input
        type="checkbox"
        checked={added || props.picked}
        disabled={added}
        onChange={(event) => props.onPick(event.target.checked)}
      />
      <span className={styles.fetchName}>
        <span>{name ?? model.id}</span>
        <span className={`${styles.modelId} ${styles.mono}`}>{model.id}</span>
      </span>
      <span className={`${styles.fetchInfo} ${styles.mono}`}>
        {[size, cost && `$${priceLabel(cost.input)} / $${priceLabel(cost.output)}`]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <span className={styles.capSlot}>
        {capability && <CapabilityIcon capability={capability} size={13} />}
      </span>
      <span className={styles.fetchTag}>
        {added ? t("ai.fetch.added") : model.chat === false ? t("ai.fetch.notChat") : ""}
      </span>
    </label>
  );
}
