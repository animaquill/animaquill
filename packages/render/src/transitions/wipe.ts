import { clear, contextOf, directionOf, share, type TransitionCode } from "./code.ts";

/**
 * 擦除: an edge goes across the picture the way the variant says, and what it has gone past shows
 * the side after. The edge is soft over a share of the short side of the picture. It starts just
 * outside the picture and ends just outside the other side of it, so that nothing of the side after
 * shows at the start, and nothing of the side before at the end.
 */
const wipe: TransitionCode = (aq) => {
  const context = contextOf(aq.canvas);
  // The side after is cut out on a canvas of its own, which the frame then adds up with the other.
  const after = new OffscreenCanvas(1, 1);
  const cut = contextOf(after);
  aq.render(({ from, to, progress, use, values, width, height }) => {
    const [x, y] = directionOf(values["direction"]);
    const across = Math.abs(x) >= Math.abs(y);
    const length = across ? width : height;
    const soft = Math.max(Number(values["softness"]) * Math.min(width, height), 0.5) || 0.5;
    // How far the edge is from the side it starts at, at its end towards the side before.
    const edge = share(progress) * (length + soft);
    // Where the edge is on the picture: the side after shows fully up to `full`, not at all from `none`.
    const forwards = across ? x > 0 : y > 0;
    const along = (distance: number) => (forwards ? distance : length - distance);
    const full = along(edge - soft);
    const none = along(edge);
    /** Keeps as much of what is on a canvas as the side after shows there, or takes that away. */
    const keep = (
      target: OffscreenCanvasRenderingContext2D,
      operation: GlobalCompositeOperation,
    ) => {
      const gradient = across
        ? target.createLinearGradient(full, 0, none, 0)
        : target.createLinearGradient(0, full, 0, none);
      gradient.addColorStop(0, "#000000ff");
      gradient.addColorStop(1, "#00000000");
      target.globalCompositeOperation = operation;
      target.fillStyle = gradient;
      target.fillRect(0, 0, width, height);
    };

    clear(context, width, height);
    if (use === "enter") {
      context.drawImage(to, 0, 0);
      keep(context, "destination-in");
      return;
    }
    context.drawImage(from, 0, 0);
    keep(context, "destination-out");
    if (use === "exit") return;
    if (after.width !== width || after.height !== height) {
      after.width = width;
      after.height = height;
    }
    clear(cut, width, height);
    cut.drawImage(to, 0, 0);
    keep(cut, "destination-in");
    context.globalCompositeOperation = "lighter";
    context.drawImage(after, 0, 0);
  });
};

export default wipe;
