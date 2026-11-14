import { kindOf, type ServiceConfig } from "@animaquill/agent";
import { Plus } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { AddService } from "./AddService.tsx";
import { ServiceAvatar, stateOf } from "./aiParts.tsx";
import styles from "./AiSettings.module.css";
import { AiSyncLine } from "./AiSyncStatus.tsx";
import { ModelDetail } from "./ModelDetail.tsx";
import { dropIndex } from "./modelParts.tsx";
import { ServiceDetail } from "./ServiceDetail.tsx";

/**
 * The group of AI models in the settings (docs/design/settings-and-properties.md of AnimaQuill
 * Cloud, 6.1): the default model on top; the services on the left, with how each is, how many of
 * its models are on and a switch for all of them; on the right the service open (itself above, its
 * models below), or the cards of services to add. One level in, the details of one model. Where
 * the settings are narrow, one at a time: the dialog has the way back.
 */
export function AiModelsPage() {
  const workbench = useWorkbench();
  const { ai, settingsNav, dialogs } = workbench;
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const place = useSyncExternalStore(settingsNav.subscribe, settingsNav.getSnapshot);
  const { services } = snapshot;

  // How many models each kind has, for the counts beside each service.
  const kinds = [...new Set(services.map(({ kind }) => kind))].join(" ");
  useEffect(() => {
    for (const kind of kinds.split(" ")) if (kind) void ai.loadKnown(kind);
  }, [ai, kinds]);

  const open = services.find(({ id }) => id === place.service) ?? services[0];
  const adding = place.adding !== undefined || services.length === 0;
  const model = !adding && place.depth === 3 && open ? place.model : undefined;
  const depth = place.depth === 0 ? 1 : place.depth;
  const go = (changes: { service?: string | undefined; adding?: true | string }) =>
    settingsNav.go({
      group: "models",
      depth: 2,
      ...(changes.adding !== undefined && place.back && { back: place.back }),
      ...changes,
    });

  const reset = async () => {
    const sure = await dialogs.confirm({
      title: t("ai.held.reset"),
      message: t("ai.held.resetConfirm"),
      confirm: t("ai.held.reset"),
      danger: true,
    });
    if (sure) ai.reset();
  };

  return (
    <div
      className={styles.page}
      data-depth={depth}
      data-model={model === undefined ? undefined : ""}
      data-testid="ai-models"
    >
      {model === undefined && <DefaultBar />}
      {snapshot.held && (
        <p className={styles.held} role="alert" data-testid="ai-held">
          {t(`ai.held.${snapshot.held}`)}{" "}
          <button type="button" className={styles.link} onClick={() => void reset()}>
            {t("ai.held.reset")}
          </button>
        </p>
      )}
      {model === undefined && (
        <ServiceList
          services={services}
          current={adding ? undefined : open?.id}
          onOpen={(id) => go({ service: id })}
          onAdd={() => go({ adding: true })}
        />
      )}
      <div className={styles.detail}>
        <div className={styles.detailInner}>
          {model !== undefined && open ? (
            <ModelDetail key={`${open.id}\n${model}`} service={open} model={model} />
          ) : adding || !open ? (
            <AddService
              key="add"
              picked={typeof place.adding === "string" ? place.adding : undefined}
              onPick={(kind) => go({ adding: kind ?? true })}
              onBack={() =>
                services.length > 0
                  ? go({ service: open?.id })
                  : settingsNav.go({ group: "models", depth: 1 })
              }
              backAlways={services.length > 0}
              onAdded={(id) => {
                const back = place.back;
                go({ service: id });
                // Sent here from the chat: back to it, where the service is ready to use.
                if (back === "chat") {
                  settingsNav.close();
                  workbench.layout.openPanel("chat");
                }
              }}
            />
          ) : (
            <ServiceDetail key={open.id} service={open} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The model new conversations use, on top of the page: a list of the models that are on, by
 * service. How the settings stand with the account is on its right.
 */
function DefaultBar() {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const fallback = ai.defaultModel();
  const value = fallback ? `${fallback.service.id}\n${fallback.model}` : "";
  const groups = snapshot.services
    .map((service) => ({
      service,
      models: ai.modelsFor(service.id).filter((model) => model.enabled),
    }))
    .filter(({ models }) => models.length > 0);
  return (
    // `data-setting`: what searching the settings goes to, see settings/registry.ts.
    <div className={styles.defaultBar} data-setting="models.default">
      <label className={styles.defaultLabel} htmlFor="ai-default-model">
        {t("ai.defaultModel")}
      </label>
      <select
        id="ai-default-model"
        className={`${styles.input} ${styles.defaultSelect}`}
        data-testid="ai-default-model"
        value={value}
        disabled={snapshot.held !== undefined || groups.length === 0}
        onChange={(event) => {
          const [service, model] = event.target.value.split("\n");
          if (service && model) ai.setDefault({ service, model });
        }}
      >
        {groups.length === 0 && <option value="">{t("ai.defaultNone")}</option>}
        {groups.map(({ service, models }) => (
          <optgroup key={service.id} label={service.name}>
            {models.map((model) => (
              <option key={model.id} value={`${service.id}\n${model.id}`}>
                {`${value === `${service.id}\n${model.id}` ? "★ " : ""}${model.name ?? model.id} · ${service.name}`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className={styles.defaultHelp}>{t("ai.defaultHelp")}</span>
      <span className={styles.grow} />
      <AiSyncLine className={styles.syncLine ?? ""} link={styles.link ?? ""} />
    </div>
  );
}

function ServiceList(props: {
  readonly services: readonly ServiceConfig[];
  readonly current: string | undefined;
  readonly onOpen: (id: string) => void;
  readonly onAdd: () => void;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [dragged, setDragged] = useState<string | undefined>();
  const [refused, setRefused] = useState(false);
  const held = snapshot.held !== undefined;

  const move = (id: string, to: number) => {
    const from = props.services.findIndex((service) => service.id === id);
    // Taken out first: a place after it is one less.
    ai.moveService(id, from < to ? to - 1 : to);
  };

  return (
    // `data-setting`: what searching the settings goes to, see settings/registry.ts.
    <div className={styles.list} data-setting="models.services">
      <div className={styles.listHead}>
        <span>{t("ai.services")}</span>
      </div>
      {props.services.length === 0 && (
        <p className={`${styles.none} ${styles.addLink}`}>{t("ai.none")}</p>
      )}
      {props.services.map((service, index) => {
        const state = stateOf(snapshot, service);
        const kind = kindOf(service.kind);
        const total = ai.modelsFor(service.id).length;
        const on = service.enabled.length > 0;
        return (
          <div
            key={service.id}
            className={styles.serviceRow}
            data-testid="ai-service-item"
            data-service={service.id}
            data-dragging={dragged === service.id ? "" : undefined}
            draggable={!held}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", service.name);
              setDragged(service.id);
            }}
            onDragEnd={() => setDragged(undefined)}
            onDragOver={(event) => {
              if (dragged !== undefined) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragged !== undefined) move(dragged, dropIndex(event, index));
              setDragged(undefined);
            }}
          >
            <button
              type="button"
              className={styles.service}
              aria-current={props.current === service.id}
              onClick={() => props.onOpen(service.id)}
              onKeyDown={(event) => {
                if (!event.altKey || held) return;
                if (event.key === "ArrowUp" && index > 0) {
                  event.preventDefault();
                  ai.moveService(service.id, index - 1);
                } else if (event.key === "ArrowDown" && index < props.services.length - 1) {
                  event.preventDefault();
                  ai.moveService(service.id, index + 1);
                }
              }}
            >
              <span
                className={styles.dot}
                data-state={state}
                title={t(`ai.status.${state}`)}
                aria-label={t(`ai.status.${state}`)}
              />
              <ServiceAvatar kind={service.kind} name={service.name} />
              <span className={styles.serviceName} title={kind?.name}>
                {service.name}
              </span>
              {state === "noKey" ? (
                <span className={styles.badge} data-warn>
                  {t("ai.noKey")}
                </span>
              ) : (
                <span className={styles.badge}>
                  {service.enabled.length}/{Math.max(total, service.enabled.length)}
                </span>
              )}
            </button>
            <input
              type="checkbox"
              role="switch"
              className={`${styles.switch} ${styles.serviceSwitch}`}
              aria-label={t("ai.serviceSwitch", { service: service.name })}
              title={t("ai.serviceSwitch", { service: service.name })}
              data-testid="ai-service-switch"
              checked={on}
              disabled={held}
              onChange={(event) =>
                setRefused(ai.setServiceOn(service.id, event.target.checked) === "last")
              }
            />
          </div>
        );
      })}
      {refused && (
        <p className={`${styles.warning} ${styles.addLink}`} role="status">
          {t("ai.lastModel")}
        </p>
      )}
      <button
        type="button"
        className={`${styles.link} ${styles.addLink}`}
        data-testid="ai-add-service"
        disabled={held}
        onClick={props.onAdd}
      >
        <Plus size={12} aria-hidden /> {t("ai.addService")}
      </button>
      {props.services.length > 1 && <p className={styles.listFoot}>{t("ai.servicesFoot")}</p>}
    </div>
  );
}
