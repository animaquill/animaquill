import { checkPack, type ModelPack, type PackProblem } from "@animaquill/tools";
import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import settingsStyles from "./AiServicesSettings.module.css";
import styles from "./ModelPacks.module.css";
import { PackDialog, type PackDialogChoice, type PackDialogProps } from "./PackDialog.tsx";
import { PackViewer, type PackViewerProps } from "./PackViews.tsx";
import {
  readFolder,
  readGitHub,
  readManifestFile,
  textFiles,
  type InstalledPack,
  type PackInput,
  type PackSource,
} from "./packs.ts";
import { packLabel, packName, problemText, sourceText } from "./packText.ts";

const AUTO = "";

/** What the dialog shows now, with what installing it takes. */
type Pending = Omit<PackDialogProps, "onClose" | "onConfirm"> & {
  readonly input?: PackInput;
};

/**
 * Model packs, in the settings of AI services: which pack each service's model uses and a choice
 * of another, the packs there are, and installing, updating and removing them. A model without a
 * pack of its own uses the default one, which is said here and in the chat, and nothing asks.
 */
export function ModelPacksSettings() {
  const { ai, packs, chat, dialogs, notifications } = useWorkbench();
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const [pending, setPending] = useState<Pending | undefined>();
  const [viewing, setViewing] = useState<Omit<PackViewerProps, "onClose"> | undefined>();
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

  const view = (id: string) => setViewing({ view: "details", pack: id });

  const services = settings.services.filter(({ model }) => model !== "");
  // Hidden packs show only when people ask, or where one is chosen.
  const shown = (pack: ModelPack, chosen?: string) =>
    !pack.hidden || settings.showHiddenPacks === true || pack.id === chosen;
  return (
    <section className={styles.packs} aria-label={t("ai.packs.title")} data-testid="model-packs">
      <h2 className={settingsStyles.group}>{t("ai.packs.title")}</h2>
      <p className={settingsStyles.help}>{t("ai.packs.intro")}</p>

      {services.length === 0 && <p className={settingsStyles.none}>{t("ai.packs.noModels")}</p>}
      {services.map((service) => {
        const chosen = settings.packFor?.[service.model];
        const automatic = packs.choose(service.model, undefined);
        const now = chat.choiceFor(service.model);
        return (
          <div key={service.id} data-testid="pack-service">
            <label className={styles.service}>
              <span title={service.model}>
                {service.name} · {service.model}
              </span>
              <select
                aria-label={t("ai.packs.choose", { model: service.model })}
                value={chosen !== undefined && packs.packOf(chosen) ? chosen : AUTO}
                onChange={(event) =>
                  ai.choosePack(
                    [service.model],
                    event.target.value === AUTO ? undefined : event.target.value,
                  )
                }
              >
                <option value={AUTO}>
                  {automatic.by === "fallback"
                    ? t("ai.packs.autoNone")
                    : t("ai.packs.auto", { name: packLabel(t, automatic.pack) })}
                </option>
                {snapshot.packs
                  .filter((pack) => shown(pack, chosen))
                  .map((pack) => (
                    <option key={pack.id} value={pack.id}>
                      {packLabel(t, pack)}
                    </option>
                  ))}
              </select>
            </label>
            <p className={styles.using} data-testid="pack-using">
              {t(now.pack.builtin ? "ai.packs.usingBuiltin" : "ai.packs.usingThirdParty", {
                name: packLabel(t, now.pack),
              })}{" "}
              <button
                type="button"
                className={settingsStyles.link}
                data-testid="pack-preview-open"
                onClick={() =>
                  setViewing({ view: "full", pack: now.pack.id, model: service.model })
                }
              >
                {t("ai.packs.preview.open")}
              </button>
            </p>
            {now.note.by === "fallback" && (
              <p className={settingsStyles.help} data-testid="pack-none">
                {t("ai.packs.noMatch")}
              </p>
            )}
          </div>
        );
      })}

      <h3 className={settingsStyles.group}>
        {t("ai.packs.installed")}{" "}
        <button
          type="button"
          className={settingsStyles.link}
          data-testid="pack-compare-open"
          onClick={() =>
            setViewing({
              view: "compare",
              pack: "animaquill/default",
              other: snapshot.installed.find(({ pack }) => pack)?.id ?? "animaquill/claude-5",
              ...(services[0] && { model: services[0].model }),
            })
          }
        >
          {t("ai.packs.compare")}
        </button>
      </h3>
      <ul className={styles.list}>
        {snapshot.packs
          .filter((pack) => pack.builtin && shown(pack))
          .map((pack) => (
            <li key={pack.id} className={styles.item} data-testid="pack-item">
              <strong>{packLabel(t, pack)}</strong>
              <span>{t("ai.packs.version", { version: pack.version })}</span>
              <button type="button" className={settingsStyles.link} onClick={() => view(pack.id)}>
                {t("ai.packs.view")}
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
            <li key={installed.id} className={styles.item} data-testid="pack-item">
              <strong>{pack ? packLabel(t, pack) : installed.id}</strong>
              {pack && <span>{t("ai.packs.version", { version: pack.version })}</span>}
              <button
                type="button"
                className={settingsStyles.link}
                onClick={() => view(installed.id)}
              >
                {t("ai.packs.view")}
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

      <label className={styles.agree}>
        <input
          type="checkbox"
          checked={settings.showHiddenPacks === true}
          onChange={(event) => ai.setShowHiddenPacks(event.target.checked)}
          data-testid="pack-show-hidden"
        />
        {t("ai.packs.showHidden")}
      </label>

      <div className={styles.install}>
        <button type="button" onClick={() => folder.current?.click()}>
          {t("ai.packs.installFolder")}
        </button>
        <button type="button" onClick={() => file.current?.click()}>
          {t("ai.packs.installFile")}
        </button>
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
            if (chosen) {
              void safely(async () =>
                prepare(await readManifestFile(chosen), { kind: "file", name: chosen.name }),
              );
            }
          }}
        />
      </div>
      <div className={styles.install}>
        <input
          type="url"
          value={address}
          spellCheck={false}
          aria-label={t("ai.packs.installGitHub")}
          placeholder={t("ai.packs.githubPlaceholder")}
          onChange={(event) => setAddress(event.target.value)}
        />
        <button
          type="button"
          disabled={address.trim() === "" || busy !== undefined}
          onClick={() => void fromGitHub(address)}
        >
          {busy === address ? t("ai.packs.fetching") : t("ai.packs.installGitHub")}
        </button>
      </div>
      <p className={settingsStyles.help}>{t("ai.packs.installHelp")}</p>
      {failure && (
        <p className={settingsStyles.warning} role="alert">
          {failure}
        </p>
      )}

      {pending && (
        <PackDialog {...pending} onConfirm={confirm} onClose={() => setPending(undefined)} />
      )}
      {viewing && <PackViewer {...viewing} onClose={() => setViewing(undefined)} />}
    </section>
  );
}
