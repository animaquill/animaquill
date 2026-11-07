const WIDTH = 480;
const HEIGHT = 270;
const STRIPE = 24;

let picture: OffscreenCanvas | undefined;

/**
 * What a scene looks like that cannot run. It says nothing itself: it has no words, and the reason
 * is shown next to the picture, where people can do something about it. It only has to look like
 * something is missing there, and not like a color somebody picked.
 */
export function placeholderPicture(): OffscreenCanvas {
  if (picture) return picture;
  picture = new OffscreenCanvas(WIDTH, HEIGHT);
  const painter = picture.getContext("2d");
  if (!painter) return picture;
  painter.fillStyle = "#2a2a2e";
  painter.fillRect(0, 0, WIDTH, HEIGHT);
  painter.strokeStyle = "#3a3a40";
  painter.lineWidth = STRIPE / 2;
  for (let x = -HEIGHT; x < WIDTH; x += STRIPE) {
    painter.beginPath();
    painter.moveTo(x, HEIGHT);
    painter.lineTo(x + HEIGHT, 0);
    painter.stroke();
  }
  return picture;
}
