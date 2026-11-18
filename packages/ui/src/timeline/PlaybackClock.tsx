import { PlaybackAudio, createMixer, createPitchKeeper } from "@animaquill/audio";
import { buildMixPlan, type MixPlan } from "@animaquill/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useSession, useWorkbench } from "../app/context.ts";
import { projectKeyOf } from "../workbench/session.ts";
import { triedApart } from "../mixer/track-clip.ts";

/** Plays the sound and keeps time by it, whichever panels are open. */
export function PlaybackClock() {
  const workbench = useWorkbench();
  const { timeline, projects, notifications, diagnostics, properties } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const { playing } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);

  const audio = useMemo(() => {
    const warned = new Set<string>();
    const isElsewhereFile = (file: string) => workbench.isElsewhereFile(file);
    return new PlaybackAudio({
      fileOf: async (file) => {
        return store ? projects.media(projectKeyOf(store)).get(file) : undefined;
      },
      onProblem(file) {
        // A file that is not here but on its way, which the downloads say: no problem of the preview.
        if (!warned.has(file) && !isElsewhereFile(file))
          notifications.push(t("notice.previewCannotDecode"));
        warned.add(file);
      },
      onNote: (kind, data) => diagnostics.note(kind, data),
      onNoMixer: () => notifications.push(t("notice.previewNoSound")),
      // The mix runs in the audio thread, from the editor's own address as the next one.
      mixer: async (context) => {
        const { default: url } = await import("@animaquill/audio/mixer-worklet?worker&url");
        return createMixer(context, url);
      },
      // Its own file, because the editor runs no scripts that it did not serve itself.
      keepPitch: async (context) => {
        const { default: url } = await import("@animaquill/audio/stretch-worklet?worker&url");
        return createPitchKeeper(context, url);
      },
    });
  }, [diagnostics, notifications, projects, store, t, workbench]);

  useEffect(() => () => audio.dispose(), [audio]);

  // The meters of the mixer, whether it is open or not: what plays is what they show.
  useEffect(
    () => audio.listenLevels((levels) => workbench.levels.receive(levels, performance.now())),
    [audio, workbench],
  );

  useEffect(() => {
    diagnostics.mark(playing ? "play" : "pause", { frame: timeline.frame });
    if (!playing || !store) return;
    let plan: MixPlan | undefined;
    let start = timeline.playbackStart;
    let planChanged = true;
    const replan = () => {
      planChanged = true;
    };
    const stopWatching = store.subscribe(replan);
    const stopTrying = properties.subscribe(replan);

    /** Sound starts over when the playhead jumped, or when what it should play changed. */
    const followSound = (now: number) => {
      const { model, playbackStart } = timeline;
      if (!model || !playbackStart) return;
      // What people are trying out is what they want to hear.
      const tried = triedApart(properties.getPreviewed());
      const next = planChanged
        ? buildMixPlan(store.getState(), model.id, tried.clips, tried.tracks, tried.master)
        : plan;
      planChanged = false;
      if (next && plan && playbackStart === start && PlaybackAudio.onTheSpot(next, plan)) {
        if (next !== plan) audio.change(next);
      } else if (next) {
        const { frame, since, rate } = playbackStart;
        const seconds = frame / model.rate.fps + ((now - since) / 1000) * rate;
        audio.play(next, seconds, now, rate);
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
