import { enabledModelsOf } from "@animaquill/agent";
import { nameIssues, type PackProblem } from "@animaquill/tools";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import settingsStyles from "./AiSettings.module.css";
import styles from "./ModelPacks.module.css";
import { GitHubInstall, usePackInstall } from "./PackInstall.tsx";
import { PackLabel } from "./PackLabel.tsx";
import { PackSelect } from "./PackSelect.tsx";
import { PackViewer, type PackView } from "./PackViews.tsx";
import type { InstalledPack } from "./packs.ts";
import { problemText, sourceText } from "./packText.ts";

/** How a pack's page opens from here: which of its pages, for which model. */
interface ViewOptions {
  readonly view?: PackView;
  readonly model?: string;
}

/**
 * The page of model packs in the settings (docs/design/settings-and-properties.md of AnimaQuill
 * Cloud, 8.2), in the order of what people come here for: which pack each model that is on uses,
 * and another one; installing a new one (from GitHub, a folder or a pack.json on this computer;
 * "发现" joins them with S-P2); and the packs
 * installed, with their updates (looked for as the page opens, see `ModelPacks.lookForUpdates`),
 * where they are from, which models use them, reading a pack from this computer again, and removing
 * one. AnimaQuill's own come last, in one line. A pack's page (README, what it changes, a comparison,
 * all a model gets) goes one level in, in place of the page. Chosen here, a pack comes with the next
 * conversation.
 */
