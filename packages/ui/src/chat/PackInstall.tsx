import { checkPack } from "@animaquill/tools";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import dialogStyles from "../app/DialogHost.module.css";
import settingsStyles from "./AiSettings.module.css";
import styles from "./ModelPacks.module.css";
import { PackDialog, type PackDialogChoice, type PackDialogProps } from "./PackDialog.tsx";
import {
  readFolder,
  readFolderReadme,
  readGitHub,
  readManifestFile,
  textFiles,
  type GitHubRead,
  type InstalledPack,
  type PackInput,
  type PackReadme,
  type PackSource,
} from "./packs.ts";
import { packName } from "./packText.ts";

/** What the dialog shows now, with what installing it takes. */
type Pending = Omit<PackDialogProps, "onClose" | "onConfirm"> & {
  readonly input?: PackInput;
};

/** Installing, updating and removing model packs, the same from the page of packs and a pack's page. */
export interface PackInstall {
  /**
   * A pack from GitHub: to install, or, with `update`, a new version of that one. Whether it got as
   * far as the dialog (or found the version installed is the newest).
   */
  fromGitHub(address: string, update?: InstalledPack): Promise<boolean>;
  /** Picks a folder on this computer: a pack to install, or a new version of `update`. */
  pickFolder(update?: InstalledPack): void;
  /** Picks a pack.json on this computer: a pack to install, or a new version of `update`. */
  pickFile(update?: InstalledPack): void;
  /** Asks, then removes a pack; the models it was chosen for go back to automatic. */
  remove(installed: InstalledPack): Promise<void>;
  /** The address being read from GitHub. */
  readonly busy: string | undefined;
  /** Why the last try did not get as far as the dialog. */
  readonly failure: string | undefined;
  clearFailure(): void;
  /** The dialog and the inputs of files: to put where this is used. */
  readonly element: ReactNode;
}

/**
 * What installing a pack takes: reading it (from GitHub, a folder or a pack.json), checking it, and
 * showing what it changes, its README a tab away (`PackDialog`); nothing is kept before people say
 * so. Looking at an update of one pack only takes that pack: another id there is said, not shown.
 */
