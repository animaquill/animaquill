import { PlaybackAudio } from "@animaquill/audio";
import { buildAudioPlan, type AudioPlan } from "@animaquill/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useSession, useWorkbench } from "../app/context.ts";

/** Plays the sound and keeps time by it, whichever panels are open. */
export function PlaybackClock() {
  const { timeline, projects, notifications, diagnostics, properties } = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  const { playing } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);

  const audio = useMemo(() => {
    const warned = new Set<string>();
    return new PlaybackAudio({
      fileOf: async (file) => {
        const project = store?.getState().manifest.id;
        return project === undefined ? undefined : projects.media(project).get(file);
      },
      onProblem(file) {
        if (!warned.has(file)) notifications.push(t("notice.previewCannotDecode"));
        warned.add(file);
      },
      onNote: (kind, data) => diagnostics.note(kind, data),
    });
  }, [diagnostics, notifications, projects, store, t]);

  useEffect(() => () => audio.dispose(), [audio]);

  useEffect(() => {
    diagnostics.mark(playing ? "play" : "pause", { frame: timeline.frame });
    if (!playing || !store) return;
    let plan: AudioPlan | undefined;
    let start = timeline.playbackStart;
    let planChanged = true;
    const replan = () => {
      planChanged = true;
    };
    const stopWatching = store.subscribe(replan);
    const stopTrying = properties.subscribe(replan);
    /** What people are trying out is what they want to hear. */
    const volumeOf = (clip: string) => {
      const value = properties.getPreviewed().get(clip)?.get("audio.volume");
      return typeof value === "number" ? value : undefined;
    };

    /** Sound starts over when the playhead jumped, or when what it should play changed. */
    const followSound = (now: number) => {
      const { model, playbackStart } = timeline;
      if (!model || !playbackStart) return;
      const next = planChanged ? buildAudioPlan(store.getState(), model.id, volumeOf) : plan;
      planChanged = false;
      if (next && plan && playbackStart === start && PlaybackAudio.sameButGains(next, plan)) {
        if (next !== plan) audio.changeGains(next);
      } else if (next) {
        const seconds = playbackStart.frame / model.rate.fps + (now - playbackStart.since) / 1000;
        audio.play(next, seconds, now);
      }
      plan = next;
      start = playbackStart;
    };

    let frame = requestAnimationFrame(function step() {
      const now = audio.now();
      timeline.tick(now);
      followSound(now);
      frame = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(frame);
      stopWatching();
      stopTrying();
      audio.stop();
    };
  }, [audio, diagnostics, playing, properties, store, timeline]);

  return null;
}
