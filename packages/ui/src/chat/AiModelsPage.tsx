import { kindOf, type ServiceConfig } from "@animaquill/agent";
import { Cpu, Plus } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { AddServicePicker } from "./AddService.tsx";
import { ServiceAvatar, isServiceOn, stateOf, useUnreadableKeys } from "./aiParts.tsx";
import styles from "./AiSettings.module.css";
import { CapabilityIcon, capabilityOf } from "./CapabilityIcon.tsx";
import { failureText } from "./failure.ts";
import { ModelDetail, NewModel } from "./ModelDetail.tsx";
import { StarButton, dropIndex } from "./modelParts.tsx";
import { ServiceDetail } from "./ServiceDetail.tsx";
import type { ServiceModel } from "./settings.ts";

/**
 * The group of AI models in the settings, as pi-web's Models (docs/design/settings-and-
 * properties.md of AnimaQuill Cloud, 6): a tree on the left, the services with, under those of
 * one's own, their models, "＋ 模型" under each and "＋ 添加服务" at the bottom; on the right what is
 * picked in it. Where the settings are narrow, one at a time: the tree, then what was picked.
 */
export function AiModelsPage() {
  const workbench = useWorkbench();
  const { ai, settingsNav, dialogs } = workbench;
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const place = useSyncExternalStore(settingsNav.subscribe, settingsNav.getSnapshot);
  const { services } = snapshot;
  // A model being named under a service of one's own, which is not one until it has an id.
  const [naming, setNaming] = useState<string | undefined>();

  // What pi knows of each kind: its models, for the lists of the services and the picker.
  const kinds = [...new Set(services.map(({ kind }) => kind))].join(" ");
  useEffect(() => {
    for (const kind of kinds.split(" ")) if (kind) void ai.loadKnown(kind);
  }, [ai, kinds]);

  const open = services.find(({ id }) => id === place.service) ?? services[0];
  const picking = snapshot.held === undefined && place.adding !== undefined;
  // With no service yet, the picker is what the page shows.
  const empty = snapshot.held === undefined && services.length === 0;
  const model = place.depth === 3 && open ? place.model : undefined;
  const drafting = naming !== undefined && naming === open?.id && model === undefined;
  const depth = place.depth === 0 ? 1 : place.depth;
  // Where the page is, without the picker over it.
  const here = {
    group: "models" as const,
    depth: place.depth,
    ...(place.service !== undefined && { service: place.service }),
    ...(place.model !== undefined && { model: place.model }),
  };

  const go = (service: string, opened?: string) => {
    setNaming(undefined);
    settingsNav.go(
      opened === undefined
        ? { group: "models", depth: 2, service }
        : { group: "models", depth: 3, service, model: opened },
    );
  };

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
      data-empty={empty ? "" : undefined}
      data-testid="ai-models"
    >
      {snapshot.held && (
        <p className={styles.held} role="alert" data-testid="ai-held">
          {t(`ai.held.${snapshot.held}`)}
          {snapshot.resettable && (
            <>
              {" "}
              <button type="button" className={styles.link} onClick={() => void reset()}>
                {t("ai.held.reset")}
              </button>
            </>
          )}
        </p>
      )}
      {/* With no service yet, the page is the picker alone. */}
      {!empty && (
        <Tree
          services={services}
          current={drafting || model !== undefined ? undefined : open?.id}
          currentModel={open && model !== undefined ? { service: open.id, model } : undefined}
          naming={drafting ? naming : undefined}
          onService={(id) => go(id)}
          onModel={go}
          onNewModel={(id) => {
            settingsNav.go({ group: "models", depth: 2, service: id });
            setNaming(id);
          }}
          onAdd={() => settingsNav.go({ ...here, depth: depth, adding: true })}
        />
      )}
      <div className={styles.detail}>
        <div className={styles.detailInner}>
          {!open ? (
            empty && (
              // `data-setting`: where searching the settings goes while there is no service.
              <div data-setting="models.default">
                <AddServicePicker
                  inline
                  picked={undefined}
                  onClose={() => {}}
                  onAdded={(id) => settingsNav.go({ group: "models", depth: 2, service: id })}
                />
              </div>
            )
          ) : drafting ? (
            <NewModel key={`new\n${open.id}`} service={open} onAdded={(id) => go(open.id, id)} />
          ) : model !== undefined ? (
            <ModelDetail key={`${open.id}\n${model}`} service={open} model={model} />
          ) : (
            <ServiceDetail key={open.id} service={open} />
          )}
        </div>
      </div>
      {picking && (
        <AddServicePicker
          picked={typeof place.adding === "string" ? place.adding : undefined}
          onClose={() => settingsNav.go(here)}
          onAdded={(id) => {
            setNaming(undefined);
            settingsNav.go({
              group: "models",
              depth: 2,
              service: id,
              ...(place.back !== undefined && { back: place.back }),
            });
          }}
        />
      )}
    </div>
  );
}

