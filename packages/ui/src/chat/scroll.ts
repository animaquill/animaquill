// Adapted from pi-web (https://github.com/agegr/pi-web), lib/chat-lazy-load.ts, commit 57cea50.
// Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.

/** How close to the bottom counts as at the bottom. */
export const TAIL_TOLERANCE = 8;
/** How close to the bottom scrolling down again takes up following the newest. */
export const REATTACH_TOLERANCE = 96;

export function isScrollAtTail(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = TAIL_TOLERANCE,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

/**
 * Whether the chat keeps following the newest after people scrolled: scrolling up at all lets go,
 * at the bottom it follows, and scrolling down to near the bottom takes it up again.
 */
export function followsAfterScroll(
  wasFollowing: boolean,
  previousScrollTop: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  if (isScrollAtTail(scrollTop, clientHeight, scrollHeight)) return true;
  if (scrollTop < previousScrollTop) return false;
  if (
    !wasFollowing &&
    scrollTop > previousScrollTop &&
    isScrollAtTail(scrollTop, clientHeight, scrollHeight, REATTACH_TOLERANCE)
  )
    return true;
  return wasFollowing;
}

/** Whether to offer to go to the newest: there is more below than shows. */
export function showsToLatest(scrollTop: number, clientHeight: number, scrollHeight: number) {
  if (scrollHeight <= clientHeight) return false;
  return !isScrollAtTail(scrollTop, clientHeight, scrollHeight);
}
