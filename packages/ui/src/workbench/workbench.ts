import type {
  AccountAccess,
  AccountSnapshot,
  CloudAccess,
  CoverAccess,
  CoverStore,
  DiagnosticsSink,
  ChatImageStore,
  ChatStore,
  Host,
  LocalFolder,
  MakingNotes,
  MediaStore,
  ProjectLibrary,
  RepositoryAccess,
  SignInOutcome,
  StoragePersistence,
  WindowMemory,
} from "@animaquill/host";
import type { TFunction } from "i18next";
import {
  buildRenderPlan,
  entryOf,
  clipEnd,
  clipOffset,
  clipStart,
  ProjectStore,
  withId,
  type OperationCall,
  type UndoResult,
  type ClipState,
  sceneSourceOf,
  startingFiles,
  INSTRUCTIONS_FILE,
  INSTRUCTIONS_START,
  elsewhereOf,
  type ObjectRef,
  type ProjectState,
} from "@animaquill/core";
import type { SceneStatus } from "@animaquill/render";
import type { SceneProblem } from "@animaquill/scene";
import {
  compare,
  createProject,
  formatTime,
  lfsOidOf,
  parseTime,
  toSeconds,
} from "@animaquill/schema";
import {
  memoryChatImages,
  memoryKeys,
  newSyncId,
  type DownloadStore,
  type ProjectSummary,
} from "@animaquill/host";
import type { ConnectTiming } from "../cloud/connect.ts";
import {
  CloudCreate,
  takeCreateIntent,
  tidyCreated,
  type CreateContent,
  type CreateIntent,
  type NewFormat,
} from "../cloud/create.ts";
import { loadPinyin } from "../cloud/repository-name.ts";
import type { PanelActionId } from "../cloud/panel.ts";
import { CloudProjects } from "../cloud/projects.ts";
import type { CloudEnvironment, CloudTiming } from "../cloud/session.ts";
import { StartList } from "../cloud/start-list.ts";
import { ChatSession } from "../chat/session.ts";
import type { FrameShot } from "../chat/attachments.ts";
import { ChatPointing } from "../chat/pointing.ts";
import { askingIn } from "../chat/conversations.ts";
import { parseAddress } from "@animaquill/tools";
import { ModelPacks } from "../chat/packs.ts";
import { AiSettingsStore } from "../chat/settings.ts";
import { AiSync } from "../chat/ai-sync.ts";
import { CloudChats } from "../chat/cloud-chats.ts";
import { SETTINGS_GROUPS, SettingsNav, type SettingsPlace } from "./settings-nav.ts";
import { SwitchSetting } from "./switch-setting.ts";
import { ToolActivity } from "./tool-activity.ts";
import { CodeDocuments, type CodePlace } from "../code/documents.ts";
import { CodeDrafts } from "../code/drafts.ts";
import { FileActions } from "../code/files.ts";
import { ErrorReports } from "../diagnostics/errors.ts";
import { namesIn } from "../diagnostics/privacy.ts";
import { DiagnosticsRecorder, deviceFacts } from "../diagnostics/recorder.ts";
import { registerKeyframeActions } from "../keyframes/actions.ts";
import { connectionsFor, type Connection } from "../keyframes/connect.ts";
import { KeyframeEditor } from "../keyframes/editor.ts";
import { OverlayEditor } from "../overlay/editor.ts";
import { SceneHandles } from "../overlay/scene-handles.ts";
import { CoverMaker, CoverUploads, canvasEncoder, type CoverShot } from "../export/cover.ts";
import { ExportCompositor, exportCompositorOptions } from "../export/compositor.ts";
import { FrameLooks } from "../look/looks.ts";
import { StillExport } from "../export/still.ts";
import { VideoExport } from "../export/video.ts";
import { MediaLibrary } from "../media/library.ts";
import type { Hasher } from "../media/hasher.ts";
import { MadeSounds, SoundMaker } from "../media/sounds.ts";
import { hashFile, isSameHash } from "@animaquill/media";
import type { ProxyMaker } from "../proxy/maker.ts";
import { ProxyFiles, type ProxyProject } from "../proxy/proxies.ts";
import { describeProblem, sceneClipName } from "../preview/problems.ts";
import { ProblemList, sceneProblem, type ListedProblem } from "../problems/list.ts";
import { OutputDifferences } from "../problems/output.ts";
import { PreviewFrameRate } from "../preview/frame-rate.ts";
import { PreviewQuality } from "../preview/quality.ts";
import { PreviewStatus } from "../preview/status.ts";
import { SceneRegistrations } from "../properties/registrations.ts";
import { TrialSession } from "../properties/trial.ts";
import { PropertyWriter } from "../properties/writer.ts";
import { registerTimelineActions } from "../timeline/actions.ts";
import { TimelineEditor } from "../timeline/editor.ts";
import { formatTimecode, frameAt, frameSeconds, frameTime } from "../timeline/frames.ts";
import { keepFiles, type ImportReport, type PreparedProject } from "../transfer/import.ts";
import { downloadFrom, type HereOf } from "../storage/places.ts";
import { ProjectTransfer, formatSize } from "../transfer/transfer.ts";
import { ActionRegistry, type Action } from "./actions.ts";
import { Dialogs } from "./dialogs.ts";
import { commandFailedText } from "../i18n/failures.ts";
import { ProjectEdits } from "../project/edits.ts";
import { PROJECT_GROUPS, ProjectNav, type ProjectPlace } from "./project-nav.ts";
import { Flag } from "./flag.ts";
import { InputMode } from "./input-mode.ts";
import { KeybindingService } from "./keybindings.ts";
import type { Platform } from "./keys.ts";
import { LayoutController, type LayoutChoice, type LayoutPreset } from "./layout.ts";
import { Notifications } from "./notifications.ts";
import { OperationLog, type Operation } from "./operations.ts";
import { CommandPalette } from "./palette.ts";
import { ResourceHabits } from "../resources/habits.ts";
import { ExplorerState, nodeOfResource } from "../resources/explorer.ts";
import { ResourcePages } from "../resources/pages.ts";
import { parseProjectResourceId, projectResourceId } from "../resources/project-resources.ts";
import { MissingFileWatch } from "../resources/missing-files.ts";
import type { FolderTiming } from "../folder/session.ts";
import { ProjectFolders, type FolderLinking, type PlacedFiles } from "./project-folders.ts";
import { ProjectSession, projectKeyOf } from "./session.ts";
import type { RepositoryWatch } from "../cloud/repository-watch.ts";
import { LfsAccountState } from "../storage/lfs-account.ts";
import {
  AssetUploads,
  type UploadBlock,
  type UploadFiles,
  type UploadProblem,
  type UploadProject,
} from "../storage/uploads.ts";
import { GITHUB_BILLING } from "../storage/links.ts";
import {
  AssetDownloads,
  assetsOfClip,
  downloadWhole,
  type DownloadProblem,
  type DownloadTarget,
} from "../storage/downloads.ts";

/**
 * Pauses of archiving for which the repository cannot take files either: it is not there to the
 * platform, or the platform may not touch it.
 */
/** A file brought in that is larger than this is said to be only here, once (4.3). */
const LARGE_IMPORT_BYTES = 100 * 1024 * 1024;

const LFS_STOPPING: ReadonlySet<string> = new Set([
  "gone",
  "uninstalled",
  "suspended",
  "transferred",
]);
import { StartHabits } from "../start/habits.ts";
import {
  chooseCover,
  restoreAutoCover,
  type CoverChoiceOptions,
  type CoverTarget,
} from "../start/cover-choice.ts";
import { StartCovers } from "../start/covers.ts";
import { StartOrganizer } from "../start/organize.ts";
import { CloudSync } from "../cloud/cloud-sync.ts";
import { renameUnopened, type RenameOutcome } from "../start/rename.ts";
import { PanelRegistry, type PanelDefinition } from "./panels.ts";

export interface WorkbenchOptions {
  readonly host: Host;
  readonly t: TFunction;
  readonly version: string;
  readonly platform: Platform;
  readonly panels: readonly PanelDefinition[];
  readonly layouts: readonly LayoutPreset[];
  readonly compositorUrl: string;
  readonly sceneOrigins?: readonly string[];
  readonly sceneStage?: "plain";
  /** For tests: how long code gets to make a sound. */
  readonly soundLimitMs?: number;
  /** For tests: how long a project folder waits, see `FolderTiming`. */
  readonly folderTiming?: Partial<FolderTiming>;
  /** For tests: how long syncing with the platform waits, and the world it waits in. */
  readonly cloudTiming?: Partial<CloudTiming>;
  readonly cloudEnvironment?: CloudEnvironment;
  /** For tests: how long the dialog that connects a project waits, see `ConnectTiming`. */
  readonly connectTiming?: Partial<ConnectTiming>;
  /** What finds out hashes of files in project folders, in a worker where the page has one. */
  readonly hasher?: Hasher;
  /**
   * What makes proxies, smaller copies of large videos for the preview, in a worker. Without it
   * there are none, as in tests that are not about them.
   */
  readonly proxyMaker?: ProxyMaker;
}

/** The editor's frame, without any rendering, so that it can be tested on its own. */
const MAX_REPORTED_CLIPS = 500;
/** How long problems of properties wait for more changes, so that a burst of them is one look. */
const PROPERTY_PROBLEMS_DELAY_MS = 150;

