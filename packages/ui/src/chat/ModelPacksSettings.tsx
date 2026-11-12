import { checkPack, type ModelPack, type PackProblem } from "@animaquill/tools";
import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import settingsStyles from "./AiServicesSettings.module.css";
import styles from "./ModelPacks.module.css";
import { PackDialog, type PackDialogProps } from "./PackDialog.tsx";
import {
  readFolder,
  readGitHub,
  readManifestFile,
  textFiles,
  type InstalledPack,
  type PackInput,
  type PackSource,
} from "./packs.ts";
import { packLabel, problemText, sourceText } from "./packText.ts";

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
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const folder = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);

  /** Checks what was read, and shows it: to install, as an update, or why it cannot be. */
  const prepare = (input: PackInput, source: PackSource) => {
    setFailure(undefined);
    const check = checkPack(input);
    if (!check.pack) {
      setPending({ mode: "install", pack: undefined, problems: check.problems, source });
      return;
    }
    const before = packs.installedOf(check.pack.id)?.pack;
    setPending({
      mode: before ? "update" : "install",
      pack: check.pack,
      installed: before,
      source,
      input,
    });
  };

  const confirm = (models: readonly string[]) => {
    const { input, source, pack } = pending ?? {};
    setPending(undefined);
    if (!input || !source || !pack) return;
    const check = packs.install(textFiles(input), source);
    if (!check.pack) return;
    if (models.length > 0) ai.choosePack(models, pack.id);
  };

  const fromGitHub = async (url: string, update?: InstalledPack) => {
    setBusy(url);
    setFailure(undefined);
    const read = await readGitHub(url);
    setBusy(undefined);
    if (!read.ok) {
      setFailure(t(`ai.packs.github.${read.failure}`));
      return;
    }
    if (update?.kept.source.kind === "github" && update.kept.source.commit === read.source.commit) {
      notifications.push(t("ai.packs.upToDate", { name: update.pack?.name ?? update.id }));
      return;
    }
    prepare(read.files, read.source);
  };

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

  const view = (pack: ModelPack, source?: PackSource) =>
    setPending({ mode: "view", pack, ...(source && { source }) });

  const services = settings.services.filter(({ model }) => model !== "");
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
                {snapshot.packs.map((pack) => (
                  <option key={pack.id} value={pack.id}>
                    {packLabel(t, pack)}
                  </option>
                ))}
              </select>
            </label>
            {now.note.by === "fallback" && (
              <p className={settingsStyles.help} data-testid="pack-none">
                {t("ai.packs.noMatch")}
              </p>
            )}
          </div>
        );
      })}

      <h3 className={settingsStyles.group}>{t("ai.packs.installed")}</h3>
      <ul className={styles.list}>
        {snapshot.packs
          .filter(({ builtin }) => builtin)
          .map((pack) => (
            <li key={pack.id} className={styles.item} data-testid="pack-item">
              <strong>{packLabel(t, pack)}</strong>
              <span>{t("ai.packs.version", { version: pack.version })}</span>
              <button type="button" className={settingsStyles.link} onClick={() => view(pack)}>
                {t("ai.packs.view")}
              </button>
              <small>
                {pack.models.length > 0
                  ? t("ai.packs.models", { models: pack.models.join(", ") })
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
              {pack && (
                <button
                  type="button"
                  className={settingsStyles.link}
                  onClick={() => view(pack, kept.source)}
                >
                  {t("ai.packs.view")}
                </button>
              )}
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
                <small className={settingsStyles.warning}>
                  {t("ai.packs.dropped", { count: installed.dropped.length })}
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
          onChange={async (event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length === 0) return;
            const first =
              (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
            prepare(await readFolder(files), { kind: "folder", name: first.split("/")[0] || "?" });
          }}
        />
        <input
          ref={file}
          type="file"
          hidden
          accept=".json,application/json"
          data-testid="pack-file-input"
          onChange={async (event) => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            if (chosen)
              prepare(await readManifestFile(chosen), { kind: "file", name: chosen.name });
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
    </section>
  );
}
