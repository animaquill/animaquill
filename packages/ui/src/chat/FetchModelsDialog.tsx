import { catalogValues, type ListedModel, type ServiceConfig } from "@animaquill/agent";
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./AiSettings.module.css";
import { CapabilityIcon, capabilityOf } from "./CapabilityIcon.tsx";
import { failureText } from "./failure.ts";
import { contextLabel, priceLabel } from "./modelText.ts";

/** How many of what a service lists show at once, as pi-web shows them. */
const MOST_SHOWN = 300;

/**
 * The models a service lists, to pick some to add (docs/design/settings-and-properties.md of
 * AnimaQuill Cloud, 6.3, sketch S4): a filter, a box that ticks all those shown, the ones already
 * there greyed, what the catalogs know of each, and those that hold no conversation marked and
 * not ticked. What is added is filled in from the catalogs right away.
 */
export function FetchModelsDialog(props: {
  readonly service: ServiceConfig;
  readonly onClose: () => void;
}) {
  const { service } = props;
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const listing = snapshot.listings.get(service.id);
  const known = snapshot.known.get(service.kind) ?? [];

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  useEffect(() => {
    void ai.fetchModels(service.id);
    void ai.loadCatalog();
  }, [ai, service.id]);

  const listed = listing?.state === "ok" ? listing.models : [];
  const have = new Set(ai.modelsFor(service.id).map((model) => model.id));
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

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const close = () => {
    dialog.current?.close();
    props.onClose();
  };
  const add = () => {
    const ids = listed.filter((model) => picked.has(model.id) && !have.has(model.id));
    ai.addModels(
      service.id,
      ids.map((model) => ({ id: model.id, added: "service" as const })),
    );
    close();
  };

  return (
    <dialog
      ref={dialog}
      className={styles.fetchDialog}
      data-testid="ai-fetch"
      aria-labelledby="ai-fetch-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className={styles.fetchHead}>
        <h2 id="ai-fetch-title">{t("ai.fetch.title", { name: service.name })}</h2>
        <button
          type="button"
          className={styles.link}
          aria-label={t("ai.fetch.close")}
          onClick={close}
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className={styles.fetchBody}>
        <div className={styles.row}>
          <input
            className={`${styles.input} ${styles.grow}`}
            type="search"
            aria-label={t("ai.fetch.search")}
            placeholder={t("ai.fetch.search")}
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
          />
          {listing?.state === "ok" && (
            <span className={styles.muted} data-testid="ai-fetch-count">
              {t("ai.fetch.found", { count: found.length, shown: shown.length })}
            </span>
          )}
        </div>
        {listing === undefined || listing.state === "loading" ? (
          <p className={styles.help}>{t("ai.fetch.loading")}</p>
        ) : listing.state === "failed" ? (
          <p className={styles.warning} data-testid="ai-fetch-failed">
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
            {Object.keys(service.headers ?? {}).length > 0 &&
              service.route === "direct" &&
              ai.canRelay && <> {t("ai.headers.relayHint")}</>}
          </p>
        ) : listing.state === "held" ? (
          <p className={styles.warning} data-testid="ai-fetch-failed">
            {t(`chat.hold.${listing.hold}`)}
          </p>
        ) : listed.length === 0 ? (
          <p className={styles.help}>{t("ai.fetch.empty")}</p>
        ) : (
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
              <span className={styles.grow}>
                {t("ai.fetch.selectShown", { count: pickable.length })}
              </span>
              <span className={styles.muted}>{t("ai.fetch.infoHead")}</span>
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
        )}
        <p className={styles.help}>{t("ai.fetch.source")}</p>
      </div>
      <footer className={styles.fetchFoot}>
        <button type="button" className={styles.button} onClick={close}>
          {t("ai.keyCancel")}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          data-testid="ai-fetch-add"
          disabled={picked.size === 0}
          onClick={add}
        >
          {t("ai.fetch.add", { count: [...picked].filter((id) => !have.has(id)).length })}
        </button>
      </footer>
    </dialog>
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
  const inCatalog = props.pi !== undefined || ai.catalogEntryOf(service.id, model.id) !== undefined;
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
      <span className={`${styles.grow} ${styles.mono}`}>{model.id}</span>
      <span className={styles.fetchInfo}>
        {added ? (
          t("ai.fetch.added")
        ) : model.chat === false ? (
          t("ai.fetch.notChat")
        ) : inCatalog ? (
          <>
            {[name, size].filter(Boolean).join(" · ")}
            {capability && (
              <>
                {" · "}
                <CapabilityIcon capability={capability} size={14} />
              </>
            )}
            {cost && ` · $${priceLabel(cost.input)}/$${priceLabel(cost.output)}`}
          </>
        ) : (
          <span className={styles.fetchUnknown}>
            {t("ai.fetch.notInCatalog")}
            {model.contextWindow !== undefined &&
              ` · ${t("ai.fetch.serviceSays", { size: contextLabel(model.contextWindow) })}`}
          </span>
        )}
      </span>
    </label>
  );
}
