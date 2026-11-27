import { useEffect, useRef, useState } from "react";

/** How long something shakes to say "this is why nothing went". */
const SHAKE_MS = 450;

/** Whether to shake now: for a while after `nudge` changes, not as it first shows. */
export function useNudged(nudge: number): boolean {
  const [shaking, setShaking] = useState(false);
  const first = useRef(nudge);
  useEffect(() => {
    if (nudge === first.current) return;
    setShaking(true);
    const timer = setTimeout(() => setShaking(false), SHAKE_MS);
    return () => clearTimeout(timer);
  }, [nudge]);
  return shaking;
}
