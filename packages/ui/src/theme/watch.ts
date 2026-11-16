/**
 * What the theme or the size of words changes for, besides style sheets, which follow on their
 * own: what reads the colours once, such as a canvas or the code editor. It hears of every change
 * of the root's `data-theme` and `data-font-size`, whoever made it. Returns how to stop.
 */
export function onAppearanceChange(listener: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-font-size"],
  });
  return () => observer.disconnect();
}
