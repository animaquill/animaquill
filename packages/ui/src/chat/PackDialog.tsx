import {
  callChanges,
  choosePack,
  closenessFor,
  wordsChanges,
  type ModelPack,
  type PackProblem,
  type WordsChange,
  type WordsGroup,
} from "@animaquill/tools";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import dialogStyles from "../app/DialogHost.module.css";
import styles from "./ModelPacks.module.css";
import type { PackSource } from "./packs.ts";
import { callText, packLabel, packName, problemText, sourceText } from "./packText.ts";

export interface PackDialogProps {
  /** Installing a pack, taking a new version of one installed, or only looking at one. */
  readonly mode: "install" | "update" | "view";
  /** Nothing when it does not pass: `problems` says why. */
  readonly pack: ModelPack | undefined;
  /** The version installed, which an update is shown against. */
  readonly installed?: ModelPack | undefined;
  readonly source?: PackSource | undefined;
  readonly problems?: readonly PackProblem[];
  /** People said yes, and which of their models are to use it from now on. */
  readonly onConfirm?: (models: readonly string[]) => void;
  readonly onClose: () => void;
}

const GROUPS: readonly WordsGroup[] = ["system", "tools", "params", "ops", "examples"];

/**
 * What a model pack would change, before people install it or take an update: where it is from,
 * what it changes of the guard or of what the place says of itself (first, to agree to on its own),
 * which models it would be for, how it calls them, and every change of words next to the words it
 * replaces. All of it as text: what a pack says is never markup.
 */
