import { clear, contextOf, share, type TransitionCode } from "./code.ts";

/**
 * 闪黑 and 闪白: through a plain color that covers the whole picture, so that in the middle of it
 * there is nothing but the color, whatever is below. In the first half the side before goes to the
 * color, in the second the color goes to the side after. At the start of a clip it comes from the
 * color, and at its end it goes to the color. Mixed as a fade is, with premultiplied colors.
 */
const dip: TransitionCode = (aq) => {
  const context = contextOf(aq.canvas);
  aq.render(({ from, to, progress, use, values, width, height }) => {
    const color = typeof values["color"] === "string" ? values["color"] : "#000000";
    const p = share(progress);
    // How much of the side before, of the color and of the side after there is.
    const [before, plain, after] =
      use === "enter"
        ? [0, 1 - p, p]
        : use === "exit"
          ? [1 - p, p, 0]
          : p < 0.5
            ? [1 - 2 * p, 2 * p, 0]
            : [0, 2 - 2 * p, 2 * p - 1];
    clear(context, width, height);
    context.globalCompositeOperation = "lighter";
    if (before > 0) {
      context.globalAlpha = share(before);
      context.drawImage(from, 0, 0);
    }
    if (plain > 0) {
      context.globalAlpha = share(plain);
      context.fillStyle = color;
      context.fillRect(0, 0, width, height);
    }
    if (after > 0) {
      context.globalAlpha = share(after);
      context.drawImage(to, 0, 0);
    }
  });
};

export default dip;
