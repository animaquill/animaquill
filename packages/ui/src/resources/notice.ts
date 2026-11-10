import { useCallback, useEffect, useRef, useState } from "react";
import type { Notice } from "./ResourceBrowser.tsx";

/** How long a tab says what a click did. */
export const NOTICE_MS = 2500;

/**
 * What a tab of resources says about a click for a moment, see `ResourceBrowserProps.notice`. A new
 * one takes the place of the one before, and each goes after `NOTICE_MS`. One that says why a click
 * did nothing is `failed`: the resource shakes.
 */
export function useNotice(): readonly [
  Notice | undefined,
  (resource: string, text: string, badge?: string, failed?: boolean) => void,
] {
  const [notice, setNotice] = useState<Notice>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const say = useCallback((resource: string, text: string, badge?: string, failed?: boolean) => {
    clearTimeout(timer.current);
    setNotice({
      resource,
      text,
      at: performance.now(),
      ...(badge === undefined ? {} : { badge }),
      ...(failed ? { failed } : {}),
    });
    timer.current = setTimeout(() => setNotice(undefined), NOTICE_MS);
  }, []);
  return [notice, say];
}
