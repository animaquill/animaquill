import { clear, contextOf, directionOf, share, type TransitionCode } from "./code.ts";

/**
 * 擦除: an edge goes across the picture the way its direction says, and what it has gone past shows
 * the side after. The edge is soft over `softness` of the short side of the picture. It starts just
 * outside the picture and ends just outside the other side of it, so that nothing of the side after
 * shows at the start, and nothing of the side before at the end.
 *
 * Only the band of the soft edge mixes the two. On either side of it the picture is one of them as
 * it is, so that is all a frame copies there, whatever size the picture is.
 */
const wipe: TransitionCode = (aq) => {
  const context = contextOf(aq.canvas);
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
    // The band in whole pixels, so that what is outside it is a plain copy.
    const bandStart = Math.min(Math.max(Math.floor(Math.min(full, none)), 0), length);
    const bandEnd = Math.min(Math.max(Math.ceil(Math.max(full, none)), bandStart), length);
    const band = bandEnd - bandStart;

    clear(context, width, height);
    /** Copies a stretch along the way the edge goes, from a side as it is. */
    const copy = (picture: CanvasImageSource, start: number, end: number) => {
      const size = end - start;
      if (size <= 0) return;
      if (across) context.drawImage(picture, start, 0, size, height, start, 0, size, height);
      else context.drawImage(picture, 0, start, width, size, 0, start, width, size);
    };
    // Before the band is what the edge went past for one way, the side before for the other.
    const [first, second] = forwards ? [to, from] : [from, to];
    const shows = (picture: CanvasImageSource) =>
      picture === to ? use !== "exit" : use !== "enter";
    if (shows(first)) copy(first, 0, bandStart);
    if (shows(second)) copy(second, bandEnd, length);
    if (band <= 0) return;

    // In the band, each side with as much of it as shows there, added up.
    const strip = aq.scratch(across ? band : width, across ? height : band);
    const part = contextOf(strip);
    const mix = (picture: CanvasImageSource, keep: GlobalCompositeOperation) => {
      part.setTransform(1, 0, 0, 1, 0, 0);
      part.globalCompositeOperation = "copy";
      part.globalAlpha = 1;
      if (across) part.drawImage(picture, -bandStart, 0);
      else part.drawImage(picture, 0, -bandStart);
      const gradient = across
        ? part.createLinearGradient(full - bandStart, 0, none - bandStart, 0)
        : part.createLinearGradient(0, full - bandStart, 0, none - bandStart);
      gradient.addColorStop(0, "#000000ff");
      gradient.addColorStop(1, "#00000000");
      part.globalCompositeOperation = keep;
      part.fillStyle = gradient;
      part.fillRect(0, 0, strip.width, strip.height);
      context.globalCompositeOperation = "lighter";
      context.drawImage(strip, across ? bandStart : 0, across ? 0 : bandStart);
      context.globalCompositeOperation = "source-over";
    };
    if (use !== "enter") mix(from, "destination-out");
    if (use !== "exit") mix(to, "destination-in");
  });
};

export default wipe;
