import type { DiagnosticsSink, Host, ProjectLibrary } from "@animaquill/host";
import type { TFunction } from "i18next";
import {
  clipEnd,
  clipOffset,
  clipStart,
  projectFrameRate,
  type ProjectStore,
  type UndoResult,
} from "@animaquill/core";
import type { SceneStatus } from "@animaquill/render";
import type { SceneProblem } from "@animaquill/scene";
import { toSeconds } from "@animaquill/schema";
import type { ProjectSummary } from "@animaquill/host";
import { CodeDocuments, type CodePlace } from "../code/documents.ts";
import { CodeDrafts } from "../code/drafts.ts";
import { FileActions } from "../code/files.ts";
import { ErrorReports } from "../diagnostics/errors.ts";
import { namesIn } from "../diagnostics/privacy.ts";
import { DiagnosticsRecorder, deviceFacts } from "../diagnostics/recorder.ts";
import { registerKeyframeActions } from "../keyframes/actions.ts";
import { KeyframeEditor } from "../keyframes/editor.ts";
import { StillExport } from "../export/still.ts";
import { VideoExport } from "../export/video.ts";
import { MediaLibrary } from "../media/library.ts";
import { MadeSounds, SoundMaker } from "../media/sounds.ts";
import { describeProblem, describeStatus, sceneClipName } from "../preview/problems.ts";
import { ProblemList, severityOf, type ListedProblem } from "../problems/list.ts";
import { PreviewFrameRate } from "../preview/frame-rate.ts";
import { PreviewQuality } from "../preview/quality.ts";
import { PreviewStatus } from "../preview/status.ts";
import { TrialSession } from "../properties/trial.ts";
import { PropertyWriter } from "../properties/writer.ts";
import { registerTimelineActions } from "../timeline/actions.ts";
import { TimelineEditor } from "../timeline/editor.ts";
import type { ImportReport } from "../transfer/import.ts";
import { ProjectTransfer } from "../transfer/transfer.ts";
import { ActionRegistry } from "./actions.ts";
import { Dialogs } from "./dialogs.ts";
import { InputMode } from "./input-mode.ts";
import { KeybindingService } from "./keybindings.ts";
import type { Platform } from "./keys.ts";
import { LayoutController, type WorkspaceDefinition } from "./layout.ts";
import { Notifications } from "./notifications.ts";
import { CommandPalette } from "./palette.ts";
import { ProjectSession } from "./session.ts";
import { PanelRegistry, type PanelDefinition } from "./panels.ts";

export interface WorkbenchOptions {
  readonly host: Host;
  readonly t: TFunction;
  readonly version: string;
  readonly platform: Platform;
  readonly panels: readonly PanelDefinition[];
  readonly workspaces: readonly WorkspaceDefinition[];
  readonly compositorUrl: string;
  readonly sceneOrigins?: readonly string[];
  readonly sceneStage?: "plain";
  /** For tests: how long code gets to make a sound. */
  readonly soundLimitMs?: number;
}

/** The editor's frame, without any rendering, so that it can be tested on its own. */
const MAX_REPORTED_CLIPS = 500;

