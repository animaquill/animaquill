import type { RepositoryRefusal, RepositoryStatus, SyncRejection } from "@animaquill/host";
import type { TFunction } from "i18next";
import { pauseText } from "./repository-text.ts";

/**
 * What making a project of the online mode goes through, see `CloudCreate`: the steps, what has
 * to be there first, and why a step stops, in words.
 */

/** The clock of the dialog. The page's, unless a test says so. */
export interface ConnectEnvironment {
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  now(): number;
}

export type ConnectStepState = "waiting" | "running" | "done" | "failed";

/** What has to be there before people can choose anything. */
export type ConnectNeed =
  /** Who is signed in is not known yet. */
  | "account"
  | "signIn"
  /** The GitHub App on the person's account. */
  | "installApp";

/** Why a step stopped. */
export type ConnectProblem =
  | {
      readonly step: "upload";
      /**
       * There is no network ("offline") or no platform at
       * the other end ("unreachable"), which it gets over by itself; or the platform does not take
       * the project: nobody is signed in, the editor is too old, the project is too large or more
       * than the person may keep, or something else, see `reason`. "stopped": syncing ended, as
       * where another window disconnected the project. "undone": the platform would not make the
       * project, as connecting it was given up on before, see `CloudProblem`; the link is gone,
       * and trying again starts anew. "missing": the same where the project may be of another
       * account than the one that is signed in, which keeps its link.
       */
      readonly code:
        | "offline"
        | "unreachable"
        | "signedOut"
        | "outdated"
        | "tooLarge"
        | "quota"
        | "rejected"
        | "undone"
        | "missing"
        | "stopped";
      readonly reason?: SyncRejection;
    }
  | {
      readonly step: "repository";
      /** What the platform said, or "choice" where it shows at what people chose. */
      readonly code: RepositoryRefusal | "signedOut" | "choice";
    }
  | {
      readonly step: "archive";
      /** Archiving paused, see `RepositoryStatus.reason`, or failed and is tried again. */
      readonly code: "paused" | "retrying";
      readonly status: RepositoryStatus;
    };

const plain = { interpolation: { escapeValue: false } } as const;

/** The refusals about repositories that have words of their own; the others say their code. */
const REPOSITORY_FAILURES = {
  nameTaken: true,
  invalidName: true,
  alreadyLinked: true,
  notFound: true,
  signedOut: true,
  busy: true,
  unavailable: true,
} as const;

/** Why a step stopped, and what helps, in words. */
export function connectProblemText(problem: ConnectProblem, t: TFunction): string {
  if (problem.step === "upload") {
    return problem.code === "rejected"
      ? t("cloud.connect.problem.rejected", {
          reason: t(`cloud.reason.${problem.reason ?? "malformed"}`),
          ...plain,
        })
      : t(`cloud.connect.problem.${problem.code}`);
  }
  if (problem.step === "repository") {
    if (problem.code === "choice") return t("cloud.connect.problem.choice");
    return problem.code in REPOSITORY_FAILURES
      ? t(`repository.failure.${problem.code as keyof typeof REPOSITORY_FAILURES}`)
      : t("repository.failure.other", { code: problem.code, ...plain });
  }
  if (problem.code === "retrying") return t("cloud.connect.problem.retrying");
  const { reason, fix } = pauseText(problem.status, t);
  return t("cloud.connect.problem.paused", { reason, fix, ...plain });
}
