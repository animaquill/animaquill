import {
  orderedSections,
  projectFrameRate,
  timelineLength,
  versionsAbout,
  type ProjectState,
  type ProjectStore,
} from "@animaquill/core";
import { CURRENT_FORMAT_VERSION, formatTime, parseTime, toSeconds } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { Copy, Lock, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useWorkbench } from "../app/context.ts";
import { Choice, Segmented } from "../settings/parts.tsx";
import settings from "../settings/Settings.module.css";
import { frameSeconds } from "../timeline/frames.ts";
import {
  FRAME_RATES,
  SAFE_AREAS,
  formatPresets,
  freeId,
  isFrameRate,
  rateLabel,
  ratioOf,
  safeAreaChoice,
  sameRate,
  type SafeAreaChoice,
} from "./changes.ts";
import {
  CommitText,
  ColorPick,
  Facts,
  Group,
  Heading,
  Row,
  Small,
  length,
  moment,
} from "./parts.tsx";
import type { Locked } from "./ProjectDialog.tsx";
import styles from "./Project.module.css";

type Manifest = ProjectState["manifest"];
type ProjectFormat = Manifest["formats"][number];
type Tag = NonNullable<Manifest["tags"]>[number];
type Credit = NonNullable<Manifest["credits"]>[number];
type Language = Manifest["languages"][number];

interface GroupProps {
  readonly store: ProjectStore;
  readonly locked: Locked;
}

const noSubscription = () => () => {};
const nothing = () => undefined;

// ---- 常规

/** Where the name of the project does not go, as the name row says: its repository and folder. */
function useElsewhere(): { repository?: string; folder?: string } {
  const { cloud, projectFolders } = useWorkbench();
  const snapshot = useSyncExternalStore(
    cloud?.subscribe ?? noSubscription,
    cloud?.getSnapshot ?? nothing,
  );
  const folders = useSyncExternalStore(
    projectFolders?.subscribe ?? noSubscription,
    projectFolders?.getSnapshot ?? nothing,
  );
  const watch = snapshot?.kind === "linked" ? snapshot.repository : undefined;
  const archive = useSyncExternalStore(
    watch?.subscribe ?? noSubscription,
    watch?.getSnapshot ?? nothing,
  );
  const repository =
    snapshot?.kind === "linked"
      ? (archive?.status?.repository?.fullName ?? snapshot.link.repository?.fullName ?? undefined)
      : undefined;
  const folder = folders?.open?.record.folder.name;
  return {
    ...(repository !== undefined && { repository }),
    ...(folder !== undefined && { folder }),
  };
}

/** When the project was made and last changed, as far as anything here knows. */
function useTimes(): { created?: number; updated?: number } {
  const workbench = useWorkbench();
  const [times, setTimes] = useState<{ created?: number; updated?: number }>({});
  useEffect(() => {
    let live = true;
    void (async () => {
      const summary = await workbench.cloud?.summaryOfOpen();
      const key = workbench.session.key;
      const kept = summary
        ? undefined
        : (await workbench.projects.list().catch(() => [])).find((each) => each.id === key);
      if (!live) return;
      const created = summary?.createdAt;
      const updated = summary?.updatedAt ?? kept?.updatedAt;
      setTimes({
        ...(created !== undefined && { created }),
        ...(updated !== undefined && { updated }),
      });
    })();
    return () => {
      live = false;
    };
  }, [workbench]);
  return times;
}

export function GeneralGroup({ store, locked }: GroupProps) {
  const { projectEdits, notifications } = useWorkbench();
  const { t } = useTranslation();
  const state = useProject(store);
  const elsewhere = useElsewhere();
  const times = useTimes();
  if (!state) return null;
  const { manifest } = state;
  const disabled = locked.locked;
  const nameHelp = [
    elsewhere.repository !== undefined &&
      t("projectProps.general.nameRepository", { repository: elsewhere.repository }),
    elsewhere.folder !== undefined &&
      t("projectProps.general.nameFolder", { folder: elsewhere.folder }),
  ].filter(Boolean);
  return (
    <Group title={t("projectProps.groups.general")}>
      <Row
        id="name"
        name={t("projectProps.general.name")}
        help={
          nameHelp.length > 0
            ? t("projectProps.general.nameHelpElsewhere", {
                where: nameHelp.join(t("projectProps.and")),
                interpolation: { escapeValue: false },
              })
            : t("projectProps.general.nameHelp")
        }
      >
        <CommitText
          label={t("project.nameLabel")}
          value={manifest.name}
          disabled={disabled}
          width={260}
          onCommit={(name) => projectEdits.rename(name)}
        />
      </Row>
      <Row
        id="description"
        name={t("projectProps.general.description")}
        help={t("projectProps.general.descriptionHelp")}
        wide
        below={
          <CommitText
            label={t("projectProps.general.description")}
            value={manifest.description ?? ""}
            multiline
            disabled={disabled}
            className={styles.wideText}
            placeholder={t("projectProps.general.descriptionPlaceholder")}
            onCommit={(description) => projectEdits.setDescription(description)}
          />
        }
      />
      <CreditsRow credits={manifest.credits ?? []} disabled={disabled} />
      <TagsRow tags={manifest.tags ?? []} disabled={locked.why === "platform"} />
      <Heading>{t("projectProps.readOnly")}</Heading>
      <Row id="id" name={t("projectProps.general.id")} help={t("projectProps.general.idHelp")}>
        <code className={styles.code}>{manifest.id}</code>
        <Small
          label={t("projectProps.general.copyId")}
          onClick={() =>
            void navigator.clipboard
              .writeText(manifest.id)
              .then(() => notifications.push(t("projectProps.general.copied")))
              .catch(() => notifications.push(t("projectProps.general.copyFailed")))
          }
        >
          <Copy size={12} aria-hidden /> {t("projectProps.general.copy")}
        </Small>
      </Row>
      <Row id="formatVersion" name={t("projectProps.general.formatVersion")}>
        <span className={settings.value}>
          {t("projectProps.general.formatVersionValue", {
            version: manifest.formatVersion,
            current: CURRENT_FORMAT_VERSION,
          })}
        </span>
      </Row>
      <Row
        id="times"
        name={t("projectProps.general.times")}
        help={times.created === undefined ? t("projectProps.general.noCreated") : undefined}
      >
        <Facts
          items={[
            [t("projectProps.general.created"), moment(times.created)],
            [t("projectProps.general.updated"), moment(times.updated)],
          ]}
        />
      </Row>
    </Group>
  );
}

