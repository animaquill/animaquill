import {
  comparePacks,
  previewOf,
  type ComparedSegment,
  type ModelPack,
  type PackPreview,
  type PacksCompared,
} from "@animaquill/tools";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import dialogStyles from "../app/DialogHost.module.css";
import styles from "./ModelPacks.module.css";
import { Sides, sizeText, visible } from "./PackDialog.tsx";
import { detailsOf, type PackDetails } from "./packs.ts";
import {
  authorText,
  callText,
  packLabel,
  problemText,
  settingsText,
  sourceText,
} from "./packText.ts";

/** Which view of packs is open. */
export type PackView = "details" | "full" | "compare";

export interface PackViewerProps {
  readonly view: PackView;
  /** The pack to look at, and for a comparison the one on the left. */
  readonly pack: string;
  /** For a comparison, the one on the right. */
  readonly other?: string;
  /** The model the words are merged for; the first model of a service when none. */
  readonly model?: string;
  readonly onClose: () => void;
}

/**
 * Model packs, to look at: the details of one, everything a model gets with it, or two side by
 * side for one model. Three views that stand on their own (`PackDetailsView`, `PackFullTextView`,
 * `PackCompareView`); this dialog only picks what they show. What packs say is text, never markup.
 */
export function PackViewer(props: PackViewerProps) {
  const { ai, packs } = useWorkbench();
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const models = [...new Set(settings.services.map(({ model }) => model).filter(Boolean))];
  const [view, setView] = useState<PackView>(props.view);
  const [id, setId] = useState(props.pack);
  const [other, setOther] = useState(props.other ?? props.pack);
  const [model, setModel] = useState(props.model ?? models[0] ?? "");

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    close.current?.focus();
    return () => element?.close();
  }, []);

  // Every pack there is, hidden ones and those installed that do not pass included.
  const all = snapshot.packs;
  const pack = all.find((each) => each.id === id);
  const second = all.find((each) => each.id === other);
  const details = useMemo((): PackDetails | undefined => {
    const installed = snapshot.installed.find((each) => each.id === id);
    return installed ? detailsOf(installed) : pack && detailsOf(pack);
  }, [snapshot, id, pack]);
  const choose = (value: string, set: (id: string) => void) => (
    <select value={value} onChange={(event) => set(event.target.value)}>
      {all.map((each) => (
        <option key={each.id} value={each.id}>
          {packLabel(t, each)}
        </option>
      ))}
      {snapshot.installed
        .filter((each) => !each.pack)
        .map((each) => (
          <option key={each.id} value={each.id}>
            {each.id}
          </option>
        ))}
    </select>
  );
  const title = t("ai.packs.viewer.title");

  return (
    <dialog
      ref={dialog}
      className={`${dialogStyles.wide} ${styles.dialog}`}
      aria-label={title}
      data-testid="pack-viewer"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <div className={`${dialogStyles.content} ${styles.full}`}>
        <h2>{title}</h2>
        <div className={styles.tabs} role="tablist">
          {(["details", "full", "compare"] as const).map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={view === each}
              className={view === each ? styles.tabOn : undefined}
              onClick={() => setView(each)}
            >
              {t(`ai.packs.viewer.${each}`)}
            </button>
          ))}
        </div>
        <div className={styles.pickers}>
          <label>
            {view === "compare" ? t("ai.packs.viewer.left") : t("ai.packs.viewer.pack")}{" "}
            {choose(id, setId)}
          </label>
          {view === "compare" && (
            <label>
              {t("ai.packs.viewer.right")} {choose(other, setOther)}
            </label>
          )}
          {view !== "details" && (
            <label>
              {t("ai.packs.viewer.model")}{" "}
              <input
                value={model}
                list="pack-viewer-models"
                spellCheck={false}
                aria-label={t("ai.packs.viewer.model")}
                onChange={(event) => setModel(event.target.value.trim())}
              />
              <datalist id="pack-viewer-models">
                {models.map((each) => (
                  <option key={each} value={each} />
                ))}
              </datalist>
            </label>
          )}
        </div>
        {view === "details" && details && <PackDetailsView details={details} />}
        {view === "full" && pack && <FullText pack={pack} model={model} />}
        {view === "full" && !pack && <p>{t("ai.packs.viewer.unusable")}</p>}
        {view === "compare" && pack && second && (
          <Compared left={pack} right={second} model={model} />
        )}
        {view === "compare" && (!pack || !second) && <p>{t("ai.packs.viewer.unusable")}</p>}
        <div className={dialogStyles.buttons}>
          <button type="button" ref={close} onClick={props.onClose}>
            {t("ai.packs.dialog.close")}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function FullText(props: { readonly pack: ModelPack; readonly model: string }) {
  const preview = useMemo(() => previewOf(props.pack, props.model), [props.pack, props.model]);
  return <PackFullTextView preview={preview} />;
}

