import { enabledModelsOf } from "@animaquill/agent";
import { checkPack, DEFAULT_PACK, type ModelPack, type PackProblem } from "@animaquill/tools";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import dialogStyles from "../app/DialogHost.module.css";
import settingsStyles from "./AiSettings.module.css";
import styles from "./ModelPacks.module.css";
import { PackDialog, type PackDialogChoice, type PackDialogProps } from "./PackDialog.tsx";
import { PackSelect } from "./PackSelect.tsx";
import { PackViewer, type PackViewRequest } from "./PackViews.tsx";
import {
  readFolder,
  readGitHub,
  readManifestFile,
  textFiles,
  type InstalledPack,
  type PackInput,
  type PackSource,
} from "./packs.ts";
import { authorText, packLabel, packName, problemText, sourceText } from "./packText.ts";

/** What the dialog shows now, with what installing it takes. */
type Pending = Omit<PackDialogProps, "onClose" | "onConfirm"> & {
  readonly input?: PackInput;
};

/**
 * The page of model packs in the settings: on top which pack each model that is on uses, with
 * another to choose, back to the one recommended, and its details, all it gets and a comparison;
 * below the packs there are, with installing (from a folder, a pack.json or GitHub), looking for an
 * update and removing, and whether the hidden pack to compare with shows. Details, all a model gets
 * and comparisons go one level in, in place of the page, with a way back. A model without a pack
 * of its own uses the default one, which is said here and in the chat, and nothing asks. Chosen
 * here, a pack comes with the next conversation.
 */