/** Who did what: rows of a role and a name; one without a name waits here until it has one. */
function CreditsRow({ credits, disabled }: { credits: readonly Credit[]; disabled: boolean }) {
  const { projectEdits } = useWorkbench();
  const { t } = useTranslation();
  const [rows, setRows] = useState<readonly Credit[]>(credits);
  // What others change comes in, as the rows of the project.
  const [was, setWas] = useState(credits);
  if (was !== credits) {
    setWas(credits);
    setRows(credits);
  }
  const commit = (next: readonly Credit[]) => {
    setRows(next);
    const whole = next.filter((credit) => credit.name.trim() !== "");
    if (JSON.stringify(whole) === JSON.stringify(credits)) return true;
    return projectEdits.setCredits(
      whole.map(({ role, name }) => ({ role: role.trim(), name: name.trim() })),
    );
  };
  const change = (index: number, field: keyof Credit, value: string) =>
    commit(rows.map((row, at) => (at === index ? { ...row, [field]: value } : row)));
  return (
    <Row
      id="credits"
      name={t("projectProps.general.credits")}
      help={t("projectProps.general.creditsHelp")}
      wide
      below={
        <div className={styles.list} data-testid="project-credits">
          {rows.map((credit, index) => (
            <div key={index} className={styles.listRow}>
              <CommitText
                label={t("projectProps.general.creditRole", { number: index + 1 })}
                value={credit.role}
                placeholder={t("projectProps.general.rolePlaceholder")}
                disabled={disabled}
                width={140}
                onCommit={(value) => change(index, "role", value)}
              />
              <CommitText
                label={t("projectProps.general.creditName", { number: index + 1 })}
                value={credit.name}
                placeholder={t("projectProps.general.namePlaceholder")}
                disabled={disabled}
                className={styles.grow}
                onCommit={(value) => change(index, "name", value)}
              />
              <Small
                label={t("projectProps.general.removeCredit", { number: index + 1 })}
                disabled={disabled}
                onClick={() => commit(rows.filter((_, at) => at !== index))}
              >
                <Trash2 size={12} aria-hidden />
              </Small>
            </div>
          ))}
          <div>
            <Small disabled={disabled} onClick={() => setRows([...rows, { role: "", name: "" }])}>
              <Plus size={12} aria-hidden /> {t("projectProps.general.addCredit")}
            </Small>
          </div>
        </div>
      }
    />
  );
}

/**
 * The tags of the project, each with its colour, and whether it locks the project: only people
 * change them, and locking and unlocking are asked about first (5.2). They stay changeable while a
 * tag locks the project, as that is the way to unlock it.
 */
function TagsRow({ tags, disabled }: { tags: readonly Tag[]; disabled: boolean }) {
  const { projectEdits, dialogs } = useWorkbench();
  const { t } = useTranslation();
  const set = (next: readonly Tag[]) => void projectEdits.setTags(next);
  const change = (index: number, tag: Tag) =>
    set(tags.map((each, at) => (at === index ? tag : each)));
  const add = async () => {
    const name = await dialogs.prompt({
      title: t("projectProps.tags.addTitle"),
      confirm: t("projectProps.tags.add"),
    });
    if (name) set([...tags, { name }]);
  };
  return (
    <Row
      id="tags"
      name={t("projectProps.general.tags")}
      help={t("projectProps.general.tagsHelp")}
      wide
      below={
        <div className={styles.list} data-testid="project-tags">
          {tags.length === 0 && (
            <span className={settings.note}>{t("projectProps.tags.none")}</span>
          )}
          {tags.map((tag, index) => (
            <div key={`${index}:${tag.name}`} className={styles.listRow} data-tag={tag.name}>
              <ColorPick
                label={t("projectProps.tags.color", { name: tag.name })}
                value={tag.color ?? "#8b949e"}
                disabled={disabled}
                onPick={(color) => change(index, { ...tag, color })}
              />
              <CommitText
                label={t("projectProps.tags.name", { number: index + 1 })}
                value={tag.name}
                disabled={disabled}
                className={styles.grow}
                onCommit={(name) => {
                  if (name.trim() === "") return false;
                  change(index, { ...tag, name: name.trim() });
                  return true;
                }}
              />
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={tag.locked === true}
                  disabled={disabled}
                  onChange={(event) => {
                    const { locked: _, ...rest } = tag;
                    change(index, event.target.checked ? { ...rest, locked: true } : rest);
                  }}
                />
                <Lock size={12} aria-hidden /> {t("projectProps.tags.locks")}
              </label>
              <Small
                label={t("projectProps.tags.remove", { name: tag.name })}
                disabled={disabled}
                onClick={() => set(tags.filter((_, at) => at !== index))}
              >
                <Trash2 size={12} aria-hidden />
              </Small>
            </div>
          ))}
          <div>
            <Small disabled={disabled} onClick={() => void add()}>
              <Plus size={12} aria-hidden /> {t("projectProps.tags.add")}
            </Small>
          </div>
        </div>
      }
    />
  );
}

