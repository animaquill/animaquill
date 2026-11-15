import { enabledModelsOf } from "@animaquill/agent";
import {
  choosePack,
  comparePacks,
  DEFAULT_PACK,
  nameIssues,
  previewOf,
  type ComparedSegment,
  type ModelPack,
  type PackPreview,
  type PacksCompared,
} from "@animaquill/tools";
import type { TFunction } from "i18next";
import { ChevronLeft, ExternalLink } from "lucide-react";
import {
  createContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import aiStyles from "./AiSettings.module.css";
import styles from "./ModelPacks.module.css";
import { Sides, sizeText, visible } from "./PackDialog.tsx";
import { packUsers, usePackInstall, type PackInstall } from "./PackInstall.tsx";
import { PackIntro } from "./PackIntro.tsx";
import { PackLabel } from "./PackLabel.tsx";
import { detailsOf, gitHubPlace, type PackDetails, type PackReadme } from "./packs.ts";
import {
  authorText,
  callText,
  packLabel,
  problemText,
  repositoryOf,
  settingsText,
  sourceText,
} from "./packText.ts";
import { wordDiff, type DiffRun } from "./wordDiff.ts";

/** Which page of a pack's details is open. */
export type PackView = "readme" | "changes" | "compare" | "full";

export interface PackPageProps {
  /** The page open first: the README, unless asked otherwise. */
  readonly view?: PackView;
  /** The pack to look at. */
  readonly pack: string;
  /** For a comparison, the pack to compare it with, on the left. */
  readonly other?: string;
  /** The model the words are merged for; the first model on when none. */
  readonly model?: string;
  /** The pack is no more, as people removed it here. */
  readonly onGone?: () => void;
  /** Installing as the page around it does, with its dialog there: else the page's own. */
  readonly install?: PackInstall;
}

export interface PackViewerProps extends PackPageProps {
  readonly onClose: () => void;
}

/** What opening a pack's details takes, where it is opened from. */
export type PackViewRequest = Omit<PackViewerProps, "onClose" | "onGone">;

/**
 * Opens a pack's details over the chat, from anywhere in it (the bubble of models, the menu of the
 * conversation): the chat panel provides it, and shows them over all of itself.
 */
export const OpenPackView = createContext<((request: PackViewRequest) => void) | undefined>(
  undefined,
);

/**
 * A pack's page over the chat (docs/design/settings-and-properties.md of AnimaQuill Cloud, 8.4):
 * `PackPage` under a bar with the way back (also Esc).
 */
export function PackViewer(props: PackViewerProps) {
  const { t } = useTranslation();
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    back.current?.focus();
  }, []);
  return (
    <section
      className={styles.layer}
      aria-label={t("ai.packs.viewer.title")}
      data-testid="pack-viewer"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if ((event.target as Element).closest("dialog")) return;
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }}
    >
      <div className={styles.layerBar}>
        <button
          type="button"
          ref={back}
          className={styles.layerBack}
          data-testid="pack-viewer-back"
          onClick={props.onClose}
        >
          <ChevronLeft size={14} aria-hidden /> {t("ai.packs.viewer.back")}
        </button>
      </div>
      <div className={styles.layerBody}>
        <PackPage {...props} onGone={props.onGone ?? props.onClose} />
      </div>
    </section>
  );
}

/**
 * The page of one model pack, as pi-web shows a plugin (docs/design/settings-and-properties.md of
 * AnimaQuill Cloud, 8.4): on top its label and version, an update with the way to look at it, and
 * what can be done with it (GitHub, reading it again, removing it; nothing for AnimaQuill's own);
 * under that a few rows of what it is (where from, the models it is for, those that use it,
 * licence); then four pages: its README, what it changes, a comparison with another pack, and all a
 * model gets with it. Which model uses which pack is chosen in the bubble of models, not here. What
 * packs say is text, never markup; the README is Markdown shown as `Readme` shows what someone else
 * wrote.
 */
