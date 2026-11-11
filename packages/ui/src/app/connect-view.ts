import type { TFunction } from "i18next";
import {
  connectProblemText,
  connectStepText,
  type ConnectSnapshot,
  type ConnectStepId,
  type ConnectStepState,
} from "../cloud/connect.ts";
import type { PickerMode } from "../cloud/repository-picker.ts";

/**
 * What the dialog that connects a project shows for a state of `CloudConnect`, see the design of
 * the start page (docs/design/start-and-cloud.md of AnimaQuill Cloud), 3: which part of it is
 * there, what it says, and which buttons there are. No DOM, so that tests read what people read.
 */

const plain = { interpolation: { escapeValue: false } } as const;

export interface ConnectStepView {
  readonly id: ConnectStepId;
  readonly text: string;
  readonly state: ConnectStepState;
  /** The state in a word, for whoever does not see the icon. */
  readonly stateText: string;
}

export interface ConnectButton {
  readonly label: string;
  readonly enabled: boolean;
}

export interface ConnectView {
  readonly title: string;
  /**
   * What is in the middle of the dialog. "need": what has to be there first, with the button that
   * gets it. "choice": the repository to choose. "result": the project is connected and has its
   * repository; what is left runs by itself.
   */
  readonly body: "need" | "choice" | "result";
  /** What connecting gives, at the top: not for a project that is on the platform already. */
  readonly intro: "about" | "repositoryOnly";
  /** What people chose cannot change now: the steps run, or are being taken back. */
  readonly locked: boolean;
  /** The steps and how far each is. Empty before the first try: there is nothing to show yet. */
  readonly steps: readonly ConnectStepView[];
  /** What the dialog says below, the most pressing only. */
  readonly message:
    { readonly text: string; readonly tone: "plain" | "attention" | "done" } | undefined;
  /**
   * Giving up could not make sure that nothing is left on the platform: people choose to wait, or
   * to let go all the same. The other buttons are not there then.
   */
  readonly asksAboutCancel: boolean;
  /** Goes on with what people chose: missing where there is nothing to go on with. */
  readonly primary: ConnectButton | undefined;
  /** Closes the dialog: "取消" takes back what it made, "关闭" and "完成" leave it as it is. */
  readonly close: ConnectButton;
}

export interface ConnectViewInput {
  readonly snapshot: ConnectSnapshot;
  /** What the project is called. */
  readonly name: string;
  /** A new repository, or one people have: the second step is named after it. */
  readonly mode: PickerMode;
  /** See `CloudConnect.canSubmit`. */
  readonly canSubmit: boolean;
  /** People said to wait with giving up, see `ConnectView.asksAboutCancel`. */
  readonly putOff: boolean;
  /** Giving up found that the project has a repository after all, see `CloudConnect.cancel`. */
  readonly kept: boolean;
}

const STEPS: readonly ConnectStepId[] = ["upload", "repository", "archive"];

export function connectView(input: ConnectViewInput, t: TFunction): ConnectView {
  const { snapshot, mode, canSubmit } = input;
  const { need, phase, steps, problem, cancelling, repositoryOnly } = snapshot;
  const words = { name: input.name, ...plain };
  const isOver = phase === "archiving" || phase === "done";
  const body = isOver ? "result" : need !== undefined ? "need" : "choice";
  const hasBegun =
    phase !== "choosing" ||
    STEPS.some((id) => steps[id] === "running" || steps[id] === "failed") ||
    // The project got there, by this dialog: that stays to see while people choose again.
    (!repositoryOnly && steps.upload === "done");
  const asksAboutCancel = snapshot.unconfirmed && !input.putOff && !cancelling && !isOver;

  let message: ConnectView["message"];
  if (cancelling) message = { text: t("cloud.connect.cancelling"), tone: "plain" };
  else if (asksAboutCancel) message = { text: t("cloud.connect.unconfirmed"), tone: "attention" };
  else if (problem) message = { text: connectProblemText(problem, t), tone: "attention" };
  else if (phase === "done") message = { text: t("cloud.connect.done"), tone: "done" };
  else if (phase === "archiving")
    message = {
      text: input.kept ? t("cloud.connect.kept") : t("cloud.connect.archiving"),
      tone: "plain",
    };
  else if (phase === "working") message = { text: t("cloud.connect.working"), tone: "plain" };

  const hasFailed = STEPS.some((id) => steps[id] === "failed");
  return {
    title: t(repositoryOnly ? "cloud.connect.repositoryTitle" : "cloud.connect.title", words),
    body,
    intro: repositoryOnly ? "repositoryOnly" : "about",
    locked: phase === "working" || cancelling,
    steps: hasBegun
      ? STEPS.filter((id) => !(repositoryOnly && id === "upload")).map((id) => ({
          id,
          text: connectStepText(id, mode, t),
          state: steps[id],
          stateText: t(`cloud.connect.stepState.${steps[id]}`),
        }))
      : [],
    message,
    asksAboutCancel,
    primary:
      isOver || need !== undefined || asksAboutCancel
        ? undefined
        : {
            label: t(
              hasFailed
                ? "cloud.connect.retry"
                : repositoryOnly
                  ? "cloud.connect.submitRepository"
                  : "cloud.connect.submit",
            ),
            enabled: canSubmit,
          },
    close: {
      label: t(
        phase === "done"
          ? "cloud.connect.finish"
          : phase === "archiving"
            ? "cloud.connect.close"
            : "dialog.cancel",
      ),
      enabled: !cancelling,
    },
  };
}