// ---- 画面和帧率

/** A format being changed or added, with its fields as typed. */
interface FormatDraft {
  readonly id: string;
  /** Undefined for a new one. */
  readonly index: number | undefined;
  readonly name: string;
  readonly width: string;
  readonly height: string;
  readonly fps: string;
}

const draftOf = (format: ProjectFormat, index: number | undefined): FormatDraft => ({
  id: format.id,
  index,
  name: format.name,
  width: String(format.width),
  height: String(format.height),
  fps: format.fps,
});

const isSize = (text: string) => /^\d+$/.test(text.trim()) && Number(text) > 0;

export function PictureGroup({ store, locked }: GroupProps) {
  const { projectEdits } = useWorkbench();
  const { t } = useTranslation();
  const state = useProject(store);
  const [draft, setDraft] = useState<FormatDraft>();
  if (!state) return null;
  const { manifest } = state;
  const { formats } = manifest;
  const disabled = locked.locked;
  const fps = projectFrameRate(manifest);

  const save = async (edit: FormatDraft) => {
    if (!isSize(edit.width) || !isSize(edit.height) || !isFrameRate(edit.fps)) return;
    const base = edit.index === undefined ? undefined : formats[edit.index];
    const format: ProjectFormat = {
      ...base,
      id: edit.id,
      name: edit.name.trim() || t("projectProps.formats.unnamed"),
      width: Number(edit.width),
      height: Number(edit.height),
      fps: edit.fps.trim(),
    };
    const next =
      edit.index === undefined
        ? [...formats, format]
        : formats.map((each, at) => (at === edit.index ? format : each));
    if (await projectEdits.setFormats(next)) setDraft(undefined);
  };
  const addPreset = (
    preset: Omit<ProjectFormat, "id" | "name">,
    kind: "landscape" | "vertical" | "square" | "custom",
  ) => {
    const taken = formats.map(({ id }) => id);
    setDraft(
      draftOf(
        { ...preset, id: freeId(kind, taken), name: t(`projectProps.formats.preset.${kind}`) },
        undefined,
      ),
    );
  };
  const presets = formatPresets(fps);
  const versionsOf = (format: string) => versionsAbout(state, { format }).length;

  return (
    <Group title={t("projectProps.groups.picture")}>
      <Row
        id="formats"
        name={t("projectProps.formats.title")}
        help={t("projectProps.formats.help")}
        wide
        below={
          <div className={styles.table} role="table" aria-label={t("projectProps.formats.title")}>
            {formats.map((format, index) =>
              draft?.index === index ? (
                <FormatEditor
                  key={format.id}
                  draft={draft}
                  onChange={setDraft}
                  onSave={(edit) => void save(edit)}
                  onCancel={() => setDraft(undefined)}
                />
              ) : (
                <div key={format.id} className={styles.tableRow} role="row" data-format={format.id}>
                  <span className={styles.cellName} role="cell">
                    {format.name}
                    {index === 0 && (
                      <span className={styles.badge}>{t("projectProps.formats.master")}</span>
                    )}
                  </span>
                  <span className={styles.cellMono} role="cell">
                    {format.width} × {format.height}
                  </span>
                  <span className={styles.cellMuted} role="cell">
                    {ratioOf(format.width, format.height)}
                  </span>
                  <span role="cell">
                    {t("projectProps.formats.fps", { fps: rateLabel(format.fps) })}
                  </span>
                  <span className={styles.cellNote} role="cell">
                    {index === 0
                      ? t("projectProps.formats.masterNote")
                      : versionsOf(format.id) > 0
                        ? t("projectProps.formats.versionsNote")
                        : ""}
                  </span>
                  <span className={styles.cellActions} role="cell">
                    {index > 0 && (
                      <Small
                        disabled={disabled}
                        onClick={() =>
                          void projectEdits.setFormats([
                            format,
                            ...formats.filter((_, at) => at !== index),
                          ])
                        }
                      >
                        {t("projectProps.formats.makeMaster")}
                      </Small>
                    )}
                    <Small
                      disabled={disabled}
                      label={t("projectProps.formats.editLabel", { name: format.name })}
                      onClick={() => setDraft(draftOf(format, index))}
                    >
                      {t("projectProps.formats.edit")}
                    </Small>
                    <Small
                      danger
                      disabled={disabled || formats.length === 1}
                      label={t("projectProps.formats.removeLabel", { name: format.name })}
                      onClick={() =>
                        void projectEdits.setFormats(formats.filter((_, at) => at !== index))
                      }
                    >
                      <Trash2 size={12} aria-hidden />
                    </Small>
                  </span>
                </div>
              ),
            )}
            {draft?.index === undefined && draft && (
              <FormatEditor
                draft={draft}
                onChange={setDraft}
                onSave={(edit) => void save(edit)}
                onCancel={() => setDraft(undefined)}
              />
            )}
            <div className={styles.adds}>
              <span className={settings.note}>{t("projectProps.formats.add")}</span>
              {(["landscape", "vertical", "square"] as const).map((kind, at) => (
                <Small key={kind} disabled={disabled} onClick={() => addPreset(presets[at]!, kind)}>
                  <Plus size={12} aria-hidden /> {t(`projectProps.formats.preset.${kind}`)}
                </Small>
              ))}
              <Small
                disabled={disabled}
                onClick={() => addPreset({ width: 1280, height: 720, fps }, "custom")}
              >
                <Plus size={12} aria-hidden /> {t("projectProps.formats.preset.custom")}
              </Small>
            </div>
          </div>
        }
      />
      <FrameRateRow fps={fps} disabled={disabled} />
      <BackgroundRow state={state} disabled={disabled} />
      <SafeAreaRow formats={formats} disabled={disabled} />
    </Group>
  );
}

