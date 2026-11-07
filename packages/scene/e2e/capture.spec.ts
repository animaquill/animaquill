import { test } from "@playwright/test";
import { expect, expectGone, openLab, pageScene } from "./support.ts";

test.beforeEach(({ page }) => openLab(page));

/** The picture is one color, which goes from black to white over a second. */
const FADE = `<!doctype html><style>
  @keyframes fade { from { background: #000 } to { background: #fff } }
  body { animation: fade 1s linear both }
</style>`;

test.describe("without capture", () => {
  test("a scene sends no pictures on a normal page", async ({ page }) => {
    const scene = await pageScene(page, FADE, { stage: "plain" });
    await scene.seek(30);
    expect((await scene.info()).pictures).toEqual([]);
  });
});

test.describe("capture", () => {
  // The picture of a canvas is what this is about, and only a browser that can capture has one.
  test.skip(!process.env["AQ_CHROME"], "needs a browser that can capture");

  test("a seek brings a picture of that frame", async ({ page }) => {
    const scene = await pageScene(page, FADE);
    expect(await scene.seek(30)).toBe(true);
    const { pictures } = await scene.info();
    expect(pictures.at(-1)).toMatchObject({ frame: 30, width: 1280, height: 720 });
    const [red = 0, , , alpha] = pictures.at(-1)?.middle ?? [];
    expect(red).toBeGreaterThan(120);
    expect(red).toBeLessThan(136);
    expect(alpha).toBe(255);
  });

  test("going back brings the picture of the earlier frame", async ({ page }) => {
    const scene = await pageScene(page, FADE);
    await scene.seek(45);
    await scene.seek(15);
    const { pictures } = await scene.info();
    const [red = 0] = pictures.at(-1)?.middle ?? [];
    expect(pictures.at(-1)?.frame).toBe(15);
    expect(red).toBeGreaterThan(56);
    expect(red).toBeLessThan(72);
  });

  test("a picture has the pixels of the output, whatever the size of the view", async ({
    page,
  }) => {
    const scene = await pageScene(page, FADE, { pixelRatio: 2 / 3 });
    await scene.seek(1);
    expect((await scene.info()).pictures.at(-1)).toMatchObject({ width: 853, height: 480 });
  });

  test("the first picture does not wait for anybody to ask for a frame twice", async ({ page }) => {
    const scene = await pageScene(page, FADE);
    await scene.seek(0);
    expect((await scene.info()).pictures).toHaveLength(1);
  });

  test("a page that stands still gets its picture at once, however often", async ({ page }) => {
    const scene = await pageScene(page, `<!doctype html><p>nothing moves here</p>`);
    await scene.seek(1);
    const started = Date.now();
    for (let frame = 2; frame < 8; frame += 1) await scene.seek(frame);
    expect(Date.now() - started).toBeLessThan(1500);
    const { pictures, problems } = await scene.info();
    expect(pictures.map(({ frame }) => frame)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(problems).toEqual([]);
  });

  test("a playing scene sends pictures by itself, newest last", async ({ page }) => {
    const scene = await pageScene(page, FADE);
    await scene.seek(0);
    await scene.call("play", 0);
    await page.waitForTimeout(600);
    await scene.call("pause");
    const { pictures } = await scene.info();
    expect(pictures.length).toBeGreaterThan(3);
    const frames = pictures.map(({ frame }) => frame);
    expect(frames).toEqual(frames.toSorted((a, b) => a - b));
    expect(frames.at(-1)).toBeGreaterThan(10);
  });

  test("the frame that takes over brings its picture along, and no other", async ({ page }) => {
    const scene = await pageScene(
      page,
      `${FADE}<script>requestAnimationFrame(function loop() { requestAnimationFrame(loop); })</script>`,
    );
    await scene.seek(40);
    const before = (await scene.info()).pictures.length;
    expect(await scene.seek(20)).toBe(true);
    const { pictures } = await scene.info();
    expect(pictures.slice(before).map(({ frame }) => frame)).toEqual([20]);
  });

  test.describe("a canvas in a scene", () => {
    const FULL = `position:absolute;left:0;top:0;width:100%;height:100%`;

    const middleOf = async (scene: Awaited<ReturnType<typeof pageScene>>) => {
      await scene.seek(1);
      return (await scene.info()).pictures.at(-1)?.middle;
    };

    test("is the one its code finds, and sizing it changes nothing about the picture", async ({
      page,
    }) => {
      const scene = await pageScene(
        page,
        `<!doctype html><style>body { background: #00f }</style>
        <canvas style="${FULL}"></canvas><script>
          const mine = document.querySelector("canvas");
          mine.width = 64;
          mine.height = 32;
          const painter = mine.getContext("2d");
          painter.fillStyle = "#f00";
          painter.fillRect(0, 0, 64, 32);
        </script>`,
      );
      expect(await middleOf(scene)).toEqual([255, 0, 0, 255]);
      const { pictures, failures } = await scene.info();
      expect(pictures.at(-1)).toMatchObject({ width: 1280, height: 720 });
      expect(failures).toEqual([]);
    });

    test("shows a 2D canvas where it is", async ({ page }) => {
      const scene = await pageScene(
        page,
        `<!doctype html><style>body { background: #00f }</style>
        <canvas id="c" width="64" height="64" style="${FULL}"></canvas><script>
          const painter = document.getElementById("c").getContext("2d");
          painter.fillStyle = "#f00";
          painter.fillRect(0, 0, 64, 64);
        </script>`,
      );
      expect(await middleOf(scene)).toEqual([255, 0, 0, 255]);
      expect((await scene.problems()).map(({ code }) => code)).toContain("canvas-layer");
    });

    test("shows a WebGL canvas, also long after it drew", async ({ page }) => {
      const scene = await pageScene(
        page,
        `<!doctype html><canvas id="c" width="64" height="64" style="${FULL}"></canvas><script>
          const gl = document.getElementById("c").getContext("webgl");
          gl.clearColor(0, 1, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        </script>`,
      );
      expect(await middleOf(scene)).toEqual([0, 255, 0, 255]);
      await page.waitForTimeout(300);
      expect(await middleOf(scene)).toEqual([0, 255, 0, 255]);
    });

    test("keeps what WebGL drew, whatever the code asked for", async ({ page }) => {
      const scene = await pageScene(
        page,
        `<!doctype html><script>
          const attributes = (type) =>
            document.createElement("canvas").getContext(type, { alpha: false }).getContextAttributes();
          window.attributes = [attributes("webgl"), attributes("webgl2")];
        </script>`,
      );
      const attributes = await scene.read(
        () => (window as unknown as { attributes: WebGLContextAttributes[] }).attributes,
      );
      // A picture comes later than the drawing, and by then the browser may have wiped that.
      expect(attributes.map(({ preserveDrawingBuffer }) => preserveDrawingBuffer)).toEqual([
        true,
        true,
      ]);
      expect(attributes.map(({ alpha }) => alpha)).toEqual([false, false]);
    });

    test("does not show twice, so that what is see-through stays that", async ({ page }) => {
      const scene = await pageScene(
        page,
        `<!doctype html><style>body { background: #000 }</style>
        <canvas id="c" width="64" height="64" style="${FULL}"></canvas><script>
          const painter = document.getElementById("c").getContext("2d");
          painter.fillStyle = "rgba(255, 255, 255, 0.5)";
          painter.fillRect(0, 0, 64, 64);
        </script>`,
      );
      const [red = 0] = (await middleOf(scene)) ?? [];
      expect(red).toBeGreaterThan(120);
      expect(red).toBeLessThan(136);
    });

    test("follows the clock like everything else", async ({ page }) => {
      const scene = await pageScene(
        page,
        `<!doctype html><canvas id="c" width="64" height="64" style="${FULL}"></canvas><script>
          const painter = document.getElementById("c").getContext("2d");
          aq.frame((seconds) => {
            const level = Math.round(seconds * 255);
            painter.fillStyle = "rgb(" + level + ", 0, 0)";
            painter.fillRect(0, 0, 64, 64);
          });
        </script>`,
      );
      await scene.seek(30);
      const [red = 0] = (await scene.info()).pictures.at(-1)?.middle ?? [];
      expect(red).toBeGreaterThan(120);
      expect(red).toBeLessThan(136);
    });
  });

  test("a picture of the wrong size takes the scene away", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = async () => {
          const image = await createImageBitmap(new ImageData(100, 100));
          parent.postMessage({ type: "frame", frame: 1, image }, "*", [image]);
        };
      </script>`,
    );
    await scene.seek(1);
    void scene.read(() => (window as unknown as { attack: () => Promise<void> }).attack());
    await expectGone(scene, "oversized");
  });

  test("a picture somewhere else in a message takes the scene away", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = async () => {
          const image = await createImageBitmap(new ImageData(1000, 1000));
          parent.postMessage({ type: "pong", nonce: 1, image }, "*", [image]);
        };
      </script>`,
    );
    await scene.seek(1);
    void scene.read(() => (window as unknown as { attack: () => Promise<void> }).attack());
    await expectGone(scene, "oversized");
  });

  test("more pictures than a screen can show take the scene away", async ({ page }) => {
    const scene = await pageScene(
      page,
      `<!doctype html><script>
        window.attack = async () => {
          const image = await createImageBitmap(new ImageData(1280, 720));
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = async () => {
            for (let round = 0; round < 50; round += 1) {
              const copy = await createImageBitmap(image);
              parent.postMessage({ type: "frame", frame: 1, image: copy }, "*", [copy]);
            }
            port2.postMessage(0);
          };
          port2.postMessage(0);
        };
      </script>`,
      { closePictures: true, messageRules: { burstPictures: 20, picturesPerSecond: 1 } },
    );
    await scene.seek(1);
    void scene.read(() => (window as unknown as { attack: () => Promise<void> }).attack());
    await expectGone(scene, "flood", 20000);
  });
});
