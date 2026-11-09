import { clear, contextOf, directionOf, type TransitionCode } from "./code.ts";

/**
 * 推移: the side after pushes the side before out of the picture, the way its direction says, the two
 * moving as one. A speed curve that goes past the end overshoots: the two go a little too far and
 * come back. The edges where they meet add up, so that no line shows between them.
 */
const push: TransitionCode = (aq) => {
  const context = contextOf(aq.canvas);
  aq.render(({ from, to, progress, use, values, width, height }) => {
    const [x, y] = directionOf(values["direction"]);
    const p = Number.isFinite(progress) ? progress : 0;
    clear(context, width, height);
    context.globalCompositeOperation = "lighter";
    if (use !== "enter") context.drawImage(from, x * p * width, y * p * height);
    if (use !== "exit") context.drawImage(to, x * (p - 1) * width, y * (p - 1) * height);
  });
};

export default push;
