import {
  SERVICE_KINDS,
  TOOL_CALL_LIMITS,
  checkBaseUrl,
  kindOf,
  type ServiceConfig,
  type ServiceFailure,
} from "@animaquill/agent";
import { useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./AiServicesSettings.module.css";
import { failureText } from "./failure.ts";

/** The AI services people bring, in the settings: each with its address, key and model. */
export function AiServicesSettings() {
  const { ai, dialogs } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [kind, setKind] = useState(SERVICE_KINDS[0]?.id ?? "");

  const removeAll = async () => {
    const sure = await dialogs.confirm({
      title: t("ai.removeAllKeys"),
      message: t("ai.removeAllKeysConfirm"),
      confirm: t("ai.removeAllKeys"),
      danger: true,
    });
    if (sure) await ai.removeAllKeys();
  };

  return (
    <section className={styles.section} aria-label={t("ai.title")}>
      <h2 className={styles.group}>{t("ai.title")}</h2>
      <p className={styles.help}>{t("ai.intro")}</p>
      <p className={styles.help} data-testid="ai-keys-where">
        {snapshot.keysWhere
          ? t("ai.keysWhere", { where: snapshot.keysWhere })
          : t("ai.keysNowhere")}{" "}
        {snapshot.keyed.size > 0 && (
          <button type="button" className={styles.link} onClick={() => void removeAll()}>
            {t("ai.removeAllKeys")}
          </button>
        )}
      </p>
      <p className={styles.help}>{t("ai.noSubscription")}</p>

      {snapshot.services.length === 0 && <p className={styles.none}>{t("ai.none")}</p>}
      {snapshot.services.map((service) => (
        <ServiceCard key={service.id} service={service} />
      ))}

      <div className={styles.add}>
        <label>
          <span>{t("ai.addKind")}</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            {SERVICE_KINDS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            const name = kindOf(kind)?.name ?? kind;
            ai.add(kind, name);
          }}
        >
          {t("ai.add")}
        </button>
      </div>

      <label className={styles.limit}>
        <span>{t("ai.limit")}</span>
        <input
          type="number"
          min={TOOL_CALL_LIMITS.min}
          max={TOOL_CALL_LIMITS.max}
          value={snapshot.maxToolCalls}
          onChange={(event) => ai.setMaxToolCalls(Number(event.target.value))}
        />
        <span>{t("ai.times")}</span>
      </label>
      <p className={styles.help}>{t("ai.limitHelp")}</p>
    </section>
  );
}

function ServiceCard({ service }: { readonly service: ServiceConfig }) {
  const { ai, dialogs } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const kind = kindOf(service.kind);
  const [url, setUrl] = useState(service.baseUrl);
  const [key, setKey] = useState("");
  const listId = useId();
  const hasKey = snapshot.keyed.has(service.id);
  const listing = snapshot.listings.get(service.id);
  const models = ai.modelsFor(service.id);
  const urlInvalid = url.trim() !== "" && checkBaseUrl(url) === undefined;

  const saveUrl = () => {
    const checked = checkBaseUrl(url);
    if (checked !== undefined && checked !== service.baseUrl)
      ai.update(service.id, { baseUrl: checked });
  };
  const saveKey = async () => {
    if (!key.trim()) return;
    await ai.setKey(service.id, key);
    setKey("");
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
    <div className={styles.card} data-testid="ai-service">
      <div className={styles.head}>
        <input
          className={styles.name}
          aria-label={t("ai.name")}
          defaultValue={service.name}
          onBlur={(event) => {
            const name = event.target.value.trim();
            if (name && name !== service.name) ai.update(service.id, { name });
          }}
        />
        <span className={styles.kind}>{kind?.name}</span>
        <button type="button" className={styles.link} onClick={() => void remove()}>
          {t("ai.remove")}
        </button>
      </div>

      <label className={styles.row}>
        <span>{t("ai.baseUrl")}</span>
        <input
          value={url}
          placeholder="https://"
          spellCheck={false}
          aria-invalid={urlInvalid}
          onChange={(event) => setUrl(event.target.value)}
          onBlur={saveUrl}
          onKeyDown={(event) => event.key === "Enter" && saveUrl()}
        />
      </label>
      {urlInvalid && <p className={styles.warning}>{t("ai.baseUrlInvalid")}</p>}

      <label className={styles.row}>
        <span>{t("ai.key")}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder={hasKey ? t("ai.keySaved") : t("ai.keyPlaceholder")}
          onChange={(event) => setKey(event.target.value)}
          onBlur={() => void saveKey()}
          onKeyDown={(event) => event.key === "Enter" && void saveKey()}
        />
        {hasKey && (
          <button
            type="button"
            className={styles.link}
            onClick={() => void ai.removeKey(service.id)}
          >
            {t("ai.keyRemove")}
          </button>
        )}
      </label>

      <label className={styles.row}>
        <span>{t("ai.model")}</span>
        <input
          list={listId}
          defaultValue={service.model}
          key={service.model}
          placeholder={t("ai.modelPlaceholder")}
          spellCheck={false}
          onFocus={() => void ai.loadKnown(service.kind)}
          onBlur={(event) => {
            const model = event.target.value.trim();
            if (model !== service.model) ai.update(service.id, { model });
          }}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
        />
        <datalist id={listId}>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </datalist>
        <button
          type="button"
          className={styles.link}
          disabled={listing?.state === "loading"}
          onClick={() => void ai.fetchModels(service.id)}
        >
          {listing?.state === "loading" ? t("ai.fetchingModels") : t("ai.fetchModels")}
        </button>
      </label>
      {listing?.state === "ok" && (
        <p className={styles.help}>{t("ai.fetchedModels", { count: listing.models.length })}</p>
      )}
      {listing?.state === "failed" && (
        <FailedListing
          failure={listing.failure}
          relayed={service.route === "relay"}
          canRelay={ai.canRelay}
        />
      )}
      {listing?.state === "held" && (
        <p className={styles.warning} data-testid="ai-models-failed">
          {t(`chat.hold.${listing.hold}`)}
        </p>
      )}

      <label className={styles.row}>
        <span>{t("ai.route")}</span>
        <select
          value={service.route}
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
  );
}

function FailedListing(props: {
  readonly failure: ServiceFailure;
  readonly relayed: boolean;
  readonly canRelay: boolean;
}) {
  const { t } = useTranslation();
  const { advice, detail } = failureText(t, props.failure, props);
  return (
    <p className={styles.warning} data-testid="ai-models-failed">
      {advice} {detail}
    </p>
  );
}