/** The models of a server of one's own the tree lists: those people added, in their order. */
function treeModelsOf(service: ServiceConfig, models: readonly ServiceModel[]) {
  const order = service.enabled.length > 0 ? service.enabled : (service.paused ?? []);
  const at = new Map(order.map((id, index) => [id, index]));
  return models
    .filter((model) => at.has(model.id))
    .toSorted((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0));
}

const isCustom = (service: ServiceConfig) => kindOf(service.kind)?.custom === true;

function Tree(props: {
  readonly services: readonly ServiceConfig[];
  readonly current: string | undefined;
  readonly currentModel: { readonly service: string; readonly model: string } | undefined;
  readonly naming: string | undefined;
  readonly onService: (id: string) => void;
  readonly onModel: (service: string, model: string) => void;
  readonly onNewModel: (service: string) => void;
  readonly onAdd: () => void;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const unreadable = useUnreadableKeys();
  const [dragged, setDragged] = useState<string | undefined>();
  const held = snapshot.held !== undefined;
  // Services of the catalog above, those of one's own below the line; each kept in its order.
  const builtin = props.services.filter((service) => !isCustom(service));
  const own = props.services.filter(isCustom);

  /** Moves a service to before another of its group, or to after the last one of it. */
  const moveTo = (
    id: string,
    group: readonly ServiceConfig[],
    before: ServiceConfig | undefined,
  ) => {
    const others = props.services.filter((service) => service.id !== id);
    const last = group.filter((service) => service.id !== id).at(-1);
    const at = before
      ? others.findIndex((service) => service.id === before.id)
      : last
        ? others.indexOf(last) + 1
        : others.length;
    ai.moveService(id, at);
  };

  const drop = (event: DragEvent<HTMLElement>, target: ServiceConfig, index: number) => {
    event.preventDefault();
    setDragged(undefined);
    if (dragged === undefined || dragged === target.id) return;
    const group = isCustom(target) ? own : builtin;
    if (!group.some((service) => service.id === dragged)) return;
    const after = dropIndex(event, index) > index;
    moveTo(dragged, group, after ? group[index + 1] : target);
  };

  const node = (service: ServiceConfig, index: number, group: readonly ServiceConfig[]) => {
    const state = stateOf(snapshot, service, unreadable);
    const failure = snapshot.failing.get(service.id);
    const custom = isCustom(service);
    const off = !isServiceOn(service);
    return (
      <div
        key={service.id}
        className={styles.treeService}
        data-off={off ? "" : undefined}
        data-dragging={dragged === service.id ? "" : undefined}
      >
        <button
          type="button"
          className={styles.treeRow}
          data-testid="ai-service-item"
          data-service={service.id}
          aria-current={props.current === service.id}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
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
          onDrop={(event) => drop(event, service, index)}
          onClick={() => props.onService(service.id)}
          onKeyDown={(event) => {
            if (!event.altKey || held) return;
            if (event.key === "ArrowUp" && index > 0) {
              event.preventDefault();
              moveTo(service.id, group, group[index - 1]);
            } else if (event.key === "ArrowDown" && index < group.length - 1) {
              event.preventDefault();
              moveTo(service.id, group, group[index + 2]);
            }
          }}
        >
          {custom ? (
            <Cpu size={14} className={styles.treeIcon} aria-hidden />
          ) : (
            <ServiceAvatar kind={service.kind} name={service.name} />
          )}
          <span className={styles.treeName}>{service.name}</span>
          {state !== "ok" && (
            <span
              className={styles.dot}
              data-state={state}
              data-testid="ai-service-dot"
              role="img"
              aria-label={t(`ai.status.${state}`)}
              title={
                state === "failed" && failure
                  ? `${t("ai.status.failed")} · ${t(`ai.testFailed.${failure.kind}`)}\n${
                      failureText(t, failure, {
                        relayed: service.route === "relay",
                        canRelay: ai.canRelay,
                      }).advice
                    }`
                  : t(`ai.status.${state}`)
              }
            />
          )}
        </button>
        {custom && (
          <TreeModels
            service={service}
            current={
              props.currentModel?.service === service.id ? props.currentModel.model : undefined
            }
            naming={props.naming === service.id}
            onModel={(model) => props.onModel(service.id, model)}
            onNew={() => props.onNewModel(service.id)}
          />
        )}
      </div>
    );
  };

  return (
    // `data-setting`: what searching the settings goes to, see settings/registry.ts.
    <nav className={styles.tree} aria-label={t("ai.title")} data-setting="models.services">
      <div className={styles.treeList} data-setting="models.default" data-testid="ai-tree">
        {builtin.map((service, index) => node(service, index, builtin))}
        {builtin.length > 0 && own.length > 0 && <hr className={styles.treeLine} />}
        {own.map((service, index) => node(service, index, own))}
      </div>
      <button
        type="button"
        className={styles.treeAdd}
        data-testid="ai-add-service"
        disabled={held}
        onClick={props.onAdd}
      >
        <Plus size={14} aria-hidden /> {t("ai.addService")}
      </button>
    </nav>
  );
}

/** The models of a server of one's own, under it: to open, order, and make the default. */
function TreeModels(props: {
  readonly service: ServiceConfig;
  readonly current: string | undefined;
  readonly naming: boolean;
  readonly onModel: (model: string) => void;
  readonly onNew: () => void;
}) {
  const { service } = props;
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const [dragged, setDragged] = useState<string | undefined>();
  const held = snapshot.held !== undefined;
  const models = treeModelsOf(service, ai.modelsFor(service.id));
  // Only those on move: a service turned off keeps its order as it was.
  const movable = !held && service.enabled.length > 0;
  const move = (id: string, to: number) => {
    const from = service.enabled.indexOf(id);
    if (from < 0) return;
    ai.moveModel(service.id, id, from < to ? to - 1 : to);
  };
  return (
    <>
      {models.map((model, index) => {
        const name = model.name ?? model.id;
        const capability = capabilityOf(model.values);
        return (
          <div
            key={model.id}
            className={styles.treeModel}
            data-testid="ai-model"
            data-model={model.id}
            data-dragging={dragged === model.id ? "" : undefined}
            data-current={props.current === model.id ? "" : undefined}
            draggable={movable}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", model.id);
              setDragged(model.id);
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
              className={styles.treeModelName}
              aria-current={props.current === model.id}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              data-testid="ai-model-open"
              onClick={() => props.onModel(model.id)}
              onKeyDown={(event) => {
                if (!event.altKey || !movable) return;
                if (event.key === "ArrowUp" && index > 0) {
                  event.preventDefault();
                  ai.moveModel(service.id, model.id, index - 1);
                } else if (event.key === "ArrowDown" && index < models.length - 1) {
                  event.preventDefault();
                  ai.moveModel(service.id, model.id, index + 1);
                }
              }}
            >
              {name}
            </button>
            {capability && <CapabilityIcon capability={capability} size={13} />}
            <StarButton service={service.id} model={model.id} name={name} />
          </div>
        );
      })}
      {props.naming && (
        <div className={styles.treeModel} data-current="" data-testid="ai-model-new">
          <span className={`${styles.treeModelName} ${styles.treeNew}`}>{t("ai.newModel")}</span>
        </div>
      )}
      <button
        type="button"
        className={styles.treeAddModel}
        data-testid="ai-add-model"
        disabled={held}
        onClick={props.onNew}
      >
        <Plus size={12} aria-hidden /> {t("ai.addModel")}
      </button>
    </>
  );
}
