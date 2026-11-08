import { clear, contextOf, share, type TransitionCode } from "./code.ts";

/**
 * 淡入, 淡出 and 叠化: the two sides mixed by how far it got, as `from · (1 − p) + to · p` with
 * premultiplied colors. Added up on a clear canvas, so that where both sides have something, all of
 * it shows all the way through, and nothing from the tracks below comes through in the middle.
 */
const fade: TransitionCode = (aq) => {
  const context = contextOf(aq.canvas);
  aq.render(({ from, to, progress, use, width, height }) => {
    clear(context, width, height);
    context.globalCompositeOperation = "lighter";
    // Nothing on a side adds nothing.
    if (use !== "enter") {
      context.globalAlpha = share(1 - progress);
      context.drawImage(from, 0, 0);
    }
    if (use !== "exit") {
      context.globalAlpha = share(progress);
      context.drawImage(to, 0, 0);
    }
  });
};

export default fade;
