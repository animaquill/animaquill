import type { LocalFolder } from "@animaquill/host";
import { Check, Circle, CircleAlert, FolderOpen, Globe, LoaderCircle, Lock } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectStepState } from "../cloud/steps.ts";
import type { PickerSnapshot, RepositoryPicker } from "../cloud/repository-picker.ts";
import type { DialogRequest } from "../workbench/dialogs.ts";
import type { ProjectFolders } from "../workbench/project-folders.ts";
import styles from "./CloudSteps.module.css";
import { createView } from "./create-view.ts";
import { useWorkbench } from "./context.ts";
import host from "./DialogHost.module.css";
import own from "./NewProjectDialog.module.css";
import repo from "./RepositoryDialog.module.css";
import { RepositoryFields } from "./RepositoryFields.tsx";

type CreateRequest = Extract<DialogRequest, { kind: "create" }>;

const STEP_ICONS: Readonly<Record<ConnectStepState, typeof Circle>> = {
  waiting: Circle,
  running: LoaderCircle,
  done: Check,
  failed: CircleAlert,
};

const noSubscription = () => () => {};
const noPicker = (): PickerSnapshot | undefined => undefined;

/**
 * "新建项目", see `CloudCreate` and the design of the start page, 3: what it is called, and whether
 * it is a project of this computer, a folder, or one of the platform, which gets its repository
 * here and is made in one press, with the steps as they run. "取消" takes back what the dialog
 * made, so that nothing is left halfway; once the project has its repository, the dialog only
 * closes.
 */