function Compared(props: {
  readonly left: ModelPack;
  readonly right: ModelPack;
  readonly model: string;
}) {
  const { left, right, model } = props;
  const compared = useMemo(() => comparePacks(left, right, model), [left, right, model]);
  const { t } = useTranslation();
  return (
    <PackCompareView compared={compared} left={packLabel(t, left)} right={packLabel(t, right)} />
  );
}

/** A button that puts text on the clipboard. */
function Copy(props: { readonly text: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={styles.copy}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(props.text)
          .then(() => setDone(true))
          .catch(() => undefined);
      }}
    >
      {done ? t("ai.packs.viewer.copied") : t("ai.packs.viewer.copy")}
    </button>
  );
}

/**
 * The details of a pack: who wrote it and where it is from, its version, the models it is for, how
 * it calls them and how much results give, the words it changes by group (each next to the words
 * it replaces), the version of the tools it was installed with, and what of it is not used and why.
 */
export function PackDetailsView(props: { readonly details: PackDetails }) {
  const { details } = props;
  const { pack } = details;
  const { t } = useTranslation();
  const rows: [string, string][] = [
    [t("ai.packs.viewer.name"), pack ? packLabel(t, pack) : details.id],
    [t("ai.packs.viewer.id"), details.id],
    ...(pack
      ? ([
          [t("ai.packs.viewer.author"), authorText(t, pack)],
          [t("ai.packs.viewer.version"), pack.version],
          ...(pack.license ? [[t("ai.packs.viewer.license"), pack.license]] : []),
          ...(pack.homepage ? [[t("ai.packs.viewer.homepage"), pack.homepage]] : []),
        ] as [string, string][])
      : []),
    [
      t("ai.packs.viewer.source"),
      details.source === "builtin" ? t("ai.packs.sourceBuiltin") : sourceText(t, details.source),
    ],
    ...(details.toolset
      ? [[t("ai.packs.viewer.toolset"), details.toolset] as [string, string]]
      : []),
    ...(pack
      ? ([
          [
            t("ai.packs.viewer.models"),
            pack.models.length > 0
              ? pack.models.join(", ")
              : pack.hidden
                ? t("ai.packs.modelsHidden")
                : t("ai.packs.modelsNone"),
          ],
          [t("ai.packs.viewer.results"), t(`ai.packs.value.results.${pack.results ?? "standard"}`)],
        ] as [string, string][])
      : []),
  ];
  const before = t("ai.packs.dialog.builtinWords");
  const after = t("ai.packs.dialog.packWords");
  return (
    <div data-testid="pack-details">
      <dl className={styles.facts}>
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {pack?.description && <p>{pack.description}</p>}
      {details.problems.length > 0 && (
        <div className={styles.section}>
          <h3>{t("ai.packs.viewer.problems")}</h3>
          <ul className={styles.problems}>
            {details.problems.map((problem, index) => (
              <li key={index}>{problemText(t, problem)}</li>
            ))}
          </ul>
        </div>
      )}
      {details.dropped.length > 0 && (
        <div className={styles.section} data-testid="pack-details-dropped">
          <h3>{t("ai.packs.viewer.dropped", { count: details.dropped.length })}</h3>
          <ul className={styles.problems}>
            {details.dropped.map((problem, index) => (
              <li key={index}>{problemText(t, problem)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={styles.section}>
        <h3>{t("ai.packs.dialog.call")}</h3>
        {details.call.length === 0 ? (
          <p>{t("ai.packs.dialog.callNone")}</p>
        ) : (
          <ul className={styles.rows}>
            {details.call.map((change, index) => (
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
      <div className={styles.section} data-testid="pack-details-words">
        <h3>{t("ai.packs.dialog.words")}</h3>
        {details.words.length === 0 && <p>{t("ai.packs.dialog.wordsNone")}</p>}
        {details.words.map(({ group, changes }) => (
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
                  <span className={styles.size}>{sizeText(t, change.after)}</span>
                  {change.sensitive && (
                    <span className={styles.costly}>{t("ai.packs.viewer.sensitive")}</span>
                  )}
                </summary>
                <Sides change={change} before={before} after={after} />
              </details>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Everything a model gets with a pack, merged: how it is called, the system prompt part by part and
 * whole, and each tool with its description and its parameters with what they say. Read only; each
 * piece folds and can be copied.
 */
export function PackFullTextView(props: { readonly preview: PackPreview }) {
  const { preview } = props;
  const { t } = useTranslation();
  const tools = preview.tools.map((tool) => ({
    ...tool,
    schema: JSON.stringify(tool.inputSchema, null, 2),
    // As the list goes out (JSON without spaces), which is what the limits of packs count.
    size: tool.description.length + JSON.stringify(tool.inputSchema).length,
  }));
  const toolsSize = tools.reduce((sum, tool) => sum + tool.name.length + tool.size, 0);
  const everything = [
    preview.system,
    ...tools.map((tool) => `## ${tool.name}\n\n${tool.description}\n\n${tool.schema}`),
  ].join("\n\n");
  return (
    <div data-testid="pack-full">
      <div className={styles.section}>
        <h3>{t("ai.packs.preview.call")}</h3>
        <ul className={styles.rows} data-testid="pack-preview-call">
          {settingsText(t, preview.call, preview.results).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div className={styles.section}>
        <h3>
          {t("ai.packs.preview.system", { chars: preview.system.length.toLocaleString() })}{" "}
          <Copy text={preview.system} /> <Copy text={everything} />
        </h3>
        {preview.parts.map(({ part, text }) => (
          <details key={part} open data-testid="pack-preview-part">
            <summary>
              <code>system.{part}</code>
              <span className={styles.size}>
                {text === "" ? t("ai.packs.viewer.partNone") : sizeText(t, text)}
              </span>
            </summary>
            {text !== "" && <pre>{visible(t, text)}</pre>}
          </details>
        ))}
      </div>
      <div className={styles.section}>
        <h3>
          {t("ai.packs.preview.tools", {
            count: tools.length,
            chars: toolsSize.toLocaleString(),
          })}
        </h3>
        {tools.map((tool) => (
          <details key={tool.name} data-testid="pack-preview-tool">
            <summary>
              <code>{tool.name}</code>
              <span className={styles.size}>
                {t("ai.packs.preview.toolSize", { chars: tool.size.toLocaleString() })}
              </span>
            </summary>
            <Copy text={`${tool.description}\n\n${tool.schema}`} />
            <pre>{visible(t, tool.description)}</pre>
            <pre>{tool.schema}</pre>
          </details>
        ))}
      </div>
    </div>
  );
}

/**
 * Two packs for one model: where how it is called differs, then every piece of what the model gets
 * side by side, those that differ marked and open, the same ones folded, and below the words that
 * differ by key as the install dialog shows them.
 */
export function PackCompareView(props: {
  readonly compared: PacksCompared;
  readonly left: string;
  readonly right: string;
}) {
  const { compared, left, right } = props;
  const { t } = useTranslation();
  const differ = compared.segments.filter(({ state }) => state !== "same").length;
  return (
    <div data-testid="pack-compare">
      <div className={styles.section}>
        <h3>{t("ai.packs.dialog.call")}</h3>
        {compared.call.length === 0 ? (
          <p>{t("ai.packs.viewer.callSame")}</p>
        ) : (
          <ul className={styles.rows} data-testid="pack-compare-call">
            {compared.call.map((change, index) => (
              <li key={index}>{callText(t, change)}</li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.section} data-testid="pack-compare-words">
        <h3>{t("ai.packs.viewer.words", { count: compared.words.length })}</h3>
        {compared.words.map((change, index) => (
          <details key={`${change.key}-${index}`} className={styles.change}>
            <summary>
              {change.key}
              <span className={styles.size}>{sizeText(t, change.after)}</span>
              {change.sensitive && (
                <span className={styles.costly}>{t("ai.packs.viewer.sensitive")}</span>
              )}
            </summary>
            <Sides change={change} before={left} after={right} />
          </details>
        ))}
      </div>
      <div className={styles.section}>
        <h3>{t("ai.packs.viewer.segments", { count: compared.segments.length, differ })}</h3>
        {compared.segments.map((segment) => (
          <Segment key={segment.key} segment={segment} left={left} right={right} />
        ))}
      </div>
    </div>
  );
}

function Segment(props: {
  readonly segment: ComparedSegment;
  readonly left: string;
  readonly right: string;
}) {
  const { segment } = props;
  const { t } = useTranslation();
  const same = segment.state === "same";
  const side = (text: string, label: string, marked: boolean) => (
    <div className={`${styles.side} ${marked ? styles.flagged : ""}`}>
      <h4>
        {label}
        <span className={styles.size}>
          {text === "" ? t("ai.packs.viewer.partNone") : sizeText(t, text)}
        </span>
      </h4>
      <pre>{visible(t, text)}</pre>
    </div>
  );
  return (
    <details
      className={styles.change}
      open={!same}
      data-testid="pack-compare-segment"
      data-state={segment.state}
    >
      <summary>
        {segment.key}
        {!same && <span className={styles.costly}>{t(`ai.packs.viewer.${segment.state}`)}</span>}
      </summary>
      <div className={styles.sides}>
        {side(
          segment.left,
          props.left,
          segment.state === "onlyLeft" || segment.state === "changed",
        )}
        {side(
          segment.right,
          props.right,
          segment.state === "onlyRight" || segment.state === "changed",
        )}
      </div>
    </details>
  );
}