function FormatEditor(props: {
  readonly draft: FormatDraft;
  readonly onChange: (draft: FormatDraft) => void;
  readonly onSave: (draft: FormatDraft) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { draft, onChange } = props;
  const field = (
    key: "name" | "width" | "height" | "fps",
    label: string,
    valid: boolean,
    width: number,
  ) => (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        className={styles.text}
        aria-label={label}
        aria-invalid={!valid || undefined}
        spellCheck={false}
        value={draft[key]}
        style={{ width }}
        onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            props.onSave(draft);
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
      />
    </label>
  );
  const valid = isSize(draft.width) && isSize(draft.height) && isFrameRate(draft.fps);
  return (
    <div className={styles.editor} data-testid="format-editor">
      {field("name", t("projectProps.formats.name"), true, 140)}
      {field("width", t("projectProps.formats.width"), isSize(draft.width), 72)}
      {field("height", t("projectProps.formats.height"), isSize(draft.height), 72)}
      {field("fps", t("projectProps.formats.exportFps"), isFrameRate(draft.fps), 90)}
      {isSize(draft.width) && isSize(draft.height) && (
        <span className={styles.cellMuted}>
          {ratioOf(Number(draft.width), Number(draft.height))}
        </span>
      )}
      <span className={styles.cellActions}>
        <Small onClick={props.onCancel}>{t("dialog.cancel")}</Small>
        <button
          type="button"
          className={settings.primary}
          disabled={!valid}
          onClick={() => props.onSave(draft)}
        >
          {t("projectProps.formats.save")}
        </button>
      </span>
    </div>
  );
}

/** The rate of editing: the common ones to pick, or one of people's own (5.3). */
function FrameRateRow({ fps, disabled }: { fps: string; disabled: boolean }) {
  const { projectEdits } = useWorkbench();
  const { t } = useTranslation();
  const known = FRAME_RATES.find((each) => sameRate(each.value, fps));
  const [custom, setCustom] = useState(known === undefined);
  const [was, setWas] = useState(fps);
  if (was !== fps) {
    setWas(fps);
    setCustom(known === undefined);
  }
  return (
    <Row id="fps" name={t("projectProps.fps.name")} help={t("projectProps.fps.help")}>
      <Choice
        label={t("projectProps.fps.name")}
        value={custom ? "custom" : (known?.value ?? "custom")}
        disabled={disabled}
        options={[
          ...FRAME_RATES.map(({ value, label }) => ({
            value,
            label: t("projectProps.formats.fps", { fps: label }),
          })),
          { value: "custom", label: t("projectProps.fps.custom") },
        ]}
        onChange={(value) => {
          if (value === "custom") return setCustom(true);
          void projectEdits.setFrameRate(value);
        }}
      />
      {custom && (
        <CommitText
          label={t("projectProps.fps.customLabel")}
          value={fps}
          disabled={disabled}
          width={110}
          placeholder="30000/1001"
          onCommit={(value) =>
            isFrameRate(value) ? projectEdits.setFrameRate(value).then(() => true) : false
          }
        />
      )}
    </Row>
  );
}

/** One background for every timeline, as most projects have; a timeline of its own in its group. */
function BackgroundRow({ state, disabled }: { state: ProjectState; disabled: boolean }) {
  const { projectEdits } = useWorkbench();
  const { t } = useTranslation();
  const colors = [
    ...new Set(Object.values(state.timelines).map((each) => each.background ?? "#000000")),
  ];
  const [only] = colors;
  return (
    <Row
      id="background"
      name={t("projectProps.background.name")}
      help={t("projectProps.background.help")}
      below={
        colors.length > 1 && (
          <span className={settings.note}>{t("projectProps.background.differ")}</span>
        )
      }
    >
      <ColorPick
        label={t("projectProps.background.name")}
        value={colors.length === 1 && only ? only : "#000000"}
        disabled={disabled}
        onPick={(color) => projectEdits.setBackground(color)}
      />
      <Small disabled={disabled} onClick={() => projectEdits.setBackground(null)}>
        {t("projectProps.background.black")}
      </Small>
    </Row>
  );
}

/** The safe area of the master, which the preview draws as a frame (5.2). */
function SafeAreaRow({
  formats,
  disabled,
}: {
  formats: readonly ProjectFormat[];
  disabled: boolean;
}) {
  const { projectEdits } = useWorkbench();
  const { t } = useTranslation();
  const [master] = formats;
  const choice = safeAreaChoice(master);
  if (!master) return null;
  const area = master.safeArea ?? SAFE_AREAS.action;
  const write = (safeArea: ProjectFormat["safeArea"] | undefined) => {
    const { safeArea: _, ...rest } = master;
    const next = safeArea ? { ...rest, safeArea } : rest;
    void projectEdits.setFormats([next, ...formats.slice(1)]);
  };
  const pick = (value: SafeAreaChoice) => {
    if (value === choice) return;
    if (value === "none") write(undefined);
    else if (value === "custom") write({ ...area });
    else write({ ...SAFE_AREAS[value] });
  };
  const side = (key: "top" | "right" | "bottom" | "left") => (
    <label key={key} className={styles.field}>
      <span>{t(`projectProps.safe.${key}`)}</span>
      <CommitText
        label={t(`projectProps.safe.${key}`)}
        value={String(Math.round(area[key] * 1000) / 10)}
        disabled={disabled}
        width={56}
        onCommit={(text) => {
          const percent = Number(text);
          if (!Number.isFinite(percent) || percent < 0 || percent > 100 || text.trim() === "")
            return false;
          write({ ...area, [key]: percent / 100 });
          return true;
        }}
      />
      <span className={settings.unit}>%</span>
    </label>
  );
  return (
    <Row
      id="safeArea"
      name={t("projectProps.safe.name")}
      help={t("projectProps.safe.help", { name: master.name })}
      below={
        choice === "custom" && (
          <div className={styles.sides}>
            {(["top", "right", "bottom", "left"] as const).map(side)}
          </div>
        )
      }
    >
      <Segmented<SafeAreaChoice>
        label={t("projectProps.safe.name")}
        value={choice}
        disabled={disabled}
        options={(["none", "action", "title", "custom"] as const).map((value) => ({
          value,
          label: t(`projectProps.safe.${value}`),
        }))}
        onChange={pick}
      />
    </Row>
  );
}

// ---- 声音

export function SoundGroup({ store }: { readonly store: ProjectStore }) {
  const { t } = useTranslation();
  const state = useProject(store);
  if (!state) return null;
  const mixes = Object.values(state.timelines).filter((each) => each.mix !== undefined);
  return (
    <Group title={t("projectProps.groups.sound")}>
      <Row
        id="sampleRate"
        name={t("projectProps.sound.sampleRate")}
        help={t("projectProps.sound.sampleRateHelp")}
      >
        <span className={settings.value}>{t("projectProps.sound.sampleRateValue")}</span>
      </Row>
      <Row id="mix" name={t("projectProps.sound.mix")} help={t("projectProps.sound.mixHelp")}>
        <span className={settings.value}>
          {mixes.length === 0
            ? t("projectProps.sound.noMix")
            : t("projectProps.sound.mixes", { names: mixes.map((each) => each.name).join("、") })}
        </span>
      </Row>
    </Group>
  );
}

// ---- 时间轴

export function TimelinesGroup({ store, locked }: GroupProps) {
  const { projectEdits } = useWorkbench();
  const { t } = useTranslation();
  const state = useProject(store);
  if (!state) return null;
  const disabled = locked.locked;
  const { timelines } = state.manifest;
  return (
    <Group title={t("projectProps.groups.timelines")}>
      <p className={settings.intro}>{t("projectProps.timelines.intro")}</p>
      {timelines.map((id, index) => {
        const timeline = state.timelines[id];
        if (!timeline) {
          return (
            <Row
              key={id}
              id={`timeline:${id}`}
              name={id}
              help={t("projectProps.timelines.missing")}
            />
          );
        }
        const markers = Object.keys(timeline.markers).length;
        const beats = timeline.beatGrid?.segments.length ?? 0;
        return (
          <Row
            key={id}
            id={`timeline:${id}`}
            name={timeline.name}
            wide
            below={
              <div className={styles.timeline} data-timeline={id}>
                <label className={styles.field}>
                  <span>{t("projectProps.timelines.name")}</span>
                  <CommitText
                    label={t("projectProps.timelines.nameLabel", { id })}
                    value={timeline.name}
                    disabled={disabled}
                    width={200}
                    onCommit={(name) => projectEdits.renameTimeline(id, name)}
                  />
                </label>
                <Facts
                  items={[
                    [
                      t("projectProps.timelines.length"),
                      length(t, toSeconds(timelineLength(timeline))),
                    ],
                    [
                      t("projectProps.timelines.sections"),
                      t("projectProps.timelines.count", {
                        count: orderedSections(timeline).length,
                      }),
                    ],
                    [
                      t("projectProps.timelines.markers"),
                      t("projectProps.timelines.count", { count: markers }),
                    ],
                    [
                      t("projectProps.timelines.beats"),
                      beats === 0
                        ? t("projectProps.timelines.noBeats")
                        : t("projectProps.timelines.beatSegments", { count: beats }),
                    ],
                  ]}
                />
                <label className={styles.check}>
                  <input
                    type="radio"
                    name="default-timeline"
                    checked={index === 0}
                    disabled={disabled}
                    onChange={() => projectEdits.setDefaultTimeline(id)}
                  />
                  {t("projectProps.timelines.default")}
                </label>
                <span className={styles.field}>
                  <span>{t("projectProps.timelines.background")}</span>
                  <ColorPick
                    label={t("projectProps.timelines.backgroundLabel", { name: timeline.name })}
                    value={timeline.background ?? "#000000"}
                    disabled={disabled}
                    onPick={(color) => projectEdits.setTimelineBackground(id, color)}
                  />
                </span>
              </div>
            }
          />
        );
      })}
      <p className={settings.note}>{t("projectProps.timelines.later")}</p>
    </Group>
  );
}

// ---- 语言和版本

/** What a version is about, from the name of its file. */
function versionWords(t: TFunction, name: string, state: ProjectState): string {
  const [kind, first, second] = name.split(".");
  const language = (id: string | undefined) =>
    state.manifest.languages.find((each) => each.id === id)?.name ?? id ?? "";
  const format = (id: string | undefined) =>
    state.manifest.formats.find((each) => each.id === id)?.name ?? id ?? "";
  if (kind === "language") return t("projectProps.versions.language", { name: language(first) });
  if (kind === "format") return t("projectProps.versions.format", { name: format(first) });
  return t("projectProps.versions.both", { language: language(first), format: format(second) });
}

export function LanguagesGroup({ store, locked }: GroupProps) {
  const { projectEdits } = useWorkbench();
  const { t } = useTranslation();
  const state = useProject(store);
  const [adding, setAdding] = useState<{ id: string; name: string }>();
  if (!state) return null;
  const disabled = locked.locked;
  const { languages } = state.manifest;
  const set = (next: readonly Language[]) => projectEdits.setLanguages(next);
  const versions = Object.entries(state.timelines).flatMap(([id, timeline]) =>
    Object.keys(timeline.overrides).map((name) => ({ timeline: id, name, of: timeline.name })),
  );
  const validTag = (id: string) => /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(id.trim());
  return (
    <Group title={t("projectProps.groups.languages")}>
      <Row
        id="languages"
        name={t("projectProps.languages.title")}
        help={t("projectProps.languages.help")}
        wide
        below={
          <div className={styles.table}>
            {languages.map((language, index) => (
              <div key={language.id} className={styles.tableRow} data-language={language.id}>
                <span className={styles.cellName}>
                  <CommitText
                    label={t("projectProps.languages.nameLabel", { id: language.id })}
                    value={language.name}
                    disabled={disabled}
                    width={150}
                    onCommit={(name) =>
                      name.trim() !== "" &&
                      set(
                        languages.map((each, at) =>
                          at === index ? { ...each, name: name.trim() } : each,
                        ),
                      )
                    }
                  />
                  {index === 0 && (
                    <span className={styles.badge}>{t("projectProps.formats.master")}</span>
                  )}
                </span>
                <code className={styles.cellMono}>{language.id}</code>
                <span className={styles.cellMuted}>
                  {language.font ? t("projectProps.languages.font", { font: language.font }) : ""}
                </span>
                <span className={styles.cellActions}>
                  {index > 0 && (
                    <Small
                      disabled={disabled}
                      onClick={() =>
                        void set([language, ...languages.filter((_, at) => at !== index)])
                      }
                    >
                      {t("projectProps.formats.makeMaster")}
                    </Small>
                  )}
                  <Small
                    danger
                    disabled={disabled || languages.length === 1}
                    label={t("projectProps.languages.removeLabel", { name: language.name })}
                    onClick={() => void set(languages.filter((_, at) => at !== index))}
                  >
                    <Trash2 size={12} aria-hidden />
                  </Small>
                </span>
              </div>
            ))}
            {adding ? (
              <div className={styles.editor} data-testid="language-editor">
                <label className={styles.field}>
                  <span>{t("projectProps.languages.tag")}</span>
                  <input
                    className={styles.text}
                    aria-label={t("projectProps.languages.tag")}
                    aria-invalid={(adding.id !== "" && !validTag(adding.id)) || undefined}
                    placeholder="en"
                    value={adding.id}
                    style={{ width: 90 }}
                    onChange={(event) => setAdding({ ...adding, id: event.target.value })}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t("projectProps.languages.name")}</span>
                  <input
                    className={styles.text}
                    aria-label={t("projectProps.languages.name")}
                    placeholder="English"
                    value={adding.name}
                    style={{ width: 150 }}
                    onChange={(event) => setAdding({ ...adding, name: event.target.value })}
                  />
                </label>
                <span className={styles.cellActions}>
                  <Small onClick={() => setAdding(undefined)}>{t("dialog.cancel")}</Small>
                  <button
                    type="button"
                    className={settings.primary}
                    disabled={
                      !validTag(adding.id) ||
                      adding.name.trim() === "" ||
                      languages.some((each) => each.id === adding.id.trim())
                    }
                    onClick={() =>
                      void set([
                        ...languages,
                        { id: adding.id.trim(), name: adding.name.trim() },
                      ]).then((done) => done && setAdding(undefined))
                    }
                  >
                    {t("projectProps.languages.add")}
                  </button>
                </span>
              </div>
            ) : (
              <div className={styles.adds}>
                <Small disabled={disabled} onClick={() => setAdding({ id: "", name: "" })}>
                  <Plus size={12} aria-hidden /> {t("projectProps.languages.addOne")}
                </Small>
              </div>
            )}
          </div>
        }
      />
      <Row
        id="versions"
        name={t("projectProps.versions.title")}
        help={t("projectProps.versions.help")}
        wide
        below={
          versions.length === 0 ? (
            <span className={settings.note}>{t("projectProps.versions.none")}</span>
          ) : (
            <ul className={styles.plainList} data-testid="project-versions">
              {versions.map(({ timeline, name, of }) => (
                <li key={`${timeline}/${name}`}>
                  <code
                    className={styles.code}
                  >{`timelines/${timeline}/overrides/${name}.json`}</code>{" "}
                  {t("projectProps.versions.line", {
                    timeline: of,
                    what: versionWords(t, name, state),
                    interpolation: { escapeValue: false },
                  })}
                </li>
              ))}
            </ul>
          )
        }
      />
    </Group>
  );
}

