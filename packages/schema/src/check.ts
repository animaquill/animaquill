import type { Project, Problem } from "./project.ts";
import { cannotHaveKeys } from "./properties.ts";
import { add, compare, parseTime, type Rational } from "./time.ts";
import type { Clip, ClipSource, Join, Timeline, Track } from "./timeline.ts";
import {
  TRANSITION_USE_NAMES,
  describeMissing,
  describeUnsupported,
  edgeLength,
  findTransition,
  isSupported,
  mediaOfTrack,
  placeJoins,
  type TransitionMedia,
  type TransitionRef,
  type TransitionUse,
} from "./transitions.ts";
import type { MediaRef, Properties, PropertyValue } from "./values.ts";
import { CURRENT_SCENE_RUNTIME } from "./version.ts";

const warning = (code: string, file: string, path: string, message: string): Problem => ({
  severity: "warning",
  code,
  file,
  path,
  message,
});

const error = (code: string, file: string, path: string, message: string): Problem => ({
  severity: "error",
  code,
  file,
  path,
  message,
});

function* stringRefs(properties: Properties | undefined): Generator<string> {
  const visit = function* (value: PropertyValue): Generator<string> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    if ("string" in value) yield value.string;
    if ("keys" in value) for (const key of value.keys) yield* visit(key.value);
  };
  for (const value of Object.values(properties ?? {})) yield* visit(value);
}

/** Plugin sources can hold anything, so the fields of a source are read by name. */
const fieldsOf = (source: ClipSource) => source as Record<string, unknown>;

/** Which timelines a timeline puts inside itself. */
function nestedTimelines(timeline: Timeline): string[] {
  return timeline.tracks.flatMap((track) =>
    track.clips.flatMap((clip) =>
      clip.source.kind === "timeline" ? [fieldsOf(clip.source)["timeline"] as string] : [],
    ),
  );
}

function checkCycles(project: Project, problems: Problem[]): void {
  const state = new Map<string, "open" | "done">();
  const visit = (id: string): void => {
    state.set(id, "open");
    const document = project.timelines.get(id)?.document;
    for (const nested of document ? nestedTimelines(document) : []) {
      if (state.get(nested) === "open") {
        const file = `timelines/${id}/timeline.json`;
        problems.push(
          error("timeline-cycle", file, "tracks", `时间轴不能嵌套自己：${id} 里有 ${nested}`),
        );
      } else if (!state.has(nested)) {
        visit(nested);
      }
    }
    state.set(id, "done");
  };
  for (const id of project.timelines.keys()) if (!state.has(id)) visit(id);
}

/** What a transition that this editor cannot do comes to, there. */
function insteadOf(media: TransitionMedia, use: TransitionUse): string {
  if (media === "sound") return "，暂时没有效果";
  return use === "join" ? "，剪切点照常硬切" : "，预览按淡入淡出显示，导出会停在这里";
}

/**
 * What a transition is, as far as this editor can tell, and whether it does it. Captions are not
 * drawn yet, so what this editor cannot do with theirs is nothing to say yet either.
 */
function checkImplementation(
  ref: TransitionRef,
  track: Track,
  use: TransitionUse,
  report: (code: string, message: string) => void,
  libraries: ReadonlySet<string>,
): void {
  const media = mediaOfTrack(track.kind);
  const found = findTransition(ref, media, use);
  const instead = insteadOf(media, use);
  if (found.kind === "missing") {
    const { why } = found;
    if (why.reason === "library" && !libraries.has(why.library)) {
      report("library-missing", `没有关联这个库：${why.library}`);
    } else {
      report("transition-missing", `${describeMissing(why)}${instead}`);
    }
  } else if (track.kind !== "caption" && !isSupported(found, media, use)) {
    report("transition-unsupported", `${describeUnsupported(found.type, media, use)}${instead}`);
  }
}

const JOIN_PROBLEMS = {
  missing: (clip: string) => `衔接转场的片段不在这条轨道上：${clip}`,
  same: (clip: string) => `衔接转场的两边是同一个片段：${clip}`,
  apart: (from: string, to: string) => `衔接转场的两个片段不相邻：${from} 的结尾不是 ${to} 的开头`,
} as const;