export function ModelPacksSettings() {
  const { ai, packs, chat, settingsNav } = useWorkbench();
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const place = useSyncExternalStore(settingsNav.subscribe, settingsNav.getSnapshot);
  const install = usePackInstall();
  const [fromGitHub, setFromGitHub] = useState(false);
  const [viewOptions, setViewOptions] = useState<ViewOptions>({});

  // As the page opens: what GitHub has newer, each pack at most every few hours.
  useEffect(() => {
    void packs.lookForUpdates();
  }, [packs]);

  const open = (pack: string, options: ViewOptions = {}) => {
    setViewOptions(options);
    settingsNav.go({ group: "packs", depth: 2, pack });
  };
  const viewing = place.group === "packs" && place.depth >= 2 ? place.pack : undefined;

  if (viewing !== undefined) {
    return (
      <section className={styles.packs} aria-label={t("ai.packs.title")} data-testid="model-packs">
        <PackViewer
          key={viewing}
          pack={viewing}
          {...viewOptions}
          back={t("ai.packs.title")}
          onClose={() => settingsNav.go({ group: "packs", depth: 1 })}
        />
      </section>
    );
  }

  // Each model that is on, with the service it is on in: once, as the choice is by model.
  const models = enabledModelsOf(settings).map((model) => {
    const service = settings.services.find(({ enabled }) => enabled.includes(model));
    return {
      model,
      service: service?.name ?? "",
      name: (service && ai.modelOf(service.id, model)?.name) ?? model,
    };
  });
  /** The models that are on and use a pack now. */
  const usedBy = (id: string) =>
    models.filter(({ model }) => chat.packOptions(model).current.id === id).map(({ name }) => name);
  // Hidden packs show only when people ask, or where one is chosen.
  const chosenIds = new Set(Object.values(settings.packFor ?? {}));
  const builtins = snapshot.packs.filter(
    (pack) =>
      pack.builtin && (!pack.hidden || settings.showHiddenPacks === true || chosenIds.has(pack.id)),
  );
  const rate = [...snapshot.updates.values()].some(
    ({ latest }) => latest.state === "failed" && latest.failure === "rate",
  );

  return (
    <section className={styles.packs} aria-label={t("ai.packs.title")} data-testid="model-packs">
      <h2 className={settingsStyles.group}>{t("ai.packs.title")}</h2>
      <p className={settingsStyles.help}>{t("ai.packs.intro")}</p>

      {/* `data-setting`: what searching the settings goes to, see settings/registry.ts. */}
      <h3 className={styles.heading} data-setting="packs.choice">
        {t("ai.packs.perModel")}
      </h3>
      {models.length === 0 && <p className={settingsStyles.none}>{t("ai.packs.noModels")}</p>}
      <div className={styles.table} role="list">
        {models.map(({ model, service, name }) => {
          const options = chat.packOptions(model);
          return (
            <div
              key={model}
              className={styles.modelRow}
              role="listitem"
              data-testid="pack-service"
              data-model={model}
            >
              <span className={styles.modelName} title={`${service} · ${model}`}>
                <strong>{name}</strong>
                <small>
                  {service} · {model}
                </small>
              </span>
              <span className={styles.modelChoose}>
                <PackSelect
                  model={model}
                  onChoose={(pack) => chat.choosePack(model, pack, "next")}
                />
              </span>
              <span className={styles.modelPack} data-testid="pack-using">
                {options.chosen && (
                  <span className={styles.tag} data-kind="mine">
                    {t("ai.packs.byChosen")}
                  </span>
                )}
              </span>
              <span className={styles.modelLinks}>
                <button
                  type="button"
                  className={settingsStyles.link}
                  data-testid="pack-details"
                  onClick={() => open(options.current.id, { model })}
                >
                  {t("ai.packs.details")}
                </button>
                {options.chosen && (
                  <button
                    type="button"
                    className={settingsStyles.link}
                    data-testid="pack-reset"
                    onClick={() => chat.choosePack(model, undefined, "next")}
                  >
                    {t("ai.packs.reset")}
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <h3 className={styles.heading}>{t("ai.packs.installSection")}</h3>
      <p className={settingsStyles.help}>{t("ai.packs.installSectionHelp")}</p>
      <div className={styles.install} data-testid="pack-install-ways">
        <button
          type="button"
          className={`${settingsStyles.button} ${styles.primary}`}
          data-testid="pack-install-github"
          onClick={() => {
            install.clearFailure();
            setFromGitHub(true);
          }}
        >
          {t("ai.packs.installGitHub")}
        </button>
        <button
          type="button"
          className={settingsStyles.button}
          data-testid="pack-install-folder"
          onClick={() => install.pickFolder()}
        >
          {t("ai.packs.installFolder")}
        </button>
        <button
          type="button"
          className={settingsStyles.button}
          data-testid="pack-install-file"
          onClick={() => install.pickFile()}
        >
          {t("ai.packs.installFile")}
        </button>
      </div>

      <h3 className={styles.heading} data-setting="packs.installed">
        {t("ai.packs.installedCount", { count: snapshot.installed.length })}
      </h3>
      {snapshot.installed.length === 0 && (
        <p className={settingsStyles.help} data-testid="pack-none-installed">
          {t("ai.packs.noneInstalled")}{" "}
          <a href={t("ai.packs.formatUrl")} target="_blank" rel="noopener noreferrer">
            {t("ai.packs.formatLink")}
          </a>
        </p>
      )}
      <ul className={styles.installedList}>
        {snapshot.installed.map((installed) => (
          <InstalledRow
            key={installed.id}
            installed={installed}
            usedBy={usedBy(installed.id)}
            busy={install.busy !== undefined}
            onSeeUpdate={() => {
              if (installed.kept.source.kind === "github") {
                void install.fromGitHub(installed.kept.source.url, installed);
              }
            }}
            onReread={() =>
              installed.kept.source.kind === "file"
                ? install.pickFile(installed)
                : install.pickFolder(installed)
            }
            onDetails={() => open(installed.id)}
            onRemove={() => void install.remove(installed)}
          />
        ))}
        <li className={styles.installedItem} data-testid="pack-builtins">
          <div className={styles.installedMain}>
            <span className={styles.builtinNames}>
              {builtins.map((pack, index) => (
                <span key={pack.id}>
                  {index > 0 && " · "}
                  <button
                    type="button"
                    className={styles.nameLink}
                    data-testid="pack-builtin"
                    data-pack={pack.id}
                    title={t("ai.packs.details")}
                    onClick={() => open(pack.id)}
                  >
                    <PackLabel pack={pack} />
                  </button>
                  {pack.hidden && (
                    <span className={styles.tag} data-testid="pack-hidden-tag">
                      {t("ai.packs.hiddenTag")}
                    </span>
                  )}
                </span>
              ))}
            </span>
            <small>{t("ai.packs.builtinLine")}</small>
          </div>
        </li>
      </ul>
      {rate && (
        <p className={settingsStyles.warning} data-testid="pack-rate">
          {t("ai.packs.github.rateLater")}
        </p>
      )}

      <label className={styles.showHidden} data-setting="packs.hidden">
        <input
          type="checkbox"
          checked={settings.showHiddenPacks === true}
          onChange={(event) => ai.setShowHiddenPacks(event.target.checked)}
          data-testid="pack-show-hidden"
        />
        <span>
          {t("ai.packs.showHidden")}
          <small>{t("ai.packs.showHiddenHelp")}</small>
        </span>
      </label>

      {install.failure && !fromGitHub && (
        <p className={settingsStyles.warning} role="alert" data-testid="pack-failure">
          {install.failure}
        </p>
      )}
      {fromGitHub && <GitHubInstall install={install} onClose={() => setFromGitHub(false)} />}
      {install.element}
    </section>
  );
}

/**
 * One pack installed: its label, version and update; where it is from and which models use it; and
 * what can be done with it. What of it this version of the tools goes without, why it is not used,
 * and a name that does not keep to the rules, under it.
 */
function InstalledRow(props: {
  readonly installed: InstalledPack;
  readonly usedBy: readonly string[];
  readonly busy: boolean;
  readonly onSeeUpdate: () => void;
  readonly onReread: () => void;
  readonly onDetails: () => void;
  readonly onRemove: () => void;
}) {
  const { packs } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const { installed, usedBy } = props;
  const { pack, kept } = installed;
  const update = packs.updateOf(installed.id);
  const looking = snapshot.looking.has(installed.id);
  const local = kept.source.kind === "folder" || kept.source.kind === "file";
  const facts = [
    sourceText(t, kept.source),
    usedBy.length > 0
      ? t("ai.packs.usedBy", { models: usedBy.join("、") })
      : t("ai.packs.usedByNone"),
    pack &&
      (pack.models.length > 0
        ? t("ai.packs.models", { models: pack.models.join(", ") })
        : t("ai.packs.modelsNone")),
  ].filter(Boolean);
  return (
    <li className={styles.installedItem} data-testid="pack-item" data-pack={installed.id}>
      <div className={styles.installedMain}>
        <span className={styles.installedHead}>
          <PackLabel
            pack={pack ?? { id: installed.id, name: installed.id, builtin: false }}
            className={styles.installedName}
            testId="pack-item-label"
          />
          {pack && <span className={styles.badge}>v{pack.version}</span>}
          {update && (
            <span className={styles.badge} data-kind="update" data-testid="pack-update">
              {update.version
                ? t("ai.packs.updateTo", { version: update.version })
                : t("ai.packs.updateCommit", { commit: update.commit.slice(0, 7) })}
            </span>
          )}
          {looking && <small data-testid="pack-looking">{t("ai.packs.checking")}</small>}
        </span>
        <small data-testid="pack-item-facts">{facts.join(" · ")}</small>
        {pack && nameIssues(pack.name).length > 0 && (
          <small className={settingsStyles.warning} data-testid="pack-name-issue">
            {t("ai.packs.nameNotAllowedHelp")}
          </small>
        )}
        {installed.dropped.length > 0 && (
          <small className={settingsStyles.warning} data-testid="pack-dropped">
            {t("ai.packs.dropped", { count: installed.dropped.length })}
            {installed.dropped.map((problem: PackProblem, index) => (
              <span key={index} className={styles.droppedLine}>
                {problemText(t, problem)}
              </span>
            ))}
          </small>
        )}
        {!pack && (
          <small className={settingsStyles.warning}>
            {t("ai.packs.disabled", {
              reason: installed.problems
                .map((problem: PackProblem) => problemText(t, problem))
                .join(" "),
            })}
          </small>
        )}
      </div>
      <span className={styles.installedActions}>
        {update && (
          <button
            type="button"
            className={`${settingsStyles.button} ${styles.primary}`}
            data-testid="pack-see-update"
            disabled={props.busy}
            onClick={props.onSeeUpdate}
          >
            {t("ai.packs.seeUpdate")}
          </button>
        )}
        {local && (
          <button
            type="button"
            className={settingsStyles.button}
            data-testid="pack-reread"
            onClick={props.onReread}
          >
            {t("ai.packs.reread")}
          </button>
        )}
        <button
          type="button"
          className={settingsStyles.link}
          data-testid="pack-item-details"
          onClick={props.onDetails}
        >
          {t("ai.packs.details")}
        </button>
        <button
          type="button"
          className={`${settingsStyles.link} ${settingsStyles.danger}`}
          data-testid="pack-remove"
          onClick={props.onRemove}
        >
          {t("ai.packs.remove")}
        </button>
      </span>
    </li>
  );
}