export function NewProjectDialog({ request }: { request: CreateRequest }) {
  const workbench = useWorkbench();
  const { dialogs } = workbench;
  const { t } = useTranslation();
  const { create } = request;
  const snapshot = useSyncExternalStore(create.subscribe, create.getSnapshot);
  const picked = useSyncExternalStore(
    create.picker?.subscribe ?? noSubscription,
    create.picker?.getSnapshot ?? noPicker,
  );
  const [putOff, setPutOff] = useState(false);
  const [kept, setKept] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    nameInput.current?.focus();
    nameInput.current?.select();
    return () => element?.close();
  }, []);

  const view = createView(
    {
      snapshot,
      mode: picked?.mode,
      canSubmit: create.canSubmit,
      formatValid: create.format !== undefined,
      imported: request.imported === true,
      putOff,
      kept,
      local: create.savesLocally,
    },
    t,
  );
  const leave = () => {
    if (dialogs.getSnapshot()?.id === request.id) dialogs.answer(undefined);
  };
  const giveUp = async ({ force = false } = {}): Promise<boolean> => {
    setPutOff(false);
    const outcome = await create.cancel({ force });
    if (outcome === "kept") setKept(true);
    if (outcome !== "closed" && outcome !== "cancelled") return false;
    leave();
    return true;
  };
  // A project of this computer is made by whoever makes folders: the dialog is over.
  const isOver =
    snapshot.phase === "cancelled" || (snapshot.kind !== "cloud" && snapshot.phase === "done");
  useEffect(() => {
    if (isOver && dialogs.getSnapshot()?.id === request.id) dialogs.answer(undefined);
  }, [isOver, dialogs, request.id]);
  const { need, kind } = snapshot;
  const isLocked = view.locked;

  return (
    <dialog
      ref={dialog}
      className={`${host.wide} ${own.dialog}`}
      aria-label={view.title}
      data-create-phase={snapshot.phase}
      data-create-kind={kind}
      onCancel={(event) => {
        event.preventDefault();
        if (view.close.enabled) void giveUp();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !create.takesBack && !isLocked) void giveUp();
      }}
    >
      <form
        className={host.content}
        onSubmit={(event) => {
          event.preventDefault();
          // Right in the press: the browser asks for a folder only then.
          void create.submit();
        }}
      >
        <h2>{view.title}</h2>
        {request.imported && <p>{t("newProject.importAbout")}</p>}

        <label className={repo.nameLabel}>
          <span>{t("project.nameLabel")}</span>
          <input
            ref={nameInput}
            aria-label={t("project.nameLabel")}
            spellCheck={false}
            autoComplete="off"
            value={snapshot.name}
            disabled={isLocked || create.takesBack}
            onChange={(event) => create.setName(event.target.value)}
          />
        </label>

        {kind === "local" && workbench.projectFolders && (
          <Place folders={workbench.projectFolders} name={snapshot.name} disabled={isLocked} />
        )}

        {view.format && (
          <div className={`${styles.format} ${own.format}`}>
            <label>
              <span>{t("newProject.format.label")}</span>
              <select
                value={snapshot.shape}
                disabled={isLocked || create.takesBack}
                onChange={(event) => create.setShape(event.target.value as typeof snapshot.shape)}
              >
                {(["landscape", "portrait", "square", "custom"] as const).map((shape) => (
                  <option key={shape} value={shape}>
                    {t(`newProject.format.shape.${shape}`)}
                  </option>
                ))}
              </select>
            </label>
            {view.format.custom && (
              <>
                <label>
                  <span>{t("newProject.format.width")}</span>
                  <input
                    className={styles.size}
                    inputMode="numeric"
                    aria-invalid={view.format.invalid}
                    value={snapshot.width}
                    disabled={isLocked || create.takesBack}
                    onChange={(event) => create.setSize(event.target.value, snapshot.height)}
                  />
                </label>
                <label>
                  <span>{t("newProject.format.height")}</span>
                  <input
                    className={styles.size}
                    inputMode="numeric"
                    aria-invalid={view.format.invalid}
                    value={snapshot.height}
                    disabled={isLocked || create.takesBack}
                    onChange={(event) => create.setSize(snapshot.width, event.target.value)}
                  />
                </label>
              </>
            )}
            <label>
              <span>{t("newProject.format.fps")}</span>
              <select
                value={snapshot.fps}
                disabled={isLocked || create.takesBack}
                onChange={(event) => create.setFps(event.target.value as typeof snapshot.fps)}
              >
                {(["30", "60"] as const).map((fps) => (
                  <option key={fps} value={fps}>
                    {t("newProject.format.fpsValue", { fps })}
                  </option>
                ))}
              </select>
            </label>
            {view.format.invalid && (
              <p className={styles.formatProblem} role="status">
                {t("newProject.format.invalid")}
              </p>
            )}
          </div>
        )}

        {view.body === "need" && need !== undefined && (
          <div className={repo.install} role="status" data-connect-need={need}>
            <p className={repo.strong}>
              {need === "signIn" ? t("newProject.need.signIn") : t(`cloud.connect.need.${need}`)}
            </p>
            {need === "installApp" && <p>{t("cloud.connect.need.installAdvice")}</p>}
            {need === "signIn" && (
              <button
                type="button"
                className={repo.installButton}
                onClick={() => void create.signIn()}
              >
                {t("cloud.connect.signIn")}
              </button>
            )}
            {need === "installApp" && (
              <button
                type="button"
                className={repo.installButton}
                onClick={() => void create.installApp()}
              >
                {t("cloud.connect.install")}
              </button>
            )}
          </div>
        )}

        {view.body === "choice" && create.picker && (
          <fieldset className={styles.choice} aria-label={t("cloud.connect.repository")}>
            <legend>{t("cloud.connect.repository")}</legend>
            {picked?.mode === "existing" ? (
              // Chosen in "从仓库打开" already: that one, and the way back to choose another.
              <ChosenRepository
                picker={create.picker}
                disabled={isLocked}
                onAnother={() =>
                  void giveUp().then((gone) => {
                    if (gone) void workbench.openRepository();
                  })
                }
              />
            ) : (
              // A new project gets a new repository; one people have is opened from, see 2.2.
              <RepositoryFields picker={create.picker} disabled={isLocked} only="create" />
            )}
          </fieldset>
        )}

        {view.body === "result" && snapshot.linked?.repository?.place === "local" && (
          <p className={styles.result}>
            <span>{t("cloud.connect.repository")}</span>
            {t("cloud.panel.repository.local")}
          </p>
        )}
        {view.body === "result" &&
          snapshot.linked?.repository?.place !== "local" &&
          snapshot.linked?.repository && (
            <p className={styles.result}>
              <span>{t("cloud.connect.repository")}</span>
              {t("cloud.panel.repository.value", {
                name: snapshot.linked.repository.fullName,
                visibility: t(
                  snapshot.linked.repository.private ? "repository.private" : "repository.public",
                ),
                interpolation: { escapeValue: false },
              })}
            </p>
          )}

        {view.steps.length > 0 && (
          <ol className={styles.steps} aria-label={t("newProject.stepsLabel")}>
            {view.steps.map(({ id, text, state, stateText }) => {
              const Icon = STEP_ICONS[state];
              return (
                <li key={id} data-step={id} data-state={state}>
                  <Icon size={14} className={state === "running" ? styles.spin : undefined} />
                  <span>{text}</span>
                  <span className={styles.stepState}>{stateText}</span>
                </li>
              );
            })}
          </ol>
        )}

        {view.message && (
          <p
            className={styles.message}
            data-tone={view.message.tone}
            role={view.message.tone === "attention" ? "alert" : "status"}
          >
            {view.message.text}
          </p>
        )}

        <div className={host.buttons}>
          {view.asksAboutCancel ? (
            <>
              <button type="button" onClick={() => setPutOff(true)}>
                {t("newProject.cancelLater")}
              </button>
              <button
                type="button"
                className={host.danger}
                onClick={() => void giveUp({ force: true })}
              >
                {t("newProject.cancelForce")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                {...(view.body === "result" && { className: host.primary })}
                disabled={!view.close.enabled}
                onClick={() => void giveUp()}
              >
                {view.close.label}
              </button>
              {view.primary && (
                <button type="submit" className={host.primary} disabled={!view.primary.enabled}>
                  {view.primary.label}
                </button>
              )}
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}

/** The repository a new project goes to, chosen beforehand, see `RepositoryPicker.preselect`. */
function ChosenRepository({
  picker,
  disabled,
  onAnother,
}: {
  readonly picker: RepositoryPicker;
  readonly disabled: boolean;
  readonly onAnother: () => void;
}) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(picker.subscribe, picker.getSnapshot);
  const choice = picker.selectedChoice;
  if (!choice) return null;
  const isPublic = picker.isPublic(choice);
  return (
    <div className={repo.section}>
      <div className={own.chosen} data-repository={choice.fullName}>
        <span className={repo.choiceName}>
          {choice.fullName}
          <span className={repo.badge}>
            {isPublic ? <Globe size={10} /> : <Lock size={10} />}
            {t(isPublic ? "repository.public" : "repository.private")}
          </span>
        </span>
        <button
          type="button"
          className={repo.openLinked}
          disabled={disabled || snapshot.working}
          onClick={onAnother}
        >
          {t("newProject.changeRepository")}
        </button>
      </div>
      {isPublic && (
        <div className={repo.public} role="status">
          <p>{t("repository.publicWarning")}</p>
          <label className={repo.mode}>
            <input
              type="checkbox"
              checked={snapshot.publicConfirmed}
              disabled={disabled || snapshot.working}
              onChange={(event) => picker.confirmPublic(event.target.checked)}
            />
            {t("repository.publicConfirm")}
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * Where a new project of the offline mode goes (the design of U1, 2.3): the place people put the
 * last one, or chose now, and the folder of its own it gets there, as it will be called. The
 * browser only gives the name of a folder, not where it is.
 */
function Place({
  folders,
  name,
  disabled,
}: {
  readonly folders: ProjectFolders;
  readonly name: string;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const [place, setPlace] = useState<LocalFolder>();
  // What the folder is called there, for the place and the name it was looked up for.
  const [found, setFound] = useState<{ readonly for: string; readonly folder?: string }>();
  const wanted = name.trim();
  const lookingFor = place ? `${place.name}\n${wanted}` : undefined;
  const folder = found && found.for === lookingFor ? found.folder : undefined;
  useEffect(() => {
    let isCurrent = true;
    void folders.lastPlace().then((last) => {
      if (isCurrent && last) setPlace((chosen) => chosen ?? last);
    });
    return () => {
      isCurrent = false;
    };
  }, [folders]);
  // A moment after people stop typing the name.
  useEffect(() => {
    if (!place || wanted === "" || lookingFor === undefined) return;
    const over = new AbortController();
    const timer = setTimeout(() => {
      void folders.folderNameIn(place, wanted).then((inside) => {
        if (!over.signal.aborted)
          setFound({ for: lookingFor, ...(inside !== undefined && { folder: inside }) });
      });
    }, PREVIEW_DELAY_MS);
    return () => {
      over.abort();
      clearTimeout(timer);
    };
  }, [folders, place, wanted, lookingFor]);
  return (
    <div className={own.place} role="group" aria-label={t("newProject.location")}>
      <span>{t("newProject.location")}</span>
      <div className={own.placeRow}>
        <span className={own.placeName} data-none={place ? undefined : true} data-place="">
          <FolderOpen size={14} aria-hidden />
          {place ? place.name : t("newProject.noLocation")}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            // Right in the click: the browser asks for a folder only then.
            void folders.choosePlace().then((chosen) => {
              if (chosen) setPlace(chosen);
            })
          }
        >
          {t(place ? "newProject.changeLocation" : "newProject.chooseLocation")}
        </button>
      </div>
      {place && folder && (
        <span className={own.placePreview} data-new-folder={folder}>
          {`${place.name} › ${folder}`}
        </span>
      )}
    </div>
  );
}

/** How long after the last key the dialog looks at the place for the name of the folder. */
const PREVIEW_DELAY_MS = 250;
