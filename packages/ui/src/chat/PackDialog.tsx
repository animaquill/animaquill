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
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import dialogStyles from "../app/DialogHost.module.css";
import styles from "./ModelPacks.module.css";
import type { PackSource } from "./packs.ts";
import {
  authorText,
  callText,
  originDiffers,
  packLabel,
  packName,
  problemText,
  sourceText,
} from "./packText.ts";

export interface PackDialogProps {
  /** Installing a pack, taking a new version of one installed, or only looking at one. */
  readonly mode: "install" | "update" | "view";
  /** Nothing when it does not pass: `problems` says why. */
  readonly pack: ModelPack | undefined;
  /** The version installed, which an update is shown against. */
  readonly installed?: ModelPack | undefined;
  /** Where the version installed came from, for an update. */
  readonly installedSource?: PackSource | undefined;
  readonly source?: PackSource | undefined;
  readonly problems?: readonly PackProblem[];
  /** People said yes, and what their models are to use from now on. */
  readonly onConfirm?: (choice: PackDialogChoice) => void;
  readonly onClose: () => void;
}

/**
 * What people chose for their models as they installed a pack: models that are to use it although
 * another pack would go on, and models that are to keep the pack they have now although this one
 * would take over.
 */
export interface PackDialogChoice {
  readonly switchTo: readonly string[];
  readonly keep: readonly { readonly model: string; readonly pack: string }[];
}

const GROUPS: readonly WordsGroup[] = ["system", "tools", "params", "ops", "examples"];

/**
 * What a model pack would change, before people install it or take an update: where it is from,
 * what it changes of the guard or of what the place says of itself (first, to agree to on its own),
 * which models it would be for, how it calls them, and every change of words next to the words it
 * replaces. All of it as text: what a pack says is never markup.
 */