export function PackPage(props: PackPageProps) {
  const { ai, packs, chat } = useWorkbench();
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const own = usePackInstall();
  const install = props.install ?? own;
  const models = enabledModelsOf(settings);
  const [view, setView] = useState<PackView>(props.view ?? "readme");
  const id = props.pack;
  const [model, setModel] = useState(props.model ?? models[0] ?? "");

  // Every pack there is, hidden ones and those installed that do not pass included.
  const all = snapshot.packs;
  const pack = all.find((each) => each.id === id);
  const installed = snapshot.installed.find((each) => each.id === id);
  const details = useMemo((): PackDetails | undefined => {
    return installed ? detailsOf(installed) : pack && detailsOf(pack);
  }, [installed, pack]);
  const recommended = model ? choosePack(model, all).pack : undefined;
  const [other, setOther] = useState(
    props.other ??
      (recommended && recommended.id !== id
        ? recommended.id
        : id === DEFAULT_PACK.id
          ? (all.find((each) => each.builtin && each.id !== id && !each.hidden)?.id ?? id)
          : DEFAULT_PACK.id),
  );
  const second = all.find((each) => each.id === other);
  const source = installed?.kept.source;
  const update = packs.updateOf(id);
  const looking = snapshot.looking.has(id);
  const repository = repositoryOf(source);
  // A homepage of its own, besides its repository.
  const homepage = pack?.homepage !== repository ? pack?.homepage : undefined;
  const local = source?.kind === "folder" || source?.kind === "file";
  // A pack from this computer whose homepage is on GitHub can come from there instead.
  const homeOnGitHub =
    local && pack?.homepage && gitHubPlace(pack.homepage) ? pack.homepage : undefined;
  const usedBy = packUsers(ai, chat, settings, id);
  const wordsCount = details?.words.reduce((sum, { changes }) => sum + changes.length, 0) ?? 0;
  const label = (each: ModelPack) => packLabel(t, each, snapshot);
  const choose = (value: string, set: (id: string) => void, name: string) => (
    <select value={value} aria-label={name} onChange={(event) => set(event.target.value)}>
      {all.map((each) => (
        <option key={each.id} value={each.id}>
          {label(each)}
        </option>
      ))}
    </select>
  );
  const modelPicker = (
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
  );
  const updateText =
    update &&
    (update.version
      ? t("ai.packs.updateTo", { version: update.version })
      : t("ai.packs.updateCommit", { commit: update.commit.slice(0, 7) }));
  // What it is, a row each, as pi-web lists a plugin.
  const rows: { key: string; name: string; value: ReactNode; mono?: boolean }[] = [];
  const row = (key: string, name: string, value: ReactNode, mono = false) =>
    rows.push({ key, name, value, mono });
  if (source) row("source", t("ai.packs.meta.source"), sourceText(t, source), true);
  else if (pack?.builtin) row("source", t("ai.packs.meta.source"), t("ai.packs.sourceBuiltin"));
  if (pack)
    row(
      "models",
      t("ai.packs.meta.models"),
      pack.models.length > 0
        ? pack.models.join(", ")
        : pack.hidden
          ? t("ai.packs.modelsHidden")
          : t("ai.packs.modelsNone"),
      pack.models.length > 0,
    );
  row("usedBy", t("ai.packs.meta.usedBy"), usedBy.length > 0 ? usedBy.join("、") : "—");
  if (pack?.author && !pack.builtin) row("author", t("ai.packs.meta.author"), authorText(t, pack));
  if (pack?.license) row("license", t("ai.packs.meta.license"), pack.license);
  if (homepage)
    row(
      "homepage",
      t("ai.packs.meta.homepage"),
      <a
        href={homepage}
        target="_blank"
        rel="noopener noreferrer"
        title={homepage}
        data-testid="pack-viewer-homepage"
      >
        {homepage}
      </a>,
    );
  if (details && !pack?.builtin)
    row(
      "changes",
      t("ai.packs.meta.changes"),
      t("ai.packs.changeCount", { words: wordsCount, call: details.call.length }),
    );

  return (
    <div data-testid="pack-page" data-pack={id}>
      <div className={styles.head}>
        <h2 className={styles.headName} data-testid="pack-viewer-name">
          {pack ? (
            <PackLabel pack={pack} />
          ) : installed ? (
            <PackLabel pack={{ id, name: id, builtin: false }} />
          ) : (
            id
          )}
        </h2>
        {pack && <span className={styles.headVersion}>{pack.version}</span>}
        <span className={styles.grow} />
        <div className={styles.actions}>
          {updateText && (
            <span className={styles.badge} data-kind="update" data-testid="pack-viewer-update">
              {updateText}
            </span>
          )}
          {update && installed && source?.kind === "github" && (
            <button
              type="button"
              className={styles.primary}
              data-testid="pack-viewer-see-update"
              disabled={install.busy !== undefined}
              onClick={() => void install.fromGitHub(source.url, installed)}
            >
              {t("ai.packs.seeUpdate")}
            </button>
          )}
          {installed && source?.kind === "github" && !update && (
            <button
              type="button"
              data-testid="pack-viewer-check"
              disabled={looking}
              onClick={() => void packs.lookForUpdates({ force: true, only: id })}
            >
              {looking ? t("ai.packs.checking") : t("ai.packs.checkUpdate")}
            </button>
          )}
          {installed && local && (
            <button
              type="button"
              data-testid="pack-viewer-reread"
              onClick={() =>
                source.kind === "folder"
                  ? install.pickFolder(installed)
                  : install.pickFile(installed)
              }
            >
              {t("ai.packs.reread")}
            </button>
          )}
          {repository && (
            <a
              className={styles.buttonLink}
              href={repository}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="pack-viewer-github"
            >
              GitHub <ExternalLink size={12} aria-hidden />
            </a>
          )}
          {installed && (
            <button
              type="button"
              className={styles.danger}
              data-testid="pack-viewer-remove"
              onClick={async () => {
                await install.remove(installed);
                if (!packs.installedOf(id)) props.onGone?.();
              }}
            >
              {t("ai.packs.remove")}
            </button>
          )}
        </div>
      </div>
      <dl className={styles.meta2} data-testid="pack-viewer-facts">
        {rows.map(({ key, name, value, mono }) => (
          <div key={key} data-row={key}>
            <dt>{name}</dt>
            <dd className={mono ? styles.mono : undefined}>{value}</dd>
          </div>
        ))}
        {pack?.hidden && (
          <div data-row="shown">
            <dt>{t("ai.packs.meta.shown")}</dt>
            <dd>
              {/* `data-setting`: what searching the settings goes to, see settings/registry.ts. */}
              <input
                type="checkbox"
                role="switch"
                className={aiStyles.switch}
                aria-label={t("ai.packs.meta.shown")}
                data-setting="packs.hidden"
                data-testid="pack-show-hidden"
                checked={settings.showHiddenPacks === true}
                onChange={(event) => ai.setShowHiddenPacks(event.target.checked)}
              />
            </dd>
          </div>
        )}
      </dl>
      {homeOnGitHub && installed && (
        <p className={styles.note}>
          <button
            type="button"
            className={styles.linkButton}
            data-testid="pack-viewer-to-github"
            disabled={install.busy !== undefined}
            onClick={() => void install.fromGitHub(homeOnGitHub, installed)}
          >
            {t("ai.packs.toGitHub")}
          </button>
        </p>
      )}
      {pack && !pack.builtin && nameIssues(pack.name).length > 0 && (
        <p className={styles.warning} data-testid="pack-name-issue">
          {t("ai.packs.nameNotAllowedHelp")}
        </p>
      )}
      {installed && installed.dropped.length > 0 && (
        <p className={styles.warning} data-testid="pack-dropped">
          {t("ai.packs.dropped", { count: installed.dropped.length })}
          {installed.dropped.map((problem, index) => (
            <span key={index} className={styles.droppedLine}>
              {problemText(t, problem)}
            </span>
          ))}
        </p>
      )}
      {installed && !pack && (
        <p className={styles.warning} data-testid="pack-disabled">
          {t("ai.packs.disabled", {
            reason: installed.problems.map((problem) => problemText(t, problem)).join(" "),
          })}
        </p>
      )}
      {install.failure && (
        <p className={styles.warning} role="alert">
          {install.failure}
        </p>
      )}
      <div className={styles.pageTabs} role="tablist">
        {(["readme", "changes", "compare", "full"] as const).map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={view === each}
            data-testid={`pack-tab-${each}`}
            onClick={() => setView(each)}
          >
            {t(`ai.packs.viewer.${each}`)}
          </button>
        ))}
      </div>
      {view === "readme" && (
        <PackIntro
          pack={pack}
          source={source ?? (pack?.builtin ? "builtin" : undefined)}
          readme={installed?.kept.readme ?? (pack?.builtin ? builtinReadme(t, pack) : undefined)}
        />
      )}
      {view === "changes" && details && <PackDetailsView details={details} />}
      {view === "compare" && (
        <>
          <div className={styles.pickers}>
            <label>
              {t("ai.packs.viewer.against")} {choose(other, setOther, t("ai.packs.viewer.against"))}
            </label>
            {modelPicker}
            {recommended && recommended.id !== id && recommended.id !== other && (
              <button type="button" onClick={() => setOther(recommended.id)}>
                {t("ai.packs.viewer.againstRecommended", { name: label(recommended) })}
              </button>
            )}
            {id !== DEFAULT_PACK.id && other !== DEFAULT_PACK.id && (
              <button type="button" onClick={() => setOther(DEFAULT_PACK.id)}>
                {t("ai.packs.viewer.againstDefault")}
              </button>
            )}
          </div>
          {pack && second ? (
            <Compared left={second} right={pack} model={model} />
          ) : (
            <p>{t("ai.packs.viewer.unusable")}</p>
          )}
        </>
      )}
      {view === "full" && (
        <>
          <div className={styles.pickers}>{modelPicker}</div>
          {pack ? <FullText pack={pack} model={model} /> : <p>{t("ai.packs.viewer.unusable")}</p>}
        </>
      )}
      {!props.install && own.element}
    </div>
  );
}

