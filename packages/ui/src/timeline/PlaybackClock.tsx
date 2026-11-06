import { PlaybackAudio } from "@animaquill/audio";
import { buildAudioPlan, type AudioPlan } from "@animaquill/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useSession, useWorkbench } from "../app/context.ts";

/** Plays the sound and keeps time by it, whichever panels are open. */
export function PlaybackClock() {
  const { timeline, projects, notifications, diagnostics } = useWorkbench();
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
    diagnostics.note(playing ? "play" : "pause", { frame: timeline.frame });
    if (!playing || !store) return;
    let plan: AudioPlan | undefined;
    let start = timeline.playbackStart;
    let planChanged = true;
    const stopWatching = store.subscribe(() => {
      planChanged = true;
    });

    /** Sound starts over when the playhead jumped, or when what it should play changed. */
    const followSound = (now: number) => {
      const { model, playbackStart } = timeline;
      if (!model || !playbackStart) return;
      const next = planChanged ? buildAudioPlan(store.getState(), model.id) : plan;
      planChanged = false;
      const same = JSON.stringify(next) === JSON.stringify(plan);
      if (next && (playbackStart !== start || !same || plan === undefined)) {
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
      audio.stop();
    };
  }, [audio, diagnostics, playing, store, timeline]);

  return null;
}
