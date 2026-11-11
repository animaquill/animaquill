import { Check, Circle, CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectStepState } from "../cloud/connect.ts";
import type { PickerSnapshot } from "../cloud/repository-picker.ts";
import type { DialogRequest } from "../workbench/dialogs.ts";
import styles from "./ConnectDialog.module.css";
import { createView } from "./create-view.ts";
import { useWorkbench } from "./context.ts";
import host from "./DialogHost.module.css";
import own from "./NewProjectDialog.module.css";
import picker from "./RepositoryDialog.module.css";
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
  const { dialogs, cloud, projectFolders } = useWorkbench();
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
      kinds: create.kinds,
      canFolders: projectFolders !== undefined,
      mode: picked?.mode,
      canSubmit: create.canSubmit,
      formatValid: create.format !== undefined,
      imported: request.imported === true,
      putOff,
      kept,
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

        <label className={picker.nameLabel}>
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

        {view.kinds.length > 0 && (
          <div
            className={`${styles.kinds} ${own.kinds}`}
            role="radiogroup"
            aria-label={t("newProject.kindLabel")}
          >
            {view.kinds.map(({ id, label, about, disabled }) => (
              <label
                key={id}
                className={`${styles.kind} ${own.kind}`}
                data-disabled={disabled}
                data-checked={kind === id || undefined}
              >
                <input
                  type="radio"
                  name="project-kind"
                  checked={kind === id}
                  disabled={disabled || isLocked || create.takesBack}
                  onChange={() => create.setKind(id)}
                />
                <span className={styles.kindWords}>
                  <span className={styles.kindLabel}>{label}</span>
                  <span className={styles.kindAbout}>{about}</span>
                </span>
              </label>
            ))}
          </div>
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
          <div className={picker.install} role="status" data-connect-need={need}>
            <p className={picker.strong}>
              {need === "signIn" ? t("newProject.need.signIn") : t(`cloud.connect.need.${need}`)}
            </p>
            {need === "installApp" && <p>{t("cloud.connect.need.installAdvice")}</p>}
            {need === "signIn" && (
              <button
                type="button"
                className={picker.installButton}
                onClick={() => void create.signIn()}
              >
                {t("cloud.connect.signIn")}
              </button>
            )}
            {need === "installApp" && (
              <button
                type="button"
                className={picker.installButton}
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
            <RepositoryFields
              picker={create.picker}
              disabled={isLocked}
              onOpenProject={
                cloud &&
                (({ id, name }) =>
                  void giveUp().then((gone) => {
                    if (gone) void cloud.openCloudProject(id, { name });
                  }))
              }
            />
          </fieldset>
        )}

        {view.withFolder !== undefined && view.body !== "result" && (
          <label className={`${styles.withFolder} ${own.withFolder}`}>
            <input
              type="checkbox"
              checked={view.withFolder}
              disabled={isLocked || create.takesBack}
              onChange={(event) => create.setWithFolder(event.target.checked)}
            />
            <span>
              {t("newProject.withFolder")}
              <span className={styles.kindAbout}>{t("newProject.withFolderHint")}</span>
            </span>
          </label>
        )}

        {view.body === "result" && snapshot.linked?.repository && (
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