// ---- 封面

export function CoverGroup({ store, locked }: GroupProps) {
  const workbench = useWorkbench();
  const { projectEdits, timeline: editor } = workbench;
  const { t } = useTranslation();
  const state = useProject(store);
  const picture = useCoverPicture();
  if (!state) return null;
  const disabled = locked.locked;
  const { cover, timelines } = state.manifest;
  const target = coverTarget(workbench, state);
  const named = (id: string) => state.timelines[id]?.name ?? id;
  const fromPlayhead = () => {
    const model = editor.getSnapshot().model;
    if (!model) return;
    const seconds = frameSeconds(editor.frame, model.rate);
    const time = formatTime(parseTime(String(Math.max(0, Math.round(seconds * 1000) / 1000))));
    projectEdits.setCover({ timeline: model.id, time });
  };
  return (
    <Group title={t("projectProps.groups.cover")}>
      <p className={settings.intro}>{t("projectProps.cover.intro")}</p>
      <Row
        id="coverFrame"
        name={t("projectProps.cover.frame")}
        help={t("projectProps.cover.frameHelp")}
        wide
        below={
          <div className={styles.timeline}>
            <Segmented<"auto" | "chosen">
              label={t("projectProps.cover.frame")}
              value={cover ? "chosen" : "auto"}
              disabled={disabled}
              options={[
                { value: "auto", label: t("projectProps.cover.auto") },
                { value: "chosen", label: t("projectProps.cover.chosen") },
              ]}
              onChange={(value) => {
                if (value === "auto") projectEdits.setCover(null);
                else fromPlayhead();
              }}
            />
            {cover && (
              <>
                <Choice
                  label={t("projectProps.cover.timeline")}
                  value={cover.timeline}
                  disabled={disabled}
                  options={timelines.map((id) => ({ value: id, label: named(id) }))}
                  onChange={(timeline) => projectEdits.setCover({ timeline, time: "0" })}
                />
                <label className={styles.field}>
                  <span>{t("projectProps.cover.time")}</span>
                  <CommitText
                    label={t("projectProps.cover.time")}
                    value={cover.time}
                    disabled={disabled}
                    width={90}
                    onCommit={(time) => {
                      try {
                        return projectEdits.setCover({
                          timeline: cover.timeline,
                          time: formatTime(parseTime(time.trim())),
                        });
                      } catch {
                        return false;
                      }
                    }}
                  />
                </label>
              </>
            )}
            <Small disabled={disabled} onClick={fromPlayhead}>
              {t("projectProps.cover.playhead")}
            </Small>
          </div>
        }
      />
      <Row
        id="coverPicture"
        name={t("projectProps.cover.picture")}
        help={t("projectProps.cover.pictureHelp")}
        wide
        below={
          <div className={styles.cover}>
            {picture.url ? (
              <img
                className={styles.coverImage}
                src={picture.url}
                alt={t("projectProps.cover.now")}
              />
            ) : (
              <span className={styles.coverEmpty}>{t("projectProps.cover.noneYet")}</span>
            )}
            <div className={styles.coverSide}>
              <span className={settings.note}>
                {picture.chosen ? t("projectProps.cover.isChosen") : t("projectProps.cover.isAuto")}
              </span>
              {target && workbench.canChooseCovers ? (
                <span className={styles.cellActions}>
                  <Small disabled={disabled} onClick={() => void workbench.chooseCover(target)}>
                    {t("projectProps.cover.choose")}
                  </Small>
                  {picture.chosen && (
                    <Small
                      disabled={disabled}
                      onClick={() => void workbench.restoreAutoCover(target)}
                    >
                      {t("projectProps.cover.restore")}
                    </Small>
                  )}
                </span>
              ) : (
                <span className={settings.note}>{t("projectProps.cover.cannotChoose")}</span>
              )}
            </div>
          </div>
        }
      />
    </Group>
  );
}