/**
 * What the transitions of a track come to, where that is not what they say. They stay as they are:
 * people or AI fix them or take them away, the editor does not.
 */
function checkTransitions(
  track: Track,
  trackPath: string,
  file: string,
  problems: Problem[],
  libraries: ReadonlySet<string>,
): void {
  const clips = new Map<string, Clip>(track.clips.map((clip) => [clip.id, clip]));
  const joins: readonly Join[] = track.kind === "caption" ? [] : (track.joins ?? []);
  const joinPaths = new Map(joins.map((join, index) => [join.id, `${trackPath}.joins.${index}`]));
  const places = placeJoins(new Map(joins.map((join) => [join.id, join])), (id) => clips.get(id));
  /** Which edges of clips have a join that does what it says, by clip. */
  const joined = { enter: new Map<string, string>(), exit: new Map<string, string>() };
  for (const join of joins) {
    const path = joinPaths.get(join.id) as string;
    const report = (code: string, message: string) =>
      problems.push(warning(code, file, path, message));
    const place = places.get(join.id);
    if (place?.kind === "cut") {
      joined.exit.set(join.from, join.id);
      joined.enter.set(join.to, join.id);
    } else if (place?.kind === "taken") {
      report("join-duplicate", `这个剪切点已经有衔接转场 ${place.by}，这个不生效`);
    } else if (place?.kind === "hidden") {
      // Hiding a clip is something people do on purpose, so this is no problem, only no join.
    } else if (place?.kind === "missing") {
      report("join-detached", JOIN_PROBLEMS.missing(place.clip));
    } else if (place?.kind === "same") {
      report("join-detached", JOIN_PROBLEMS.same(join.from));
    } else {
      report("join-detached", JOIN_PROBLEMS.apart(join.from, join.to));
    }
    checkImplementation(join, track, "join", report, libraries);
  }

  track.clips.forEach((clip, index) => {
    const path = `${trackPath}.clips.${index}`;
    const length = parseTime(clip.duration);
    const lengths: Rational[] = [];
    for (const use of ["enter", "exit"] as const) {
      const transition = clip[use];
      if (!transition) continue;
      const where = `${path}.${use}`;
      const report = (code: string, message: string) =>
        problems.push(warning(code, file, where, message));
      const join = joined[use].get(clip.id);
      if (join !== undefined) {
        const end = use === "enter" ? "开头" : "结尾";
        const name = TRANSITION_USE_NAMES[use];
        report("transition-shadowed", `片段的${end}有衔接转场 ${join}，${name}不生效`);
        continue;
      }
      checkImplementation(transition, track, use, report, libraries);
      const duration = parseTime(transition.duration);
      if (compare(duration, length) > 0) {
        report("transition-too-long", `${TRANSITION_USE_NAMES[use]}比片段长，只用到片段的长度`);
      }
      lengths.push(edgeLength(duration, length));
    }
    const [first, second] = lengths;
    if (first && second && compare(add(first, second), length) > 0) {
      const message = "入转场和出转场加起来比片段长，重叠的地方先算入转场，再算出转场";
      problems.push(warning("transition-overlap", file, path, message));
    }
  });
}

