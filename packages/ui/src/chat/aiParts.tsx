import { kindOf, type ServiceConfig } from "@animaquill/agent";
import { Check, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

/** How a service is, for the dot beside it. */
export type ServiceState = "ok" | "failed" | "noKey" | "testing" | "untested";

export function stateOf(snapshot: AiSettingsSnapshot, service: ServiceConfig): ServiceState {
  // Servers of one's own may need no key.
  if (!snapshot.keyed.has(service.id) && !kindOf(service.kind)?.custom) return "noKey";
  const test = snapshot.tests.get(service.id);
  if (test?.state === "running") return "testing";
  if (test?.state === "ok") return "ok";
  if (test?.state === "failed" || test?.state === "held") return "failed";
  return "untested";
}

/**
 * What a test came to, as a pill: how long a word took, or what kind of failure, with what to do
 * and what was said folded underneath.
 */
export function TestPill(props: {
  readonly test: ConnectionTest | undefined;
  readonly relayed: boolean;
  readonly canRelay: boolean;
  /** Only the pill, without what to do: where a row of a model has no room. */
  readonly short?: boolean;
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
    const text =
      test.models !== undefined
        ? t("ai.testOkListed", { ms: test.ms, count: test.models })
        : test.text && !props.short
          ? t("ai.testOk", { ms: test.ms, text: test.text })
          : t("ai.testOkQuiet", { ms: test.ms });
    return (
      <span className={styles.pill} data-state="ok" data-testid={testId} title={text}>
        <Check size={11} aria-hidden /> {text}
      </span>
    );
  }
  if (test.state === "held") {
    const said = t(`chat.hold.${test.hold}`);
    return (
      <span className={styles.pill} data-state="held" data-testid={testId} title={said}>
        <X size={11} aria-hidden /> {props.short ? t("ai.testFailed.other") : said}
      </span>
    );
  }
  const { advice, detail } = failureText(t, test.failure, props);
  const label = t(`ai.testFailed.${test.failure.kind}`);
  if (props.short) {
    return (
      <span className={styles.pill} data-state="failed" data-testid={testId} title={advice}>
        <X size={11} aria-hidden /> {label}
      </span>
    );
  }
  return (
    <>
      <span className={styles.pill} data-state="failed" data-testid={testId}>
        <X size={11} aria-hidden /> {label}
      </span>
      <details className={styles.failure} data-testid={`${testId}-failure`}>
        <summary>{advice}</summary>
        {detail}
      </details>
    </>
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
