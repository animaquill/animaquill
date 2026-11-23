import { scoped } from "@animaquill/host";
import { Check, ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSession, useWorkbench } from "../app/context.ts";
import { DialogFrame, useNarrow } from "../settings/shell.tsx";
import settings from "../settings/Settings.module.css";
import { toolName } from "../workbench/tool-activity.ts";
import { hasInstructions } from "./AgentsGroup.tsx";
import {
  COMMANDS,
  DESKTOP_CONFIG,
  GUIDE_SYSTEMS,
  GUIDE_TOOLS,
  NODE_DOWNLOAD,
  allowOriginCommand,
  cleanPath,
  cursorJson,
  cursorLink,
  desktopConfig,
  guideCommand,
  isGuideTool,
  otherWithProject,
  systemHere,
  vscodeCommand,
  vscodeLink,
  type GuideSystem,
  type GuideTool,
} from "./guide.ts";
import { canConnectHere, whenText, useToolActivity } from "./LocalAiSettings.tsx";
import styles from "./LocalAi.module.css";

/** Edge says the same as Chrome in other words. */
const isEdge = () => typeof navigator !== "undefined" && /\bEdg\//.test(navigator.userAgent);

/** The editor of `npx animaquill`, which every `animaquill mcp` lets connect without being told. */
const isLocalEditor = (origin: string) => {
  try {
    return new URL(origin).hostname === "animaquill.localhost";
  } catch {
    return false;
  }
};
/** Where this browser keeps the tool people picked last: what they use, not a setting. */
const TOOL_KEY = "animaquill.localAi.tool";

function rememberedTool(): GuideTool {
  try {
    const kept = localStorage.getItem(scoped(TOOL_KEY));
    return isGuideTool(kept) ? kept : "claudeCode";
  } catch {
    return "claudeCode";
  }
}

function rememberTool(tool: GuideTool): void {
  try {
    localStorage.setItem(scoped(TOOL_KEY), tool);
  } catch {
    // Not kept: it starts with the first one next time.
  }
}

/** The guide, while the window has it open. */
export function LocalAiGuideHost() {
  const { localAiGuide } = useWorkbench();
  const shown = useSyncExternalStore(localAiGuide.subscribe, localAiGuide.getSnapshot);
  return shown ? <LocalAiGuide /> : null;
}

/** Something to copy: a command or a piece of a configuration, with its button. */
function Copyable({ text, label }: { readonly text: string; readonly label?: string }) {
  const { t } = useTranslation();
  const [said, setSaid] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    let done = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      done = false;
    }
    setSaid(done ? t("localAi.guide.copied") : t("localAi.guide.copyFailed"));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(undefined), 1500);
  };
  const isBlock = text.includes("\n");
  return (
    <div className={styles.code} data-testid="local-ai-copyable">
      {isBlock ? <pre>{text}</pre> : <code>{text}</code>}
      <button
        type="button"
        className={styles.copy}
        aria-label={`${t("localAi.guide.copy")} ${label ?? text}`}
        onClick={() => void copy()}
      >
        {said ?? t("localAi.guide.copy")}
      </button>
    </div>
  );
}

function Step(props: {
  readonly number: number;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <li className={styles.step}>
      <span className={styles.number} aria-hidden>
        {props.number}
      </span>
      <div className={styles.stepBody}>
        <h3 className={styles.stepTitle}>{props.title}</h3>
        {props.children}
      </div>
    </li>
  );
}