export function PackDialog(props: PackDialogProps) {
  const { mode, pack, installed, source, problems = [], onConfirm, onClose } = props;
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [agreed, setAgreed] = useState(false);
  const [switching, setSwitching] = useState(false);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    // What others wrote goes in only when people press the button.
    cancel.current?.focus();
    return () => element?.close();
  }, []);

  const words = useMemo(
    () => (pack ? wordsChanges(pack, mode === "update" ? installed : undefined) : []),
    [pack, installed, mode],
  );
  const calls = useMemo(
    () => (pack ? callChanges(pack, mode === "update" ? installed : undefined) : []),
    [pack, installed, mode],
  );
  const sensitive = words.filter((change) => change.sensitive);
  const rest = words.filter((change) => !change.sensitive);
  const foreign = pack !== undefined && !pack.builtin;
  const title = !pack
    ? t("ai.packs.dialog.failedTitle")
    : t(`ai.packs.dialog.${mode}Title`, { name: packName(t, pack) });
  const before =
    mode === "update" ? t("ai.packs.dialog.oldWords") : t("ai.packs.dialog.builtinWords");
  const after = mode === "update" ? t("ai.packs.dialog.newWords") : t("ai.packs.dialog.packWords");
  const models = useModels(pack, mode);
  const ready = pack !== undefined && (sensitive.length === 0 || agreed || mode === "view");

  return (
    <dialog
      ref={dialog}
      className={`${dialogStyles.wide} ${styles.dialog}`}
      aria-label={title}
      data-testid="pack-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={dialogStyles.content}>
        <h2>{title}</h2>
        {pack && (
          <p className={styles.meta}>
            {[
              packLabel(t, pack),
              t("ai.packs.version", { version: pack.version }),
              pack.license && t("ai.packs.license", { license: pack.license }),
              source && sourceText(t, source),
              pack.builtin && t("ai.packs.sourceBuiltin"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        {pack?.description && <p>{pack.description}</p>}
        {problems.length > 0 && (
          <>
            <p>{t("ai.packs.dialog.problemsIntro")}</p>
            <ul className={styles.problems} data-testid="pack-problems">
              {problems.map((problem, index) => (
                <li key={index}>{problemText(t, problem)}</li>
              ))}
            </ul>
          </>
        )}
        {foreign && mode !== "view" && (
          <p className={styles.trust} data-testid="pack-trust">
            {t("ai.packs.dialog.trust")}
            {mode === "update" && installed && (
              <> {t("ai.packs.dialog.updateFrom", { version: installed.version })}</>
            )}
          </p>
        )}

        {sensitive.length > 0 && (
          <div className={styles.sensitive} data-testid="pack-sensitive">
            {sensitive.map((change) => (
              <div key={change.key} className={styles.section}>
                <h3>
                  {t(
                    `ai.packs.dialog.sensitive.${change.key === "system.guard" ? "guard" : "host"}`,
                  )}
                </h3>
                <Sides change={change} before={before} after={after} />
              </div>
            ))}
            <p className={styles.hint}>{t("ai.packs.dialog.sensitiveHelp")}</p>
            {mode !== "view" && (
              <label className={styles.agree}>
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(event) => setAgreed(event.target.checked)}
                  data-testid="pack-agree"
                />
                {t("ai.packs.dialog.agree")}
              </label>
            )}
          </div>
        )}

        {pack && mode !== "view" && (
          <div className={styles.section} data-testid="pack-models">
            <h3>{t("ai.packs.dialog.models")}</h3>
            {models.length === 0 ? (
              <p>{t("ai.packs.dialog.modelsNone")}</p>
            ) : (
              <ul className={styles.rows}>
                {models.map(({ model, current, automatic }) => (
                  <li key={model}>
                    {automatic
                      ? t("ai.packs.dialog.modelAutomatic", { model })
                      : t("ai.packs.dialog.modelNow", { model, current: packLabel(t, current) })}
                  </li>
                ))}
              </ul>
            )}
            {models.some(({ automatic }) => !automatic) && (
              <label className={styles.agree}>
                <input
                  type="checkbox"
                  checked={switching}
                  onChange={(event) => setSwitching(event.target.checked)}
                  data-testid="pack-switch"
                />
                {t("ai.packs.dialog.switchTo")}
              </label>
            )}
          </div>
        )}

        {pack && (
          <div className={styles.section} data-testid="pack-call">
            <h3>{t("ai.packs.dialog.call")}</h3>
            {calls.length === 0 ? (
              <p>{t("ai.packs.dialog.callNone")}</p>
            ) : (
              <ul className={styles.rows}>
                {calls.map((change, index) => (
                  <li key={index}>
                    {callText(t, change)}
                    {change.costly && (
                      <span className={styles.costly}> {t("ai.packs.dialog.costly")}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {pack && (
          <div className={styles.section} data-testid="pack-words">
            <h3>{t("ai.packs.dialog.words")}</h3>
            {rest.length === 0 ? (
              <p>{t("ai.packs.dialog.wordsNone")}</p>
            ) : (
              GROUPS.map((group) => {
                const changes = rest.filter((change) => change.group === group);
                if (changes.length === 0) return null;
                return (
                  <div key={group} className={styles.section}>
                    <h3>
                      {t("ai.packs.dialog.groupCount", {
                        group: t(`ai.packs.group.${group}`),
                        count: changes.length,
                      })}
                    </h3>
                    {changes.map((change, index) => (
                      <details key={`${change.key}-${index}`} className={styles.change}>
                        <summary>
                          {change.key}
                          {change.models && ` (${change.models.join(", ")})`}
                          {change.hints.length > 0 && t("ai.packs.dialog.flagged")}
                        </summary>
                        <Sides change={change} before={before} after={after} />
                      </details>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        )}

        <div className={dialogStyles.buttons}>
          <button type="button" ref={cancel} onClick={onClose}>
            {mode === "view" || !pack ? t("ai.packs.dialog.close") : t("ai.packs.dialog.cancel")}
          </button>
          {mode !== "view" && pack && onConfirm && (
            <button
              type="button"
              className={dialogStyles.primary}
              disabled={!ready}
              data-testid="pack-confirm"
              onClick={() =>
                onConfirm(
                  switching
                    ? models.filter(({ automatic }) => !automatic).map(({ model }) => model)
                    : [],
                )
              }
            >
              {mode === "update" ? t("ai.packs.dialog.update") : t("ai.packs.dialog.install")}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

/** The words before and after, side by side, with what to look out for. */
function Sides(props: {
  readonly change: WordsChange;
  readonly before: string;
  readonly after: string;
}) {
  const { change } = props;
  const { t } = useTranslation();
  const label =
    change.how === "append"
      ? `${props.after}${t("ai.packs.dialog.appended")}`
      : change.how === "remove"
        ? `${props.after}${t("ai.packs.dialog.removed")}`
        : props.after;
  return (
    <>
      <div className={styles.sides}>
        <div className={styles.side}>
          <h4>{props.before}</h4>
          <pre>{change.before}</pre>
        </div>
        <div className={`${styles.side} ${change.hints.length > 0 ? styles.flagged : ""}`}>
          <h4>{label}</h4>
          <pre data-testid="pack-after">{change.after}</pre>
        </div>
      </div>
      {change.hints.length > 0 && (
        <p className={styles.hint} data-testid="pack-hint">
          {t("ai.packs.dialog.hints", {
            reasons: change.hints.map((rule) => t(`ai.packs.hint.${rule}`)).join("、"),
          })}
        </p>
      )}
    </>
  );
}

/**
 * The models of the services people set up that a pack is for: whether it would be theirs on its
 * own, or which pack they have now.
 */
function useModels(pack: ModelPack | undefined, mode: PackDialogProps["mode"]) {
  const { ai, packs } = useWorkbench();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const installed = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  return useMemo(() => {
    if (!pack || mode === "view") return [];
    const models = [...new Set(settings.services.map(({ model }) => model).filter(Boolean))];
    const others = installed.packs.filter(({ id }) => id !== pack.id);
    const all = [...others, pack];
    return models
      .filter((model) => closenessFor(pack, model) !== undefined)
      .map((model) => {
        const chosen = settings.packFor?.[model];
        const current = choosePack(model, others, chosen).pack;
        const automatic = choosePack(model, all, chosen).pack.id === pack.id;
        return { model, current, automatic };
      });
  }, [pack, mode, settings, installed]);
}
