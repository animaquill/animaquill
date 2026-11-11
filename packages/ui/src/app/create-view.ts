import type { TFunction } from "i18next";
import type { ConnectStepState } from "../cloud/connect.ts";
import {
  createProblemText,
  createStepText,
  type CreateKind,
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

export interface CreateKindView {
  readonly id: CreateKind;
  readonly label: string;
  readonly about: string;
  /** It cannot be chosen here, and `about` says why. */
  readonly disabled: boolean;
}

export interface CreateStepView {
  readonly id: CreateStepId;
  readonly text: string;
  readonly state: ConnectStepState;
  readonly stateText: string;
}

export interface CreateView {
  readonly title: string;
  /** What there is to choose from: none where only one kind can be made. */
  readonly kinds: readonly CreateKindView[];
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
  /** "同时放一份在这台电脑的文件夹里": only where the browser can write folders. */
  readonly withFolder: boolean | undefined;
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
  /** What can be made, see `CloudCreate.kinds`. */
  readonly kinds: readonly CreateKind[];
  /** Whether the browser can write folders at all: a project of this computer needs that. */
  readonly canFolders: boolean;
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
  // A project of this computer is there to choose, greyed with why, where the browser cannot
  // write folders, so that people know what they are missing.
  const shown: CreateKind[] = [
    ...(input.imported ? [] : (["local"] as const)),
    ...(input.kinds.includes("cloud") ? (["cloud"] as const) : []),
    ...(input.kinds.includes("browser") ? (["browser"] as const) : []),
  ];
  const kinds = shown.map((id): CreateKindView => ({
    id,
    label: t(`newProject.kind.${id}`),
    about:
      id === "local" && !input.canFolders
        ? t("newProject.localUnsupported")
        : t(`newProject.kindAbout.${id}`),
    disabled: id === "local" && !input.canFolders,
  }));
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
  else if (kind === "local") message = { text: t("newProject.localNext"), tone: "plain" };

  const hasFailed = STEPS.some((id) => steps[id] === "failed");
  return {
    title: t(input.imported ? "newProject.importTitle" : "newProject.title"),
    kinds: kinds.length > 1 ? kinds : [],
    body,
    format: input.imported
      ? undefined
      : { custom: snapshot.shape === "custom", invalid: !input.formatValid },
    withFolder: isCloud && input.canFolders ? snapshot.withFolder : undefined,
    locked: phase === "working" || cancelling || isOver,
    steps: hasBegun
      ? STEPS.map((id) => ({
          id,
          text: createStepText(id, mode, snapshot.withFolder, t),
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
            label: t(hasFailed ? "newProject.retry" : "newProject.submit"),
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
