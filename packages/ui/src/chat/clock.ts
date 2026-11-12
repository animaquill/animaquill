import { useEffect, useState } from "react";

/** The time now, again every `ms` while `on`: for what counts up while it runs. */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const tick = () => setNow(Date.now());
    // Right away too: what was off a while ago has an old time.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, ms);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [on, ms]);
  return now;
}