/** What AnimaQuill's own packs say of themselves: they have no README of their own. */
function builtinReadme(t: TFunction, pack: ModelPack): PackReadme {
  return {
    text:
      pack.id === DEFAULT_PACK.id
        ? t("ai.packs.readme.default")
        : pack.hidden
          ? t("ai.packs.readme.comparison")
          : `${pack.description ?? ""}\n\n${t("ai.packs.readme.builtin")}`,
  };
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
  const { packs } = useWorkbench();
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const compared = useMemo(() => comparePacks(left, right, model), [left, right, model]);
  const { t } = useTranslation();
  return (
    <PackCompareView
      compared={compared}
      left={packLabel(t, left, snapshot)}
      right={packLabel(t, right, snapshot)}
    />
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
  const { packs } = useWorkbench();
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const rows: [string, string][] = [
    [t("ai.packs.viewer.name"), pack ? packLabel(t, pack, snapshot) : details.id],
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
        <p className={styles.meta}>{t("ai.packs.preview.schemaNote")}</p>
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

/** Narrower than this, the two sides of a comparison go one under the other, piece by piece. */
export const NARROW_COMPARE = 640;

/** The width of an element, as it changes. */
function useWidth(element: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number | undefined>();
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return;
    // It tells the width it starts with too, before anything is painted.
    const observer = new ResizeObserver(() => setWidth(target.clientWidth));
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/** What a piece is, for people: "系统提示 · 工作方式", "工具说明 · aq_edit", "参数 · aq_edit". */
export function segmentName(t: TFunction, key: string): string {
  const [group, name, rest] = key.split(".");
  if (group === "system" && name) {
    return t("ai.packs.segment.system", {
      part: t(`ai.packs.part.${name}`, { defaultValue: name }),
    });
  }
  if (group === "tools" && name) {
    return t(rest === "params" ? "ai.packs.segment.params" : "ai.packs.segment.tool", { name });
  }
  return key;
}

/** A piece that makes AI keep to the rules, or tells it where it is: worth a look when it differs. */
const isGuarded = (key: string) => key === "system.guard" || key === "system.host";

/**
 * Two packs for one model: where how it is called differs, then every piece of what the model gets
 * side by side, those that differ marked and open, the same ones folded, and below the words that
 * differ by key as the install dialog shows them. Where it is narrow (`NARROW_COMPARE`), piece by
 * piece one under the other: `NarrowCompare`.
 */
export function PackCompareView(props: {
  readonly compared: PacksCompared;
  readonly left: string;
  readonly right: string;
}) {
  const { compared, left, right } = props;
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const narrow = width !== undefined && width < NARROW_COMPARE;
  const differ = compared.segments.filter(({ state }) => state !== "same").length;
  const words = (
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
  );
  return (
    <div data-testid="pack-compare" data-narrow={narrow ? "" : undefined} ref={root}>
      {narrow ? (
        <NarrowCompare compared={compared} left={left} right={right} />
      ) : (
        <>
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
          {words}
          <div className={styles.section}>
            <h3>{t("ai.packs.viewer.segments", { count: compared.segments.length, differ })}</h3>
            {compared.segments.map((segment) => (
              <Segment key={segment.key} segment={segment} left={left} right={right} />
            ))}
          </div>
        </>
      )}
      {narrow && words}
    </div>
  );
}

/** Which side of a narrow comparison shows: one of them, or both, one under the other. */
type CompareSide = "a" | "b" | "both";

/**
 * Two packs where it is narrow: a card a piece, its name on top; those that are the same fold into
 * one line, and by default only those that differ show. The left pack is A, the right one B; each
 * side says which it is, and the words B puts in are marked, those it takes out marked in A. A
 * switch shows one side alone.
 */
function NarrowCompare(props: {
  readonly compared: PacksCompared;
  readonly left: string;
  readonly right: string;
}) {
  const { compared, left, right } = props;
  const { t } = useTranslation();
  const [onlyDiffer, setOnlyDiffer] = useState(true);
  const [side, setSide] = useState<CompareSide>("both");
  const differ = compared.segments.filter(({ state }) => state !== "same");
  const same = compared.segments.length - differ.length;
  const shown = onlyDiffer ? differ : compared.segments;
  return (
    <>
      <div className={styles.narrowBar}>
        <label className={styles.agree}>
          <input
            type="checkbox"
            checked={onlyDiffer}
            data-testid="pack-compare-only-differ"
            onChange={(event) => setOnlyDiffer(event.target.checked)}
          />
          {t("ai.packs.viewer.onlyDiffer", {
            differ: differ.length,
            count: compared.segments.length,
          })}
        </label>
        <div
          className={styles.sideSwitch}
          role="radiogroup"
          aria-label={t("ai.packs.viewer.sides")}
          data-testid="pack-compare-sides"
        >
          {(["a", "b", "both"] as const).map((each) => (
            <button
              key={each}
              type="button"
              role="radio"
              aria-checked={side === each}
              onClick={() => setSide(each)}
            >
              {t(`ai.packs.viewer.side.${each}`)}
            </button>
          ))}
        </div>
      </div>
      {compared.call.length > 0 && (
        <div className={styles.card} data-testid="pack-compare-call">
          <div className={styles.cardHead}>
            <strong>{t("ai.packs.dialog.call")}</strong>
          </div>
          <ul className={styles.rows}>
            {compared.call.map((change, index) => (
              <li key={index}>
                {callText(t, change)}
                {change.costly && (
                  <span className={styles.costly}> {t("ai.packs.dialog.costly")}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {shown.map((segment) => (
        <NarrowSegment key={segment.key} segment={segment} left={left} right={right} side={side} />
      ))}
      {onlyDiffer && same > 0 && (
        <button
          type="button"
          className={styles.sameRow}
          data-testid="pack-compare-same"
          onClick={() => setOnlyDiffer(false)}
        >
          {t("ai.packs.viewer.sameFolded", { count: same })}
        </button>
      )}
    </>
  );
}

function NarrowSegment(props: {
  readonly segment: ComparedSegment;
  readonly left: string;
  readonly right: string;
  readonly side: CompareSide;
}) {
  const { segment, side } = props;
  const { t } = useTranslation();
  const same = segment.state === "same";
  const runs = useMemo(
    () => (same ? undefined : wordDiff(segment.left, segment.right)),
    [same, segment.left, segment.right],
  );
  const name = segmentName(t, segment.key);
  if (same) {
    return (
      <details className={styles.sameRow} data-testid="pack-compare-segment" data-state="same">
        <summary>
          {name} <span className={styles.size}>{t("ai.packs.viewer.same")}</span>
        </summary>
        <pre className={styles.cardText}>{visible(t, segment.left)}</pre>
      </details>
    );
  }
  const flagged = isGuarded(segment.key);
  const tag = flagged
    ? t(
        segment.key === "system.guard"
          ? "ai.packs.viewer.guardChanged"
          : "ai.packs.viewer.hostChanged",
      )
    : t(`ai.packs.viewer.narrow.${segment.state}`);
  return (
    <div
      className={`${styles.card} ${flagged ? styles.cardFlagged : ""}`}
      data-testid="pack-compare-segment"
      data-state={segment.state}
      data-key={segment.key}
    >
      <div className={styles.cardHead}>
        <strong>{name}</strong>
        <span className={flagged ? styles.costly : styles.size}>{tag}</span>
      </div>
      {side !== "b" && (
        <div className={styles.cardSide} data-side="a">
          <div className={styles.who}>{t("ai.packs.viewer.whoA", { name: props.left })}</div>
          <pre className={styles.cardText}>{runsOf(t, runs, "a", segment.left)}</pre>
        </div>
      )}
      {side !== "a" && (
        <div className={styles.cardSide} data-side="b">
          <div className={styles.who}>{t("ai.packs.viewer.whoB", { name: props.right })}</div>
          <pre className={styles.cardText}>{runsOf(t, runs, "b", segment.right)}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * One side of a piece that differs: in A what B takes out is marked, in B what it puts in. An empty
 * side says it is not there.
 */
function runsOf(
  t: TFunction,
  runs: readonly DiffRun[] | undefined,
  which: "a" | "b",
  text: string,
): ReactNode {
  if (text === "") return <span className={styles.size}>{t("ai.packs.viewer.partNone")}</span>;
  if (!runs) return visible(t, text);
  return runs
    .filter(({ kind }) => kind !== (which === "a" ? "in" : "out"))
    .map((run, index) =>
      run.kind === "same" ? (
        <span key={index}>{visible(t, run.text)}</span>
      ) : (
        <mark
          key={index}
          className={run.kind === "in" ? styles.put : styles.taken}
          data-testid={run.kind === "in" ? "pack-diff-in" : "pack-diff-out"}
        >
          {visible(t, run.text)}
        </mark>
      ),
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
  const runs = useMemo(
    () => (same ? undefined : wordDiff(segment.left, segment.right)),
    [same, segment.left, segment.right],
  );
  const side = (which: "a" | "b", text: string, label: string, marked: boolean) => (
    <div className={`${styles.side} ${marked ? styles.flagged : ""}`}>
      <h4>
        {label}
        <span className={styles.size}>
          {text === "" ? t("ai.packs.viewer.partNone") : sizeText(t, text)}
        </span>
      </h4>
      <pre>{text === "" ? null : runsOf(t, runs, which, text)}</pre>
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
          "a",
          segment.left,
          props.left,
          segment.state === "onlyLeft" || segment.state === "changed",
        )}
        {side(
          "b",
          segment.right,
          props.right,
          segment.state === "onlyRight" || segment.state === "changed",
        )}
      </div>
    </details>
  );
}
