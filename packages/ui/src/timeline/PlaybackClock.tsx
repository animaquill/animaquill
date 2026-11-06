import { useEffect, useSyncExternalStore } from "react";
import { useWorkbench } from "../app/context.ts";

/** Keeps time while playing, whichever panels are open. Later the audio does this. */
export function PlaybackClock() {
  const { timeline } = useWorkbench();
  const { playing } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);

  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function step(now) {
      timeline.tick(now);
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [timeline, playing]);

  return null;
}