/** Where a cover people choose for the open project goes: as its card on the start page has it. */
function coverTarget(
  workbench: ReturnType<typeof useWorkbench>,
  state: ProjectState,
): { key: string; project: string | undefined; durationMs: number | undefined } | undefined {
  const key = workbench.session.key;
  if (key === undefined) return undefined;
  const snapshot = workbench.cloud?.getSnapshot();
  const own =
    snapshot?.kind === "linked" && snapshot.made && workbench.cloud?.isOwn(snapshot.link) === true;
  const main = state.manifest.timelines.find((id) => state.timelines[id]);
  const timeline = main === undefined ? undefined : state.timelines[main];
  return {
    key,
    project: own && snapshot?.kind === "linked" ? snapshot.link.project : undefined,
    durationMs: timeline ? Math.round(toSeconds(timelineLength(timeline)) * 1000) : undefined,
  };
}

/** The cover the start page shows for the open project, as this browser keeps it. */
function useCoverPicture(): { url: string | undefined; chosen: boolean } {
  const workbench = useWorkbench();
  const [shown, setShown] = useState<{ url: string | undefined; chosen: boolean }>({
    url: undefined,
    chosen: false,
  });
  useEffect(() => {
    const covers = workbench.coverStore;
    const key = workbench.session.key;
    if (!covers || key === undefined) return;
    let url: string | undefined;
    let live = true;
    const read = () =>
      void covers
        .read([key])
        .then((kept) => {
          if (!live) return;
          const cover = kept.get(key);
          if (url) URL.revokeObjectURL(url);
          url = cover ? URL.createObjectURL(cover.picture) : undefined;
          setShown({ url, chosen: cover?.chosen === true });
        })
        .catch(() => {});
    read();
    const stop = covers.listen((changed) => changed === key && read());
    return () => {
      live = false;
      stop();
      if (url) URL.revokeObjectURL(url);
    };
  }, [workbench]);
  return shown;
}