export function PackDialog(props: PackDialogProps) {
  const {
    mode,
    pack,
    installed,
    installedSource,
    source,
    problems = [],
    onConfirm,
    onClose,
  } = props;
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [agreed, setAgreed] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [keeping, setKeeping] = useState(false);

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
  const takeover = models.filter(({ effect }) => effect === "takeover");
  const stays = models.filter(({ effect }) => effect === "stays");
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
        {foreign && mode !== "view" && (
          <p className={styles.trust} data-testid="pack-trust">
            {t("ai.packs.dialog.trust")}
          </p>
        )}
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
        {pack && !pack.builtin && (
          <p className={styles.meta} data-testid="pack-author">
            {t("ai.packs.dialog.author", { author: authorText(t, pack) })}
            {pack.homepage && ` · ${pack.homepage}`}
          </p>
        )}
        {pack?.description && <p>{pack.description}</p>}
        {mode === "update" && pack && installed && (
          <Origin
            pack={pack}
            installed={installed}
            source={source}
            installedSource={installedSource}
          />
        )}
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
        {mode === "update" && installed && (
          <p>{t("ai.packs.dialog.updateFrom", { version: installed.version })}</p>
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
                {models.map(({ model, current, effect }) => (
                  <li
                    key={model}
                    className={effect === "takeover" ? styles.takeover : undefined}
                    data-testid="pack-model"
                  >
                    {t(`ai.packs.dialog.model.${effect}`, {
                      model,
                      current: packLabel(t, current),
                    })}
                  </li>
                ))}
              </ul>
            )}
            {takeover.length > 0 && (
              <label className={styles.agree}>
                <input
                  type="checkbox"
                  checked={keeping}
                  onChange={(event) => setKeeping(event.target.checked)}
                  data-testid="pack-keep"
                />
                {t("ai.packs.dialog.keep")}
              </label>
            )}
            {stays.length > 0 && (
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
                // What to look out for first in each group.
                const changes = rest
                  .filter((change) => change.group === group)
                  .toSorted((a, b) => Number(b.hints.length > 0) - Number(a.hints.length > 0));
                if (changes.length === 0) return null;
                const flagged = changes.filter((change) => change.hints.length > 0).length;
                return (
                  <div key={group} className={styles.section}>
                    <h3>
                      {t("ai.packs.dialog.groupCount", {
                        group: t(`ai.packs.group.${group}`),
                        count: changes.length,
                      })}
                      {flagged > 0 && (
                        <span className={styles.costly}>
                          {t("ai.packs.dialog.groupFlagged", { count: flagged })}
                        </span>
                      )}
                    </h3>
                    {changes.map((change, index) => (
                      <details key={`${change.key}-${index}`} className={styles.change}>
                        <summary>
                          {change.key}
                          {change.models && ` (${change.models.join(", ")})`}
                          <span className={styles.size}>{sizeText(t, change.after)}</span>
                          {change.hints.length > 0 && (
                            <span className={styles.costly}>{t("ai.packs.dialog.flagged")}</span>
                          )}
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
                onConfirm({
                  switchTo: switching ? stays.map(({ model }) => model) : [],
                  keep: keeping
                    ? takeover.map(({ model, current }) => ({ model, pack: current.id }))
                    : [],
                })
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
export function Sides(props: {
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
          <h4>
            {props.before}
            <span className={styles.size}>{sizeText(t, change.before)}</span>
          </h4>
          <pre>{visible(t, change.before)}</pre>
        </div>
        <div className={`${styles.side} ${change.hints.length > 0 ? styles.flagged : ""}`}>
          <h4>
            {label}
            <span className={styles.size}>{sizeText(t, change.after)}</span>
          </h4>
          <pre data-testid="pack-after">{visible(t, change.after)}</pre>
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

/** What installing a pack does for one model: it takes over, the model stays, or it has it now. */
type ModelEffect = "takeover" | "stays" | "already";

/**
 * The models of the services people set up that a pack is for, or that people chose it for: which
 * pack each has now, and whether this one would take over once installed.
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
      .filter(
        (model) => closenessFor(pack, model) !== undefined || settings.packFor?.[model] === pack.id,
      )
      .map((model) => {
        const chosen = settings.packFor?.[model];
        const current = choosePack(model, installed.packs, chosen).pack;
        const after = choosePack(model, all, chosen).pack;
        const effect: ModelEffect =
          current.id === pack.id ? "already" : after.id === pack.id ? "takeover" : "stays";
        return { model, current, effect };
      });
  }, [pack, mode, settings, installed]);
}

/** How long words are: "3 行 · 120 字". */
export function sizeText(t: TFunction, text: string): string {
  return t("ai.packs.dialog.size", {
    lines: text === "" ? 0 : text.split("\n").length,
    chars: [...text].length,
  });
}

/**
 * What shows as a mark: two lines or more in a row with nothing to see; any space but the plain
 * one (wide spaces, spaces that do not break, and the like); a run of eight plain spaces or more
 * after words in a line, and an indent wider than sixteen (a tab counts four); and combining marks
 * with nothing to sit on, which show as next to nothing. The check of packs lets no long run of any
 * of them through; the marks make even those plain to see.
 */
const MARKED =
  /(?:(?:[^\S\n]|(?<![\p{L}\p{N}\p{P}\p{S}])\p{M})*\n){3,}|[^\S\n \t]+|(?<=\S)[ \t]{8,}|^[ \t]{17,}|(?<![\p{L}\p{N}\p{P}\p{S}\p{M}])\p{M}+/gmu;

/** What a mark says of the blank it stands for. */
function markOf(t: TFunction, run: string): string {
  const breaks = run.split("\n").length - 1;
  if (breaks > 0) return t("ai.packs.dialog.emptyLines", { count: breaks - 1 });
  const chars = [...run];
  if (chars.every((char) => /\p{M}/u.test(char))) {
    return t("ai.packs.dialog.marks", { count: chars.length });
  }
  if (chars.some((char) => char !== " " && char !== "\t")) {
    return t("ai.packs.dialog.otherSpaces", { count: chars.length });
  }
  return t("ai.packs.dialog.spaces", {
    count: chars.reduce((width, char) => width + (char === "\t" ? 4 : 1), 0),
  });
}

/**
 * Words as they are, with blank that could hide what comes after it shown as marks that say what
 * it is and how long: no run of blank can push words out of sight, and none goes unseen.
 */
export function visible(t: TFunction, text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKED)) {
    const run = match[0];
    const at = match.index;
    nodes.push(text.slice(last, at));
    const lines = run.includes("\n") ? "\n" : "";
    nodes.push(
      lines,
      <span key={at} className={styles.blank} data-testid="pack-blank">
        {markOf(t, run)}
      </span>,
      lines,
    );
    last = at + run.length;
  }
  nodes.push(text.slice(last));
  return nodes;
}

/**
 * For an update: where the version installed came from and who wrote it, next to the new one's.
 * The same id is no proof of the same author: anyone can write any id, so where they differ it
 * says so plainly.
 */
function Origin(props: {
  readonly pack: ModelPack;
  readonly installed: ModelPack;
  readonly source: PackSource | undefined;
  readonly installedSource: PackSource | undefined;
}) {
  const { pack, installed, source, installedSource } = props;
  const { t } = useTranslation();
  const where = (each: PackSource | undefined) => (each ? sourceText(t, each) : "?");
  const differs = originDiffers(pack, installed, source, installedSource);
  return (
    <div
      className={`${styles.section} ${differs ? styles.origin : ""}`}
      data-testid="pack-origin"
      data-differs={differs ? "yes" : "no"}
    >
      {differs && <h3>{t("ai.packs.dialog.originDiffers")}</h3>}
      <ul className={styles.rows}>
        <li>
          {t("ai.packs.dialog.originInstalled", {
            author: authorText(t, installed),
            source: where(installedSource),
          })}
        </li>
        <li>
          {t("ai.packs.dialog.originNew", { author: authorText(t, pack), source: where(source) })}
        </li>
      </ul>
    </div>
  );
}
