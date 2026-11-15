import { kindOf, type ServiceConfig } from "@animaquill/agent";
import { Check, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import styles from "./AiSettings.module.css";
import { failureText } from "./failure.ts";
import { colorOf, initialOf } from "./modelText.ts";
import type { AiSettingsSnapshot, ConnectionTest } from "./settings.ts";

/** A service's letter, in place of a logo (logos are trademarks). */
export function ServiceAvatar(props: {
  readonly kind: string;
  readonly name: string;
  readonly large?: boolean;
}) {
  return (
    <span
      className={`${styles.avatar} ${props.large ? styles.avatarLarge : ""}`}
      style={{ background: colorOf(kindOf(props.kind)) }}
      aria-hidden
    >
      {initialOf(props.name)}
    </span>
  );
}

/** How a service is, for the dot beside it: nothing to say, or what is wrong. */
export type ServiceState = "ok" | "failed" | "noKey";

export function stateOf(snapshot: AiSettingsSnapshot, service: ServiceConfig): ServiceState {
  // Servers of one's own may need no key.
  if (!snapshot.keyed.has(service.id) && !kindOf(service.kind)?.custom) return "noKey";
  if (snapshot.failing.has(service.id)) return "failed";
  return "ok";
}

/**
 * Whether a service is on: it was not turned off as a whole (which keeps the models it had on), and
 * so a service with no model on yet, such as one just added, is on.
 */
export const isServiceOn = (service: ServiceConfig): boolean =>
  service.enabled.length > 0 || !service.paused?.length;

/** How long a test took, as people read it: "412 毫秒", "1.08 秒". */
const timeOf = (t: TFunction, ms: number) =>
  ms < 1000 ? t("ai.ms", { ms }) : t("ai.seconds", { s: (ms / 1000).toFixed(2) });

/**
 * What a test came to, as a pill: how long it took, or what kind of failure. What to do about it,
 * and what was said, show on hovering it.
 */
export function TestPill(props: {
  readonly test: ConnectionTest | undefined;
  readonly relayed: boolean;
  readonly canRelay: boolean;
  readonly testId?: string;
}) {
  const { t } = useTranslation();
  const { test } = props;
  if (!test) return null;
  const testId = props.testId ?? "ai-test";
  if (test.state === "running") {
    return (
      <span className={styles.pill} data-state="running" data-testid={testId}>
        <LoaderCircle size={11} className={styles.spin} aria-hidden /> {t("ai.testing")}
      </span>
    );
  }
  if (test.state === "ok") {
    const title =
      test.models !== undefined
        ? t("ai.testOkListed", { ms: test.ms, count: test.models })
        : test.text
          ? t("ai.testOk", { ms: test.ms, text: test.text })
          : t("ai.testOkQuiet", { ms: test.ms });
    return (
      <span className={styles.pill} data-state="ok" data-testid={testId} title={title}>
        <Check size={11} aria-hidden /> {timeOf(t, test.ms)}
      </span>
    );
  }
  if (test.state === "held") {
    const said = t(`chat.hold.${test.hold}`);
    return (
      <span className={styles.pill} data-state="held" data-testid={testId} title={said}>
        <X size={11} aria-hidden /> {t("ai.testFailed.other")}
      </span>
    );
  }
  const { advice, detail } = failureText(t, test.failure, props);
  return (
    <span
      className={styles.pill}
      data-state="failed"
      data-testid={testId}
      title={[advice, detail].filter(Boolean).join("\n")}
    >
      <X size={11} aria-hidden /> {t(`ai.testFailed.${test.failure.kind}`)}
    </span>
  );
}

/**
 * What people type into a field, which follows the value saved while they are not typing: another
 * window may change it meanwhile.
 */
export function useDraft(saved: string): readonly [string, (value: string) => void, () => void] {
  const [draft, setDraft] = useState(saved);
  const before = useRef(saved);
  useEffect(() => {
    if (before.current === saved) return;
    before.current = saved;
    setDraft(saved);
  }, [saved]);
  return [draft, setDraft, () => setDraft(saved)] as const;
}