/** Finds what points at nothing. These are warnings: a project still opens with something missing. */
export function checkProject(project: Project): Problem[] {
  const problems: Problem[] = [];
  const { manifest } = project;
  const languages = new Set(manifest.languages.map((language) => language.id));
  const formats = new Set(manifest.formats.map((format) => format.id));
  const assets = project.assets?.assets ?? {};
  const libraries = new Set(project.libraries?.libraries.map((library) => library.id));
  const masterLanguage = manifest.languages[0]?.id;
  const masterStrings = masterLanguage ? project.locales.get(masterLanguage)?.strings : undefined;

  const manifestFile = "animaquill.json";

  manifest.timelines.forEach((id, index) => {
    if (!project.timelines.get(id)?.document) {
      problems.push(
        error("timeline-missing", manifestFile, `timelines.${index}`, `没有这条时间轴：${id}`),
      );
    }
  });
  for (const [id, timeline] of project.timelines) {
    if (timeline.document && !manifest.timelines.includes(id)) {
      const file = `timelines/${id}/timeline.json`;
      problems.push(
        warning("timeline-unlisted", file, "", `时间轴 ${id} 不在 animaquill.json 的列表里`),
      );
    }
  }
  manifest.fonts?.forEach((font, index) => {
    if (!(font.asset in assets)) {
      problems.push(
        warning(
          "asset-missing",
          manifestFile,
          `fonts.${index}.asset`,
          `没有这个素材：${font.asset}`,
        ),
      );
    }
  });
  if (manifest.cover && !project.timelines.has(manifest.cover.timeline)) {
    problems.push(
      warning(
        "timeline-missing",
        manifestFile,
        "cover.timeline",
        `没有这条时间轴：${manifest.cover.timeline}`,
      ),
    );
  }
  for (const library of project.libraries?.libraries ?? []) {
    if (!library.followLatest && !project.lock?.libraries[library.id]) {
      problems.push(
        warning("library-unlocked", "libraries.lock.json", library.id, `库没有锁定：${library.id}`),
      );
    }
  }

  const checkMedia = (media: MediaRef, file: string, path: string) => {
    if ("asset" in media) {
      if (!(media.asset in assets)) {
        problems.push(warning("asset-missing", file, path, `没有这个素材：${media.asset}`));
      }
    } else if (!libraries.has(media.library)) {
      problems.push(warning("library-missing", file, path, `没有关联这个库：${media.library}`));
    }
  };

  const checkString = (key: string, file: string, path: string) => {
    if (masterStrings && !(key in masterStrings)) {
      problems.push(warning("string-missing", file, path, `字符串表里没有：${key}`));
    }
  };

  const checkSource = (source: ClipSource, file: string, path: string) => {
    const fields = fieldsOf(source);
    switch (source.kind) {
      case "video":
      case "image":
      case "audio":
        checkMedia(fields["media"] as MediaRef, file, `${path}.media`);
        break;
      case "scene": {
        const scene = fields["scene"] as string | undefined;
        const library = fields["library"] as string | undefined;
        if (scene && !project.scenes.has(scene)) {
          problems.push(warning("scene-missing", file, path, `没有这个场景：${scene}`));
        }
        if (library && !libraries.has(library)) {
          problems.push(warning("library-missing", file, path, `没有关联这个库：${library}`));
        }
        break;
      }
      case "sound": {
        const sound = fields["sound"] as string | undefined;
        const library = fields["library"] as string | undefined;
        if (sound && !project.sounds.has(sound)) {
          problems.push(warning("sound-missing", file, path, `没有这个声音：${sound}`));
        }
        if (library && !libraries.has(library)) {
          problems.push(warning("library-missing", file, path, `没有关联这个库：${library}`));
        }
        break;
      }
      case "timeline": {
        const nested = fields["timeline"] as string;
        if (!project.timelines.has(nested)) {
          problems.push(warning("timeline-missing", file, path, `没有这条时间轴：${nested}`));
        }
        break;
      }
      case "caption": {
        const text = fields["text"];
        if (typeof text === "object" && text !== null) {
          checkString((text as { string: string }).string, file, `${path}.text`);
        }
        break;
      }
      default:
    }
  };

  /** Sounds on one track simply mix, but a picture would cover the one behind it. */
  const checkOverlaps = (track: Track, trackIndex: number, file: string) => {
    if (track.kind === "audio") return;
    let end: ReturnType<typeof parseTime> | undefined;
    track.clips.forEach((clip, index) => {
      if (clip.draft || clip.hidden) return;
      const start = parseTime(clip.start);
      if (end && compare(start, end) < 0) {
        const path = `tracks.${trackIndex}.clips.${index}`;
        problems.push(
          warning("clip-overlap", file, path, `片段和同一轨道的前一个片段重叠：${clip.id}`),
        );
      }
      const clipEnd = add(start, parseTime(clip.duration));
      if (!end || compare(clipEnd, end) > 0) end = clipEnd;
    });
  };

  for (const [id, { document, overrides }] of project.timelines) {
    if (!document) continue;
    const file = `timelines/${id}/timeline.json`;
    const clips = new Set<string>();
    const buses = new Set(document.mix?.buses?.map((bus) => bus.id));
    const sections = new Set(document.sections.map((section) => section.id));

    document.tracks.forEach((track, trackIndex) => {
      const trackPath = `tracks.${trackIndex}`;
      checkOverlaps(track, trackIndex, file);
      track.clips.forEach((clip, clipIndex) => {
        clips.add(clip.id);
        const path = `${trackPath}.clips.${clipIndex}`;
        checkSource(clip.source, file, `${path}.source`);
        for (const key of stringRefs(clip.properties)) checkString(key, file, `${path}.properties`);
        for (const [property, value] of Object.entries(clip.properties ?? {})) {
          if (cannotHaveKeys(property, value)) {
            const where = `${path}.properties.${property}`;
            const message = `${property} 不能打关键帧，这里只用第一个关键帧的值`;
            problems.push(warning("not-animatable", file, where, message));
          }
        }

        const sceneId =
          clip.source.kind === "scene"
            ? (fieldsOf(clip.source)["scene"] as string | undefined)
            : undefined;
        const scene = sceneId ? project.scenes.get(sceneId) : undefined;
        if (scene) {
          const declared = new Set(scene.params?.map((param) => param.id));
          for (const property of Object.keys(clip.properties ?? {})) {
            const name = property.startsWith("param.")
              ? property.slice("param.".length)
              : undefined;
            if (name && !declared.has(name)) {
              problems.push(
                warning(
                  "param-unknown",
                  file,
                  `${path}.properties.${property}`,
                  `场景 ${sceneId} 没有声明这个参数：${name}`,
                ),
              );
            }
          }
        }
      });
      checkTransitions(track, trackPath, file, problems, libraries);
      if (track.kind !== "audio") return;
      const targets = [track.output, ...(track.sends ?? []).map((send) => send.bus)];
      for (const target of targets) {
        if (target && !buses.has(target)) {
          problems.push(warning("bus-missing", file, trackPath, `没有这条总线：${target}`));
        }
      }
    });

    for (const [name, { scope, clips: changed, sections: resized }] of overrides) {
      const overrideFile = `timelines/${id}/overrides/${name}.json`;
      const { language, format } = scope;
      const expected =
        language && format
          ? `version.${language}.${format}`
          : language
            ? `language.${language}`
            : `format.${format}`;
      if (name !== expected) {
        problems.push(
          error(
            "override-misnamed",
            overrideFile,
            "scope",
            `这个范围的文件名应该是 ${expected}.json`,
          ),
        );
      }
      if (language && !languages.has(language)) {
        problems.push(
          warning("language-unknown", overrideFile, "scope", `没有这个语言：${language}`),
        );
      }
      if (format && !formats.has(format)) {
        problems.push(warning("format-unknown", overrideFile, "scope", `没有这个画幅：${format}`));
      }
      for (const clip of Object.keys(changed ?? {})) {
        if (!clips.has(clip)) {
          problems.push(
            warning(
              "override-orphan",
              overrideFile,
              `clips.${clip}`,
              `母版里已经没有这个片段：${clip}`,
            ),
          );
        }
      }
      for (const section of Object.keys(resized ?? {})) {
        if (!sections.has(section)) {
          problems.push(
            warning(
              "override-orphan",
              overrideFile,
              `sections.${section}`,
              `母版里已经没有这个段落：${section}`,
            ),
          );
        }
      }
    }
  }

  checkCycles(project, problems);

  for (const [id, { runtime }] of project.scenes) {
    if (runtime > CURRENT_SCENE_RUNTIME) {
      const message = `场景 ${id} 要运行时版本 ${runtime}，这个编辑器只有 ${CURRENT_SCENE_RUNTIME}，要先更新编辑器`;
      problems.push(
        warning("scene-runtime-too-new", `scenes/${id}/scene.json`, "runtime", message),
      );
    }
  }

  for (const [id, locale] of project.locales) {
    const file = `locales/${id}.json`;
    if (!languages.has(id)) {
      problems.push(warning("language-unknown", file, "", `项目没有这个语言：${id}`));
    }
    if (id === masterLanguage || !masterStrings) continue;
    for (const [key, master] of Object.entries(masterStrings)) {
      const entry = locale.strings[key];
      if (!entry) {
        problems.push(warning("translation-missing", file, key, `缺少翻译：${key}`));
      } else if (entry.base !== undefined && entry.base !== master.text) {
        problems.push(warning("translation-stale", file, key, `母版文字改了，翻译要更新：${key}`));
      }
    }
  }

  return problems;
}
