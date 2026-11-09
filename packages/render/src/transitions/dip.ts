import { clear, contextOf, share, type TransitionCode } from "./code.ts";

/** The most of the time that can be nothing but the color: some of it has to go to and from it. */
const MOST_HOLD = 0.9;

/**
 * 闪入, 闪出 and the dip between two clips: through a plain color that covers the whole picture, so
 * that in the middle of it there is nothing but the color, whatever is below. Between two clips the
 * side before goes to the color, the color stays for `hold` of the time, and then goes to the side
 * after. At the start of a clip it stays and then comes from the color, at its end it goes to the
 * color and stays. Mixed as a fade is, with premultiplied colors.
 */
const dip: TransitionCode = (aq) => {
  const context = contextOf(aq.canvas);
  aq.render(({ from, to, progress, use, values, width, height }) => {
    const color = typeof values["color"] === "string" ? values["color"] : "#000000";
    const hold = Math.min(share(Number(values["hold"])), MOST_HOLD);
    const p = share(progress);
    // How far it went to the color, and how far back from it, each from 0 to 1.
    const going = (1 - hold) / 2;
    const [into, out] =
      use === "enter"
        ? [1, share((p - hold) / (1 - hold))]
        : use === "exit"
          ? [share(p / (1 - hold)), 0]
          : [share(p / going), share((p - going - hold) / going)];
    // How much of the side before, of the color and of the side after there is.
    const [before, plain, after] =
      use === "enter" ? [0, 1 - out, out] : [1 - into, into - out, out];
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