// ---- 字体

export function FontsGroup({ store }: { readonly store: ProjectStore }) {
  const { t } = useTranslation();
  const state = useProject(store);
  if (!state) return null;
  const { fonts = [], languages } = state.manifest;
  const assetName = (id: string) => state.assets?.[id]?.name ?? id;
  return (
    <Group title={t("projectProps.groups.fonts")}>
      <p className={settings.intro}>{t("projectProps.fonts.intro")}</p>
      <Row
        id="fonts"
        name={t("projectProps.fonts.title")}
        wide
        below={
          fonts.length === 0 ? (
            <span className={settings.note}>{t("projectProps.fonts.none")}</span>
          ) : (
            <ul className={styles.plainList} data-testid="project-fonts">
              {fonts.map((font, index) => (
                <li key={`${index}:${font.family}`}>
                  <strong>{font.family}</strong>{" "}
                  {t("projectProps.fonts.line", {
                    asset: assetName(font.asset),
                    weight: font.weight ?? 400,
                    style: t(`projectProps.fonts.style.${font.style ?? "normal"}`),
                    interpolation: { escapeValue: false },
                  })}
                </li>
              ))}
            </ul>
          )
        }
      />
      <Row
        id="languageFonts"
        name={t("projectProps.fonts.languages")}
        wide
        below={
          <ul className={styles.plainList}>
            {languages.map((language) => (
              <li key={language.id}>
                {language.name}：{language.font ?? t("projectProps.fonts.noFont")}
              </li>
            ))}
          </ul>
        }
      />
    </Group>
  );
}