function saveReport(report: unknown, name: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, undefined, 2)]));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replaceAll(":", "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** How long the page may take to go once it is ready to, see `Workbench.leavePage`. */
const LEAVING_MS = 10_000;

export class Workbench {
  readonly t: TFunction;
  readonly version: string;
  readonly panels = new PanelRegistry();
  readonly actions = new ActionRegistry();
  readonly notifications = new Notifications();
  readonly layout: LayoutController;
  readonly keybindings: KeybindingService;
  readonly palette: CommandPalette;
  /** What people used of the resources lately, and how they like each tab of them grouped. */
  readonly resourceHabits: ResourceHabits;
  /** Where people are in the explorer, which every tab of resources can show something in. */
  readonly explorer = new ExplorerState();
  /** Which assets of the open project have no file, for the explorer and the assets tab. */
  readonly missingFiles: MissingFileWatch;
  /**
   * Where the open project is, as far as the places of files go, see `Here`: the repository it is
   * kept in, and who is signed in. Nothing says that yet, which takes every place as it is written
   * down: the uploads tell, once there are any (step 14.2③). Files the editor writes go by every
   * place all the same, as merges of the folder do.
   */
  readonly here: HereOf = () => {
    const cloud = this.cloud?.getSnapshot();
    const id =
      cloud?.kind === "linked" ? cloud.repository?.getSnapshot().status?.repository?.id : undefined;
    if (id === undefined) return undefined;
    // The same object while it is the same, as what is worked out from it is kept by it.
    if (this.#here?.repo !== String(id)) this.#here = { repo: String(id) };
    return this.#here;
  };
  #here: { readonly repo: string } | undefined;
  /**
   * The files of assets of the open project on their way into the large file storage of its
   * repository, see `AssetUploads`.
   */
  readonly uploads: AssetUploads;
  /**
   * The files of assets of the open project that this computer lacks, out of the large file
   * storage of its repository, see `AssetDownloads`.
   */
  readonly downloads: AssetDownloads;
  /** The assets whose files are on their way here, as the problems go by them. */
  #downloading: ReadonlySet<string> = new Set();
  /** What people have in the large file storage of GitHub, and how they go about it. */
  readonly lfsAccount: LfsAccountState;
  /** What was said about the files of the open project, which goes with it as it closes. */
  readonly #uploadNotices: number[] = [];
  readonly dialogs = new Dialogs();
  readonly session: ProjectSession;
  readonly timeline: TimelineEditor;
  readonly trials: TrialSession;
  /** What changed the project lately, for the status bar, and taking it back from there. */
  readonly operations: OperationLog;
  readonly properties: PropertyWriter;
  readonly keyframes: KeyframeEditor;
  /** What scenes say about where the objects of their code are, for the handles on the picture. */
  readonly sceneHandles: SceneHandles;
  /** The handles on the picture of the preview. */
  readonly overlay: OverlayEditor;
  readonly input: InputMode;
  readonly media: MediaLibrary;
  readonly sounds: MadeSounds;
  /** The revision of each scene whose code last ran in the preview, by scene. */
  readonly #ranScenes = new Map<string, string>();
  readonly transfer: ProjectTransfer;
  readonly stills: StillExport;
  readonly videos: VideoExport;
  /**
   * Projects that are folders on this computer, where the browser can write folders: Chrome and
   * Edge. Elsewhere projects stay in the browser, see the design of local projects, section 6.
   */
  readonly projectFolders: ProjectFolders | undefined;
  /**
   * Smaller copies of large videos in a project folder, which the preview plays unless its quality
   * is full. Only where projects are folders, see the decision of 2026-11-09.
   */
  readonly proxies: ProxyFiles | undefined;
  readonly diagnostics: DiagnosticsRecorder;
  /** Errors of the editor while this page is open, and whether people want to report them. */
  readonly errors: ErrorReports;
  readonly #sink: DiagnosticsSink | undefined;
  readonly projects: ProjectLibrary;
  /** The account people have where the editor is hosted, where it has accounts: see `Host.account`. */
  readonly account: AccountAccess | undefined;
  /** The repositories people may save to, where there is a platform, see `RepositoryAccess`. */
  readonly repositories: RepositoryAccess | undefined;
  /** Which window this is, for who made a change, see `ChangeSource.window`. */
  readonly windowId = newSyncId();
  /**
   * Whether the open project syncs with the platform, where the editor is hosted on one: see
   * `Host.cloud` and `CloudProjects`.
   */
  readonly cloud: CloudProjects | undefined;
  /**
   * What the start page lists: the projects on this computer, and those of the platform where the
   * editor is hosted on one, see `StartList`.
   */
  readonly start: StartList;
  /** How people organise their projects on the start page, see `StartOrganizer`. */
  readonly organizer: StartOrganizer;
  /** How each view of the start page is sorted and shown, see `StartHabits`. */
  readonly startHabits: StartHabits;
  /** The covers on the cards of the start page, see `StartCovers`. */
  readonly startCovers: StartCovers;
  /** Makes the cover of the open project while people leave it alone, see `CoverMaker`. */
  readonly covers: CoverMaker | undefined;
  /** Where covers are kept and sent, for those people choose, see start/cover-choice.ts. */
  #coverChoice: CoverChoiceOptions | undefined;
  readonly #address: Host["address"];
  /**
   * Whether the panel of the platform shows, see `cloudPanel`: the status bar has it, and the menu
   * opens it there.
   */
  readonly cloudPanel = new Flag();
  /** The guide to the AI tools on this computer is open, see `openLocalAiGuide`. */
  readonly localAiGuide = new Flag();
  /**
   * Whether it is known how the open project stands with the platform: `CloudProjects` looked at
   * it, and at its folder where it is one. Until then nothing says "仅本机", and nothing connects
   * it: a project that is connected would get a second link.
   */
  readonly cloudKnown = new Flag();
  /** The start page is asked to show its projects of the platform, see `openCloudProjects`. */
  readonly cloudColumn = new Flag();
  /**
   * The open project cannot be edited now, as a project of the platform whose repository cannot be
   * used, see `CloudProjects.unusable`: it can be looked at, played and exported, and nothing
   * changes it, see `ProjectStore.readOnly`; its folder is left as it is, see `FolderSession.hold`.
   */
  readonly readOnly = new Flag();
  /** Whether the browser keeps what the editor stores, see `Host.persistence`. */
  readonly persistence: StoragePersistence | undefined;
  /** The platform, where the editor is hosted on one and has accounts. */
  readonly #platform: CloudAccess | undefined;
  /** What finds out the hashes of files, in a worker where there is one. */
  readonly #hasher: Hasher | undefined;
  /** Where this browser keeps the pieces of files that come, see `DownloadStore`. */
  readonly #downloadStore: DownloadStore | undefined;
  /** For tests only: new projects can stay in this browser, see `Host.projectsHereForTests`. */
  readonly #projectsHere: boolean;
  readonly #memory: WindowMemory;
  readonly #settings: Host["settings"];
  /** Which projects of the platform windows of this browser are making, see `Host.making`. */
  readonly #making: MakingNotes | undefined;
  /** The page is going away on purpose, with everything kept, see `leavePage`. */
  #leavingPage = false;
  #leavingTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the last export began, see `exporting` in the constructor. */
  #exportSince = 0;
  /** Where the page with the compositor is. A site of its own keeps it apart from the editor. */
  readonly compositorUrl: string;
  /** Where scenes run, which is never where the compositor is. */
  readonly sceneOrigins: readonly string[];
  readonly sceneStage: "plain" | undefined;
  readonly preview: PreviewStatus;
  /** How many frames the preview really shows while it plays. */
  readonly frameRate: PreviewFrameRate;
  /** How sharp the preview is drawn. Never what gets exported. */
  readonly previewQuality: PreviewQuality;
  readonly problems: ProblemList;
  /** What the code of scenes registered when it ran, which is not in the project. */
  readonly registrations: SceneRegistrations;
  readonly code: CodeDocuments;
  /** What is open in the resources tab: files of code, and the details of other resources. */
  readonly resourcePages: ResourcePages;
  readonly files: FileActions;
  readonly drafts: CodeDrafts;
  /** The AI services people set up, with their keys, which only this browser has. */
  readonly ai: AiSettingsStore;
  /** The AI settings and keys going with the account, where the host has a platform. */
  readonly aiSync: AiSync;
  /** Which cloud features go with the account, and the welcome, see `CloudSync`. */
  readonly cloudSync: CloudSync;
  /** The model packs installed in this browser, see `ModelPacks`. */
  readonly packs: ModelPacks;
  /** The chat with AI in the browser, about the open project. */
  readonly chat: ChatSession;
  /** The frames AI looks at, which give way to people playing and exporting. */
  readonly looks: FrameLooks;
  /** What AI tools on this computer do through the folder of the open project. */
  readonly tools: ToolActivity;
  /** Whether new projects start with AGENTS.md, the instructions for AI. */
  readonly agentsFile: SwitchSetting;
  /** What the chat points at: the playhead, what is selected, and where its blocks go. */
  readonly pointing: ChatPointing;
  /** What the box of the chat does with the commands of the palette, while it is there. */
  #compose: ComposeHandlers | undefined;
  /** The browser was asked in this page whether the chat may tell people. */
  #askedToNotify = false;
  /** The conversations of projects of the platform, going with the account. */
  readonly chatSync: CloudChats | undefined;
  /** Whether the settings are open in this window, and where in them, see `SettingsNav`. */
  readonly settingsNav: SettingsNav;
  /** Where this browser keeps the covers of projects, for the project properties to show one. */
  readonly coverStore: CoverStore | undefined;
  /** Whether the project properties are open in this window, and where, see `ProjectNav`. */
  readonly projectNav: ProjectNav;
  /** What the project properties change, asked about first where it changes the picture. */
  readonly projectEdits: ProjectEdits;
  /** Whether the preview offers to make a proxy of a video that plays too slowly. */
  readonly proxyOffer: SwitchSetting;
  /** The conversations this browser keeps, for the settings to say what they take. */
  readonly chatStore: ChatStore | undefined;
  /** Where the pictures of conversations are kept, for what they take and clearing them. */
  readonly chatImages: ChatImageStore | undefined;
  #changingProject = false;

  constructor(options: WorkbenchOptions) {
    const { host, t, version, platform, panels, layouts, compositorUrl } = options;
    this.t = t;
    this.version = version;
    const library = host.projects;
    this.projects = {
      list: () => library.list(),
      create: (project, state) => library.create(project, state),
      receive: (project) => library.receive(project),
      open: (id) => library.open(id),
      remove: (id, removing) => library.remove(id, removing),
      // The files of a project that is a folder are in the folder, see `FolderAssets`.
      media: (id) => this.projectFolders?.mediaFor(id) ?? library.media(id),
      toFolder: (id) => library.toFolder(id),
      copies: (id) => library.copies(id),
      dropCopies: (id, names) => library.dropCopies(id, names),
    };
    // An export reads each file of a project folder all through again: what goes out is what the
    // project says, whatever a kept hash says.
    const exporting: ProjectLibrary = {
      ...this.projects,
      media: (id) => this.projectFolders?.mediaFor(id, this.#exportSince) ?? library.media(id),
    };
    this.account = host.account;
    this.repositories = host.account ? host.cloud?.repository : undefined;
    this.diagnostics = new DiagnosticsRecorder(version);
    this.aiSync = new AiSync({
      settings: host.settings,
      keys: host.keys ?? memoryKeys(),
      ...(host.accountKeys && { accountKeys: host.accountKeys }),
      ...(host.account &&
        host.cloud?.aiSync && { access: host.cloud.aiSync, account: host.account }),
      ask: (question) => this.cloudSync.ask(question),
    });
    this.cloudSync = new CloudSync({
      settings: host.settings,
      platform: host.cloud?.aiSync !== undefined,
      account: host.account,
      aiSync: this.aiSync,
      changed: () => {
        this.organizer.allowedChanged();
        if (this.chatSync) void this.chatSync.retry().then(() => this.chat.reloadList());
      },
    });
    this.ai = new AiSettingsStore(
      this.aiSync.settings,
      this.aiSync.keys,
      {
        saveFailed: () => this.notifications.push(t("ai.saveFailed")),
        keyFailed: () => this.notifications.push(t("ai.keyFailed")),
        headersLeftOut: () => this.notifications.push(t("ai.headersLeftOut")),
      },
      host.aiRelay,
      {
        cache: host.caches,
        // The platform's copy is for people signed in: nobody is asked for it otherwise.
        platform: (() => {
          const catalog = host.account ? host.cloud?.modelCatalog : undefined;
          const account = host.account;
          if (!catalog || !account) return undefined;
          return () =>
            account.getSnapshot().status === "signedIn"
              ? catalog()
              : Promise.reject(new Error("Nobody is signed in"));
        })(),
      },
    );
    this.packs = new ModelPacks(
      this.aiSync.settings,
      { saveFailed: () => this.notifications.push(t("ai.packs.saveFailed")) },
      { memory: host.windowMemory },
    );
    const sink = host.diagnostics;
    this.#sink = sink;
    let names: { state: unknown; keys: ReadonlySet<string>; found: Set<string> } | undefined;
    this.errors = new ErrorReports({
      version,
      recorder: this.diagnostics,
      ...(sink && { send: (report) => sink.send(report) }),
      origins: () =>
        typeof location === "undefined"
          ? []
          : [location.origin, new URL(compositorUrl, location.href).origin],
      secrets: () => {
        // An error can come every frame, and the project rarely changes that often.
        const state = this.session.store?.getState();
        const keys = this.ai.knownKeys;
        if (!names || names.state !== state || names.keys !== keys) {
          // Keys of AI services must never leave, whatever an error says.
          names = { state, keys, found: new Set([...namesIn(state), ...keys]) };
        }
        return names.found;
      },
      device: deviceFacts,
    });
    this.compositorUrl = compositorUrl;
    this.sceneOrigins = options.sceneOrigins ?? [];
    this.sceneStage = options.sceneStage;
    this.problems = new ProblemList({
      t,
      state: () => this.session.store?.getState(),
      describe: (clip) => this.keyframes.describe(clip),
      registered: (revision) => this.registrations.problemsOf(revision),
      fix: (call) => this.#fix(call),
    });
    this.preview = new PreviewStatus({
      problem: (clip, revision, problem, first) =>
        this.#noteSceneProblem(clip, revision, problem, first),
      stopped: (clip, status) => this.#noteStoppedScene(clip, status),
      revisions: (revisions) => this.problems.keepRevisions(revisions),
      ran: (scene, revision) => this.#ranScenes.set(scene, revision),
      restarted: () => this.notifications.push(t("preview.restarted")),
    });
    this.layout = new LayoutController(
      host.settings,
      host.windowMemory,
      layouts,
      () => this.panels.ready(),
      {
        restoreFailed: () => this.notifications.push(t("notice.layoutRestoreFailed")),
        saveFailed: () => this.notifications.push(t("notice.layoutSaveFailed")),
      },
    );
    this.keybindings = new KeybindingService(host.settings, this.actions, platform, {
      restoreFailed: () => this.notifications.push(t("notice.keybindingsRestoreFailed")),
      saveFailed: () => this.notifications.push(t("notice.keybindingsSaveFailed")),
    });
    let choices = this.layout.getSnapshot().layouts;
    this.layout.subscribe(() => {
      const { active, layouts: now } = this.layout.getSnapshot();
      this.keybindings.notePanel(active);
      // The keys of layouts go by their place in the list.
      if (now !== choices) {
        choices = now;
        this.keybindings.refresh();
      }
    });
    this.settingsNav = new SettingsNav(host.windowMemory);
    this.projectNav = new ProjectNav(host.windowMemory);
    this.proxyOffer = new SwitchSetting(host.settings, "proxyOffer", true);
    this.agentsFile = new SwitchSetting(host.settings, "agentsFile", true);
    this.palette = new CommandPalette(host.settings, this.actions);
    this.resourceHabits = new ResourceHabits(host.settings);
    this.startHabits = new StartHabits(host.settings);
    this.#address = host.address;
    // A platform is for whoever is signed in to it: without an account, there is none.
    const cloud = host.account ? host.cloud : undefined;
    this.#platform = cloud;
    this.#hasher = options.hasher;
    this.#downloadStore = options.host.downloads;
    this.persistence = host.persistence;
    this.#projectsHere = host.projectsHereForTests === true;
    this.#memory = host.windowMemory;
    this.#settings = host.settings;
    this.#making = host.making;
    this.session = new ProjectSession(
      host.projects,
      host.address,
      {
        createFailed: () => this.notifications.push(t("notice.projectCreateFailed")),
        notFound: () => this.notifications.push(t("notice.projectNotFound")),
        openFailed: () => this.notifications.push(t("notice.projectOpenFailed")),
        tooNew: () => this.notifications.push(t("notice.projectTooNew")),
        damaged: () => this.notifications.push(t("notice.projectDamaged")),
        saveFailed: () => this.notifications.push(t("notice.projectSaveFailed")),
        saveRecovered: () => this.notifications.push(t("notice.projectSaveRecovered")),
      },
      {
        window: this.windowId,
        startingFiles: () => this.startingFiles(),
        // What the platform does not have yet stays as it is in the log: it goes from there.
        ...(cloud && {
          compactThrough: async (key: string) => {
            try {
              const link = await cloud.links.get(key);
              return link ? link.pushed : undefined;
            } catch {
              return 0;
            }
          },
        }),
      },
    );
    this.registrations = new SceneRegistrations(host.caches);
    let open = this.session.store;
    this.registrations.open(open && projectKeyOf(open));
    this.session.subscribe(() => {
      if (this.session.store !== open) {
        this.problems.clear();
        this.#ranScenes.clear();
      }
      open = this.session.store;
      this.registrations.open(open && projectKeyOf(open));
    });
    this.code = new CodeDocuments(
      this.session,
      {
        commandFailed: (failure) => this.notifications.push(commandFailedText(t, failure)),
        closedRemoved: (path) => this.notifications.push(t("code.closedRemoved", { path })),
      },
      {
        unsaved: (path) => this.#askAboutUnsaved(path),
        overwrite: (path) => this.#askAboutOverwriting(path),
      },
    );
    this.resourcePages = new ResourcePages(this.session, this.code);
    this.drafts = new CodeDrafts(this.session, this.code, host.drafts, {
      restored: (count) => this.notifications.push(t("code.draftsRestored", { count })),
      dropped: (count) => this.notifications.push(t("code.draftsDropped", { count })),
      readFailed: () => this.notifications.push(t("code.draftsReadFailed")),
      keepFailed: () => this.notifications.push(t("code.draftsKeepFailed")),
      keepRecovered: () => this.notifications.push(t("code.draftsKeepRecovered")),
    });
    this.files = new FileActions(
      this.session,
      this.code,
      (path, edit) => this.#showFile(path, edit),
      this.dialogs,
      this.notifications,
      t,
    );
    this.input = new InputMode(host.settings);
    this.media = new MediaLibrary(
      this.session,
      this.projects,
      {
        unsupported: (name) => this.notifications.push(t("notice.mediaUnsupported", { name })),
        tooLarge: (name) => this.notifications.push(t("notice.mediaTooLarge", { name })),
        saveFailed: (name) => this.notifications.push(t("notice.mediaSaveFailed", { name })),
        commandFailed: (failure) => this.notifications.push(commandFailedText(t, failure)),
        confirmCopy: (name, bytes) =>
          this.dialogs.confirm({
            title: t("folder.copy.title", { name }),
            message: t("folder.copy.message", { size: formatSize(bytes) }),
            confirm: t("folder.copy.confirm"),
          }),
        copyFailed: (name, reason) =>
          this.notifications.push(t(`folder.copy.failed.${reason}`, { name })),
        readFailed: (name) => this.notifications.push(t("folder.copy.readFailed", { name })),
        otherKind: (name) => this.notifications.push(t("folder.asset.otherKind", { name })),
        readOnly: () => this.notifications.push(t("cloud.unusable.noImport")),
      },
      compositorUrl,
      () => this.projectFolders?.assets(),
    );
    const soundMaker = new SoundMaker({
      url: compositorUrl,
      setup: () => ({
        origins: this.sceneOrigins,
        retired: this.preview.retiredOrigins,
        compositor: new URL(compositorUrl, location.href).origin,
        run: false,
      }),
      onRetired: (origin) => this.preview.noteRetired(origin),
    });
    this.sounds = new MadeSounds({
      session: this.session,
      projects: this.projects,
      run: soundMaker.run,
      messages: {
        problem: (sound, problem) => this.#noteSoundProblem(sound, problem),
        failed: (sound, reason) => {
          this.diagnostics.mark("sound.failed", { reason });
          this.notifications.push(
            t(`sound.failed.${reason}`, {
              name: this.#soundName(sound),
              interpolation: { escapeValue: false },
            }),
          );
        },
      },
      arrived: (file) => this.media.soundArrived(file),
      ...(options.soundLimitMs !== undefined && { limitMs: options.soundLimitMs }),
    });
    this.transfer = new ProjectTransfer({
      folders: host.folders,
      projects: exporting,
      session: this.session,
      dialogs: this.dialogs,
      notifications: this.notifications,
      t,
    });
    this.timeline = new TimelineEditor(this.session, host.windowMemory, host.settings, {
      commandFailed: (failure) => this.notifications.push(commandFailedText(t, failure)),
      joinsRemoved: (count) => this.notifications.push(t("timeline.joinsRemoved", { count })),
      sceneName: (number) => t("scene.newName", { number }),
      soundName: (number) => t("sound.newName", { number }),
      soundWords: () => ({ duration: t("sound.param.duration"), seed: t("sound.param.seed") }),
    });
    this.projectEdits = new ProjectEdits({
      t,
      dialogs: this.dialogs,
      notifications: this.notifications,
      store: () => this.session.store,
      playhead: () => {
        const model = this.timeline.getSnapshot().model;
        return (
          model && { timeline: model.id, seconds: frameSeconds(this.timeline.frame, model.rate) }
        );
      },
      proxies: () =>
        [...(this.proxies?.getSnapshot().states.values() ?? [])].filter(
          ({ kind }) => kind === "ready" || kind === "making" || kind === "waiting",
        ).length,
      picture: (state, timeline, seconds) => this.#framePicture(state, timeline, seconds),
    });
    // Conversations of projects of the platform go with the account.
    this.chatSync =
      cloud?.chats && host.account && host.chats
        ? new CloudChats({
            local: host.chats,
            remote: cloud.chats,
            account: host.account,
            links: cloud.links,
            platform: cloud.platform,
            copied: (title, copy) =>
              this.notifications.push(t("aiSync.chatCopied", { title, copy })),
            allowed: (account) => this.cloudSync.allows("chats", account),
            ...(host.chatImages && { images: host.chatImages }),
          })
        : undefined;
    this.chatStore = host.chats;
    this.chatImages = host.chatImages;
    this.chat = new ChatSession({
      chats: this.chatSync ?? host.chats,
      ai: this.ai,
      packs: this.packs,
      account: host.account,
      project: () => {
        const { store, key } = this.session.getSnapshot();
        return store && key !== undefined ? { store, key } : undefined;
      },
      subscribeProject: this.session.subscribe,
      selection: () => {
        const { model, selection, transition } = this.timeline.getSnapshot();
        if (!model) return undefined;
        return {
          timeline: model.id,
          playhead: formatTime(frameTime(this.timeline.frame, model.rate)),
          clips: [...selection],
          ...(transition && { transition }),
        };
      },
      problems: () => this.problems.set,
      describe: (clip) => this.keyframes.describe(clip),
      ranNow: (object, state) => this.#ranNow(object, state),
      problemInputs: () => ({
        describe: (clip) => this.keyframes.describe(clip),
        registered: (revision) => this.registrations.problemsOf(revision),
      }),
      undone: (result) => this.tellUndo(result),
      memory: host.windowMemory,
      // Pictures of the account's conversations come here as they are read.
      images:
        this.chatSync && host.chatImages
          ? this.chatSync.pictures(host.chatImages)
          : host.chatImages,
      shoot: (signal) => this.#shootFrame(signal),
      shotSize: () => this.ai.getSnapshot().shotSize ?? 1568,
      look: (request, sees, signal) => this.looks.look(request, sees, signal),
    });
    this.tools = new ToolActivity({
      t,
      notifications: this.notifications,
      dialogs: this.dialogs,
      showProblems: () => this.layout.openPanel("problems"),
      folder: () => this.projectFolders?.folderOpen,
      held: () => this.projectFolders?.isHeld === true,
      undo: (origin) => void this.projectFolders?.undoBatch(origin),
      lookAt: (paths) => this.projectFolders?.lookAt(paths),
    });
    // What the last turn of AI changed shows on the timeline until the next one, and what the
    // latest batch of an AI tool on this computer changed.
    const mark = () => {
      const chat = this.chat.getSnapshot().marked;
      const tools = this.tools.getSnapshot().marked;
      this.timeline.setMarked(tools.size === 0 ? chat : new Set([...chat, ...tools]));
    };
    this.chat.subscribe(mark);
    this.tools.subscribe(mark);
    this.frameRate = new PreviewFrameRate(this.timeline);
    this.previewQuality = new PreviewQuality(host.settings, this.frameRate);
    const differences = new OutputDifferences({
      dialogs: this.dialogs,
      t,
      goTo: (problem) => this.goToProblem({ problem }),
    });
    this.stills = new StillExport({
      session: this.session,
      timeline: this.timeline,
      projects: exporting,
      folders: host.folders,
      preview: this.preview,
      dialogs: this.dialogs,
      notifications: this.notifications,
      t,
      compositorUrl,
      sceneOrigins: this.sceneOrigins,
      sceneStage: this.sceneStage,
      differences,
    });
    this.videos = new VideoExport({
      session: this.session,
      timeline: this.timeline,
      projects: exporting,
      folders: host.folders,
      settings: host.settings,
      exports: host.exports,
      sounds: this.sounds,
      preview: this.preview,
      dialogs: this.dialogs,
      notifications: this.notifications,
      t,
      compositorUrl,
      sceneOrigins: this.sceneOrigins,
      sceneStage: this.sceneStage,
      differences,
    });
    // What nobody went on with for long goes, whichever project it is of.
    void this.videos.cleanUp();
    this.looks = this.#frameLooks(host.chatImages);
    this.projectFolders =
      host.localFolders &&
      new ProjectFolders({
        downloading: () => this.#downloading,
        folders: host.localFolders,
        projects: host.projects,
        session: this.session,
        address: host.address,
        dialogs: this.dialogs,
        notifications: this.notifications,
        problems: this.problems,
        t,
        tools: this.tools,
        startingFiles: () => this.startingFiles(),
        changeProject: (next) => this.#changeProject(next),
        warnAboutCode: (report) => this.transfer.warnAboutCode(report),
        noteArrival: (report) => this.#noteImport(report),
        letGo: async (id) => {
          await this.videos.letGoOfProject(id);
          await this.cloud?.forget(id);
        },
        showProblems: () => this.layout.openPanel("problems"),
        here: () => this.here(),
        assetFiles: {
          useNewFile: (asset) => this.media.useNewFile(asset),
          usePlace: (asset, path) => this.media.usePlace(asset, path),
          filesChanged: (paths) => this.media.filesChanged(paths),
        },
        ...(options.hasher && { hasher: options.hasher }),
        ...(options.folderTiming && { timing: options.folderTiming }),
        ...(host.presence && { presence: host.presence }),
        // What closed windows left on a folder, which goes with what this browser kept of it.
        leftBehind: async (key: string) => [
          ...((await host.trials.holds?.(key)) ? ["trial"] : []),
          ...((await host.drafts.holds?.(key)) ? ["drafts"] : []),
        ],
        ...(host.organizer && { organizer: host.organizer }),
      });
    this.session.subscribe(() => this.projectFolders?.followSession());
    this.session.subscribe(() => this.tools.follow(this.session.getSnapshot().store));
    this.cloud =
      cloud &&
      new CloudProjects({
        cloud,
        session: this.session,
        projects: host.projects,
        folderOf: (key) => this.#folderOf(key),
        isFolder: (key) => this.projectFolders?.holds(key) === true,
        account: host.account,
        dialogs: this.dialogs,
        notifications: this.notifications,
        t,
        window: this.windowId,
        editor: version,
        signIn: () => this.signIn(),
        // As a promise, like signing in: whoever asked hears when leaving is over, and whether
        // people stayed after all.
        installApp: () => this.installApp(),
        // "连成另一个云端项目" is the dialog that connects a project in one go, see `connectToCloud`.
        showConnect: () => this.connectToCloud(),
        openProject: (id) => this.openProject(id),
        reopenProject: (key) => this.#reopenProject(key),
        ...(host.localFolders && { records: host.localFolders.records }),
        ...(host.presence && {
          others: async (key: string) => (await host.presence?.others(key)) ?? 0,
        }),
        closeProject: async () => {
          await this.closeProject();
          return this.session.store === undefined;
        },
        // What its exports kept goes with it, which only happens once this window lets go of them.
        removeLocal: async (key) => {
          await this.videos.letGoOfProject(key);
          await host.projects.remove(key);
        },
        // What windows were trying out, or typed and did not save, goes with the project too.
        leftBehind: async (key) => [
          ...((await host.trials.holds?.(key)) ? (["trial"] as const) : []),
          ...((await host.drafts.holds?.(key)) ? (["drafts"] as const) : []),
        ],
        ...(this.projectFolders && {
          moveToFolder: (key: string, linking?: FolderLinking) =>
            this.projectFolders?.moveToFolder(key, undefined, linking) ?? Promise.resolve(false),
        }),
        memory: host.windowMemory,
        ...(host.persistence && { persistence: host.persistence }),
        leaving: () => this.leavingPage,
        ...(options.cloudTiming && { timing: options.cloudTiming }),
        ...(options.cloudEnvironment && { environment: options.cloudEnvironment }),
        ...(options.connectTiming && { connectTiming: options.connectTiming }),
      });
    this.start = new StartList({
      projects: host.projects,
      ...(host.localFolders && { records: host.localFolders.records }),
      ...(cloud && { cloud }),
      ...(host.account && { account: host.account }),
    });
    if (this.cloud) {
      const follow = () => void this.#followCloud();
      this.session.subscribe(follow);
      this.projectFolders?.subscribe(follow);
      // Whether the open project can be edited follows how it stands with the platform.
      const keepReadOnly = () => this.#keepReadOnly();
      this.cloud.subscribe(keepReadOnly);
      this.session.subscribe(keepReadOnly);
      // What taking a copy out of this browser left behind, should it have stopped halfway.
      void this.cloud.tidy();
      // And what making a project of the platform left there, should the page have gone halfway.
      if (cloud && host.making) void tidyCreated(cloud, host.making);
    }
    this.#keepStoredOnceSaved();
    this.missingFiles = new MissingFileWatch(this.session, this.media, this.projectFolders, () =>
      this.here(),
    );
    this.uploads = new AssetUploads({
      store: host.uploads,
      lfs: () => cloud?.lfs,
      project: () => this.#uploadProject(),
      files: () => this.#uploadFiles(),
      here: () => this.here(),
      onAllDone: (count) => this.notifications.push(t("storage.uploads.notice.allDone", { count })),
    });
    this.downloads = new AssetDownloads({
      store: host.downloads,
      lfs: () => cloud?.lfs,
      project: () => this.#uploadProject(),
      missing: this.missingFiles.getSnapshot,
      subscribeMissing: this.missingFiles.subscribe,
      target: () => this.#downloadTarget(),
      hash: (file, signal) =>
        options.hasher ? options.hasher.file(file, { signal }) : hashFile(file, { signal }),
      playhead: () => {
        const model = this.timeline.getSnapshot().model;
        return (
          model && {
            timeline: model.id,
            seconds: frameSeconds(this.timeline.frame, model.rate),
            playing: this.timeline.getSnapshot().playing,
          }
        );
      },
      subscribePlayhead: (listener) => {
        const stops = [this.timeline.subscribeView(listener), this.timeline.subscribe(listener)];
        return () => {
          for (const stop of stops) stop();
        };
      },
      estimate: async () => {
        const found = await globalThis.navigator?.storage?.estimate?.();
        return found?.quota !== undefined && found.usage !== undefined
          ? { quota: found.quota, usage: found.usage }
          : undefined;
      },
    });
    // That a file is on its way here is no problem to list in the problems.
    this.downloads.subscribe(() => {
      const coming = new Set(
        this.downloads
          .getSnapshot()
          .items.filter(({ phase }) => !["failed", "done", "blocked"].includes(phase))
          .map(({ asset }) => asset),
      );
      if ([...coming].join() === [...this.#downloading].join()) return;
      this.#downloading = coming;
      this.projectFolders?.downloadsChanged();
    });
    this.lfsAccount = new LfsAccountState(cloud?.lfsAccount, host.account);
    this.#followUploads(host);
    this.#keepPresence(host);
    this.organizer = new StartOrganizer({
      organizer: host.organizer,
      account: host.account,
      cloud: cloud?.organizer,
      allowed: (account) => this.cloudSync.allows("organizer", account),
    });
    this.startCovers = new StartCovers({
      ...(host.covers && { covers: host.covers }),
      ...(cloud?.cover && { cloud: cloud.cover }),
    });
    this.coverStore = host.covers;
    this.covers = host.covers && this.#coverMaker(host.covers, cloud?.cover, library);
    this.#noteOpened();
    this.proxies =
      this.projectFolders && options.proxyMaker
        ? this.#proxiesOf(this.projectFolders, options.proxyMaker)
        : undefined;
    // Reading a large video for its hash takes the disk and a core for a while, which a recording of
    // how playing goes should know about.
    this.diagnostics.watch("hashing", {
      get: () => this.#hashing(),
      subscribe: (listener) => {
        const stops = [
          this.media.subscribe(listener),
          this.projectFolders?.subscribeProgress(listener),
        ];
        return () => {
          for (const stop of stops) stop?.();
        };
      },
    });
    // Making a proxy decodes a large video too, which it stops doing while something plays.
    const proxies = this.proxies;
    if (proxies) {
      this.diagnostics.watch("proxies", {
        get: () => {
          const { making, paused } = proxies.getSnapshot();
          return making !== undefined && !paused;
        },
        subscribe: (listener) => proxies.subscribe(listener),
      });
    }
    this.trials = new TrialSession(this.session, this.timeline, host.trials, host.settings, {
      commandFailed: (failure) => this.notifications.push(commandFailedText(t, failure)),
      overwrote: (count) => this.notifications.push(t("notice.trialOverwrote", { count })),
      discarded: (count) => this.notifications.push(t("notice.trialDiscarded", { count })),
      setAside: (count) => this.notifications.push(t("notice.trialSetAside", { count })),
      back: (count) => this.notifications.push(t("notice.trialBack", { count })),
      asideDropped: (count) => this.notifications.push(t("notice.trialAsideDropped", { count })),
      unsure: () => this.notifications.push(t("notice.trialUnsure")),
      restored: (count) => this.notifications.push(t("notice.trialRestored", { count })),
      dropped: () => this.notifications.push(t("notice.trialDropped")),
      readFailed: () => this.notifications.push(t("notice.trialReadFailed")),
      keepFailed: () => this.notifications.push(t("notice.trialKeepFailed")),
      keepRecovered: () => this.notifications.push(t("notice.trialKeepRecovered")),
    });
    this.operations = new OperationLog(this.session);
    this.properties = new PropertyWriter(this.session, this.timeline, this.trials, {
      commandFailed: (failure) => this.notifications.push(commandFailedText(t, failure)),
      comparing: () => this.notifications.push(t("notice.comparing")),
    });
    this.keyframes = new KeyframeEditor(
      this.session,
      this.timeline,
      this.trials,
      this.properties,
      host.windowMemory,
      host.settings,
      t,
      {
        pasteTooEarly: () => this.notifications.push(t("notice.keysPasteTooEarly")),
        pasteNowhere: () => this.notifications.push(t("notice.keysPasteNowhere")),
        comparing: () => this.notifications.push(t("notice.keysComparing")),
        locked: () => this.notifications.push(t("notice.keysLocked")),
        notShown: () => this.notifications.push(t("notice.keysNotShown")),
        gone: () => this.notifications.push(t("notice.keysGone")),
      },
      this.registrations,
    );
    this.sceneHandles = new SceneHandles({
      tooMany: (clip, revision) =>
        this.preview.noteProblem(clip, revision, {
          kind: "api",
          code: "handles-flood",
          frame: 0,
        }),
    });
    this.overlay = new OverlayEditor({
      session: this.session,
      timeline: this.timeline,
      properties: this.properties,
      trials: this.trials,
      quality: this.previewQuality,
      handles: this.sceneHandles,
      registrations: this.registrations,
      describe: this.keyframes.describe,
      messages: { gone: () => this.notifications.push(t("notice.overlayGone")) },
    });
    this.pointing = new ChatPointing({
      session: this.session,
      timeline: this.timeline,
      keyframes: this.keyframes,
      explorer: this.explorer,
      code: this.code,
      t,
    });
    this.#keepTrail();
    this.#keepPropertyProblems();
    this.#followChatForNotices();
    for (const panel of panels) this.panels.register(panel);
    this.#registerProjectActions();
    this.#registerSettingsActions();
    this.#registerCodeActions();
    this.#registerChatActions();
    this.#registerEditActions();
    this.#registerViewActions();
    this.#registerHelpActions();
    registerTimelineActions(this.actions, this.timeline, this.keyframes.inTimeline);
    registerKeyframeActions(this.actions, this.keyframes, this.timeline);
  }

  /** The proxies of whatever project folder is open, see `ProxyFiles`. */
  #proxiesOf(folders: ProjectFolders, maker: ProxyMaker): ProxyFiles {
    const project = (): ProxyProject | undefined => {
      const { open } = folders.getSnapshot();
      const session = folders.session;
      const assets = folders.assets();
      const store = this.session.store;
      if (!open || !session || !assets || !store) return undefined;
      return {
        key: open.record.id,
        store,
        folder: session.folder,
        writes: open.snapshot.role === "writing",
        elsewhere: open.snapshot.role === "waiting",
        // What the project says about its videos holds once the folder was compared with it.
        compared: open.snapshot.compared,
        // Where the project says the file of a video is, while it is that file. Nothing that
        // looks for it shows as waiting: the preview does not wait for a proxy.
        async file(hash) {
          for (const asset of Object.values(store.getState().assets ?? {})) {
            if (asset.hash === undefined || !isSameHash(asset.hash, hash)) continue;
            const found = await assets.fileAt(asset.path);
            if (found.kind === "there" && isSameHash(found.hash, hash)) return found.file;
          }
          return undefined;
        },
      };
    };
    return new ProxyFiles({
      project,
      subscribe: (listener) => {
        const stops = [folders.subscribe(listener), this.session.subscribe(listener)];
        return () => {
          for (const stop of stops) stop();
        };
      },
      maker,
      playing: () => this.timeline.getSnapshot().playing,
      subscribePlaying: (listener) => this.timeline.subscribe(listener),
    });
  }

  /**
   * What people do goes in the black box: actions, tabs, the playhead, commands. Names and numbers
   * only. What commands were given stays out, because that is what people make.
   */
  #keepTrail(): void {
    const { diagnostics } = this;
    this.actions.watch((action, way) => diagnostics.mark("action", { id: action.id, way }, true));
    let active = this.layout.getSnapshot().active;
    this.layout.subscribe(() => {
      const now = this.layout.getSnapshot().active;
      if (now !== active && now !== undefined) diagnostics.mark("panel", { id: now });
      active = now;
    });
    let compositor = this.preview.getSnapshot().compositor;
    this.preview.subscribe(() => {
      const now = this.preview.getSnapshot().compositor;
      if (now !== compositor) diagnostics.mark("compositor", { state: now });
      compositor = now;
    });
    let frame = this.timeline.frame;
    this.timeline.subscribe(() => {
      const now = this.timeline.frame;
      if (now !== frame && !this.timeline.getSnapshot().playing) {
        diagnostics.mark("seek", { frame: now }, true);
      }
      frame = now;
    });
    let store: ProjectStore | undefined;
    let stopWatching: (() => void) | undefined;
    const follow = () => {
      if (this.session.store === store) return;
      stopWatching?.();
      store = this.session.store;
      diagnostics.mark("project", { open: store !== undefined });
      stopWatching = store?.watchCommands(({ commands, by, ok, dryRun, code, error }) => {
        if (dryRun && ok) return;
        const [name] = commands;
        diagnostics.mark(
          "command",
          {
            name,
            by,
            ok,
            ...(commands.length > 1 && { count: commands.length }),
            ...(code !== undefined && { code }),
            ...(dryRun && { dryRun }),
          },
          true,
        );
        if (code === "threw") this.errors.capture("command", error, { commands });
      });
    };
    this.session.subscribe(follow);
    follow();
  }

  /**
   * What the project alone tells of its problems changes with the project and with what the scenes
   * registered. It is worked out after a moment, once for all that changed in between.
   */
  #keepPropertyProblems(): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const note = () => {
      timer = undefined;
      this.problems.update();
    };
    const soon = () => {
      timer ??= setTimeout(note, PROPERTY_PROBLEMS_DELAY_MS);
    };
    let store: ProjectStore | undefined;
    let stop: (() => void) | undefined;
    const follow = () => {
      if (this.session.store === store) return;
      stop?.();
      store = this.session.store;
      stop = store?.subscribe(soon);
      soon();
    };
    this.session.subscribe(follow);
    follow();
    this.registrations.subscribe(soon);
    this.timeline.subscribe(soon);
  }

  /** Runs what fixes a problem, as one step, which undo takes back. */
  #fix(call: OperationCall): void {
    const result = this.session.store?.execute(call);
    if (result && !result.ok) {
      this.notifications.push(commandFailedText(this.t, result.error));
    }
  }

  /**
   * Gives the keys of a property another path, which is how keys that lost their object find one
   * again. One step, which undo takes back.
   */
  renameProperty(clip: string, from: string, to: string): boolean {
    const store = this.session.store;
    const timeline = this.timeline.model?.id;
    if (!store || timeline === undefined) return false;
    const renames = [{ owner: { clip }, from, to }];
    const result = store.execute({ type: "property.rename", params: { timeline, renames } });
    if (!result.ok) {
      this.notifications.push(commandFailedText(this.t, result.error));
    }
    return result.ok;
  }

  /**
   * Asks where keys that nothing describes should go, and takes them there. Only properties that
   * can take them are on offer.
   */
  async connectProperty(clip: string, path: string): Promise<void> {
    const box = this.timeline.model?.boxes.get(clip);
    if (!box) return;
    const { t, keyframes } = this;
    const found = connectionsFor(keyframes.nodeOf(box.clip), box.clip, path, (node) =>
      keyframes.nameOfNode(node),
    );
    const words = { name: path, interpolation: { escapeValue: false } };
    if (found.length === 0) {
      await this.dialogs.confirm({
        title: t("keyframes.connect.title", words),
        message: t("keyframes.connect.none"),
        confirm: t("dialog.close"),
        noticeOnly: true,
      });
      return;
    }
    const answer = await this.dialogs.form({
      title: t("keyframes.connect.title", words),
      fields: [
        {
          id: "to",
          label: t("keyframes.connect.field"),
          options: found.map(({ path: id, label }) => ({ id, label })),
          value: (found[0] as Connection).path,
        },
      ],
      confirm: t("keyframes.connect.confirm"),
    });
    const to = answer?.["to"];
    if (to !== undefined) this.renameProperty(clip, path, to);
  }

  #clipName(clip: string): string {
    const box = this.timeline.model?.boxes.get(clip);
    return sceneClipName(box?.clip, this.session.store?.getState(), this.t);
  }

  /**
   * It goes on the list, which has room for all of it. Only the first one of a state of a scene is
   * worth interrupting people for, and not while they are looking at the list.
   */
  #noteSceneProblem(clip: string, revision: string, problem: SceneProblem, first: boolean): void {
    this.#markCodeProblem("scene.problem", problem);
    const { t } = this;
    const name = this.#clipName(clip);
    const shown = this.timeline.model;
    const source = shown?.boxes.get(clip)?.clip.source;
    // The same code fails the same way in every clip that shows it.
    const subject =
      source?.kind === "scene" && typeof source.scene === "string"
        ? { kind: "scene" as const, id: source.scene }
        : { kind: "clip" as const, id: clip, ...(shown && { timeline: shown.id }) };
    this.problems.noteScene(clip, revision, sceneProblem(problem, subject), name);
    if (!first || this.layout.getSnapshot().visible.has("problems")) return;
    const text = describeProblem(t, problem);
    const words = { name, text, interpolation: { escapeValue: false } };
    this.notifications.push(t("scene.problem", words));
  }

  #noteStoppedScene(clip: string, status: SceneStatus | undefined): void {
    if (status) {
      const { reason, phase } = status;
      this.diagnostics.mark("scene.stopped", { reason, phase });
    }
    if (!status) {
      this.problems.noteStopped(clip, undefined);
      return;
    }
    const shown = this.timeline.model;
    const { state, reason, message } = status;
    this.problems.noteStopped(
      clip,
      withId({
        source: "runtime",
        severity: "error",
        code: "scene-stopped",
        params: { state, ...(reason !== undefined && { reason }) },
        subject: { kind: "clip", id: clip, ...(shown && { timeline: shown.id }) },
        ...(message !== undefined && { detail: message }),
      }),
    );
  }

  /**
   * Lets people choose another file for an asset, or the file of one that is missing: in a project
   * folder one in it is used where it is, any other gets copied in, see `MediaLibrary.replaceFile`.
   * Resolves to whether the asset has the file now.
   */
  async replaceAssetFile(assetId: string): Promise<boolean> {
    const asset = this.session.store?.getState().assets?.[assetId];
    if (!asset) return false;
    const folders = this.projectFolders;
    let source: { readonly file: File } | { readonly path: string } | undefined;
    const placed = folders?.assets() ? await folders.pickFiles() : undefined;
    if (placed) {
      for (const name of placed.unreadable) {
        this.notifications.push(this.t("notice.mediaUnsupported", { name }));
      }
      const [path] = placed.inside;
      const [file] = placed.files;
      source = path !== undefined ? { path } : file && { file };
    } else {
      const file = await this.media.chooseFile(asset.kind);
      source = file && { file };
    }
    if (!source) return false;
    const done = await this.media.replaceFile(assetId, source);
    if (done) folders?.checkAssetsSoon();
    return done;
  }

  /** The file of a missing asset is somewhere else in the project folder: the asset goes there. */
  async moveAssetTo(assetId: string, path: string): Promise<boolean> {
    const done = await this.media.usePlace(assetId, path);
    if (done) this.projectFolders?.checkAssetsSoon();
    return done;
  }

  /** Whether the explorer lists a resource, which is where `revealResource` goes. */
  canRevealResource(id: string): boolean {
    return nodeOfResource(id) !== undefined && this.panels.get("explorer") !== undefined;
  }

  /**
   * Opens the settings, at a place such as a service of AI from the chat, or where they were last.
   * A menu or the palette that opened them has closed by then.
   */
  openSettings(place?: SettingsPlace): void {
    this.palette.close();
    this.projectNav.close();
    this.localAiGuide.set(false);
    this.settingsNav.open(place);
  }

  /**
   * Opens the guide to the AI tools on this computer (docs/design/mcp.md, 6.16a), over whatever
   * the window shows: from the settings, the chat, the palette and the help menu.
   */
  openLocalAiGuide(): void {
    this.palette.close();
    this.projectNav.close();
    this.settingsNav.close();
    this.localAiGuide.set(true);
  }

  /** Gives the open project a folder: links a cloud project to one, or moves it into one. */
  linkFolder(): void {
    if (this.cloud) this.runCloudAction("linkFolder");
    else void this.moveToFolder();
  }

  /** Adds AGENTS.md to the open project, as a new project has it. */
  addInstructions(): boolean {
    return (
      this.projectEdits.run({
        type: "file.write",
        params: { path: INSTRUCTIONS_FILE, text: INSTRUCTIONS_START },
      })?.ok === true
    );
  }

  /** Opens AGENTS.md of the open project in the code tab. */
  openInstructions(): void {
    this.localAiGuide.set(false);
    this.projectNav.close();
    this.showCode(INSTRUCTIONS_FILE);
  }

  /** The files a new project starts with: AGENTS.md too, unless people turned that off. */
  startingFiles(): Readonly<Record<string, string>> {
    return this.agentsFile.getSnapshot() ? startingFiles() : {};
  }

  /** Shows a resource in the explorer, from a tab that finds and uses resources. */
  revealResource(id: string): void {
    if (!this.explorer.reveal(id)) return;
    this.layout.openPanel("explorer");
  }

  /**
   * Goes to where a resource is used, on the timeline: the clip, or the transition or join that is
   * it. Only the timeline that the editor shows can be gone to. Resolves to whether it could.
   */
  goToUse(use: {
    readonly timeline: string;
    readonly clip?: string;
    readonly join?: string;
    readonly edge?: "enter" | "exit";
  }): boolean {
    if (this.timeline.model?.id !== use.timeline) return false;
    const shown = this.timeline.revealClip(use.clip ?? "", {
      ...(use.edge && { edge: use.edge }),
      ...(use.join !== undefined && { join: use.join }),
    });
    if (shown) this.layout.openPanel("timeline");
    return shown;
  }

  /**
   * Goes to where a problem is: a file of the project, the keys of a property of a clip, or what it
   * is about on the timeline.
   */
  goToProblem({
    file,
    line,
    column,
    problem,
  }: Pick<ListedProblem, "file" | "line" | "column" | "problem">): void {
    const subject = problem?.subject;
    const timeline = this.timeline.model;
    if (problem?.source === "properties" && subject?.kind === "clip") {
      if (!timeline?.boxes.has(subject.id)) return;
      this.timeline.selectOnly(subject.id);
      this.layout.openPanel("keyframes");
      return;
    }
    if (file !== undefined) {
      const place = line === undefined ? undefined : { line, ...(column && { column }) };
      if (!this.showCode(file, place)) {
        this.notifications.push(this.t("problems.notInProject", { file }));
      }
      return;
    }
    if (subject) this.goToObject(subject);
  }

  /**
   * Goes to an object of the project, as people see it: a clip or a join on the timeline, a marker
   * at its time, a file or the code of a scene, the first clip of a track. Only the timeline that
   * the editor shows can be gone to. Resolves to whether there was somewhere to go.
   */
  goToObject(subject: ObjectRef): boolean {
    const state = this.session.store?.getState();
    const timeline = this.timeline.model;
    if (!state) return false;
    if (subject.kind === "file") return this.showCode(subject.id);
    if (subject.kind === "scene") {
      const manifest = state.scenes[subject.id];
      return manifest ? this.showCode(`scenes/${subject.id}/${manifest.entry}`) : false;
    }
    const at = subject.kind === "timeline" ? subject.id : subject.timeline;
    if (at === undefined || timeline?.id !== at) return false;
    if (subject.kind === "clip") return this.goToUse({ timeline: at, clip: subject.id });
    if (subject.kind === "join") {
      const join = state.timelines[at]?.joins?.[subject.id];
      return join?.from === undefined
        ? false
        : this.goToUse({ timeline: at, clip: join.from, join: subject.id });
    }
    if (subject.kind === "marker") {
      const marker = state.timelines[at]?.markers[subject.id];
      if (!marker) return false;
      this.timeline.seek(frameAt(toSeconds(parseTime(marker.time)), timeline.rate));
      this.layout.openPanel("timeline");
      return true;
    }
    // A track, or the whole timeline: the first clip of the track, or the timeline itself.
    const first =
      subject.kind === "track"
        ? Object.values(state.timelines[at]?.clips ?? {})
            .filter((clip) => clip.track === subject.id)
            .toSorted((a, b) => compare(clipStart(a), clipStart(b)))[0]
        : undefined;
    if (!first || !this.goToUse({ timeline: at, clip: first.id })) {
      this.layout.openPanel("timeline");
    }
    return true;
  }

  /**
   * From the list of files. Keys go by the panel in use, so a file that only gets shown leaves the
   * list in use, for going on with it. A new file is there to be written in.
   */
  #showFile(path: string, edit: boolean): void {
    this.showCode(path, edit ? { line: 1 } : undefined);
    if (!edit && this.layout.getSnapshot().visible.has("files")) this.layout.openPanel("files");
  }

  /**
   * Whether the code of a scene or a sound, as it is in `state`, ran in this window: a scene in the
   * preview, a sound when it was made for its clips.
   */
  #ranNow(
    object: { readonly kind: "scene" | "sound"; readonly id: string },
    state: ProjectState,
  ): boolean {
    if (object.kind === "scene") {
      const ran = this.#ranScenes.get(object.id);
      return ran !== undefined && ran === sceneSourceOf(state, object.id)?.revision;
    }
    const clips = Object.values(state.timelines).flatMap((timeline) =>
      Object.values(timeline.clips),
    );
    return clips.some((clip) => {
      if (clip.source.kind !== "sound" || clip.source.sound !== object.id) return false;
      const made = this.sounds.stateOf(clip)?.state;
      return made === "ready" || made === "failed";
    });
  }

  /** Resolves to whether the project has that file. */
  showCode(path: string, place?: CodePlace): boolean {
    const opened = this.code.open(path, place);
    if (opened) {
      this.resourcePages.showCode();
      this.layout.openPanel("code");
    }
    return opened;
  }

  /**
   * Opens a resource in the resources tab: the code of a scene or a sound, the details of anything
   * else, also of a scene whose code is not there.
   */
  openResource(id: string, name: string): void {
    const project = parseProjectResourceId(id);
    const state = this.session.store?.getState();
    if (project && project.kind !== "asset" && state) {
      const manifest =
        project.kind === "scene" ? state.scenes[project.id] : state.sounds[project.id];
      const folder = project.kind === "scene" ? "scenes" : "sounds";
      if (manifest && this.showCode(`${folder}/${project.id}/${manifest.entry}`)) return;
    }
    this.openResourcePage(id, name);
  }

  /** Opens the details of a resource in the resources tab, whatever it is. */
  openResourcePage(id: string, name: string): void {
    this.resourcePages.open(id, name);
    this.layout.openPanel("code");
  }

  /** An import says all of this once. The list is where it can still be found afterwards. */
  #noteImport({ missing, elsewhere, damaged, skipped, lost, warnings }: ImportReport): void {
    const { t } = this;
    const origin = t("problems.origin.import");
    const said = (kind: "missing" | "damaged" | "skipped", names: readonly string[]) =>
      names.map((name) => ({
        severity: "warning" as const,
        text: t(`problems.import.${kind}`, { name, interpolation: { escapeValue: false } }),
        origin,
      }));
    this.problems.noteImport([
      ...lost.map((text) => ({ severity: "warning" as const, text, origin })),
      ...said("missing", missing),
      // Many files that can come from where they are kept are one line, not one each.
      ...(elsewhere.length > 1
        ? [
            {
              severity: "warning" as const,
              text: t("problems.import.elsewhereMany", { count: elsewhere.length }),
              origin,
            },
          ]
        : elsewhere.map(({ name, storage, url }) => ({
            severity: "warning" as const,
            text: t("problems.import.elsewhere", {
              name,
              download: downloadFrom(t, storage, url),
            }),
            origin,
          }))),
      ...said("damaged", damaged),
      ...said("skipped", skipped),
      ...warnings.map(({ severity, message, file, path, code }) => ({
        severity,
        text: message,
        code,
        file,
        ...(path && { place: path }),
        origin,
      })),
    ]);
  }

  #askAboutUnsaved(path: string): Promise<"save" | "discard" | undefined> {
    const { t } = this;
    return this.dialogs.choose({
      title: t("code.unsavedTitle", { path }),
      message: t("code.unsavedMessage"),
      choices: [
        { id: "discard", label: t("code.discard"), kind: "danger" },
        { id: "save", label: t("code.save"), kind: "primary" },
      ],
    }) as Promise<"save" | "discard" | undefined>;
  }

  #askAboutOverwriting(path: string): Promise<"overwrite" | "theirs" | undefined> {
    const { t } = this;
    return this.dialogs.choose({
      title: t("code.overwriteTitle", { path }),
      message: t("code.overwriteMessage"),
      choices: [
        { id: "theirs", label: t("code.takeTheirs") },
        { id: "overwrite", label: t("code.overwrite"), kind: "danger" },
      ],
    }) as Promise<"overwrite" | "theirs" | undefined>;
  }

  /** Resolves to false when people would rather stay with what they typed. */
  async #settleCode(): Promise<boolean> {
    const count = this.code.unsaved.length;
    if (count === 0) return true;
    const { t } = this;
    const answer = await this.dialogs.choose({
      title: t("code.leaveTitle", { count }),
      message: t("code.unsavedMessage"),
      choices: [
        { id: "discard", label: t("code.discard"), kind: "danger" },
        { id: "save", label: t("code.saveAll"), kind: "primary" },
      ],
    });
    if (answer === undefined) return false;
    if (answer === "save") return this.code.saveAll();
    this.code.discardAll();
    return true;
  }

  #soundName(sound: string): string {
    return this.session.store?.getState().sounds[sound]?.name ?? this.t("timeline.kind.sound");
  }

  /**
   * Something went wrong with the code of a project. Only its kind goes in the black box: what it
   * says and where comes from that code, which is what people make.
   */
  #markCodeProblem(
    kind: "scene.problem" | "sound.problem",
    { kind: type, code }: SceneProblem,
  ): void {
    this.diagnostics.mark(kind, { type, ...(code !== undefined && { code }) });
  }

  #noteSoundProblem(sound: string, problem: SceneProblem): void {
    this.#markCodeProblem("sound.problem", problem);
    const words = { name: this.#soundName(sound), interpolation: { escapeValue: false } };
    const text = describeProblem(this.t, problem);
    this.notifications.push(this.t("scene.problem", { ...words, text }));
  }

  async load(): Promise<void> {
    await Promise.all([
      this.layout.load(),
      this.keybindings.load(),
      this.palette.load(),
      this.resourceHabits.load(),
      this.startHabits.load(),
      this.timeline.load(),
      this.keyframes.load(),
      this.input.load(),
      this.previewQuality.load(),
      this.proxyOffer.load(),
      this.agentsFile.load(),
      this.trials.load(),
      this.ai.load(),
      this.packs.load(),
    ]);
    this.tools.start();
    // An address of a project folder opens as one once the page is there, see `resume`.
    if (!(await this.projectFolders?.restore())) await this.session.restore();
    // Who is signed in comes when it comes: the editor does not wait for it.
    if (this.account) {
      this.#forgetChatsOnSignOut(this.account);
      void this.#followAccount(this.account);
    }
    // Before the AI settings, which ask it about the welcome.
    this.cloudSync.start();
    void this.aiSync.start();
  }

  /** Asks who is signed in, and says how a sign-in ended when it brought this page here. */
  /**
   * As people sign out, here or anywhere else, what this browser keeps of the account's
   * conversations goes, see `CloudChats.beforeSignOut`.
   */
  #forgetChatsOnSignOut(account: AccountAccess): void {
    let was = account.getSnapshot().status;
    account.subscribe(() => {
      const now = account.getSnapshot().status;
      if (was === "signedIn" && now === "signedOut") void this.chatSync?.beforeSignOut();
      if (now !== "unknown") was = now;
    });
  }

  async #followAccount(account: AccountAccess): Promise<void> {
    await account.refresh();
    const outcome = account.takeOutcome();
    if (outcome) await this.#tellSignIn(outcome, account.getSnapshot());
  }

  /**
   * Asks the browser to keep what the editor stores until people clear it (`persistence`), once,
   * the first time something of a project was saved here: what people made is worth keeping by
   * then, and the browser asks people right after they did something (Firefox shows a question).
   * Where it said no, the settings say so ("存储和数据"), where people can ask again.
   */
  #keepStoredOnceSaved(): void {
    const persistence = this.persistence;
    if (!persistence || persistence.wasAsked()) return;
    let was = this.session.getSnapshot().save;
    const stop = this.session.subscribe(() => {
      const now = this.session.getSnapshot().save;
      const saved = was === "saving" && now === "saved";
      was = now;
      if (!saved) return;
      stop();
      void persistence
        .persisted()
        .then((kept) => kept || persistence.wasAsked() || persistence.persist())
        .catch(() => {});
    });
  }

  /** Whether the welcome was answered for whoever is signed in, or there is none. */
  async #welcomed(): Promise<boolean> {
    await this.cloudSync.settled();
    const { available, welcomed } = this.cloudSync.getSnapshot();
    return !available || welcomed;
  }

  async #tellSignIn(outcome: SignInOutcome, snapshot: AccountSnapshot): Promise<void> {
    const { t } = this;
    if (outcome !== "signedIn") {
      this.notifications.push(t(`account.outcome.${outcome}`));
      return;
    }
    if (snapshot.status !== "signedIn") return;
    const words = { name: snapshot.name, interpolation: { escapeValue: false } };
    // The welcome says it, with a button to install the App: nothing more is pushed at people.
    if (snapshot.appInstalled || !(await this.#welcomed())) {
      this.notifications.push(t("account.signedIn", words));
      return;
    }
    // Saving to GitHub needs the App on the account, which people may not want yet: they get to
    // say when, and everything else works meanwhile.
    this.notifications.push(t("account.signedInWithoutApp", words), {
      stays: true,
      actions: [{ label: t("account.install"), run: () => void this.installApp() }],
    });
  }

  /**
   * Whether the page is going away on purpose, with everything kept: the browser need not ask
   * people whether to leave. See `leavePage`.
   */
  get leavingPage(): boolean {
    return this.#leavingPage;
  }

  /**
   * Gets the page ready to go away for a moment and come back to this project, as signing in does:
   * what is not saved yet, what is being tried, code that is not saved, and what this window keeps
   * of itself all go where a reload finds them. Resolves to false when something would stop halfway,
   * such as an export, or people would rather stay with what could not be kept.
   */
  async leavePage(): Promise<boolean> {
    const { t } = this;
    const exporting = this.videos.getSnapshot() !== undefined;
    if (this.transfer.running || exporting || this.projectFolders?.moving === true) {
      await this.dialogs.confirm({
        title: t("app.leaveBusyTitle"),
        message: t("app.leaveBusyMessage"),
        confirm: t("dialog.close"),
        noticeOnly: true,
      });
      return false;
    }
    // A number that is still being typed is part of what people mean to keep.
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLInputElement) {
      if (document.activeElement.matches('[role="spinbutton"]')) document.activeElement.blur();
    }
    this.timeline.flush();
    this.keyframes.flush();
    const [saved, tried, typed] = await Promise.all([
      this.session.trySave(),
      this.trials.settle(),
      this.drafts.settle(),
      this.layout.flush(),
    ]);
    // What is saved goes into the project folder too, should the page not come back.
    const written = await (this.projectFolders?.flush() ?? Promise.resolve(true)).catch(
      (error: unknown) => {
        console.warn("The project folder could not be written before leaving", error);
        return false;
      },
    );
    if (!saved || !tried || !typed) {
      const leave = await this.dialogs.confirm({
        title: t("app.leaveUnsavedTitle"),
        message: t("app.leaveUnsavedMessage"),
        confirm: t("app.leaveAnyway"),
        danger: true,
      });
      if (!leave) return false;
    } else if (!written) {
      // The browser has all of it, and the folder gets it from there once the page is back; until
      // then the folder is behind, which matters to whoever looks at it meanwhile.
      const leave = await this.dialogs.confirm({
        title: t("app.leaveFolderTitle"),
        message: t("app.leaveFolderMessage"),
        confirm: t("app.leaveAnyway"),
      });
      if (!leave) return false;
    }
    this.#leavingPage = true;
    // Should the page stay after all, it asks again before going.
    clearTimeout(this.#leavingTimer);
    this.#leavingTimer = setTimeout(() => (this.#leavingPage = false), LEAVING_MS);
    return true;
  }

  /** Signs in where the editor is hosted: the page goes and comes back, see `leavePage`. */
  async signIn(): Promise<void> {
    const { account } = this;
    if (account && (await this.leavePage())) account.signIn();
  }

  /** Installs the GitHub App on the account: the page goes and comes back, see `leavePage`. */
  async installApp(): Promise<void> {
    const { account } = this;
    if (account && (await this.leavePage())) account.installApp();
  }

  async signOut(): Promise<void> {
    const { account, t } = this;
    if (!account) return;
    try {
      // What changed here goes to the account first: the account's copy leaves this browser then.
      await this.aiSync.beforeSignOut();
      await this.chatSync?.beforeSignOut();
      await account.signOut();
      this.notifications.push(t("account.signedOut"));
    } catch (error) {
      console.warn("Signing out failed", error);
      this.notifications.push(t("account.signOutFailed"));
    }
  }

  /**
   * What starts once the page is there to ask people things: opening the project folder that the
   * address asks for, which can need people to say something, see `ProjectFolders.resume`.
   */
  async resume(): Promise<void> {
    await this.projectFolders?.resume();
    this.#resumeConnect();
    this.#resumeCreate();
  }

  /**
   * Once the page is back from signing in or installing the App, which the dialog that makes a new
   * project of the platform sent it to: the dialog comes back with what people chose.
   */
  #resumeCreate(): void {
    if (!this.#platform) return;
    const intent = takeCreateIntent(this.#memory, Date.now());
    if (intent) void this.#showCreate(this.#newCreate({ intent }));
  }

  /** The folder of the open project, where it is one and its folder is there. */
  #folderOf(key: string): LocalFolder | undefined {
    const folders = this.projectFolders;
    const open = folders?.getSnapshot().open;
    return open?.record.id === key ? (folders?.session?.folder ?? open.record.folder) : undefined;
  }

  /**
   * Has `CloudProjects` look at the open project, and notes whether what it says counts, see
   * `cloudKnown`: a folder that is not there yet is looked at once it is. Resolves to that.
   */
  async #followCloud(): Promise<boolean> {
    const { cloud } = this;
    if (!cloud) return false;
    const { key } = this.session;
    const isThere = () =>
      key !== undefined &&
      this.session.key === key &&
      this.session.store !== undefined &&
      (this.projectFolders?.holds(key) !== true || this.#folderOf(key) !== undefined);
    const wasThere = isThere();
    if (!wasThere) this.cloudKnown.set(false);
    await cloud.follow();
    const isKnown = wasThere && isThere();
    // Another project meanwhile has a look of its own.
    if (this.session.key === key) this.cloudKnown.set(isKnown);
    return isKnown;
  }

  /**
   * Makes the open project one that cannot be edited, or one that can again, as how it stands with
   * the platform says, see `readOnly`: the project first, so that nothing changes it from here on,
   * then its folder, and the browser AI stops what it does. Where it can be edited again, the
   * folder is compared with the project, and what changed in it meanwhile comes in.
   */
  #keepReadOnly(): void {
    const store = this.session.store;
    // Only what is said of this very project: another one may be on its way in.
    const said = this.cloud?.getSnapshot();
    const isThis = said?.kind === "linked" && said.link.key === this.session.key;
    // Also while what it has is of a copy that the platform made again, until it is taken back.
    const isReadOnly =
      store !== undefined &&
      isThis &&
      (this.cloud?.unusable !== undefined || this.cloud?.rebuilt === true);
    if (store && store.readOnly !== isReadOnly) store.readOnly = isReadOnly;
    this.projectFolders?.hold(isReadOnly);
    if (isReadOnly && !this.readOnly.getSnapshot() && this.chat.running) this.chat.stop();
    this.readOnly.set(isReadOnly);
  }

  /**
   * "另存为本地项目…": a copy of a project of the platform, the open one where none is said, as a
   * project of this computer of its own in a folder, which does not sync, see
   * `ProjectFolders.saveAsLocal`. Where this window has the project open, the copy is of what it
   * has; otherwise of what the platform has, read only. The project itself does not change.
   */
  async saveAsLocal(project?: string, name?: string): Promise<void> {
    const { cloud, projectFolders } = this;
    if (!cloud || !projectFolders) return;
    const open = cloud.getSnapshot();
    const id = project ?? (open.kind === "linked" ? open.link.project : undefined);
    if (id === undefined) return;
    const isOpen = open.kind === "linked" && open.link.project === id;
    const shown = name ?? (isOpen ? this.session.store?.getState().manifest.name : undefined) ?? "";
    const came: string[] = [];
    await projectFolders.saveAsLocal(shown, async (signal) => {
      const got = await cloud.copySource(
        id,
        signal,
        (key) => projectFolders.mediaFor(key) ?? this.projects.media(key),
      );
      // The copy does not stay with the platform: whatever can come out of the large file storage
      // comes first, used or not (4.3 of the design of the start page).
      return (
        got && { ...got, media: this.#downloadingMedia(id, got.store, got.media, signal, came) }
      );
    });
    // What came for the copy alone goes: the copy has it. The open project may want it still.
    if (!isOpen)
      for (const oid of came) await this.#downloadStore?.dropUnused(oid).catch(() => false);
  }

  /**
   * The files of a project as a copy of it takes them: those this browser has, and where it does
   * not, those that can come out of the large file storage of its repository, checked.
   */
  #downloadingMedia(
    project: string,
    store: ProjectStore,
    media: Pick<MediaStore, "get">,
    signal: AbortSignal,
    came: string[],
  ): Pick<MediaStore, "get"> {
    const lfs = this.#platform?.lfs;
    const kept = this.#downloadStore;
    if (!lfs?.piece || !kept) return media;
    return {
      get: async (hash) => {
        const here = await media.get(hash);
        if (here) return here;
        const state = store.getState();
        const asset = Object.entries(state.assets ?? {}).find(
          ([id, each]) =>
            each.hash !== undefined &&
            isSameHash(each.hash, hash) &&
            elsewhereOf(state, id) === "lfs",
        )?.[1];
        if (asset?.hash === undefined || asset.size === undefined) return undefined;
        const hashOf = (file: Blob, stop: AbortSignal) =>
          this.#hasher
            ? this.#hasher.file(file, { signal: stop })
            : hashFile(file, { signal: stop });
        const oid = lfsOidOf(asset.hash);
        if (oid !== undefined) came.push(oid);
        return downloadWhole(
          lfs,
          kept,
          project,
          { hash: asset.hash, size: asset.size },
          hashOf,
          signal,
        ).catch(() => undefined);
      },
    };
  }

  /**
   * "删除云端项目…": takes a project of the platform away there, the open one where none is said,
   * see `CloudProjects.deleteFromCloud`.
   */
  async deleteFromCloud(project?: string, name?: string): Promise<boolean> {
    const { cloud } = this;
    if (!cloud) return false;
    const open = cloud.getSnapshot();
    const id = project ?? (open.kind === "linked" ? open.link.project : undefined);
    if (id === undefined) return false;
    const shown =
      name ??
      (open.kind === "linked" && open.link.project === id
        ? this.session.store?.getState().manifest.name
        : undefined) ??
      "";
    return cloud.deleteFromCloud(id, shown);
  }

  /**
   * "云端…": how the open project stands with the platform. One that is not connected gets the
   * dialog that connects it; any other the panel, which the status bar shows.
   */
  showCloud(): void {
    void this.#showCloud();
  }

  async #showCloud(): Promise<void> {
    const { cloud } = this;
    if (!cloud || !(await this.#followCloud())) return;
    if (cloud.getSnapshot().kind === "none") await this.connectToCloud();
    else this.cloudPanel.set(true);
  }

  /**
   * Connects the open project to the platform in one dialog, see `CloudConnect`: the project goes
   * there, gets its repository, and is archived for the first time. For one that is on the
   * platform without a repository the dialog does what is missing; one that has its repository
   * gets the panel. `resume`: only where the page left in the middle of it, as to sign in.
   */
  async connectToCloud({ resume = false } = {}): Promise<void> {
    const { cloud } = this;
    // Not before it is known whether the project is connected: the dialog would connect one
    // that is, a second time.
    if (!cloud || !(await this.#followCloud())) return;
    const snapshot = cloud.getSnapshot();
    // Whether it has a repository is not known yet: the dialog would ask for one it has.
    if (snapshot.kind === "linked" && cloud.isOnPlatform && !snapshot.repository?.status)
      await snapshot.repository?.refresh();
    const connect = cloud.beginConnect({ resume });
    if (!connect) {
      if (resume) return;
      // Its repository is there: the panel says how it goes. A platform that saves no projects
      // to repositories has no such dialog, and nothing to connect a project with here.
      if (cloud.getSnapshot().kind === "linked") this.cloudPanel.set(true);
      return;
    }
    this.cloudPanel.set(false);
    try {
      await this.dialogs.connect({
        title: this.t(
          connect.getSnapshot().repositoryOnly
            ? "cloud.connect.repositoryTitle"
            : "cloud.connect.title",
          { name: connect.name, interpolation: { escapeValue: false } },
        ),
        connect,
      });
    } finally {
      // Over, or another dialog took its place: what it made stays as it is then, for people to
      // go on with from the panel.
      connect.close();
    }
    // Connected: whether the assets go into the large file storage too, once.
    const done = connect.getSnapshot().phase;
    const project = this.#uploadProject();
    if (
      (done === "done" || done === "archiving") &&
      project?.project &&
      this.uploads.available &&
      this.#assetCount() > 0
    )
      void this.#askOnce(`connected.${project.project}`, "connected");
  }

  /**
   * Once the page is back from signing in or installing the App, which the dialog that connects a
   * project sent it to: the dialog comes back with what people chose, as soon as that project is
   * open again, which a folder is once people let the browser read it.
   */
  #resumeConnect(): void {
    const { cloud } = this;
    if (!cloud) return;
    let stops: (() => void)[] = [];
    const look = () => {
      const { key, store } = this.session;
      if (!key || !store) return;
      if (this.projectFolders?.holds(key) && !this.#folderOf(key)) return;
      for (const stop of stops.splice(0)) stop();
      void this.connectToCloud({ resume: true });
    };
    stops = [
      this.session.subscribe(look),
      ...(this.projectFolders ? [this.projectFolders.subscribe(look)] : []),
    ];
    look();
  }

  /** "打开云端的项目…": the start page, at its projects of the platform. */
  async openCloudProjects(): Promise<void> {
    await this.closeProject();
    if (!this.session.store) this.cloudColumn.set(true);
  }

  /** What people press in the panel of the platform, see `cloudPanel`. */
  runCloudAction(id: PanelActionId): void {
    const { cloud } = this;
    if (!cloud) return;
    // These show how they go in the panel itself; the others ask something, or leave.
    if (id !== "archiveNow" && id !== "retry" && id !== "recheck") this.cloudPanel.set(false);
    switch (id) {
      case "connect":
      case "chooseRepository":
      case "finishConnect":
        void this.connectToCloud();
        break;
      case "switchRepository":
        void cloud.switchRepository();
        break;
      case "disconnect":
        void cloud.disconnect();
        break;
      case "removeFromBrowser": {
        const { key } = this.session;
        if (key !== undefined) void cloud.removeFromBrowser(key);
        break;
      }
      case "linkFolder": {
        // As from the start page: a folder that has the project already is compared with it.
        const snapshot = cloud.getSnapshot();
        if (snapshot.kind === "linked") void cloud.linkFolder(snapshot.link.project);
        else void this.moveToFolder();
        break;
      }
      case "recheck":
        void cloud.recheck();
        break;
      case "reauthorize":
      case "reinstall":
      case "restoreApp":
        void this.installApp();
        break;
      case "saveAsLocal":
        void this.saveAsLocal();
        break;
      case "deleteCloud":
        void this.deleteFromCloud();
        break;
      case "archiveNow":
        void cloud.archiveNow();
        break;
      case "continueWithEditor":
        void cloud.continueWithEditor();
        break;
      case "resolveStuck":
        void cloud.resolveStuck();
        break;
      case "retry":
        cloud.session?.resume();
        break;
      case "takeBack":
        void cloud.takeBackAgain();
        break;
      case "wakeAsItIs":
        void cloud.wakeFromBranch();
        break;
      case "signIn":
        void this.signIn();
        break;
      case "installApp":
        void this.installApp();
        break;
      case "reload":
        location.reload();
        break;
      case "moveToFolder":
        void this.moveToFolder();
        break;
      case "saveCopy":
        void this.exportProject();
        break;
    }
  }

  /**
   * A new project, see the design of the start page (docs/design/start-and-cloud.md of AnimaQuill
   * Cloud), 3: a project of this computer, which is a folder people choose, or a project of the
   * platform, see `CloudCreate`, in one dialog that asks which. No new project is only in this
   * browser: the browser can clear it at any time. Where the editor is hosted on no platform there
   * is only the folder, and a browser that cannot write folders cannot make a project then. Tests
   * still make projects in this browser, see `Host.projectsHereForTests`.
   */
  async newProject(kind?: "local" | "cloud"): Promise<void> {
    if (this.#platform) {
      const create = this.#newCreate({});
      // From "新建云端项目" or "新建本地项目" of the start page: that one is chosen already.
      if (kind) create.setKind(kind);
      await this.#showCreate(create);
      return;
    }
    if (this.projectFolders) {
      await this.projectFolders.create();
      return;
    }
    if (this.#projectsHere) {
      const { t } = this;
      const name = await this.dialogs.prompt({
        title: t("project.nameLabel"),
        value: t("project.defaultName"),
        confirm: t("project.create"),
      });
      if (name) await this.#createHere(name);
      return;
    }
    await this.dialogs.confirm({
      title: this.t("project.new"),
      message: this.t("newProject.unsupported"),
      confirm: this.t("dialog.close"),
      noticeOnly: true,
    });
  }

  /** For tests only: a project in this browser, see `Host.projectsHereForTests`. */
  async #createHere(name: string, format?: NewFormat): Promise<void> {
    await this.#changeProject(() => this.session.create(name, format));
    // Made here on purpose: nothing is said about it being only here as it opens.
    const { key } = this.session;
    if (key !== undefined) this.cloud?.noteToldOnlyHere(key);
  }

  /** The dialog that makes a new project, see `CloudCreate`. */
  #newCreate({
    intent,
    imported,
  }: {
    readonly intent?: CreateIntent;
    readonly imported?: PreparedProject;
  }): CloudCreate {
    const cloud = this.#platform;
    const folders = this.projectFolders;
    const { t } = this;
    const content = (name: string, format: NewFormat): CreateContent => {
      // What is imported keeps its own formats.
      const project = imported
        ? { ...imported.project, manifest: { ...imported.project.manifest, name } }
        : createProject({ name, format });
      const store = ProjectStore.create(
        project,
        imported ? imported.sources : this.startingFiles(),
      );
      const made = { state: store.encodeWhole(), projectId: store.getState().manifest.id };
      store.destroy();
      return made;
    };
    return new CloudCreate({
      ...(cloud && { cloud }),
      ...(cloud?.repository && { access: cloud.repository }),
      ...(this.account && { account: this.account }),
      preferCloud: () => this.cloudSync.newProjectsInCloud,
      name: imported?.project.manifest.name ?? t("project.defaultName"),
      content,
      ...(imported && { imported: true }),
      ...(folders && {
        createLocal: (name: string, format: NewFormat) => folders.createNamed(name, format),
        chooseFolder: (name: string) => folders.chooseForNew(name),
      }),
      ...(this.#projectsHere && {
        createHere: (name: string, format: NewFormat) => this.#createHere(name, format),
      }),
      pinyin: loadPinyin,
      keep: async (project, made, received) =>
        (await this.cloud?.keepUploaded(project, made, received)) ?? undefined,
      ...(imported &&
        this.cloud && {
          receive: (project: string, name: string) =>
            this.cloud?.receiveFor(project, name) ?? Promise.resolve(undefined),
          bring: (media: MediaStore) => keepFiles(imported, media),
        }),
      ...(this.#making && { making: this.#making }),
      open: async (key, folder) => {
        await this.openProject(key);
        const opened = this.session.key === key;
        const inFolder =
          opened && folder !== undefined && folders !== undefined
            ? await folders.moveToFolder(key, folder)
            : false;
        return { opened, inFolder };
      },
      ...(this.cloud && { projects: this.cloud }),
      signIn: () => this.signIn(),
      installApp: () => this.installApp(),
      leaving: () => this.leavingPage,
      memory: this.#memory,
      ...(intent && { intent }),
      window: this.windowId,
      editor: this.version,
    });
  }

  /**
   * Shows the dialog that makes a new project until it is over. Another dialog can take its place
   * while the steps run, as moving the new project into its folder does: it comes back once that
   * is over, to say how the rest goes.
   */
  async #showCreate(create: CloudCreate, imported?: PreparedProject): Promise<void> {
    const { t } = this;
    try {
      for (;;) {
        await this.dialogs.create({
          title: t(imported ? "newProject.importTitle" : "newProject.title"),
          create,
          ...(imported && { imported: true }),
        });
        if (!create.isWorking) break;
        await create.whenIdle();
        const { phase } = create.getSnapshot();
        // Something else asks people now, or there is nothing left to say.
        if (this.dialogs.getSnapshot() !== undefined) break;
        if (phase !== "archiving" && phase !== "done" && phase !== "choosing") break;
      }
    } finally {
      create.close();
    }
    const { key } = create.getSnapshot();
    if (imported && key !== undefined && this.session.key === key) {
      const report: ImportReport = {
        id: key,
        name: this.session.store?.getState().manifest.name ?? imported.project.manifest.name,
        copied: false,
        ...imported.report,
      };
      this.#noteImport(report);
      await this.transfer.announceImport(report);
    }
  }

  /**
   * A project of this browser, or one that moved into a folder since the list that has it was made:
   * that one opens as its folder.
   */
  async openProject(id: string): Promise<void> {
    const record = await this.projectFolders?.projects.records.get(id).catch(() => undefined);
    if (record) {
      await this.projectFolders?.openRecent(record);
      return;
    }
    await this.#changeProject(() => this.session.open(id));
  }

  /**
   * Says to the windows of this browser which project this one has open, and goes on as a folder
   * where another window moved that project into one, see `ProjectFolders.followMove`.
   */
  #keepPresence(host: Host): void {
    const { presence } = host;
    if (!presence) return;
    let entered: { readonly key: string; readonly leave: () => void } | undefined;
    const follow = () => {
      const { key } = this.session;
      if (entered?.key === key) return;
      entered?.leave();
      entered = key === undefined ? undefined : { key, leave: presence.enter(key) };
    };
    this.session.subscribe(follow);
    follow();
    presence.onMoved((project) => void this.projectFolders?.followMove(project));
  }

  /**
   * The cover of the open project, see `CoverMaker`: made while people leave it alone, and sent to
   * the platform for a project of the platform that can be edited.
   */
  #coverMaker(
    covers: CoverStore,
    platform: CoverAccess | undefined,
    library: ProjectLibrary,
  ): CoverMaker {
    const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const sendTo = () => {
      const snapshot = this.cloud?.getSnapshot();
      if (snapshot?.kind !== "linked" || !snapshot.made || this.readOnly.getSnapshot())
        return undefined;
      return snapshot.link.project;
    };
    const uploads = platform && new CoverUploads({ covers, cloud: platform });
    this.#coverChoice = {
      covers,
      ...(uploads && { uploads }),
      ...(platform && { cloud: platform }),
    };
    const maker = new CoverMaker({
      session: this.session,
      covers,
      picture: (shot, signal) => this.#coverPicture(shot, signal, library),
      isBusy: () =>
        this.timeline.getSnapshot().playing ||
        this.videos.busy ||
        this.dialogs.getSnapshot() !== undefined ||
        isHidden(),
      mayLeave: () => !this.videos.busy && !isHidden(),
      sendTo,
      ...(uploads && { uploads }),
    });
    // Once the open project is known to be one of the platform, a cover it did not send yet goes.
    let sending: string | undefined;
    const follow = () => {
      const project = sendTo();
      if (project !== undefined && project !== sending) maker.offerToPlatform();
      sending = project;
    };
    this.cloud?.subscribe(follow);
    this.readOnly.subscribe(follow);
    // An export, or the questions before one, or playing has the computer: a cover being made
    // gives way.
    const giveWay = () => {
      if (
        this.videos.busy ||
        this.dialogs.getSnapshot() !== undefined ||
        this.timeline.getSnapshot().playing
      )
        maker.yieldNow();
    };
    this.timeline.subscribe(giveWay);
    this.videos.subscribe(giveWay);
    this.videos.queue.subscribe(giveWay);
    this.dialogs.subscribe(giveWay);
    return maker;
  }

  /**
   * A frame of the project as it was, as the still export draws it, in a compositor of its own. The
   * files are reached before anything waits: the project may be closed while it draws.
   */
  async #coverPicture(
    { state, key, timeline, seconds }: CoverShot,
    signal: AbortSignal,
    library: ProjectLibrary,
  ): Promise<ImageBitmap> {
    const plan = buildRenderPlan(state, timeline);
    if (!plan) throw new Error("The timeline shows nothing");
    const projects: ProjectLibrary = {
      ...this.projects,
      media: (id) =>
        this.projectFolders?.mediaFor(id, undefined, () => state.assets) ?? library.media(id),
    };
    const site = {
      projects,
      preview: this.preview,
      compositorUrl: this.compositorUrl,
      sceneOrigins: this.sceneOrigins,
      sceneStage: this.sceneStage,
    };
    signal.throwIfAborted();
    const compositor = new ExportCompositor({
      ...exportCompositorOptions(site, state, key, plan),
      unseen: "cover",
    });
    const stop = () => compositor.dispose();
    signal.addEventListener("abort", stop, { once: true });
    try {
      return await compositor.still(seconds);
    } finally {
      signal.removeEventListener("abort", stop);
      compositor.dispose();
    }
  }

  /**
   * The frames AI renders, each look in compositors of its own for the project as the tool read it.
   * It gives way to an export always, to playing as the settings say, and waits for the page to show.
   */
  #frameLooks(images: ChatImageStore | undefined): FrameLooks {
    const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    return new FrameLooks({
      compositor: (state, plan) => {
        const key = this.session.getSnapshot().key ?? "";
        const projects: ProjectLibrary = {
          ...this.projects,
          media: (id) =>
            this.projectFolders?.mediaFor(id, undefined, () => state.assets) ??
            this.projects.media(id),
        };
        const site = {
          projects,
          preview: this.preview,
          compositorUrl: this.compositorUrl,
          sceneOrigins: this.sceneOrigins,
          sceneStage: this.sceneStage,
        };
        return new ExportCompositor({
          ...exportCompositorOptions(site, state, key, plan),
          unseen: "look",
        });
      },
      images: images ?? memoryChatImages(),
      busy: () =>
        this.videos.busy
          ? "exporting"
          : this.timeline.getSnapshot().playing
            ? "playing"
            : undefined,
      waitsForPlayback: () => this.ai.getSnapshot().lookWhilePlaying !== true,
      size: () => this.ai.getSnapshot().lookSize ?? "medium",
      hidden: isHidden,
      watch: (changed) => {
        const stops = [
          this.timeline.subscribe(changed),
          this.videos.subscribe(changed),
          this.videos.queue.subscribe(changed),
          this.ai.subscribe(changed),
        ];
        document.addEventListener("visibilitychange", changed);
        return () => {
          for (const stop of stops) stop();
          document.removeEventListener("visibilitychange", changed);
        };
      },
      // Only where people allowed it already: a look is no reason to ask.
      notify: () => {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        try {
          const notice = new Notification(this.t("chat.notify.look"), {
            body: this.session.store?.getState().manifest.name ?? "AnimaQuill",
            tag: "animaquill-look",
          });
          notice.addEventListener("click", () => {
            window.focus();
            notice.close();
          });
        } catch {
          // Some browsers only make notices from a service worker: the chat says it still.
        }
      },
    });
  }

  /** Whether people can choose the covers of projects here: this browser keeps covers. */
  get canChooseCovers(): boolean {
    return this.#coverChoice !== undefined;
  }

  /**
   * Lets people choose a picture as the cover of a project, see `chooseCover`, and says what went
   * wrong where something did.
   */
  async chooseCover(target: CoverTarget): Promise<void> {
    const options = this.#coverChoice;
    if (!options) return;
    const file = await this.media.chooseFile("image");
    if (!file) return;
    const outcome = await chooseCover(target, file, options);
    if (outcome === "chosen") return;
    this.notifications.push(
      this.t(`start.cover.${outcome}`, {
        file: file.name,
        size: formatSize(file.size),
        interpolation: { escapeValue: false },
      }),
    );
  }

  /** Back to the cover the editor makes, see `restoreAutoCover`. */
  async restoreAutoCover(target: CoverTarget): Promise<void> {
    const options = this.#coverChoice;
    if (!options) return;
    if (!(await restoreAutoCover(target, options)))
      this.notifications.push(this.t("start.cover.restoreFailed"));
  }

  /** The open project, as the uploads of its files go by it, see `UploadProject`. */
  #uploadProject(): UploadProject | undefined {
    const store = this.session.store;
    if (!store) return undefined;
    const key = projectKeyOf(store);
    const cloud = this.cloud?.getSnapshot();
    if (cloud?.kind !== "linked") return { key, store, blocked: "notCloud" };
    const project = cloud.link.project;
    const blocked = ((): UploadBlock | undefined => {
      if (!cloud.made) return "notMade";
      if (!this.#platform?.lfs) return "unsupported";
      if (this.account?.getSnapshot().status === "signedOut") return "signedOut";
      const status = cloud.repository?.getSnapshot().status;
      if (status?.state === "none") return "noRepository";
      if (status?.unusable !== undefined) return "repository";
      if (status?.state === "paused" && LFS_STOPPING.has(status.reason ?? "")) return "repository";
      return undefined;
    })();
    return { key, store, project, ...(blocked && { blocked }) };
  }

  /** Where the files of the open project are read from, for the uploads. */
  #uploadFiles(): UploadFiles | undefined {
    const store = this.session.store;
    if (!store) return undefined;
    const key = projectKeyOf(store);
    const folder = this.projectFolders?.assets();
    const open = this.projectFolders?.getSnapshot().open;
    if (folder && open)
      return {
        read: async (asset, { hash, size }) => {
          const path = this.session.store?.getState().assets?.[asset]?.path;
          if (path === undefined) return { kind: "missing" };
          const status = await open.record.folder.status().catch(() => "ask" as const);
          if (status !== "ready") return { kind: "access" };
          const found = await folder.fileAt(path);
          if (found.kind !== "there") return { kind: found.kind };
          if (found.file.size !== size || !isSameHash(found.hash, hash)) return { kind: "changed" };
          return { kind: "there", file: found.file };
        },
      };
    return {
      read: async (_asset, { hash, size }) => {
        const file = await this.projects
          .media(key)
          .get(hash)
          .catch(() => undefined);
        if (!file) return { kind: "missing" };
        return file.size === size ? { kind: "there", file } : { kind: "changed" };
      },
    };
  }

  /**
   * Where the files that come for the open project go: into its folder where it has one, and into
   * this browser where it is only here.
   */
  #downloadTarget(): DownloadTarget | undefined {
    const store = this.session.store;
    if (!store) return undefined;
    const folder = this.projectFolders?.assets();
    const open = this.projectFolders?.getSnapshot().open;
    if (folder && open)
      return {
        inBrowser: false,
        write: async ({ id, path, hash }, file) => {
          const status = await open.record.folder.status().catch(() => "ask" as const);
          if (status !== "ready") return "access";
          const written = await folder.putDownloaded(path, file, { hash, size: file.size });
          if (written === "written") {
            this.media.filesChanged([path]);
            this.projectFolders?.checkAssetsSoon();
          }
          void id;
          return written;
        },
      };
    return {
      inBrowser: true,
      write: async ({ hash }, file) => {
        await this.media.fileArrived(hash, file);
        return "written";
      },
    };
  }

  /** The uploads follow the open project, and how it stands with the platform and the account. */
  #followUploads(host: Host): void {
    let repository: RepositoryWatch | undefined;
    let stopRepository: (() => void) | undefined;
    let signedIn = host.account?.getSnapshot().status === "signedIn";
    let lfsFor: string | undefined;
    const follow = () => {
      // Signed in again: what failed for that goes on.
      const now = host.account?.getSnapshot().status === "signedIn";
      if (now && !signedIn) {
        void this.uploads.retryAll(["signedOut"]);
        this.downloads.retryAll(["signedOut"]);
      }
      signedIn = now;
      // A project of the platform opened: how the account goes about its large files, as now.
      const opened = this.#uploadProject()?.project;
      if (now && opened !== undefined && opened !== lfsFor) void this.lfsAccount.refresh();
      lfsFor = opened;
      const cloud = this.cloud?.getSnapshot();
      const watch = cloud?.kind === "linked" ? cloud.repository : undefined;
      if (watch !== repository) {
        stopRepository?.();
        repository = watch;
        stopRepository = watch?.subscribe(follow);
      }
      this.uploads.follow();
      this.downloads.follow();
    };
    this.session.subscribe(follow);
    this.cloud?.subscribe(follow);
    host.account?.subscribe(follow);
    this.projectFolders?.subscribe(follow);
    // The folder may be read again, as allowed from wherever: what waited for that goes on.
    this.projectFolders?.subscribe(() => {
      void this.uploads.retryAll(["access"]);
      this.downloads.retryAll(["access"]);
    });
    follow();
  }

  /**
   * Files of assets that this window sends and that are not there yet: closing the project stops
   * them, which people are asked about. Resolves to whether to go on.
   */
  async #settleUploads(): Promise<boolean> {
    const { t } = this;
    const { sender, items } = this.uploads.getSnapshot();
    const going = items.filter(({ phase }) =>
      ["queued", "reading", "sending", "checking", "pushing", "offline", "busy"].includes(phase),
    );
    if (sender !== "here" || going.length === 0) return true;
    const left = going.reduce((all, item) => all + Math.max(0, item.size - item.received), 0);
    return this.dialogs.confirm({
      title: t("storage.uploads.leave.title", { count: going.length, left: formatSize(left) }),
      message: t("storage.uploads.leave.message"),
      confirm: t("storage.uploads.leave.leave"),
      cancel: t("storage.uploads.leave.stay"),
      keep: true,
    });
  }

  /** Whether files of assets go somewhere from this window now, which a reload would stop. */
  get uploading(): boolean {
    const { sender, items } = this.uploads.getSnapshot();
    return (
      sender === "here" &&
      items.some(({ phase }) => ["reading", "sending", "checking", "pushing"].includes(phase))
    );
  }

  /**
   * Puts the files of these assets into the large file storage: at once where people said before
   * that they know what it means, and through the dialog otherwise, which asks them first.
   */
  async putInLfs(assets: readonly string[]): Promise<void> {
    if (!this.lfsAccount.acknowledged) await this.lfsAccount.refresh();
    if (this.lfsAccount.acknowledged) await this.uploads.add(assets);
    else await this.choosePlaces(assets);
  }

  /**
   * Turns on or off that new assets of a project go into the large file storage by themselves.
   * Turned on by someone who never said they know what that means, they are asked first, as the
   * dialog asks before the first upload. Resolves to whether it took.
   */
  async setLfsAuto(project: string, on: boolean): Promise<boolean> {
    const { t } = this;
    if (on && !this.lfsAccount.acknowledged) await this.lfsAccount.refresh();
    if (on && !this.lfsAccount.acknowledged) {
      const knows = await this.dialogs.confirm({
        title: t("storage.uploads.properties.auto"),
        message: t("storage.uploads.dialog.acknowledge"),
        confirm: t("storage.uploads.properties.agree"),
      });
      if (!knows || !(await this.lfsAccount.acknowledge())) return false;
    }
    return this.lfsAccount.setAuto(project, on);
  }

  /** Gives up every file of the open project that is not there yet, once people said so. */
  async giveUpUploads(): Promise<void> {
    const { t } = this;
    const sure = await this.dialogs.confirm({
      title: t("storage.uploads.giveUpAll.title"),
      message: t("storage.uploads.giveUpAll.message"),
      confirm: t("storage.uploads.giveUpAll.confirm"),
      danger: true,
    });
    if (sure) await this.uploads.giveUpAll();
  }

  /** Does what helps with a file that did not get into the large file storage, see `UploadProblem`. */
  async fixUpload(problem: UploadProblem): Promise<void> {
    switch (problem) {
      case "githubQuota":
        window.open(GITHUB_BILLING, "_blank", "noopener,noreferrer");
        return;
      case "changed":
      case "missing":
        this.layout.openPanel("problems");
        return;
      case "access":
        await this.projectFolders?.allowAgain();
        await this.uploads.retryAll(["access"]);
        return;
      case "signedOut":
        await this.signIn();
        return;
      default:
        return;
    }
  }

  /**
   * How far the files a clip shows have come, where this computer lacks one and it is on its way
   * here: the least of them, in percent, or "failed" where one did not come. Undefined for a clip
   * whose files are all here, or that nothing downloads.
   */
  downloadOfClip(clip: ClipState): number | "failed" | undefined {
    const { items } = this.downloads.getSnapshot();
    const state = this.session.store?.getState();
    if (items.length === 0 || !state) return undefined;
    let least: number | "failed" | undefined;
    for (const asset of assetsOfClip(state, clip)) {
      const item = items.find((each) => each.asset === asset);
      if (!item || item.phase === "done") continue;
      if (item.phase === "failed") return "failed";
      const percent = item.size === 0 ? 100 : Math.floor((item.received / item.size) * 100);
      least = least === undefined ? percent : Math.min(least as number, percent);
    }
    return least;
  }

  /**
   * Whether the file of this hash is one this computer lacks and can get from where it is kept, as
   * a download does by itself: the preview says nothing of it, the downloads do.
   */
  isElsewhereFile(hash: string): boolean {
    const state = this.session.store?.getState();
    if (!state) return false;
    for (const [id, file] of this.missingFiles.getSnapshot())
      if (file.elsewhere !== undefined) {
        const own = state.assets?.[id]?.hash;
        if (own !== undefined && isSameHash(own, hash)) return true;
      }
    return false;
  }

  /** Does what a file that did not come asks of people, see `DownloadProblem`. */
  async fixDownload(problem: DownloadProblem | "access"): Promise<void> {
    switch (problem) {
      case "githubQuota":
        window.open(GITHUB_BILLING, "_blank", "noopener,noreferrer");
        return;
      case "occupied":
        this.layout.openPanel("problems");
        return;
      case "access":
        await this.projectFolders?.allowAgain();
        this.downloads.retryAll(["access"]);
        return;
      case "signedOut":
        await this.signIn();
        return;
      case "space":
        // A project only in this browser can go into a folder, where its files take no room of it.
        if (!this.projectFolders?.assets()) await this.moveToFolder();
        return;
      default:
        return;
    }
  }

  /** Back to the start page. */
  async closeProject(): Promise<void> {
    await this.#changeProject();
  }

  /** Notes when each project was opened in this browser, for "最近打开" of the start page. */
  #noteOpened(): void {
    let noted: string | undefined;
    const follow = () => {
      const { key } = this.session;
      if (key === noted) return;
      noted = key;
      if (key !== undefined) void this.organizer.noteOpened(key);
    };
    this.session.subscribe(follow);
    follow();
  }

  /**
   * The address of a window that opens what this browser keeps by `key`, for a link that opens it
   * in a new tab; undefined where the host has none.
   */
  linkTo(key: string): string | undefined {
    return this.#address.linkTo?.(key);
  }

  /**
   * Renames a project from the start page, without opening it, see `renameUnopened`. Whoever
   * asked says what came of it.
   */
  async renameUnopened(key: string, name: string): Promise<RenameOutcome> {
    const outcome = await renameUnopened(key, name, {
      projects: this.projects,
      ...(this.projectFolders && { records: this.projectFolders.projects.records }),
      ...(this.#platform && { links: this.#platform.links }),
      window: this.windowId,
    });
    if (outcome === "renamed") await this.start.refresh();
    return outcome;
  }

  /**
   * Files people dropped on a panel: into the project folder where the project is a folder, those in
   * it already where they are, see `ProjectFolders.droppedFiles`. Has to run in the `drop` event.
   */
  async importDropped(transfer: DataTransfer): Promise<readonly string[]> {
    const folders = this.projectFolders;
    const before = this.#assetCount();
    if (!folders?.assets())
      return this.#imported(await this.media.importFiles([...transfer.files]), before);
    return this.#imported(await this.#importPlaced(await folders.droppedFiles(transfer)), before);
  }

  /** Lets people choose files to bring in, in the project folder where it is one: see `importDropped`. */
  async pickFiles(): Promise<readonly string[]> {
    const folders = this.projectFolders;
    const before = this.#assetCount();
    const placed = folders?.assets() ? await folders.pickFiles() : undefined;
    return this.#imported(
      placed ? await this.#importPlaced(placed) : await this.media.pickFiles(),
      before,
    );
  }

  #noticeOfUploads(...args: Parameters<Notifications["push"]>): void {
    this.#uploadNotices.push(this.notifications.push(...args));
  }

  #assetCount(): number {
    return Object.keys(this.session.store?.getState().assets ?? {}).length;
  }

  /**
   * New assets of a project of the platform (docs/design/asset-storage.md of AnimaQuill Cloud, 4.3
   * and 4.6): into the large file storage by themselves where people turned that on for the
   * project; otherwise they stay here, and people hear once where that is not safe: a large file,
   * a project only in this browser, and the first assets of a new project.
   */
  #imported(ids: readonly string[], before: number): readonly string[] {
    void this.#afterImport(ids, before);
    return ids;
  }

  async #afterImport(ids: readonly string[], before: number): Promise<void> {
    const project = this.#uploadProject();
    if (ids.length === 0 || !project?.project || !this.uploads.available) return;
    const { t } = this;
    const platform = project.project;
    // As the account has it now: the switch may have been turned on on another computer.
    await this.lfsAccount.refresh();
    if (this.lfsAccount.isAuto(platform)) {
      await this.uploads.add(ids);
      return;
    }
    const put = (assets: readonly string[]) => ({
      label: t("storage.uploads.notice.put"),
      run: () => void this.putInLfs(assets),
    });
    const assets = this.session.store?.getState().assets ?? {};
    for (const id of ids) {
      const asset = assets[id];
      if (asset?.size === undefined || asset.size <= LARGE_IMPORT_BYTES) continue;
      this.#noticeOfUploads(
        t("storage.uploads.notice.large", {
          name: asset.name ?? asset.path,
          size: formatSize(asset.size),
          interpolation: { escapeValue: false },
        }),
        {
          stays: true,
          actions: [put([id]), { label: t("storage.uploads.notice.no"), run: () => {} }],
        },
      );
    }
    const cloud = this.cloud?.getSnapshot();
    if (cloud?.kind === "linked" && cloud.local === "browser") {
      this.#noticeOfUploads(t("storage.uploads.notice.browserOnly"), {
        stays: true,
        actions: [put(ids), { label: t("storage.uploads.notice.later"), run: () => {} }],
      });
    } else if (before === 0) void this.#askOnce(`firstImport.${platform}`, "firstImport");
  }

  /**
   * Asks once whether to put the assets of the open project into the large file storage, opening
   * the dialog for that: `what` says why now. Once for each `name`, in this browser.
   */
  async #askOnce(name: string, what: "connected" | "firstImport"): Promise<void> {
    const key = `uploads.asked.${name}`;
    const settings = this.#settings;
    if ((await settings.load(key).catch(() => true)) !== undefined) return;
    await settings.save(key, Date.now()).catch(() => {});
    const { t } = this;
    this.#noticeOfUploads(t(`storage.uploads.notice.${what}`), {
      stays: true,
      actions: [
        { label: t("storage.uploads.notice.choose"), run: () => void this.choosePlaces() },
        { label: t("storage.uploads.notice.later"), run: () => {} },
      ],
    });
  }

  /**
   * The dialog where people choose which assets of the open project go into the large file storage,
   * with these chosen to start with: by default those the project uses. Resolves once it is over.
   */
  async choosePlaces(chosen?: readonly string[]): Promise<void> {
    if (!this.session.store) return;
    void this.lfsAccount.refresh();
    await this.dialogs.places({
      title: this.t("storage.uploads.dialog.title"),
      ...(chosen && { chosen }),
    });
  }

  async #importPlaced({ inside, files, unreadable }: PlacedFiles): Promise<readonly string[]> {
    for (const name of unreadable) {
      this.notifications.push(this.t("notice.mediaUnsupported", { name }));
    }
    return [...(await this.media.importPaths(inside)), ...(await this.media.importFiles(files))];
  }

  /** Asks for a project folder, and opens it: see `ProjectFolders.open`. */
  async openFolder(): Promise<void> {
    await this.projectFolders?.open();
  }

  /**
   * Moves a project of this browser, the open one by default, into a folder on this computer, where
   * the browser can write folders: see `ProjectFolders.moveToFolder`. Resolves to whether it moved.
   */
  async moveToFolder(id = this.session.key): Promise<boolean> {
    if (!this.projectFolders || id === undefined) return false;
    return this.projectFolders.moveToFolder(id);
  }

  /**
   * The open project stays open until the new one is there, so a failure costs nothing. Where the
   * editor is hosted on a platform, what is imported becomes a new project of the platform, see
   * `CloudCreate`: no new project is only in this browser. Only a browser that cannot write folders
   * imports at all: elsewhere a project folder opens as it is.
   */
  async importProject(): Promise<void> {
    if (this.#platform && !this.#projectsHere) {
      await this.#importToCloud();
      return;
    }
    if (!this.#projectsHere && !this.projectFolders) {
      await this.newProject();
      return;
    }
    this.diagnostics.mark("import", { step: "start" });
    const report = await this.transfer
      .importProject()
      .finally(() => this.diagnostics.mark("import", { step: "end" }));
    if (!report) return;
    await this.transfer.warnAboutCode(report);
    await this.openProject(report.id);
    if (this.session.key === report.id) this.#noteImport(report);
    await this.transfer.announceImport(report);
  }

  /** A project folder people choose, as a new project of the platform, see `importProject`. */
  async #importToCloud(): Promise<void> {
    const { account, t } = this;
    // Signing in leaves the page, and what was read goes with it: first that, then the folder.
    if (account) {
      await account.refresh();
      if (account.getSnapshot().status !== "signedIn") {
        const answer = await this.dialogs.choose({
          title: t("newProject.importTitle"),
          message: t("newProject.signInToImport"),
          choices: [{ id: "signIn", label: t("account.signIn"), kind: "primary" }],
        });
        if (answer === "signIn") await this.signIn();
        return;
      }
    }
    this.diagnostics.mark("import", { step: "start" });
    const prepared = await this.transfer
      .prepareImport()
      .finally(() => this.diagnostics.mark("import", { step: "end" }));
    if (!prepared) return;
    const report: ImportReport = {
      id: "",
      name: prepared.project.manifest.name,
      copied: false,
      ...prepared.report,
    };
    // Before it opens, as for every project that comes in: its code runs as soon as it is open.
    await this.transfer.warnAboutCode(report);
    await this.#showCreate(this.#newCreate({ imported: prepared }), prepared);
  }

  /**
   * Opens the project properties of the open project (docs/design/settings-and-properties.md of
   * AnimaQuill Cloud, 5), at a place such as the name, or where they were last. The settings close:
   * one dialog at a time.
   */
  openProjectProperties(place?: ProjectPlace): void {
    if (!this.session.store) return;
    this.palette.close();
    this.settingsNav.close();
    this.projectNav.open(place);
  }

  /** The name of the project, in the project properties, ready to type over. */
  renameProject(): void {
    this.openProjectProperties({ group: "general", depth: 1, item: "name" });
  }

  /**
   * A frame of a project as it would be, small: what the project properties show before and after
   * a change of the shape of the picture. As the cover is drawn, in a compositor of its own.
   */
  async #framePicture(
    state: ProjectState,
    timeline: string,
    seconds: number,
  ): Promise<Blob | undefined> {
    const key = this.session.key;
    if (key === undefined) return undefined;
    const image = await this.#coverPicture(
      { state, key, timeline, seconds },
      new AbortController().signal,
      this.projects,
    );
    try {
      return await canvasEncoder(image)("image/jpeg", 0.8);
    } finally {
      image.close();
    }
  }

  /**
   * Whether files of the project are being read for their hashes: those that come in, which this
   * browser reads whole, and those of a project folder, which get checked.
   */
  #hashing(): boolean {
    const progress = this.projectFolders?.getProgress();
    return (
      this.media.getImporting() > 0 ||
      this.media.getCopying() !== undefined ||
      (progress !== undefined && (progress.reading.length > 0 || progress.checked !== undefined))
    );
  }

  /** Facts about the size of a project, never its names or content. */
  #projectFacts(): unknown {
    const state = this.session.store?.getState();
    if (!state) return undefined;
    const timelines = Object.values(state.timelines);
    return {
      // Where its files are read from: what this browser keeps, or a folder on the disk.
      storage: this.projectFolders?.getSnapshot().open ? "folder" : "browser",
      fps: state.manifest.fps,
      formats: state.manifest.formats.map(({ width, height, fps }) => ({ width, height, fps })),
      tracks: timelines.reduce((sum, { tracks }) => sum + Object.keys(tracks).length, 0),
      clips: timelines.reduce((sum, { clips }) => sum + Object.keys(clips).length, 0),
      // Where clips start and end, because that is where most trouble is.
      layout: timelines.flatMap(({ clips }) =>
        Object.values(clips)
          .slice(0, MAX_REPORTED_CLIPS)
          .map((clip) => ({
            // An id, which is no name, so that a slow frame of a clip can be found here.
            id: clip.id,
            kind: clip.source.kind,
            track: clip.track,
            start: toSeconds(clipStart(clip)),
            end: toSeconds(clipEnd(clip)),
            offset: toSeconds(clipOffset(clip)),
          })),
      ),
      assets: Object.entries(state.assets ?? {}).map(([id, { kind, size, info }]) => {
        // Whether the preview decodes a smaller copy of a video, or the video itself, and how
        // long making that took here: what it takes on this computer.
        const proxy = this.proxies?.stateOf(id)?.kind;
        const proxyMade = this.proxies?.madeOf(id);
        return {
          kind,
          size,
          info,
          ...(proxy !== undefined && { proxy }),
          ...(proxyMade && { proxyMade }),
        };
      }),
      // Which decides whether proxies are used: not at full quality.
      previewQuality: this.previewQuality.getSnapshot().choice,
    };
  }

  get canSendDiagnostics(): boolean {
    return this.#sink !== undefined;
  }

  finishDiagnostics(): void {
    this.diagnostics.finish(this.#projectFacts());
  }

  saveDiagnostics(): void {
    const { report } = this.diagnostics.getSnapshot();
    if (report) saveReport(report, `animaquill-diagnostics-${report.startedAt}`);
  }

  /** For when there is nowhere to send it, or it did not arrive. */
  saveErrorReport(id: number): void {
    const caught = this.errors.getSnapshot().errors.find((error) => error.id === id);
    if (caught) saveReport(caught.report, `animaquill-error-${caught.report.at}`);
  }

  /** Nothing leaves before people press send, with the whole report in front of them. */
  async sendDiagnostics(): Promise<void> {
    const { report } = this.diagnostics.getSnapshot();
    if (!report || !this.#sink) return;
    try {
      this.diagnostics.markSent(await this.#sink.send(report));
    } catch (error) {
      console.warn("The report did not arrive", error);
      this.notifications.push(this.t("diagnostics.sendFailed"));
    }
  }

  /** What there is to know about the editor: the group "关于" of the settings. */
  showAbout(): void {
    this.openSettings({ group: "about", depth: 1 });
  }

  /** Resolves to whether the project was removed. */
  async removeProject(project: ProjectSummary): Promise<boolean> {
    const { t } = this;
    // A list made before the project moved into a folder: what the folder relies on stays, and the
    // folder goes off its own list, see `ProjectFolders.remove`.
    if (await this.#isFolder(project.id)) {
      this.notifications.push(t("folder.move.removeIsFolder", { name: project.name }));
      return false;
    }
    if (this.cloud) {
      // The copy of a project of the platform: what did not get there is nowhere else, and that
      // is looked at first, see `CloudProjects.removeFromBrowser`.
      let isCopy: boolean;
      try {
        isCopy = (await this.cloud.linkOf(project.id)) !== undefined;
      } catch (error) {
        console.warn("Whether the project is one of the platform could not be read", error);
        this.notifications.push(t("notice.projectRemoveFailed"));
        return false;
      }
      if (isCopy) return this.cloud.removeFromBrowser(project.id);
    }
    const confirmed = await this.dialogs.confirm({
      title: t("project.removeTitle", { name: project.name }),
      message: t("project.removeWarning"),
      confirm: t("project.remove"),
      danger: true,
    });
    if (!confirmed) return false;
    try {
      // What its exports kept goes with it, which only happens once this window lets go of them.
      await this.videos.letGoOfProject(project.id);
      await this.session.remove(project.id);
      await this.cloud?.forget(project.id);
      await this.organizer.forget(project.id);
      // What another window is at stays with it, which people should know.
      const left = (await this.videos.unfinished()).filter((each) => each.project === project.id);
      if (left.length > 0) {
        this.notifications.push(t("export.queue.leftElsewhere", { count: left.length }));
      }
      return true;
    } catch (error) {
      console.warn("Project could not be removed", error);
      this.notifications.push(t("notice.projectRemoveFailed"));
      return false;
    }
  }

  /** Whether a project is a folder now, by its record or by what the list of projects says. */
  async #isFolder(id: string): Promise<boolean> {
    if (await this.projectFolders?.projects.records.get(id).catch(() => undefined)) return true;
    const summaries = await this.projects.list().catch(() => []);
    return summaries.some((summary) => summary.id === id && summary.folder === true);
  }

  /**
   * Leaves the open project, then does the next thing. Whatever comes next can fail, and then the
   * start page is a clear place to be. One at a time, because a double click must not open a
   * project twice.
   */
  async #changeProject(next?: () => Promise<unknown>): Promise<void> {
    if (this.#changingProject) return;
    this.#changingProject = true;
    // Only the project that `#reopenProject` opens again is left without a word.
    const quietly = this.#reopening !== undefined && this.#reopening === this.session.key;
    try {
      if (await this.#leaveProject({ quietly })) await next?.();
    } finally {
      this.#changingProject = false;
    }
  }

  /**
   * Saves what is being tried. Without that every change is saved already, and people only press this
   * out of habit, so there is nothing to do but try again what could not be saved, and to keep the
   * browser from answering with its dialog for saving the web page.
   */
  async save(): Promise<void> {
    // A number that is still being typed is part of what people mean to save.
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLInputElement) {
      if (document.activeElement.matches('[role="spinbutton"]')) document.activeElement.blur();
    }
    if (this.trials.getSnapshot().count > 0) this.trials.save();
    else await this.session.trySave();
    // What is saved goes into the project folder right away, not once people stop.
    await this.projectFolders?.flush();
  }

  /** An export is what is saved, which is not what people have been looking at while trying. */
  async #readyToExport(): Promise<boolean> {
    const { t } = this;
    // From now on, what the export reads of a project folder is read again, see `exporting`.
    this.#exportSince = Date.now();
    const { count } = this.trials.getSnapshot();
    if (count === 0) return true;
    const answer = await this.dialogs.choose({
      title: t("trial.exportTitle", { count }),
      message: t("trial.exportMessage"),
      choices: [
        { id: "saved", label: t("trial.exportSaved") },
        { id: "save", label: t("trial.exportWithTrial"), kind: "primary" },
      ],
    });
    return answer !== undefined && (answer !== "save" || this.trials.save());
  }

  async exportProject(): Promise<void> {
    if (!(await this.#readyToExport())) return;
    this.diagnostics.mark("export", { step: "start" });
    try {
      await this.transfer.exportProject();
    } finally {
      this.diagnostics.mark("export", { step: "end" });
    }
  }

  /**
   * The frame at the playhead of the timeline shown, as the export renders it (the files themselves,
   * no proxies, no selection or guides), for the chat. Nothing where no timeline shows.
   */
  async #shootFrame(signal: AbortSignal): Promise<FrameShot | undefined> {
    const store = this.session.store;
    const model = this.timeline.model;
    if (!store || !model) return undefined;
    const state = store.getState();
    const plan = buildRenderPlan(state, model.id);
    if (!plan) return undefined;
    const frame = this.timeline.frame;
    const seconds = frame / model.rate.fps;
    const key = this.session.getSnapshot().key ?? "";
    const projects: ProjectLibrary = {
      ...this.projects,
      media: (id) =>
        this.projectFolders?.mediaFor(id, undefined, () => state.assets) ?? this.projects.media(id),
    };
    const compositor = new ExportCompositor({
      ...exportCompositorOptions(
        {
          projects,
          preview: this.preview,
          compositorUrl: this.compositorUrl,
          sceneOrigins: this.sceneOrigins,
          sceneStage: this.sceneStage,
        },
        state,
        key,
        plan,
      ),
      unseen: "cover",
    });
    const stop = () => compositor.dispose();
    signal.addEventListener("abort", stop, { once: true });
    try {
      const image = await compositor.still(seconds);
      return {
        image,
        frame: {
          timeline: model.id,
          ...(state.timelines[model.id]?.name !== undefined && {
            timelineName: state.timelines[model.id]?.name as string,
          }),
          t: formatTime(frameTime(frame, model.rate)),
          timecode: formatTimecode(frame, model.rate),
        },
      };
    } finally {
      signal.removeEventListener("abort", stop);
      compositor.dispose();
    }
  }

  /** The box of the chat says what it does with the commands; resolves to taking that back. */
  composeWith(handlers: ComposeHandlers): () => void {
    this.#compose = handlers;
    return () => {
      if (this.#compose === handlers) this.#compose = undefined;
    };
  }

  /** The frame at the playhead goes with the next message of the chat, which opens for it. */
  sendFrameToChat(): void {
    const project = this.chat.projectKey;
    const id = this.chat.getSnapshot().id;
    if (project === undefined || id === undefined) return;
    this.layout.openPanel("chat");
    void this.chat.attachments.shoot(project, id, this.t("chat.pictures.frame")).then((refused) => {
      if (refused) this.notifications.push(this.t(`chat.pictures.${refused}`));
    });
    if (!this.#compose) requestAnimationFrame(() => this.#compose?.focus());
  }

  /**
   * Something in the chat points at what a block points to: clips light up on the timeline and in
   * the preview, a moment gets a line on the timeline, a resource lights up in the explorer, lines
   * of code in the code editor. Nothing stops all of it.
   */
  pointAt(href: string | undefined): void {
    const address = href === undefined ? undefined : parseAddress(href);
    const clips = href === undefined ? [] : this.pointing.clipsOf(href);
    this.overlay.point(new Set(clips));
    if (clips.length > 0) this.timeline.flash({ clips: new Set(clips) });
    const model = this.timeline.model;
    this.timeline.pointAt(
      address?.kind === "time" && (address.timeline ?? model?.id) === model?.id
        ? toSeconds(parseTime(address.t))
        : undefined,
    );
    const state = this.session.store?.getState();
    const key = this.session.getSnapshot().key;
    const resource =
      address?.kind === "object" && state && key !== undefined
        ? (["asset", "scene", "sound"] as const).find((kind) =>
            kind === "asset"
              ? entryOf(state.assets, address.id)
              : kind === "scene"
                ? entryOf(state.scenes, address.id)
                : entryOf(state.sounds, address.id),
          )
        : undefined;
    this.explorer.point(
      resource && address?.kind === "object" && key !== undefined
        ? projectResourceId(key, resource, address.id)
        : undefined,
    );
    this.code.pointLines(
      address?.kind === "file" && address.from !== undefined
        ? { path: address.path, from: address.from, to: address.to ?? address.from }
        : undefined,
    );
  }

  /** Goes to what a block of the chat points at: a moment, a clip, a key, a resource, lines. */
  goToRef(href: string): boolean {
    const address = parseAddress(href);
    const state = this.session.store?.getState();
    const model = this.timeline.model;
    if (!address || !state) return false;
    switch (address.kind) {
      case "time": {
        if (!model) return false;
        if (address.timeline !== undefined && address.timeline !== model.id)
          return this.#elsewhere(address.timeline);
        this.timeline.seek(frameAt(toSeconds(parseTime(address.t)), model.rate));
        this.layout.openPanel("timeline");
        return true;
      }
      case "keyframe": {
        if (address.timeline !== undefined && address.timeline !== model?.id)
          return this.#elsewhere(address.timeline);
        if (!this.goToUse({ timeline: address.timeline ?? model?.id ?? "", clip: address.id }))
          return false;
        this.layout.openPanel("keyframes");
        return true;
      }
      case "object": {
        for (const kind of ["asset", "scene", "sound"] as const) {
          const found =
            kind === "asset"
              ? entryOf(state.assets, address.id)
              : kind === "scene"
                ? entryOf(state.scenes, address.id)
                : entryOf(state.sounds, address.id);
          if (!found) continue;
          const key = this.session.getSnapshot().key ?? "";
          const id = projectResourceId(key, kind, address.id);
          if (this.canRevealResource(id)) this.revealResource(id);
          return true;
        }
        const timeline = address.timeline ?? model?.id;
        if (timeline === undefined) return false;
        if (timeline !== model?.id) return this.#elsewhere(timeline);
        const on = state.timelines[timeline];
        if (on?.markers[address.id])
          return this.goToObject({ kind: "marker", id: address.id, timeline });
        if (on?.tracks[address.id])
          return this.goToObject({ kind: "track", id: address.id, timeline });
        return this.goToUse({ timeline, clip: address.id });
      }
      case "objects": {
        const timeline = address.timeline ?? model?.id;
        if (timeline === undefined || !model) return false;
        if (model.id !== timeline) return this.#elsewhere(timeline);
        const clips = address.ids.filter((id) => model.boxes.has(id));
        if (clips.length === 0) return false;
        this.goToUse({ timeline, clip: clips[0] as string });
        for (const clip of clips.slice(1)) this.timeline.addToSelection(clip);
        return true;
      }
      case "file":
        return this.showCode(
          address.path,
          address.from === undefined ? undefined : { line: address.from },
        );
    }
  }

  /**
   * A block points at another timeline than the one the editor shows, which is always the first of
   * the project for now: people hear so, rather than nothing happening.
   */
  #elsewhere(timeline: string): boolean {
    const name = this.session.store?.getState().timelines[timeline]?.name ?? timeline;
    this.notifications.push(
      this.t("chat.refs.otherTimeline", { name, interpolation: { escapeValue: false } }),
    );
    return false;
  }

  /**
   * Tells people when a task of the chat ends or AI asks them while the page is in the background:
   * a notice of the browser where they allowed it, and "●" before the title of the tab until they
   * come back.
   */
  #followChatForNotices(): void {
    if (typeof document === "undefined") return;
    let watched: { conversation: unknown; stop: () => void } | undefined;
    const follow = () => {
      const { conversation } = this.chat.getSnapshot();
      if (watched?.conversation === conversation) return;
      watched?.stop();
      if (!conversation) {
        watched = undefined;
        return;
      }
      let last = conversation.getSnapshot().last;
      const stop = conversation.subscribe(() => {
        const now = conversation.getSnapshot().last;
        if (now === last) return;
        last = now;
        // People who stopped it know it is over.
        if (!now || now.end === "stopped" || document.visibilityState !== "hidden") return;
        const entries = conversation.getSnapshot().entries;
        const asking = askingIn(entries);
        this.#notice(asking ? "asking" : now.end === "failed" ? "failed" : "done");
      });
      watched = { conversation, stop };
    };
    this.chat.subscribe(follow);
    follow();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.attention.set(false);
    });
  }

  /** Whether the chat has something for people that they have not seen: "●" before the title. */
  readonly attention = new Flag();

  #notice(what: "done" | "asking" | "failed"): void {
    this.attention.set(true);
    if (typeof Notification === "undefined" || Notification.permission === "denied") return;
    // The browser is asked the first time there is something to tell, not before.
    if (Notification.permission === "default") {
      if (this.#askedToNotify) return;
      this.#askedToNotify = true;
      void Notification.requestPermission().then(
        (answer) => answer === "granted" && this.#showNotice(what),
        () => {},
      );
      return;
    }
    this.#showNotice(what);
  }

  #showNotice(what: "done" | "asking" | "failed"): void {
    const name = this.session.store?.getState().manifest.name ?? "AnimaQuill";
    try {
      const notice = new Notification(this.t(`chat.notify.${what}`), {
        body: name,
        tag: "animaquill-chat",
      });
      notice.addEventListener("click", () => {
        window.focus();
        this.layout.openPanel("chat");
        notice.close();
      });
    } catch {
      // Some browsers only make notices from a service worker: the title says it still.
    }
  }

  async exportFrame(): Promise<void> {
    if (await this.#readyToExport()) await this.stills.run();
  }

  async exportVideo(): Promise<void> {
    if (await this.#readyToExport()) await this.videos.start();
  }

  /** Resolves to false when people would rather stay with what they are trying out. */
  async #settleTrial(): Promise<boolean> {
    await this.trials.settle();
    const { count } = this.trials.getSnapshot();
    if (count === 0) return !this.trials.notKept || this.#leaveWithoutKeeping();
    const { t } = this;
    const answer = await this.dialogs.choose({
      title: t("trial.leaveTitle", { count }),
      message: t("trial.leaveMessage"),
      choices: [
        { id: "discard", label: t("trial.discard"), kind: "danger" },
        { id: "keep", label: t("trial.keep") },
        { id: "save", label: t("trial.save"), kind: "primary" },
      ],
    });
    if (answer === undefined) return false;
    if (answer === "save") return this.trials.save();
    if (answer === "discard") {
      this.trials.discard();
      return true;
    }
    return (await this.trials.settle()) || this.#leaveWithoutKeeping();
  }

  #leaveWithoutKeeping(): Promise<boolean> {
    const { t } = this;
    return this.dialogs.confirm({
      title: t("trial.notKeptTitle"),
      message: t("trial.notKeptMessage"),
      confirm: t("project.leaveAnyway"),
      danger: true,
    });
  }

  /**
   * Opens the open project again from what this browser keeps of it, without asking people: what
   * they were trying out and the code they did not save stay where windows keep them, and come back
   * as after a reload. For a project whose log went on another working copy of the platform, see
   * `CloudProjects`: what this window has is of the copy before.
   */
  async #reopenProject(key: string): Promise<void> {
    if (this.session.key !== key || this.#changingProject || this.#reopening !== undefined) return;
    // What this window changed and could not put into the log, as the log went on the new copy
    // under it, goes into that log first, while this window still has it, see
    // `CloudProjects.carryOver`. Where it cannot, people are asked as ever before what could not
    // be saved is left behind: until they say, it is still here.
    // Once: another word that the log went on meanwhile finds this under way.
    this.#reopening = key;
    let isQuiet = true;
    try {
      const left = (await this.session.trySave()) ? [] : [...this.session.unsavedUpdates];
      if (left.length > 0)
        isQuiet = ((await this.cloud?.carryOver(key, left)) ?? "failed") !== "failed";
      if (this.session.key !== key) return;
      // As people open it, folder or not: that leaves the project as it is first, quietly or not,
      // see `#changeProject`.
      if (!isQuiet) this.#reopening = undefined;
      await this.openProject(key);
    } finally {
      this.#reopening = undefined;
    }
  }

  /** The project that `#reopenProject` opens again, while it does. */
  #reopening: string | undefined;

  /**
   * Resolves to false when people would rather stay with what could not be saved. `quietly`: asks
   * nothing, see `#reopenProject`.
   */
  async #leaveProject({ quietly = false } = {}): Promise<boolean> {
    if (!this.session.store) return true;
    if (quietly) {
      // Kept where windows keep them, as for a reload.
      await Promise.all([this.trials.settle(), this.drafts.settle()]);
    } else {
      if (!(await this.#settleCode())) return false;
      if (!(await this.#settleTrial())) return false;
      if (!(await this.#settleUploads())) return false;
    }
    // Quietly, the project could not be changed meanwhile: what its log does not have is not there.
    if (!(await this.session.trySave()) && !quietly) {
      const { t } = this;
      const leave = await this.dialogs.confirm({
        title: t("project.unsavedTitle"),
        message: t("project.unsavedWarning"),
        confirm: t("project.leaveAnyway"),
        danger: true,
      });
      if (!leave) return false;
    }
    // A cover of the project as people leave it, while its files can still be read.
    this.covers?.leaving();
    await this.layout.detach();
    this.cloudPanel.set(false);
    this.projectNav.close();
    // What is on its way stops where it is, and goes on the next time the project is open.
    await this.uploads.close();
    await this.downloads.close();
    for (const id of this.#uploadNotices.splice(0)) this.notifications.dismiss(id);
    // What the platform does not have yet stays in the log, for whoever syncs next.
    await this.cloud?.close();
    // The folder gets what is waiting first, and the next window gets to write it.
    await this.projectFolders?.close();
    await this.session.close();
    return true;
  }

  #registerProjectActions(): void {
    const isOpen = () => this.session.store !== undefined;
    this.actions.register({
      id: "project.new",
      title: (t) => t("project.new"),
      run: () => void this.newProject(),
      menu: { name: "file", group: "open" },
    });
    if (this.projectFolders) {
      this.actions.register({
        id: "project.openFolder",
        title: (t) => t("folder.openAction"),
        run: () => void this.openFolder(),
        menu: { name: "file", group: "open" },
      });
    }
    this.actions.register({
      id: "project.close",
      title: (t) => t("project.close"),
      run: () => void this.closeProject(),
      menu: { name: "file", group: "open" },
      enabled: isOpen,
    });
    this.actions.register({
      id: "project.save",
      title: (t) => t("project.save"),
      run: () => void this.save(),
      keys: ["mod+s"],
      menu: { name: "file", group: "project" },
      enabled: isOpen,
    });
    this.actions.register({
      id: "project.properties",
      title: (t) => t("projectProps.action"),
      run: () => this.openProjectProperties(),
      keys: ["mod+alt+,"],
      menu: { name: "file", group: "project" },
      enabled: isOpen,
      visible: isOpen,
    });
    for (const group of PROJECT_GROUPS) {
      this.actions.register({
        id: `project.properties.${group}`,
        title: (t) => t("projectProps.openGroup", { group: t(`projectProps.groups.${group}`) }),
        run: () => this.openProjectProperties({ group, depth: 1 }),
        enabled: isOpen,
        visible: isOpen,
      });
    }
    this.actions.register({
      id: "project.rename",
      title: (t) => t("project.renameAction"),
      run: () => this.renameProject(),
      menu: { name: "file", group: "project" },
      enabled: isOpen,
      visible: isOpen,
    });
    this.actions.register({
      id: "project.importMedia",
      title: (t) => t("assets.importAction"),
      run: () => void this.pickFiles(),
      menu: { name: "file", group: "project" },
      enabled: isOpen,
    });
    this.actions.register({
      id: "project.frameRate",
      title: (t) => t("project.frameRate"),
      run: () => this.openProjectProperties({ group: "picture", depth: 1, item: "fps" }),
      menu: { name: "file", group: "project" },
      enabled: isOpen,
      visible: isOpen,
    });
    // Where projects are folders, opening one takes the place of bringing one into the browser.
    if (!this.projectFolders) {
      this.actions.register({
        id: "project.importFolder",
        title: (t) => t("transfer.importAction"),
        run: () => void this.importProject(),
        menu: { name: "file", group: "folder" },
      });
    } else {
      const folders = this.projectFolders;
      const canMove = () => isOpen() && !folders.holds(this.session.key);
      this.actions.register({
        id: "project.moveToFolder",
        title: (t) => t("folder.move.action"),
        run: () => void this.moveToFolder(),
        menu: { name: "file", group: "folder" },
        // Only a project of the browser: a folder is where a project goes already, and the menu
        // of one does not have this at all.
        enabled: canMove,
        visible: canMove,
      });
    }
    this.actions.register({
      id: "project.exportFolder",
      title: (t) => t("transfer.exportAction"),
      run: () => void this.exportProject(),
      menu: { name: "file", group: "folder" },
      enabled: isOpen,
    });
    const cloud = this.cloud;
    if (cloud) {
      // The menu has two ways to the platform: its projects, and how the open one stands with it.
      // Everything else is in the panel, and in the command palette by the ids it always had.
      this.actions.register({
        id: "cloud.open",
        title: (t) => t("cloud.openAction"),
        run: () => void this.openCloudProjects(),
        menu: { name: "file", group: "cloud" },
      });
      this.actions.register({
        id: "cloud.panel",
        title: (t) => t("cloud.panelAction"),
        run: () => this.showCloud(),
        menu: { name: "file", group: "cloud" },
        enabled: isOpen,
      });
      this.actions.register({
        id: "cloud.saveAsLocal",
        title: (t) => t("cloud.saveAsLocalAction"),
        run: () => void this.saveAsLocal(),
        menu: { name: "file", group: "cloud" },
        // A copy of a project of the platform, into a folder.
        enabled: () => this.projectFolders !== undefined && cloud.isOnPlatform,
        visible: () => this.projectFolders !== undefined && cloud.getSnapshot().kind === "linked",
      });
      this.actions.register({
        id: "cloud.delete",
        title: (t) => t("cloud.panel.action.deleteCloud"),
        run: () => void this.deleteFromCloud(),
        enabled: () => cloud.canDelete,
      });
      this.actions.register({
        id: "cloud.recheck",
        title: (t) => t("cloud.panel.action.recheck"),
        run: () => void cloud.recheck(),
        enabled: () => cloud.unusable !== undefined,
      });
      this.actions.register({
        id: "cloud.connect",
        title: (t) => t("cloud.connectAction"),
        run: () => void this.connectToCloud(),
        enabled: () => cloud.canConnect && cloud.savesToGitHub && this.cloudKnown.getSnapshot(),
      });
      this.actions.register({
        id: "cloud.disconnect",
        title: (t) => t("cloud.disconnectAction"),
        run: () => void cloud.disconnect(),
        // A project of the platform that is only in this browser goes out of the browser instead.
        enabled: () => {
          const snapshot = cloud.getSnapshot();
          return snapshot.kind === "linked" && snapshot.local === "folder";
        },
      });
      // Only where the platform saves projects to GitHub: another repository, or the first one
      // for a project from before every project of the platform had one.
      if (cloud.savesToGitHub)
        this.actions.register({
          id: "cloud.saveToGitHub",
          title: (t) =>
            t(
              cloud.canSwitchRepository
                ? "cloud.panel.action.switchRepository"
                : "cloud.panel.action.chooseRepository",
            ),
          run: () =>
            void (cloud.canSwitchRepository ? cloud.switchRepository() : this.connectToCloud()),
          enabled: () => cloud.canDisconnect,
        });
    }
    this.actions.register({
      id: "project.exportVideo",
      title: (t) => t("export.video.action"),
      run: () => void this.exportVideo(),
      menu: { name: "file", group: "export" },
      enabled: isOpen,
    });
    this.actions.register({
      id: "project.exportFrame",
      title: (t) => t("export.frameAction"),
      run: () => void this.exportFrame(),
      menu: { name: "file", group: "export" },
      enabled: isOpen,
    });
  }

  /** The buttons of the box of the chat as commands, and sending the frame from the preview. */
  #registerChatActions(): void {
    const hasProject = () => this.session.store !== undefined && this.timeline.model !== undefined;
    const viaBox = (which: keyof ComposeHandlers) => () => {
      // The box takes it right away where it is there, else once the chat shows.
      if (this.#compose) {
        this.#compose[which]();
        return;
      }
      this.layout.openPanel("chat");
      requestAnimationFrame(() => this.#compose?.[which]());
    };
    // Option and a letter types a character on a Mac: there it is with Control as well.
    const keys = (letter: string) => [
      this.keybindings.platform === "mac" ? `ctrl+alt+${letter}` : `alt+${letter}`,
    ];
    this.actions.register({
      id: "chat.insertTime",
      title: (t) => t("chat.action.insertTime"),
      run: viaBox("time"),
      keys: keys("t"),
      scope: "chat",
      enabled: hasProject,
    });
    this.actions.register({
      id: "chat.insertSelection",
      title: (t) => t("chat.action.insertSelection"),
      run: viaBox("selection"),
      keys: keys("o"),
      scope: "chat",
      enabled: () => hasProject() && this.pointing.getSnapshot().count > 0,
    });
    this.actions.register({
      id: "chat.sendFrame",
      title: (t) => t("chat.action.sendFrame"),
      run: () => this.sendFrameToChat(),
      keys: keys("s"),
      scope: "chat",
      enabled: hasProject,
    });
    this.actions.register({
      id: "chat.addPicture",
      title: (t) => t("chat.action.addPicture"),
      run: viaBox("picture"),
      enabled: () => this.session.store !== undefined,
    });
  }

  #registerCodeActions(): void {
    const hasSelection = () => this.files.getSnapshot().selected !== undefined;
    this.actions.register({
      id: "code.save",
      title: (t) => t("code.saveFile"),
      // Saved code is a change of the project like any other: the folder gets it right away.
      run: () => void this.code.save().then(() => this.projectFolders?.flush()),
      keys: ["mod+s"],
      scope: "code",
      // What shows may be the details of a resource, with the file behind them.
      enabled: () => this.code.getSnapshot().active !== undefined && this.resourcePages.showsCode,
    });
    this.actions.register({
      id: "files.rename",
      title: (t) => t("files.renameAction"),
      run: () => void this.files.rename(),
      keys: ["f2"],
      scope: "files",
      enabled: hasSelection,
    });
    this.actions.register({
      id: "files.remove",
      title: (t) => t("files.removeAction"),
      run: () => void this.files.remove(),
      keys: ["delete"],
      scope: "files",
      enabled: hasSelection,
    });
  }

  /**
   * The settings, with or without a project: from the file menu, `Ctrl+,` and the palette, which
   * also goes to each group by its name.
   */
  #registerSettingsActions(): void {
    this.actions.register({
      id: "settings.open",
      title: (t) => t("settings.title"),
      run: () => this.openSettings(),
      keys: ["mod+,"],
      menu: { name: "file", group: "settings", title: (t) => t("settings.menu") },
    });
    for (const group of SETTINGS_GROUPS) {
      this.actions.register({
        id: `settings.open.${group}`,
        title: (t) => t("settings.openGroup", { group: t(`settings.groups.${group}`) }),
        run: () => this.openSettings({ group, depth: 1 }),
        visible: () => this.#hasSettingsGroup(group),
      });
    }
  }

  /** Whether the settings have a group now: the account's only with a platform, see `visibleGroups`. */
  #hasSettingsGroup(group: string): boolean {
    if (group === "account") return this.account !== undefined;
    if (group === "cloud")
      return (
        this.cloudSync.getSnapshot().available && this.account?.getSnapshot().status === "signedIn"
      );
    return true;
  }

  #registerHelpActions(): void {
    this.actions.register({
      id: "help.localAi",
      title: (t) => t("localAi.action"),
      run: () => this.openLocalAiGuide(),
      menu: { name: "help", group: "localAi" },
    });
    this.actions.register({
      id: "help.about",
      title: (t) => t("about.title"),
      run: () => this.showAbout(),
      menu: { name: "help", group: "about" },
    });
    this.actions.register({
      id: "help.diagnostics",
      title: (t) => t("panel.performance.title"),
      run: () => this.layout.openPanel("performance"),
      menu: { name: "help", group: "diagnostics" },
    });
  }

  #stepThroughHistory(step: (store: ProjectStore) => UndoResult): void {
    const { store } = this.session;
    if (!store) return;
    this.tellUndo(step(store));
  }

  /** What taking back or doing again came to, when there is something to say about it. */
  tellUndo(result: UndoResult): void {
    const message = this.#undoMessage(result);
    if (message !== undefined) this.notifications.push(message);
  }

  #undoMessage(result: UndoResult): string | undefined {
    if (result.ok) {
      return result.obstacle ? this.t(`notice.undoPartly.${result.obstacle}`) : undefined;
    }
    if (result.error.obstacle) return this.t(`notice.undoBlocked.${result.error.obstacle}`);
    return commandFailedText(this.t, result.error);
  }

  /**
   * Takes back what people did here, one step after the other as undo does, up to and with
   * `operation`. What is tried out goes back in between where it came in, as with undo. Stops at
   * the first step that is kept from going back, and says why.
   */
  undoTo(operation: Operation): string | undefined {
    const { store } = this.session;
    if (!store || !this.operations.canUndoTo(operation)) return undefined;
    // Each round takes one step, of the store or of what is tried out, and there are only so many.
    for (let round = 0; round < 2000 && store.lastStep >= operation.step; round++) {
      if (this.trials.undoesFirst) {
        this.trials.undo();
        continue;
      }
      const before = store.lastStep;
      const result = store.undo();
      const message = this.#undoMessage(result);
      if (message !== undefined) return message;
      if (store.lastStep === before) break;
    }
    return undefined;
  }

  /** Does again what people here took back last, as redo does. */
  redoLast(): string | undefined {
    const { store } = this.session;
    if (!store) return undefined;
    if (this.trials.redoesFirst) {
      this.trials.redo();
      return undefined;
    }
    return this.#undoMessage(store.redo());
  }

  /** Takes back an AI task or a batch of files as a whole, or does it again. */
  undoOperation(operation: Operation, direction: "undo" | "redo"): string | undefined {
    const { store } = this.session;
    if (!store || operation.origin === undefined) return undefined;
    // What came from the folder goes back the way its notice takes it, which keeps the folder's.
    if (operation.source === "folder" && direction === "undo") {
      if (this.projectFolders?.undoBatch(operation.origin)) return undefined;
    }
    const result =
      direction === "undo"
        ? store.undoOrigin(operation.origin)
        : store.redoOrigin(operation.origin);
    return this.#undoMessage(result);
  }

  #registerEditActions(): void {
    this.actions.register({
      id: "edit.undo",
      title: (t) => t("edit.undo"),
      run: () => {
        if (this.trials.undoesFirst) this.trials.undo();
        else this.#stepThroughHistory((store) => store.undo());
      },
      keys: ["mod+z"],
      menu: { name: "edit", group: "history" },
      enabled: () => this.session.store?.canUndo === true || this.trials.canUndo,
    });
    this.actions.register({
      id: "edit.redo",
      title: (t) => t("edit.redo"),
      run: () => {
        if (this.trials.redoesFirst) this.trials.redo();
        else this.#stepThroughHistory((store) => store.redo());
      },
      keys: ["mod+shift+z", "mod+y"],
      menu: { name: "edit", group: "history" },
      enabled: () => this.session.store?.canRedo === true || this.trials.canRedo,
    });
    this.actions.register({
      id: "trial.compare",
      title: (t) => t("trial.action.compare"),
      run: () => this.trials.toggleCompare(),
      menu: { name: "edit", group: "trial" },
      enabled: () => this.trials.getSnapshot().count > 0,
    });
    this.actions.register({
      id: "trial.discard",
      title: (t) => t("trial.action.discard"),
      run: () => this.trials.discard(),
      menu: { name: "edit", group: "trial" },
      enabled: () => {
        const { count, setAside } = this.trials.getSnapshot();
        return count + setAside > 0;
      },
    });
  }

  /** The layout menu: every layout, then what can be done with the current one. */
  #registerLayoutActions(isOpen: () => boolean): void {
    let made: { from: readonly LayoutChoice[]; actions: readonly Action[] } | undefined;
    this.actions.provide(() => {
      const { layouts } = this.layout.getSnapshot();
      if (made?.from !== layouts) {
        made = { from: layouts, actions: this.#layoutActions(layouts, isOpen) };
      }
      return made.actions;
    });
    const isCustom = () => isOpen() && this.layout.isCustom(this.layout.getSnapshot().layout);
    this.actions.register({
      id: "layout.saveAs",
      title: (t) => t("layout.saveAs"),
      run: () => void this.#saveLayoutAs(),
      menu: { name: "layout", group: "manage" },
      enabled: isOpen,
    });
    this.actions.register({
      id: "layout.rename",
      title: (t) => t("layout.renameAction"),
      run: () => void this.#renameLayout(),
      menu: { name: "layout", group: "manage", title: (t) => t("layout.rename") },
      enabled: isCustom,
    });
    this.actions.register({
      id: "layout.delete",
      title: (t) => t("layout.deleteAction"),
      run: () => void this.#deleteLayout(),
      menu: { name: "layout", group: "manage", title: (t) => t("layout.delete") },
      enabled: isCustom,
    });
    this.actions.register({
      id: "layout.reset",
      title: (t) => t("layout.reset"),
      run: () => this.layout.resetLayout(),
      menu: { name: "layout", group: "reset" },
      enabled: isOpen,
    });
  }

  /** One for each layout. The first nine have keys, by their place in the list. */
  #layoutActions(layouts: readonly LayoutChoice[], isOpen: () => boolean): readonly Action[] {
    return layouts.map((choice, index) => ({
      id: `layout.switch.${choice.id}`,
      title: (t) => t("action.switchLayout", { layout: choice.title(t) }),
      run: () => this.layout.switchLayout(choice.id),
      ...(index < 9 && { keys: [`alt+shift+${index + 1}`] }),
      menu: { name: "layout", group: choice.custom ? "custom" : "presets", title: choice.title },
      selected: () => this.layout.getSnapshot().layout === choice.id,
      enabled: isOpen,
    }));
  }

  #layoutTitle(): string {
    const { layout, layouts } = this.layout.getSnapshot();
    return layouts.find((choice) => choice.id === layout)?.title(this.t) ?? "";
  }

  async #saveLayoutAs(): Promise<void> {
    const { t } = this;
    const count = this.layout.getSnapshot().layouts.filter((choice) => choice.custom).length;
    const name = await this.dialogs.prompt({
      title: t("layout.saveAsTitle"),
      value: t("layout.newName", { number: count + 1 }),
      hint: t("layout.saveAsHint"),
      confirm: t("layout.saveAsConfirm"),
    });
    if (name !== undefined) this.layout.saveAs(name);
  }

  async #renameLayout(): Promise<void> {
    const { t } = this;
    const { layout } = this.layout.getSnapshot();
    if (!this.layout.isCustom(layout)) return;
    const name = await this.dialogs.prompt({
      title: t("layout.renameTitle"),
      value: this.#layoutTitle(),
      confirm: t("layout.renameConfirm"),
    });
    if (name !== undefined) this.layout.rename(layout, name);
  }

  async #deleteLayout(): Promise<void> {
    const { t } = this;
    const { layout, layouts } = this.layout.getSnapshot();
    if (!this.layout.isCustom(layout)) return;
    const first = layouts[0]?.title(t) ?? "";
    const confirmed = await this.dialogs.confirm({
      title: t("layout.deleteTitle", { name: this.#layoutTitle() }),
      message: t("layout.deleteMessage", { first }),
      confirm: t("layout.deleteConfirm"),
      danger: true,
    });
    if (confirmed) this.layout.remove(layout);
  }

  #registerViewActions(): void {
    const isOpen = () => this.session.store !== undefined;
    this.#registerLayoutActions(isOpen);
    this.actions.register({
      id: "view.commandPalette",
      title: (t) => t("palette.title"),
      run: () => this.palette.toggle(),
      keys: ["mod+shift+p", "f1"],
      menu: { name: "view", group: "commands" },
      palette: false,
    });
    for (const panel of this.panels.list()) {
      this.actions.register({
        id: `view.open.${panel.type}`,
        title: (t) => t("action.openPanel", { panel: panel.title(t) }),
        run: () => this.layout.openPanel(panel.type),
        ...(panel.keys ? { keys: panel.keys } : {}),
        menu: { name: "view", group: `panels.${panel.area}`, title: panel.title },
        enabled: isOpen,
      });
    }
  }
}

/** What the box of the chat does with the commands of the palette, see `Workbench.composeWith`. */
export interface ComposeHandlers {
  readonly time: () => void;
  readonly selection: () => void;
  readonly picture: () => void;
  readonly focus: () => void;
}
