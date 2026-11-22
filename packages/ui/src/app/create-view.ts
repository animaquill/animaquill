import type { TFunction } from "i18next";
import type { ConnectStepState } from "../cloud/steps.ts";
import {
  createProblemText,
  createStepText,
  type CreateSnapshot,
  type CreateStepId,
} from "../cloud/create.ts";
import type { PickerMode } from "../cloud/repository-picker.ts";

/**
 * What the dialog that makes a new project shows for a state of `CloudCreate`, see the design of
 * the start page (docs/design/start-and-cloud.md of AnimaQuill Cloud), 3: which kinds of project
 * there are to choose, what each says, what is in the middle, and which buttons there are. No
 * DOM, so that tests read what people read.
 */

export interface CreateStepView {
  readonly id: CreateStepId;
  readonly text: string;
  readonly state: ConnectStepState;
  readonly stateText: string;
}

export interface CreateView {
  readonly title: string;
  /**
   * What is in the middle: "need": what has to be there first, with the button that gets it;
   * "choice": the repository; "result": the project is made, what is left runs by itself;
   * "plain": nothing more to choose, as for a project of this computer.
   */
  readonly body: "need" | "choice" | "result" | "plain";
  /**
   * The format of a new project: what shape, and the size of people's own where they chose that.
   * Not for one that is imported, which keeps its own.
   */
  readonly format: { readonly custom: boolean; readonly invalid: boolean } | undefined;
  /** What people chose cannot change now. */
  readonly locked: boolean;
  readonly steps: readonly CreateStepView[];
  readonly message:
    { readonly text: string; readonly tone: "plain" | "attention" | "done" } | undefined;
  readonly asksAboutCancel: boolean;
  readonly primary: { readonly label: string; readonly enabled: boolean } | undefined;
  readonly close: { readonly label: string; readonly enabled: boolean };
}

export interface CreateViewInput {
  readonly snapshot: CreateSnapshot;
  readonly mode: PickerMode | undefined;
  readonly canSubmit: boolean;
  /** The format people chose can be one, see `CloudCreate.format`. */
  readonly formatValid: boolean;
  readonly imported: boolean;
  /** People said to wait with giving up. */
  readonly putOff: boolean;
  /** Giving up found that the project has a repository after all. */
  readonly kept: boolean;
}

const STEPS: readonly CreateStepId[] = ["upload", "repository", "place", "archive"];

export function createView(input: CreateViewInput, t: TFunction): CreateView {
  const { snapshot, canSubmit, mode = "create" } = input;
  const { kind, need, phase, steps, problem, cancelling } = snapshot;
  const isCloud = kind === "cloud";
  const isOver = phase === "archiving" || phase === "done";
  const body: CreateView["body"] = !isCloud
    ? "plain"
    : isOver
      ? "result"
      : need !== undefined
        ? "need"
        : "choice";
  const hasBegun = isCloud && (phase !== "choosing" || STEPS.some((id) => steps[id] !== "waiting"));
  const asksAboutCancel = snapshot.unconfirmed && !input.putOff && !cancelling && !isOver;

  let message: CreateView["message"];
  if (cancelling) message = { text: t("newProject.cancelling"), tone: "plain" };
  else if (asksAboutCancel) message = { text: t("newProject.unconfirmed"), tone: "attention" };
  else if (problem) message = { text: createProblemText(problem, t), tone: "attention" };
  else if (phase === "done") message = { text: t("newProject.done"), tone: "done" };
  else if (phase === "archiving")
    message = {
      text: input.kept ? t("newProject.kept") : t("newProject.archiving"),
      tone: "plain",
    };
  else if (phase === "working") message = { text: t("newProject.working"), tone: "plain" };

  const hasFailed = STEPS.some((id) => steps[id] === "failed");
  return {
    title: t(input.imported ? "newProject.importTitle" : "newProject.title"),
    body,
    format: input.imported
      ? undefined
      : { custom: snapshot.shape === "custom", invalid: !input.formatValid },
    locked: phase === "working" || cancelling || isOver,
    steps: hasBegun
      ? STEPS.map((id) => ({
          id,
          text: createStepText(id, mode, t),
          state: steps[id],
          stateText: t(`cloud.connect.stepState.${steps[id]}`),
        }))
      : [],
    message,
    asksAboutCancel,
    primary:
      isOver || (isCloud && need !== undefined) || asksAboutCancel
        ? undefined
        : {
            label: t(
              hasFailed
                ? "newProject.retry"
                : kind === "local"
                  ? "newProject.chooseFolder"
                  : "newProject.submit",
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