function saveReport(report: unknown, name: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, undefined, 2)]));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replaceAll(":", "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export class Workbench {
  readonly t: TFunction;
  readonly version: string;
  readonly panels = new PanelRegistry();
  readonly actions = new ActionRegistry();
  readonly notifications = new Notifications();
  readonly layout: LayoutController;
  readonly keybindings: KeybindingService;
  readonly palette: CommandPalette;
  readonly dialogs = new Dialogs();
  readonly session: ProjectSession;
  readonly timeline: TimelineEditor;
  readonly trials: TrialSession;
  readonly properties: PropertyWriter;
  readonly keyframes: KeyframeEditor;
  readonly input: InputMode;
  readonly media: MediaLibrary;
  readonly sounds: MadeSounds;
  readonly transfer: ProjectTransfer;
  readonly stills: StillExport;
  readonly videos: VideoExport;
  readonly diagnostics: DiagnosticsRecorder;
  /** Errors of the editor while this page is open, and whether people want to report them. */
  readonly errors: ErrorReports;
  readonly #sink: DiagnosticsSink | undefined;
  readonly projects: ProjectLibrary;
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
  readonly problems = new ProblemList();
  readonly code: CodeDocuments;
  readonly files: FileActions;
  readonly drafts: CodeDrafts;
  #changingProject = false;

  constructor(options: WorkbenchOptions) {
    const { host, t, version, platform, panels, workspaces, compositorUrl } = options;
    this.t = t;
    this.version = version;
    this.projects = host.projects;
    this.diagnostics = new DiagnosticsRecorder(version);
    const sink = host.diagnostics;
    this.#sink = sink;
    let names: { state: unknown; found: Set<string> } | undefined;
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
        if (!names || names.state !== state) names = { state, found: namesIn(state) };
        return names.found;
      },
      device: deviceFacts,
    });
    this.compositorUrl = compositorUrl;
    this.sceneOrigins = options.sceneOrigins ?? [];
    this.sceneStage = options.sceneStage;
    this.preview = new PreviewStatus({
      problem: (clip, revision, problem, first) =>
        this.#noteSceneProblem(clip, revision, problem, first),
      stopped: (clip, status) => this.#noteStoppedScene(clip, status),
      revisions: (revisions) => this.problems.keepRevisions(revisions),
      restarted: () => this.notifications.push(t("preview.restarted")),
    });
    this.layout = new LayoutController(host.settings, host.windowMemory, workspaces, {
      restoreFailed: () => this.notifications.push(t("notice.layoutRestoreFailed")),
      saveFailed: () => this.notifications.push(t("notice.layoutSaveFailed")),
    });
    this.keybindings = new KeybindingService(host.settings, this.actions, platform, {
      restoreFailed: () => this.notifications.push(t("notice.keybindingsRestoreFailed")),
      saveFailed: () => this.notifications.push(t("notice.keybindingsSaveFailed")),
    });
    this.layout.subscribe(() => this.keybindings.notePanel(this.layout.getSnapshot().active));
    this.palette = new CommandPalette(host.settings, this.actions);
    this.session = new ProjectSession(host.projects, host.address, {
      createFailed: () => this.notifications.push(t("notice.projectCreateFailed")),
      notFound: () => this.notifications.push(t("notice.projectNotFound")),
      openFailed: () => this.notifications.push(t("notice.projectOpenFailed")),
      tooNew: () => this.notifications.push(t("notice.projectTooNew")),
      damaged: () => this.notifications.push(t("notice.projectDamaged")),
      saveFailed: () => this.notifications.push(t("notice.projectSaveFailed")),
      saveRecovered: () => this.notifications.push(t("notice.projectSaveRecovered")),
    });
    let open = this.session.store;
    this.session.subscribe(() => {
      if (this.session.store !== open) this.problems.clear();
      open = this.session.store;
    });
    this.code = new CodeDocuments(
      this.session,
      {
        commandFailed: (message) => this.notifications.push(t("notice.commandFailed", { message })),
        closedRemoved: (path) => this.notifications.push(t("code.closedRemoved", { path })),
      },
      {
        unsaved: (path) => this.#askAboutUnsaved(path),
        overwrite: (path) => this.#askAboutOverwriting(path),
      },
    );
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
      host.projects,
      {
        unsupported: (name) => this.notifications.push(t("notice.mediaUnsupported", { name })),
        tooLarge: (name) => this.notifications.push(t("notice.mediaTooLarge", { name })),
        saveFailed: (name) => this.notifications.push(t("notice.mediaSaveFailed", { name })),
        commandFailed: (message) => this.notifications.push(t("notice.commandFailed", { message })),
      },
      compositorUrl,
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
      projects: host.projects,
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
      projects: host.projects,
      session: this.session,
      dialogs: this.dialogs,
      notifications: this.notifications,
      t,
    });
    this.timeline = new TimelineEditor(this.session, host.windowMemory, host.settings, {
      commandFailed: (message) => this.notifications.push(t("notice.commandFailed", { message })),
      sceneName: (number) => t("scene.newName", { number }),
      soundName: (number) => t("sound.newName", { number }),
      soundWords: () => ({ duration: t("sound.param.duration"), seed: t("sound.param.seed") }),
    });
    this.frameRate = new PreviewFrameRate(this.timeline);
    this.previewQuality = new PreviewQuality(host.settings, this.frameRate);
    this.stills = new StillExport({
      session: this.session,
      timeline: this.timeline,
      projects: host.projects,
      folders: host.folders,
      preview: this.preview,
      dialogs: this.dialogs,
      notifications: this.notifications,
      t,
      compositorUrl,
      sceneOrigins: this.sceneOrigins,
      sceneStage: this.sceneStage,
    });
    this.videos = new VideoExport({
      session: this.session,
      timeline: this.timeline,
      projects: host.projects,
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
    });
    // What nobody went on with for long goes, whichever project it is of.
    void this.videos.cleanUp();
    this.trials = new TrialSession(this.session, this.timeline, host.trials, host.settings, {
      commandFailed: (message) => this.notifications.push(t("notice.commandFailed", { message })),
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
    this.properties = new PropertyWriter(this.session, this.timeline, this.trials, {
      commandFailed: (message) => this.notifications.push(t("notice.commandFailed", { message })),
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
      },
    );
    this.#keepTrail();
    for (const panel of panels) this.panels.register(panel);
    this.#registerProjectActions();
    this.#registerCodeActions();
    this.#registerEditActions();
    this.#registerViewActions();
    this.#registerHelpActions();
    registerTimelineActions(this.actions, this.timeline, this.keyframes.inTimeline);
    registerKeyframeActions(this.actions, this.keyframes, this.timeline);
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
    const { line, ...withoutLine } = problem;
    const { file, column } = problem;
    this.problems.noteScene(clip, revision, {
      severity: severityOf(problem),
      // The list says where it is by itself.
      text: describeProblem(t, withoutLine),
      ...(file !== undefined && { file }),
      ...(line !== undefined && { line }),
      ...(column !== undefined && { column }),
      origin: name,
    });
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
    const origin = this.#clipName(clip);
    const text = describeStatus(this.t, origin, status);
    this.problems.noteStopped(clip, { severity: "error", text, origin });
  }

  /** Goes to where a problem is, if the project has that file. */
  goToProblem({ file, line, column }: ListedProblem): void {
    if (file === undefined) return;
    const place = line === undefined ? undefined : { line, ...(column && { column }) };
    if (!this.showCode(file, place)) {
      this.notifications.push(this.t("problems.notInProject", { file }));
    }
  }

  /**
   * From the list of files. Keys go by the panel in use, so a file that only gets shown leaves the
   * list in use, for going on with it. A new file is there to be written in.
   */
  #showFile(path: string, edit: boolean): void {
    this.showCode(path, edit ? { line: 1 } : undefined);
    if (!edit && this.layout.getSnapshot().visible.has("files")) this.layout.openPanel("files");
  }

  /** Resolves to whether the project has that file. */
  showCode(path: string, place?: CodePlace): boolean {
    const opened = this.code.open(path, place);
    if (opened) this.layout.openPanel("code");
    return opened;
  }

  /** An import says all of this once. The list is where it can still be found afterwards. */
  #noteImport({ missing, damaged, skipped, lost, warnings }: ImportReport): void {
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
      ...said("damaged", damaged),
      ...said("skipped", skipped),
      ...warnings.map(({ severity, message, file, path }) => ({
        severity,
        text: message,
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
      this.timeline.load(),
      this.keyframes.load(),
      this.input.load(),
      this.previewQuality.load(),
      this.trials.load(),
    ]);
    await this.session.restore();
  }

  async newProject(): Promise<void> {
    const { t } = this;
    const name = await this.dialogs.prompt({
      title: t("project.nameLabel"),
      value: t("project.defaultName"),
      confirm: t("project.create"),
    });
    if (name) await this.#changeProject(() => this.session.create(name));
  }

  async openProject(id: string): Promise<void> {
    await this.#changeProject(() => this.session.open(id));
  }

  /** Back to the start page. */
  async closeProject(): Promise<void> {
    await this.#changeProject();
  }

  /** The open project stays open until the new one is there, so a failure costs nothing. */
  async importProject(): Promise<void> {
    this.diagnostics.mark("import", { step: "start" });
    const report = await this.transfer
      .importProject()
      .finally(() => this.diagnostics.mark("import", { step: "end" }));
    if (!report) return;
    await this.transfer.warnAboutCode(report);
    await this.openProject(report.id);
    if (this.session.store?.getState().manifest.id === report.id) this.#noteImport(report);
    await this.transfer.announceImport(report);
  }

  async renameProject(): Promise<void> {
    const { store } = this.session;
    if (!store) return;
    const { t } = this;
    const name = await this.dialogs.prompt({
      title: t("project.nameLabel"),
      value: store.getState().manifest.name,
      confirm: t("project.rename"),
    });
    if (!name) return;
    const result = store.execute({ type: "project.rename", params: { name } });
    if (!result.ok) {
      this.notifications.push(t("notice.commandFailed", { message: result.error.message }));
    }
  }

  /** Sets the rate of editing. Formats keep the rates they are exported at. */
  applyFrameRate(fps: string): boolean {
    const result = this.session.store?.execute({
      type: "project.setFrameRate",
      params: { fps: fps.trim() },
    });
    return result?.ok === true;
  }

  /** Asks for a frame rate that is not on the list. */
  async setFrameRate(): Promise<void> {
    const { store } = this.session;
    if (!store) return;
    const { t } = this;
    const fps = await this.dialogs.prompt({
      title: t("project.frameRateLabel"),
      value: projectFrameRate(store.getState().manifest),
      confirm: t("project.frameRateConfirm"),
    });
    if (fps && !this.applyFrameRate(fps)) this.notifications.push(t("notice.frameRateInvalid"));
  }

  /** Facts about the size of a project, never its names or content. */
  #projectFacts(): unknown {
    const state = this.session.store?.getState();
    if (!state) return undefined;
    const timelines = Object.values(state.timelines);
    return {
      fps: state.manifest.fps,
      formats: state.manifest.formats.map(({ width, height, fps }) => ({ width, height, fps })),
      tracks: timelines.reduce((sum, { tracks }) => sum + Object.keys(tracks).length, 0),
      clips: timelines.reduce((sum, { clips }) => sum + Object.keys(clips).length, 0),
      // Where clips start and end, because that is where most trouble is.
      layout: timelines.flatMap(({ clips }) =>
        Object.values(clips)
          .slice(0, MAX_REPORTED_CLIPS)
          .map((clip) => ({
            kind: clip.source.kind,
            track: clip.track,
            start: toSeconds(clipStart(clip)),
            end: toSeconds(clipEnd(clip)),
            offset: toSeconds(clipOffset(clip)),
          })),
      ),
      assets: Object.values(state.assets ?? {}).map(({ kind, size, info }) => ({
        kind,
        size,
        info,
      })),
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

  async showAbout(): Promise<void> {
    const { t, version } = this;
    await this.dialogs.confirm({
      title: t("about.title"),
      message: t("about.message", { version }),
      confirm: t("about.close"),
      noticeOnly: true,
    });
  }

  /** Resolves to whether the project was removed. */
  async removeProject(project: ProjectSummary): Promise<boolean> {
    const { t } = this;
    const confirmed = await this.dialogs.confirm({
      title: t("project.removeTitle", { name: project.name }),
      message: t("project.removeWarning"),
      confirm: t("project.remove"),
      danger: true,
    });
    if (!confirmed) return false;
    try {
      await this.session.remove(project.id);
      return true;
    } catch (error) {
      console.warn("Project could not be removed", error);
      this.notifications.push(t("notice.projectRemoveFailed"));
      return false;
    }
  }

  /**
   * Leaves the open project, then does the next thing. Whatever comes next can fail, and then the
   * start page is a clear place to be. One at a time, because a double click must not open a
   * project twice.
   */
  async #changeProject(next?: () => Promise<unknown>): Promise<void> {
    if (this.#changingProject) return;
    this.#changingProject = true;
    try {
      if (await this.#leaveProject()) await next?.();
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
  }

  /** An export is what is saved, which is not what people have been looking at while trying. */
  async #readyToExport(): Promise<boolean> {
    const { t } = this;
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

  /** Resolves to false when people would rather stay with what could not be saved. */
  async #leaveProject(): Promise<boolean> {
    if (!this.session.store) return true;
    if (!(await this.#settleCode())) return false;
    if (!(await this.#settleTrial())) return false;
    if (!(await this.session.trySave())) {
      const { t } = this;
      const leave = await this.dialogs.confirm({
        title: t("project.unsavedTitle"),
        message: t("project.unsavedWarning"),
        confirm: t("project.leaveAnyway"),
        danger: true,
      });
      if (!leave) return false;
    }
    await this.layout.detach();
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
      id: "project.rename",
      title: (t) => t("project.renameAction"),
      run: () => void this.renameProject(),
      menu: { name: "file", group: "project" },
      enabled: isOpen,
    });
    this.actions.register({
      id: "project.importMedia",
      title: (t) => t("assets.importAction"),
      run: () => void this.media.pickFiles(),
      menu: { name: "file", group: "project" },
      enabled: isOpen,
    });
    this.actions.register({
      id: "project.frameRate",
      title: (t) => t("project.frameRate"),
      run: () => void this.setFrameRate(),
      menu: { name: "file", group: "project" },
      enabled: isOpen,
    });
    this.actions.register({
      id: "project.importFolder",
      title: (t) => t("transfer.importAction"),
      run: () => void this.importProject(),
      menu: { name: "file", group: "folder" },
    });
    this.actions.register({
      id: "project.exportFolder",
      title: (t) => t("transfer.exportAction"),
      run: () => void this.exportProject(),
      menu: { name: "file", group: "folder" },
      enabled: isOpen,
    });
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

  #registerCodeActions(): void {
    const hasSelection = () => this.files.getSnapshot().selected !== undefined;
    this.actions.register({
      id: "code.save",
      title: (t) => t("code.saveFile"),
      run: () => void this.code.save(),
      keys: ["mod+s"],
      scope: "code",
      enabled: () => this.code.getSnapshot().active !== undefined,
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

  #registerHelpActions(): void {
    this.actions.register({
      id: "help.about",
      title: (t) => t("about.title"),
      run: () => void this.showAbout(),
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
    const result = step(store);
    if (result.ok) {
      if (result.obstacle) this.notifications.push(this.t(`notice.undoPartly.${result.obstacle}`));
    } else if (result.error.obstacle) {
      this.notifications.push(this.t(`notice.undoBlocked.${result.error.obstacle}`));
    } else {
      this.notifications.push(this.t("notice.commandFailed", { message: result.error.message }));
    }
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

  #registerViewActions(): void {
    const isOpen = () => this.session.store !== undefined;
    this.actions.register({
      id: "view.commandPalette",
      title: (t) => t("palette.title"),
      run: () => this.palette.toggle(),
      keys: ["mod+shift+p", "f1"],
      menu: { name: "view", group: "commands" },
      palette: false,
    });
    this.layout.workspaces.forEach((workspace, index) => {
      this.actions.register({
        id: `view.workspace.${workspace.id}`,
        title: (t) => t("action.switchWorkspace", { workspace: workspace.title(t) }),
        run: () => this.layout.switchWorkspace(workspace.id),
        keys: [`alt+${index + 1}`],
        menu: { name: "view", group: "workspaces", title: workspace.title },
        selected: () => this.layout.getSnapshot().workspace === workspace.id,
        enabled: isOpen,
      });
    });
    this.actions.register({
      id: "view.resetLayout",
      title: (t) => t("view.resetLayout"),
      run: () => this.layout.resetWorkspace(),
      menu: { name: "view", group: "layout" },
      enabled: isOpen,
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