function More(props: {
  readonly summary: string;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  return (
    <details className={styles.more} data-testid={props.testId}>
      <summary>{props.summary}</summary>
      <div>{props.children}</div>
    </details>
  );
}

/**
 * Let an AI tool on this computer change this project (docs/design/mcp.md, 6.16a, screen M1; its
 * calls run in this editor, docs/design/online-offline.md 5): where the project is, what to have,
 * the tool with what to set up once and what to do each time, connecting this editor, a sentence to
 * try, and at the bottom who is connected now. Words only where a step needs
 * them: the commands say the rest.
 */
function LocalAiGuide() {
  const workbench = useWorkbench();
  const { localAiGuide, projectFolders, bridge, autoConnect } = workbench;
  const { t } = useTranslation();
  const narrow = useNarrow();
  const { store } = useSession();
  const folders = useSyncExternalStore(
    projectFolders?.subscribe ?? noSubscription,
    projectFolders?.getSnapshot ?? nothing,
  );
  const activity = useToolActivity();
  const link = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const auto = useSyncExternalStore(autoConnect.subscribe, autoConnect.getSnapshot);
  const [tool, setTool] = useState<GuideTool>(rememberedTool);
  const [system, setSystem] = useState<GuideSystem>(systemHere);
  const [path, setPath] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const state = store?.getState();
  // Re-rendered with the project: AGENTS.md can be added from here.
  useSyncExternalStore(store?.subscribe ?? noSubscription, store?.getState ?? nothing);

  const close = () => localAiGuide.set(false);
  const folder = folders?.open?.record.folder.name;
  const project =
    store === undefined
      ? "none"
      : workbench.mode === "online"
        ? "online"
        : folder !== undefined
          ? "folder"
          : "browser";
  // Where the AI tool starts: in the folder of an offline project, anywhere for any other.
  const where =
    folder !== undefined
      ? t("localAi.guide.theFolder", { folder, interpolation: { escapeValue: false } })
      : project === "online" || project === "browser"
        ? t("localAi.guide.anyFolder")
        : t("localAi.guide.projectFolder");
  const origin = typeof location === "undefined" ? "" : location.origin;
  const chromium = canConnectHere();
  const [first] = activity.connections;
  const pick = (next: GuideTool) => {
    setTool(next);
    rememberTool(next);
  };

  const openHere = (command: string) => (
    <>
      <span className={styles.line}>
        {t(
          system === "windows"
            ? "localAi.guide.openWindows"
            : system === "mac"
              ? "localAi.guide.openMac"
              : "localAi.guide.openLinux",
          { folder: where, interpolation: { escapeValue: false } },
        )}
      </span>
      <Copyable text={command} />
    </>
  );

  const panel = (() => {
    switch (tool) {
      case "claudeCode":
        return (
          <>
            <h4 className={styles.sub}>{t("localAi.guide.once")}</h4>
            <Copyable text={COMMANDS.marketplace} />
            <Copyable text={COMMANDS.plugin} />
            <More summary={t("localAi.guide.onlyServer")}>
              <Copyable text={COMMANDS.claudeServer} />
            </More>
            <h4 className={styles.sub}>{t("localAi.guide.each")}</h4>
            {openHere(COMMANDS.claude)}
          </>
        );
      case "codex":
        return (
          <>
            <h4 className={styles.sub}>{t("localAi.guide.once")}</h4>
            <Copyable text={COMMANDS.codexServer} />
            <More summary={t("localAi.guide.codexSlow")}>
              <Copyable text={COMMANDS.installGlobally} />
              <Copyable text={COMMANDS.codexInstalled} />
            </More>
            <h4 className={styles.sub}>{t("localAi.guide.each")}</h4>
            {openHere(COMMANDS.codex)}
          </>
        );
      case "cursor":
        return (
          <>
            <h4 className={styles.sub}>{t("localAi.guide.once")}</h4>
            <a className={styles.addButton} href={cursorLink()} data-testid="local-ai-add-cursor">
              {t("localAi.guide.addCursor")}
            </a>
            <More summary={t("localAi.guide.byHand")}>
              <span className={styles.line}>{t("localAi.guide.cursorFile")}</span>
              <Copyable text={cursorJson()} label="mcp.json" />
            </More>
            <h4 className={styles.sub}>{t("localAi.guide.each")}</h4>
            <span className={styles.line}>
              {t("localAi.guide.openWith", {
                tool: t("localAi.tools.cursor"),
                folder: where,
                interpolation: { escapeValue: false },
              })}
            </span>
          </>
        );
      case "vscode":
        return (
          <>
            <h4 className={styles.sub}>{t("localAi.guide.once")}</h4>
            <a className={styles.addButton} href={vscodeLink()} data-testid="local-ai-add-vscode">
              {t("localAi.guide.addVscode")}
            </a>
            {system !== "windows" && (
              <More summary={t("localAi.guide.byHand")}>
                <Copyable text={vscodeCommand()} label="code --add-mcp" />
              </More>
            )}
            <h4 className={styles.sub}>{t("localAi.guide.each")}</h4>
            <span className={styles.line}>
              {t("localAi.guide.openWith", {
                tool: t("localAi.tools.vscode"),
                folder: where,
                interpolation: { escapeValue: false },
              })}
            </span>
          </>
        );
      case "claudeDesktop": {
        const cleaned = cleanPath(path);
        // Without a folder, the project is the one open in front.
        if (project === "online" || project === "browser") {
          return (
            <>
              <span className={styles.line}>
                {t("localAi.guide.desktopFile", {
                  file: DESKTOP_CONFIG[system],
                  interpolation: { escapeValue: false },
                })}
              </span>
              <Copyable text={desktopConfig()} label="claude_desktop_config.json" />
            </>
          );
        }
        return (
          <>
            <label className={styles.panel}>
              <span>
                {t(
                  system === "windows"
                    ? "localAi.guide.pathWindows"
                    : system === "mac"
                      ? "localAi.guide.pathMac"
                      : "localAi.guide.pathLinux",
                )}
              </span>
              <input
                className={styles.path}
                aria-label={t("localAi.guide.pathLabel")}
                placeholder={t("localAi.guide.pathHolder")}
                spellCheck={false}
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </label>
            <span className={styles.line}>
              {t("localAi.guide.desktopFile", {
                file: DESKTOP_CONFIG[system],
                interpolation: { escapeValue: false },
              })}
            </span>
            <Copyable
              text={desktopConfig(cleaned === "" ? t("localAi.guide.pathHolder") : cleaned)}
              label="claude_desktop_config.json"
            />
          </>
        );
      }
      case "other":
        return (
          <>
            <span className={styles.line}>{t("localAi.guide.otherRun")}</span>
            <Copyable text={COMMANDS.other} />
            <span className={styles.line}>{t("localAi.guide.otherProject")}</span>
            <Copyable text={otherWithProject(t("localAi.guide.pathHolder"))} />
          </>
        );
    }
  })();

  return (
    <DialogFrame
      label={t("localAi.guide.title")}
      testId="local-ai-guide"
      narrow={narrow}
      onClose={close}
      kind="guide"
    >
      <div className={styles.box}>
        <header className={settings.head}>
          <h2 className={settings.title}>{t("localAi.guide.title")}</h2>
          <button
            type="button"
            className={settings.close}
            style={{ marginLeft: "auto" }}
            aria-label={t("localAi.guide.close")}
            onClick={close}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className={styles.page}>
          {project !== "none" && (
            <div className={styles.state} data-ok="" data-testid="local-ai-project">
              <Check size={15} aria-hidden />
              <span>
                {project === "folder"
                  ? t("localAi.guide.offlineFolder", {
                      folder,
                      interpolation: { escapeValue: false },
                    })
                  : project === "online"
                    ? t("localAi.guide.online")
                    : t("localAi.guide.offlineBrowser")}
              </span>
            </div>
          )}
          <ol className={styles.steps}>
            <Step number={1} title={t("localAi.guide.prepare")}>
              <span className={styles.line}>
                {t("localAi.guide.node")}
                <a className={settings.link} href={NODE_DOWNLOAD} target="_blank" rel="noreferrer">
                  {t("localAi.guide.nodeDownload")}
                  <ExternalLink size={11} aria-hidden />
                </a>
              </span>
              <span className={styles.line}>{t("localAi.guide.nodeCheck")}</span>
              <Copyable text={COMMANDS.nodeVersion} />
            </Step>
            <Step number={2} title={t("localAi.guide.pick")}>
              <div className={styles.tabsLine}>
                <div
                  ref={tabs}
                  className={styles.tabs}
                  role="tablist"
                  aria-label={t("localAi.guide.toolsLabel")}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                    const step = event.key === "ArrowRight" ? 1 : -1;
                    const at = GUIDE_TOOLS.indexOf(tool);
                    const next = GUIDE_TOOLS.at((at + step) % GUIDE_TOOLS.length) ?? tool;
                    pick(next);
                    event.preventDefault();
                    requestAnimationFrame(() =>
                      tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus(),
                    );
                  }}
                >
                  {GUIDE_TOOLS.map((each) => (
                    <button
                      key={each}
                      type="button"
                      role="tab"
                      aria-selected={each === tool}
                      tabIndex={each === tool ? 0 : -1}
                      data-tool={each}
                      onClick={() => pick(each)}
                    >
                      {each === "claudeCode"
                        ? `${t("localAi.tools.claudeCode")}（${t("localAi.guide.recommended")}）`
                        : t(`localAi.tools.${each}`)}
                    </button>
                  ))}
                </div>
                {tool !== "cursor" && tool !== "other" && (
                  <span className={styles.systemLine}>
                    {t("localAi.guide.system")}
                    <span
                      className={settings.segmented}
                      role="radiogroup"
                      aria-label={t("localAi.guide.system")}
                    >
                      {GUIDE_SYSTEMS.map((each) => (
                        <button
                          key={each}
                          type="button"
                          role="radio"
                          aria-checked={each === system}
                          onClick={() => setSystem(each)}
                        >
                          {t(`localAi.guide.systems.${each}`)}
                        </button>
                      ))}
                    </span>
                  </span>
                )}
              </div>
              <div className={styles.panel} role="tabpanel" data-testid="local-ai-panel">
                {panel}
              </div>
            </Step>
            <Step number={3} title={t("localAi.guide.connectStep")}>
              {chromium && origin !== "" && !isLocalEditor(origin) && (
                <>
                  <span className={styles.line}>{t("localAi.guide.allowSite")}</span>
                  <Copyable text={allowOriginCommand(origin)} />
                </>
              )}
              {chromium ? (
                <div className={styles.connect} data-testid="local-ai-connect">
                  {link.status === "connected" ? (
                    <span className={styles.line} role="status">
                      <Check size={14} aria-hidden /> {t("localAi.guide.connectedRelay")}
                      <button
                        type="button"
                        className={settings.link}
                        onClick={() => bridge.disconnect()}
                      >
                        {t("localAi.guide.disconnect")}
                      </button>
                    </span>
                  ) : (
                    <>
                      <span className={styles.line}>{t("localAi.guide.connectAsk")}</span>
                      <button
                        type="button"
                        className={`${settings.button} ${settings.primary}`}
                        style={{ alignSelf: "flex-start" }}
                        data-testid="local-ai-connect-button"
                        disabled={link.status === "connecting"}
                        onClick={() => bridge.connect()}
                      >
                        {t("localAi.guide.connect")}
                      </button>
                      {link.status !== "off" && (
                        <span
                          className={styles.muted}
                          role="status"
                          data-testid="local-ai-connect-status"
                        >
                          {link.status === "denied"
                            ? t(
                                isEdge()
                                  ? "localAi.guide.deniedEdge"
                                  : "localAi.guide.deniedChrome",
                              )
                            : t(`localAi.guide.status.${link.status}`)}
                        </span>
                      )}
                      {link.status === "not-allowed" && (
                        <Copyable text={allowOriginCommand(origin)} />
                      )}
                      {link.status === "no-relay" && (
                        <More summary={t("localAi.guide.stillNot")}>
                          <span className={styles.line}>{t("localAi.guide.wsl")}</span>
                        </More>
                      )}
                    </>
                  )}
                  {link.mismatch && link.status === "connected" && (
                    <span className={styles.muted}>
                      {t(
                        link.mismatch === "editor"
                          ? "localAi.guide.mismatchEditor"
                          : "localAi.guide.mismatchTools",
                      )}
                    </span>
                  )}
                  <label className={styles.line}>
                    <input
                      type="checkbox"
                      checked={auto}
                      onChange={(event) => autoConnect.set(event.target.checked)}
                    />
                    {t("localAi.guide.autoConnect")}
                  </label>
                </div>
              ) : (
                <span className={styles.line}>{t("localAi.guide.chromeOnly")}</span>
              )}
            </Step>
            <Step number={4} title={t("localAi.guide.try")}>
              <span className={styles.line}>{t("localAi.guide.keepOpen")}</span>
              <Copyable text={t("localAi.guide.trySay")} />
              <span className={styles.muted}>{t("localAi.guide.allow")}</span>
            </Step>
          </ol>
          <div className={styles.panel} style={{ marginTop: 16 }}>
            <More summary={t("localAi.guide.cli")} testId="local-ai-cli">
              <span className={styles.line}>{t("localAi.guide.cliCheck")}</span>
              <Copyable text={COMMANDS.check} />
              <span className={styles.line}>{t("localAi.guide.cliDescribe")}</span>
              <Copyable text={COMMANDS.describe} />
              <span className={styles.line}>{t("localAi.guide.cliGuide")}</span>
              <Copyable text={guideCommand(t("localAi.guide.topicHolder"))} />
            </More>
            {state && (
              <More summary={t("localAi.guide.agents")} testId="local-ai-agents">
                {hasInstructions(state.files) ? (
                  <span className={styles.line}>
                    {t("localAi.guide.agentsHas")}
                    <button
                      type="button"
                      className={settings.link}
                      onClick={() => workbench.openInstructions()}
                    >
                      {t("localAi.guide.open")}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={settings.button}
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => workbench.addInstructions()}
                  >
                    {t("localAi.guide.addAgents")}
                  </button>
                )}
              </More>
            )}
          </div>
        </div>
        <footer className={styles.foot}>
          {/* Who is connected is of a project: without one there is nobody to wait for. */}
          {store ? (
            <span
              className={styles.connected}
              data-on={first ? "" : undefined}
              role="status"
              data-testid="local-ai-connected"
            >
              <span className={styles.dot} aria-hidden />
              {first
                ? t("localAi.connectedHere", {
                    tool: toolName(t, first.client),
                    since: whenText(first.startedAt),
                    interpolation: { escapeValue: false },
                  })
                : t("localAi.noneConnected")}
            </span>
          ) : (
            <span className={styles.connected} />
          )}
          <button
            ref={closeButton}
            type="button"
            className={`${settings.button} ${first ? settings.primary : ""}`}
            onClick={close}
          >
            {first ? t("localAi.guide.done") : t("localAi.guide.close")}
          </button>
        </footer>
      </div>
    </DialogFrame>
  );
}

const noSubscription = () => () => {};
const nothing = () => undefined;