export function usePackInstall(): PackInstall {
  const { ai, packs, dialogs, notifications } = useWorkbench();
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const folder = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  /** The pack a folder or file picked now is a new version of. */
  const updating = useRef<InstalledPack | undefined>(undefined);

  const prepare = (
    input: PackInput,
    source: PackSource,
    readme: PackReadme | undefined,
    update?: InstalledPack,
  ): boolean => {
    setFailure(undefined);
    const check = checkPack(input);
    if (!check.pack) {
      setPending({ mode: "install", pack: undefined, problems: check.problems, source, readme });
      return true;
    }
    if (update && check.pack.id !== update.id) {
      setFailure(
        t("ai.packs.otherPack", {
          id: check.pack.id,
          name: update.pack ? packName(t, update.pack) : update.id,
        }),
      );
      return false;
    }
    const before = packs.installedOf(check.pack.id);
    setPending({
      mode: before?.pack ? "update" : "install",
      pack: check.pack,
      installed: before?.pack,
      installedSource: before?.kept.source,
      source,
      readme,
      input,
    });
    return true;
  };

  /** Whatever goes wrong on the way: this pack cannot be installed, and nothing else changes. */
  const safely = async (run: () => Promise<boolean | void> | void): Promise<boolean> => {
    try {
      return (await run()) !== false;
    } catch (error) {
      console.warn("A model pack could not be read", error);
      setBusy(undefined);
      setFailure(t("ai.packs.unexpected"));
      return false;
    }
  };

  const confirm = ({ switchTo, keep }: PackDialogChoice) => {
    const { input, source, pack, readme } = pending ?? {};
    setPending(undefined);
    if (!input || !source || !pack) return;
    const check = packs.install(textFiles(input), source, readme);
    if (!check.pack) return;
    if (switchTo.length > 0) ai.choosePack(switchTo, pack.id);
    for (const id of new Set(keep.map((each) => each.pack))) {
      ai.choosePack(
        keep.filter((each) => each.pack === id).map(({ model }) => model),
        id,
      );
    }
  };

  const failureOf = (read: GitHubRead & { ok: false }): string =>
    t(`ai.packs.github.${read.failure}`, {
      tag: read.detail?.tag ?? "",
      version: read.detail?.version ?? "",
    });

  const fromGitHub = (url: string, update?: InstalledPack) =>
    safely(async () => {
      setBusy(url);
      setFailure(undefined);
      const read = await readGitHub(url);
      setBusy(undefined);
      if (!read.ok) {
        setFailure(failureOf(read));
        return false;
      }
      if (
        update?.kept.source.kind === "github" &&
        update.kept.source.commit === read.source.commit
      ) {
        notifications.push(t("ai.packs.upToDate", { name: update.pack?.name ?? update.id }));
        return true;
      }
      return prepare(read.files, read.source, read.readme, update);
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

  const element = (
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
          const update = updating.current;
          updating.current = undefined;
          if (files.length === 0) return;
          const first =
            (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
          void safely(async () => {
            prepare(
              await readFolder(files),
              { kind: "folder", name: first.split("/")[0] || "?" },
              await readFolderReadme(files),
              update,
            );
          });
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
          const update = updating.current;
          updating.current = undefined;
          if (!chosen) return;
          void safely(async () => {
            prepare(
              await readManifestFile(chosen),
              { kind: "file", name: chosen.name },
              undefined,
              update,
            );
          });
        }}
      />
      {pending && (
        <PackDialog {...pending} onConfirm={confirm} onClose={() => setPending(undefined)} />
      )}
    </>
  );

  return {
    fromGitHub,
    pickFolder: (update) => {
      updating.current = update;
      folder.current?.click();
    },
    pickFile: (update) => {
      updating.current = update;
      file.current?.click();
    },
    remove,
    busy,
    failure,
    clearFailure: () => setFailure(undefined),
    element,
  };
}

/**
 * Installing from GitHub: the address of a repository, as packs are now, or of a folder of one.
 * What is read then shows in the install dialog; nothing is kept before people say so.
 */
export function GitHubInstall(props: {
  readonly install: PackInstall;
  readonly onClose: () => void;
}) {
  const { install } = props;
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const go = async () => {
    if (await install.fromGitHub(address)) props.onClose();
  };
  return (
    <dialog
      ref={dialog}
      className={dialogStyles.wide}
      aria-label={t("ai.packs.installGitHubTitle")}
      data-testid="pack-install"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <form
        className={dialogStyles.content}
        onSubmit={(event) => {
          event.preventDefault();
          if (address.trim() !== "" && install.busy === undefined) void go();
        }}
      >
        <h2>{t("ai.packs.installGitHubTitle")}</h2>
        <p>{t("ai.packs.installGitHubHelp")}</p>
        <div className={styles.install}>
          <input
            type="url"
            value={address}
            autoFocus
            spellCheck={false}
            aria-label={t("ai.packs.githubAddress")}
            placeholder={t("ai.packs.githubPlaceholder")}
            onChange={(event) => {
              setAddress(event.target.value);
              install.clearFailure();
            }}
          />
          <button
            type="submit"
            className={`${settingsStyles.button} ${styles.primary}`}
            disabled={address.trim() === "" || install.busy !== undefined}
            data-testid="pack-github-read"
          >
            {install.busy === address ? t("ai.packs.fetching") : t("ai.packs.githubRead")}
          </button>
        </div>
        {install.failure && (
          <p className={settingsStyles.warning} role="alert" data-testid="pack-install-failure">
            {install.failure}
          </p>
        )}
        <div className={dialogStyles.buttons}>
          <button type="button" onClick={props.onClose}>
            {t("ai.packs.dialog.close")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