export function ModelPacksSettings() {
  const { ai, packs, chat, dialogs, notifications } = useWorkbench();
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const [pending, setPending] = useState<Pending | undefined>();
  const [viewing, setViewing] = useState<PackViewRequest | undefined>();
  const [installing, setInstalling] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const folder = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);

  /**
   * Checks what was read, and shows it: to install, as an update, or why it cannot be. Looking for
   * an update of one pack only takes that pack: another id there is said, not shown to install.
   */
  const prepare = (input: PackInput, source: PackSource, update?: InstalledPack) => {
    setFailure(undefined);
    const check = checkPack(input);
    if (!check.pack) {
      setPending({ mode: "install", pack: undefined, problems: check.problems, source });
      return;
    }
    if (update && check.pack.id !== update.id) {
      setFailure(
        t("ai.packs.otherPack", {
          id: check.pack.id,
          name: update.pack ? packName(t, update.pack) : update.id,
        }),
      );
      return;
    }
    const before = packs.installedOf(check.pack.id);
    setPending({
      mode: before?.pack ? "update" : "install",
      pack: check.pack,
      installed: before?.pack,
      installedSource: before?.kept.source,
      source,
      input,
    });
  };

  /** Whatever goes wrong on the way: this pack cannot be installed, and nothing else changes. */
  const safely = async (run: () => Promise<void> | void) => {
    try {
      await run();
    } catch (error) {
      console.warn("A model pack could not be read", error);
      setBusy(undefined);
      setFailure(t("ai.packs.unexpected"));
    }
  };

  const confirm = ({ switchTo, keep }: PackDialogChoice) => {
    const { input, source, pack } = pending ?? {};
    setPending(undefined);
    if (!input || !source || !pack) return;
    const check = packs.install(textFiles(input), source);
    if (!check.pack) return;
    if (switchTo.length > 0) ai.choosePack(switchTo, pack.id);
    for (const id of new Set(keep.map((each) => each.pack))) {
      ai.choosePack(
        keep.filter((each) => each.pack === id).map(({ model }) => model),
        id,
      );
    }
  };

  const fromGitHub = (url: string, update?: InstalledPack) =>
    safely(async () => {
      setBusy(url);
      setFailure(undefined);
      const read = await readGitHub(url);
      setBusy(undefined);
      if (!read.ok) {
        setFailure(t(`ai.packs.github.${read.failure}`));
        return;
      }
      setInstalling(false);
      if (
        update?.kept.source.kind === "github" &&
        update.kept.source.commit === read.source.commit
      ) {
        notifications.push(t("ai.packs.upToDate", { name: update.pack?.name ?? update.id }));
        return;
      }
      prepare(read.files, read.source, update);
    });

  const remove = async (installed: InstalledPack) => {
    const sure = await dialogs.confirm({
      title: t("ai.packs.remove"),
      message: t("ai.packs.removeConfirm", { name: installed.pack?.name ?? installed.id }),
      confirm: t("ai.packs.remove"),
      danger: true,
    });
    if (!sure) return;
    packs.remove(installed.id);
    ai.forgetPack(installed.id);
  };

  const view = (request: PackViewRequest) => setViewing(request);
  const details = (pack: string, model?: string) =>
    view({ view: "details", pack, ...(model !== undefined && { model }) });

  // Each model that is on, with the service it is on in: once, as the choice is by model.
  const models = enabledModelsOf(settings).map((model) => {
    const service = settings.services.find(({ enabled }) => enabled.includes(model));
    return {
      model,
      service: service?.name ?? "",
      name: (service && ai.modelOf(service.id, model)?.name) ?? model,
    };
  });
  // Hidden packs show only when people ask, or where one is chosen.
  const chosenIds = new Set(Object.values(settings.packFor ?? {}));
  const shown = (pack: ModelPack) =>
    !pack.hidden || settings.showHiddenPacks === true || chosenIds.has(pack.id);
  const builtins = snapshot.packs.filter((pack) => pack.builtin && shown(pack));
  const fileInputs = (
    <>
      <input
        ref={folder}
        type="file"
        hidden
        data-testid="pack-folder-input"
        // Folders, in every browser that runs the editor.
        {...({ webkitdirectory: "" } as Record<string, string>)}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length === 0) return;
          setInstalling(false);
          const first =
            (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
          void safely(async () =>
            prepare(await readFolder(files), {
              kind: "folder",
              name: first.split("/")[0] || "?",
            }),
          );
        }}
      />
      <input
        ref={file}
        type="file"
        hidden
        accept=".json,application/json"
        data-testid="pack-file-input"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (!chosen) return;
          setInstalling(false);
          void safely(async () =>
            prepare(await readManifestFile(chosen), { kind: "file", name: chosen.name }),
          );
        }}
      />
    </>
  );

  if (viewing) {
    return (
      <section className={styles.packs} aria-label={t("ai.packs.title")} data-testid="model-packs">
        <PackViewer {...viewing} back={t("ai.packs.title")} onClose={() => setViewing(undefined)} />
      </section>
    );
  }

  return (
    <section className={styles.packs} aria-label={t("ai.packs.title")} data-testid="model-packs">
      <h2 className={settingsStyles.group}>{t("ai.packs.title")}</h2>
      <p className={settingsStyles.help}>{t("ai.packs.intro")}</p>

      <h3 className={styles.heading}>{t("ai.packs.perModel")}</h3>
      {models.length === 0 && <p className={settingsStyles.none}>{t("ai.packs.noModels")}</p>}
      <div className={styles.table} role="list">
        {models.map(({ model, service, name }) => {
          const options = chat.packOptions(model);
          const now = options.current;
          const recommended = options.recommended;
          // What to compare it with: the one recommended where people chose another, else the
          // default words.
          const base = options.chosen && recommended.id !== now.id ? recommended : DEFAULT_PACK;
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
              <span className={styles.modelPack} data-testid="pack-using">
                <span>{packLabel(t, now)}</span>
                <span className={styles.tag} data-kind={options.chosen ? "mine" : "recommended"}>
                  {options.chosen ? t("ai.packs.byChosen") : t("ai.packs.byRecommended")}
                </span>
                {now.id === DEFAULT_PACK.id && (
                  <small data-testid="pack-none">{t("ai.packs.noMatchShort")}</small>
                )}
              </span>
              <span className={styles.modelChoose}>
                <PackSelect
                  model={model}
                  onChoose={(pack) => chat.choosePack(model, pack, "next")}
                />
              </span>
              <span className={styles.modelLinks}>
                <button
                  type="button"
                  className={settingsStyles.link}
                  onClick={() => details(now.id, model)}
                >
                  {t("ai.packs.details")}
                </button>
                <button
                  type="button"
                  className={settingsStyles.link}
                  data-testid="pack-preview-open"
                  onClick={() => view({ view: "full", pack: now.id, model })}
                >
                  {t("ai.packs.fullText")}
                </button>
                {base.id !== now.id && (
                  <button
                    type="button"
                    className={settingsStyles.link}
                    data-testid="pack-compare-model"
                    onClick={() => view({ view: "compare", pack: base.id, other: now.id, model })}
                  >
                    {t("ai.packs.compareShort")}
                  </button>
                )}
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

      <div className={styles.headingRow}>
        <h3 className={styles.heading}>{t("ai.packs.installed")}</h3>
        <span className={styles.grow} />
        <button
          type="button"
          className={settingsStyles.button}
          data-testid="pack-compare-open"
          onClick={() =>
            view({
              view: "compare",
              pack: DEFAULT_PACK.id,
              other: snapshot.installed.find(({ pack }) => pack)?.id ?? "animaquill/claude-5",
              ...(models[0] && { model: models[0].model }),
            })
          }
        >
          {t("ai.packs.compare")}
        </button>
        <button
          type="button"
          className={`${settingsStyles.button} ${styles.primary}`}
          data-testid="pack-install-open"
          onClick={() => {
            setFailure(undefined);
            setInstalling(true);
          }}
        >
          {t("ai.packs.install")}
        </button>
      </div>
      <ul className={styles.list}>
        {builtins.map((pack) => (
          <li key={pack.id} className={styles.item} data-testid="pack-item" data-pack={pack.id}>
            <strong>{packLabel(t, pack)}</strong>
            {pack.hidden && <span className={styles.tag}>{t("ai.packs.hiddenTag")}</span>}
            <span>{t("ai.packs.version", { version: pack.version })}</span>
            <button type="button" className={settingsStyles.link} onClick={() => details(pack.id)}>
              {t("ai.packs.details")}
            </button>
            <small>
              {pack.models.length > 0
                ? t("ai.packs.models", { models: pack.models.join(", ") })
                : pack.hidden
                  ? t("ai.packs.modelsHidden")
                  : t("ai.packs.modelsNone")}
            </small>
          </li>
        ))}
        {snapshot.installed.map((installed) => {
          const { pack, kept } = installed;
          return (
            <li
              key={installed.id}
              className={styles.item}
              data-testid="pack-item"
              data-pack={installed.id}
            >
              <strong>{pack ? packLabel(t, pack) : installed.id}</strong>
              {pack && <span>{authorText(t, pack)}</span>}
              {pack && <span>{t("ai.packs.version", { version: pack.version })}</span>}
              <button
                type="button"
                className={settingsStyles.link}
                onClick={() => details(installed.id)}
              >
                {t("ai.packs.details")}
              </button>
              {kept.source.kind === "github" && (
                <button
                  type="button"
                  className={settingsStyles.link}
                  disabled={busy !== undefined}
                  onClick={() =>
                    kept.source.kind === "github" && void fromGitHub(kept.source.url, installed)
                  }
                >
                  {busy === kept.source.url ? t("ai.packs.checking") : t("ai.packs.checkUpdate")}
                </button>
              )}
              <button
                type="button"
                className={settingsStyles.link}
                onClick={() => void remove(installed)}
              >
                {t("ai.packs.remove")}
              </button>
              <small>
                {sourceText(t, kept.source)}
                {pack &&
                  pack.models.length > 0 &&
                  ` · ${t("ai.packs.models", { models: pack.models.join(", ") })}`}
              </small>
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
            </li>
          );
        })}
      </ul>

      <label className={styles.showHidden}>
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

      {failure && (
        <p className={settingsStyles.warning} role="alert">
          {failure}
        </p>
      )}
      {fileInputs}

      {installing && (
        <InstallChooser
          address={address}
          busy={busy}
          failure={failure}
          onAddress={setAddress}
          onFolder={() => folder.current?.click()}
          onFile={() => file.current?.click()}
          onGitHub={() => void fromGitHub(address)}
          onClose={() => setInstalling(false)}
        />
      )}
      {pending && (
        <PackDialog {...pending} onConfirm={confirm} onClose={() => setPending(undefined)} />
      )}
    </section>
  );
}

/**
 * Where a pack comes from, to install it: a folder, a pack.json, or a folder on GitHub. What is
 * read then shows in the install dialog (`PackDialog`), and nothing is kept before people say so.
 */
function InstallChooser(props: {
  readonly address: string;
  readonly busy: string | undefined;
  readonly failure: string | undefined;
  readonly onAddress: (address: string) => void;
  readonly onFolder: () => void;
  readonly onFile: () => void;
  readonly onGitHub: () => void;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={dialogStyles.wide}
      aria-label={t("ai.packs.installTitle")}
      data-testid="pack-install"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <div className={dialogStyles.content}>
        <h2>{t("ai.packs.installTitle")}</h2>
        <p>{t("ai.packs.installHelp")}</p>
        <div className={styles.install}>
          <button type="button" className={settingsStyles.button} onClick={props.onFolder}>
            {t("ai.packs.installFolder")}
          </button>
          <button type="button" className={settingsStyles.button} onClick={props.onFile}>
            {t("ai.packs.installFile")}
          </button>
        </div>
        <div className={styles.install}>
          <input
            type="url"
            value={props.address}
            spellCheck={false}
            aria-label={t("ai.packs.installGitHub")}
            placeholder={t("ai.packs.githubPlaceholder")}
            onChange={(event) => props.onAddress(event.target.value)}
          />
          <button
            type="button"
            className={settingsStyles.button}
            disabled={props.address.trim() === "" || props.busy !== undefined}
            onClick={props.onGitHub}
          >
            {props.busy === props.address ? t("ai.packs.fetching") : t("ai.packs.installGitHub")}
          </button>
        </div>
        {props.failure && (
          <p className={settingsStyles.warning} role="alert">
            {props.failure}
          </p>
        )}
        <div className={dialogStyles.buttons}>
          <button type="button" onClick={props.onClose}>
            {t("ai.packs.dialog.close")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