// ---- 关联的库

export function LibrariesGroup({ store }: { readonly store: ProjectStore }) {
  const { t } = useTranslation();
  const state = useProject(store);
  if (!state) return null;
  const libraries = state.libraries?.libraries ?? [];
  const locks = state.lock?.libraries ?? {};
  return (
    <Group title={t("projectProps.groups.libraries")}>
      <p className={settings.intro}>{t("projectProps.libraries.intro")}</p>
      {libraries.length === 0 ? (
        <p className={settings.note}>{t("projectProps.libraries.none")}</p>
      ) : (
        libraries.map((library) => {
          const lock = Object.hasOwn(locks, library.id) ? locks[library.id] : undefined;
          return (
            <Row
              key={library.id}
              id={`library:${library.id}`}
              name={library.id}
              wide
              below={
                <Facts
                  items={[
                    [
                      t("projectProps.libraries.type"),
                      t(`projectProps.libraries.types.${library.type}`),
                    ],
                    [
                      t("projectProps.libraries.source"),
                      <code key="source" className={styles.code}>
                        {library.source}
                      </code>,
                    ],
                    [t("projectProps.libraries.track"), library.track],
                    [
                      t("projectProps.libraries.pinned"),
                      library.followLatest ? (
                        t("projectProps.libraries.followLatest")
                      ) : lock?.commit ? (
                        <code key="commit" className={styles.code}>
                          {lock.commit.slice(0, 12)}
                        </code>
                      ) : (
                        t("projectProps.libraries.notPinned")
                      ),
                    ],
                  ]}
                />
              }
            />
          );
        })
      )}
    </Group>
  );
}
