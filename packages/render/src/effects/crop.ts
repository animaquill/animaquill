import { clear, contextOf, numberOf, type EffectCode } from "./code.ts";

const share = (value: number) => Math.min(Math.max(value, 0), 1);

/**
 * 裁切: shares of the box go at its sides and become transparent. The box stays as large as it is,
 * so that what is left stays where it was, and anything after this, also a transform, sees it so.
 * Sides that meet leave nothing.
 */
const crop: EffectCode = (aq) => {
  const context = contextOf(aq.canvas);
  aq.render(({ input, values, width, height }) => {
    clear(context, width, height);
    const left = share(numberOf(values, "left")) * width;
    const right = width - share(numberOf(values, "right")) * width;
    const top = share(numberOf(values, "top")) * height;
    const bottom = height - share(numberOf(values, "bottom")) * height;
    if (right <= left || bottom <= top) return;
    context.save();
    context.beginPath();
    context.rect(left, top, right - left, bottom - top);
    context.clip();
    context.drawImage(input, 0, 0);
    context.restore();
  });
};

export default crop;
