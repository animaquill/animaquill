import { Check, Circle, CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectStepState } from "../cloud/connect.ts";
import type { CloudProjectsSnapshot } from "../cloud/projects.ts";
import type { DialogRequest } from "../workbench/dialogs.ts";
import styles from "./ConnectDialog.module.css";
import { connectView } from "./connect-view.ts";
import { useWorkbench } from "./context.ts";
import host from "./DialogHost.module.css";
import picker from "./RepositoryDialog.module.css";
import { RepositoryFields } from "./RepositoryFields.tsx";

type ConnectRequest = Extract<DialogRequest, { kind: "connect" }>;

const STEP_ICONS: Readonly<Record<ConnectStepState, typeof Circle>> = {
  waiting: Circle,
  running: LoaderCircle,
  done: Check,
  failed: CircleAlert,
};

const noSubscription = () => () => {};
const NONE: CloudProjectsSnapshot = { kind: "none" };
const none = () => NONE;

/**
 * "连接到云端" in one dialog, see `CloudConnect` and the design of the start page, 3: what has to
 * be there first, with the button that gets it; the repository to choose, with what the platform
 * says about it before people go on; and the three steps as they run. "取消" takes back what the
 * dialog made, so that nothing is left halfway; once the project has its repository, the dialog
 * only closes.
 */
export function ConnectDialog({ request }: { request: ConnectRequest }) {
  const { dialogs, cloud } = useWorkbench();
  const { t } = useTranslation();
  const { connect } = request;
  const snapshot = useSyncExternalStore(connect.subscribe, connect.getSnapshot);
  const picked = useSyncExternalStore(connect.picker.subscribe, connect.picker.getSnapshot);
  const linked = useSyncExternalStore(
    cloud?.subscribe ?? noSubscription,
    cloud?.getSnapshot ?? none,
  );
  // The project of the platform it is, once it is one: a repository of it is not another's.
  const project = linked.kind === "linked" ? linked.link.project : undefined;
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

  const view = connectView(
    {
      snapshot,
      name: connect.name,
      mode: picked.mode,
      canSubmit: connect.canSubmit,
      putOff,
      kept,
    },
    t,
  );
  /** Only this dialog: another one may have taken its place while something was on its way. */
  const leave = () => {
    if (dialogs.getSnapshot()?.id === request.id) dialogs.answer(undefined);
  };
  const giveUp = async ({ force = false } = {}): Promise<boolean> => {
    setPutOff(false);
    const outcome = await connect.cancel({ force });
    if (outcome === "kept") setKept(true);
    if (outcome !== "closed" && outcome !== "cancelled") return false;
    leave();
    return true;
  };
  // Given up on after all, without anyone pressing anything: what could not be made sure of
  // when people gave up turned out to be so, see `ConnectSnapshot.phase`.
  const isOver = snapshot.phase === "cancelled";
  useEffect(() => {
    if (isOver && dialogs.getSnapshot()?.id === request.id) dialogs.answer(undefined);
  }, [isOver, dialogs, request.id]);
  const { need } = snapshot;

  return (
    <dialog
      ref={dialog}
      className={host.wide}
      aria-label={view.title}
      data-connect-phase={snapshot.phase}
      onCancel={(event) => {
        event.preventDefault();
        if (view.close.enabled) void giveUp();
      }}
      // A click next to the dialog must not take back what it made: only where nothing is to lose.
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !connect.takesBack && !view.locked)
          void giveUp();
      }}
    >
      <form
        className={host.content}
        onSubmit={(event) => {
          event.preventDefault();
          void connect.submit();
        }}
      >
        <h2>{view.title}</h2>
        {view.intro === "repositoryOnly" ? (
          <p>{t("cloud.connect.repositoryOnly")}</p>
        ) : (
          view.body !== "result" && (
            <div className={styles.about}>
              <p>{t("cloud.connect.aboutHeading")}</p>
              <ul>
                <li>{t("cloud.connect.aboutSync")}</li>
                <li>{t("cloud.connect.aboutArchive")}</li>
                <li>{t("cloud.connect.aboutAssets")}</li>
              </ul>
            </div>
          )
        )}

        {view.body === "need" && need !== undefined && (
          <div className={picker.install} role="status" data-connect-need={need}>
            <p className={picker.strong}>{t(`cloud.connect.need.${need}`)}</p>
            {need === "installApp" && <p>{t("cloud.connect.need.installAdvice")}</p>}
            {need === "signIn" && (
              <button
                type="button"
                className={picker.installButton}
                onClick={() => void connect.signIn()}
              >
                {t("cloud.connect.signIn")}
              </button>
            )}
            {need === "installApp" && (
              <button
                type="button"
                className={picker.installButton}
                onClick={() => void connect.installApp()}
              >
                {t("cloud.connect.install")}
              </button>
            )}
          </div>
        )}

        {view.body === "choice" && (
          <fieldset className={styles.choice} aria-label={t("cloud.connect.repository")}>
            <legend>{t("cloud.connect.repository")}</legend>
            <RepositoryFields
              picker={connect.picker}
              {...(project !== undefined && { project })}
              disabled={view.locked}
              nameInput={nameInput}
              onOpenProject={
                cloud &&
                (({ id, name }) =>
                  void giveUp().then((gone) => {
                    if (gone) void cloud.openCloudProject(id, { name });
                  }))
              }
              onRestore={
                cloud &&
                ((repository) =>
                  void giveUp().then((gone) => {
                    if (gone) void cloud.restoreFromRepository(repository, { other: true });
                  }))
              }
            />
          </fieldset>
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
          <ol className={styles.steps} aria-label={t("cloud.connect.stepsLabel")}>
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
                {t("cloud.connect.cancelLater")}
              </button>
              <button
                type="button"
                className={host.danger}
                onClick={() => void giveUp({ force: true })}
              >
                {t("cloud.connect.cancelForce")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                // The one thing to press once the project is connected.
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
