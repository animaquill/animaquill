import { kindOf } from "@animaquill/agent";
import { Plus } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { AddService } from "./AddService.tsx";
import { ServiceAvatar, stateOf } from "./aiParts.tsx";
import styles from "./AiSettings.module.css";
import { AiSyncLine } from "./AiSyncStatus.tsx";
import { ServiceDetail } from "./ServiceDetail.tsx";

/**
 * The group of AI models in the settings: the services on the left, with how each is and how many
 * of its models are on, and the default model; on the right the service open, or the cards of
 * services to add. Where the settings are narrow, one at a time: the dialog has the way back.
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
  const fallback = ai.defaultModel();

  return (
    <div className={styles.page} data-depth={depth} data-testid="ai-models">
      <AiSyncLine className={styles.syncLine ?? ""} link={styles.link ?? ""} />
      {snapshot.held && (
        <p className={styles.held} role="alert" data-testid="ai-held">
          {t(`ai.held.${snapshot.held}`)}{" "}
          <button type="button" className={styles.link} onClick={() => void reset()}>
            {t("ai.held.reset")}
          </button>
        </p>
      )}
      {/* `data-setting`: what searching the settings goes to, see settings/registry.ts. */}
      <div className={styles.list} data-setting="models.services">
        <div className={styles.listHead}>
          <span>{t("ai.services")}</span>
        </div>
        {services.length === 0 && (
          <p className={`${styles.none} ${styles.addLink}`}>{t("ai.none")}</p>
        )}
        {services.map((service) => {
          const state = stateOf(snapshot, service);
          const kind = kindOf(service.kind);
          const total = ai.modelsFor(service.id).length;
          return (
            <button
              key={service.id}
              type="button"
              className={styles.service}
              aria-current={!adding && open?.id === service.id}
              data-testid="ai-service-item"
              onClick={() => go({ service: service.id })}
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
          );
        })}
        <button
          type="button"
          className={`${styles.link} ${styles.addLink}`}
          data-testid="ai-add-service"
          disabled={snapshot.held !== undefined}
          onClick={() => go({ adding: true })}
        >
          <Plus size={12} aria-hidden /> {t("ai.addService")}
        </button>

        <div className={styles.footer}>
          <h3>{t("ai.defaultModel")}</h3>
          <div
            className={styles.defaultModel}
            data-testid="ai-default-model"
            data-setting="models.default"
          >
            {fallback ? (
              <>
                <span className={styles.star}>★</span>{" "}
                {ai.modelOf(fallback.service.id, fallback.model)?.name ?? fallback.model}{" "}
                <span className={styles.muted}>· {fallback.service.name}</span>
              </>
            ) : (
              <span className={styles.muted}>{t("ai.defaultNone")}</span>
            )}
          </div>
        </div>
      </div>
      <div className={styles.detail}>
        <div className={styles.detailInner}>
          {adding || !open ? (
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
