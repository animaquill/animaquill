import type { FromCompositor } from "@animaquill/render";

/** A compositor nobody sees, for what only a sandbox can do while the preview may not be open. */
export interface HiddenCompositor {
  readonly frame: HTMLIFrameElement;
  /** It said hello. */
  readonly ready: Promise<void>;
}

export function openHiddenCompositor(url: string): HiddenCompositor {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.tabIndex = -1;
  frame.hidden = true;
  frame.title = "";
  const ready = new Promise<void>((resolve) => {
    // Anything can write to this page, and reading `data` is what builds a message.
    const onReady = (event: MessageEvent<FromCompositor>) => {
      if (event.source !== frame.contentWindow || event.data.type !== "ready") return;
      removeEventListener("message", onReady);
      resolve();
    };
    addEventListener("message", onReady);
  });
  frame.src = url;
  document.body.append(frame);
  return { frame, ready };
}
