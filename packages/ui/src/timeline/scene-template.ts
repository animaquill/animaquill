import { CURRENT_SCENE_RUNTIME, type SceneManifest } from "@animaquill/schema";

const PAGE = (title: string) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <div class="ring"></div>
    <div class="dot"></div>
    <h1>${title}</h1>
  </body>
</html>
`;

const STYLE = `body {
  display: grid;
  place-items: center;
  margin: 0;
  overflow: hidden;
  color: #fff;
  font-family: system-ui, sans-serif;
  background: linear-gradient(135deg, #16213e, #0f3460);
}

h1 {
  font-size: 96px;
  font-weight: 600;
  animation: rise 1s ease-out 0.3s both;
}

.ring {
  position: absolute;
  width: 480px;
  height: 480px;
  border: 24px solid #e94560;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 4s linear infinite;
}

.dot {
  position: absolute;
  left: 10%;
  bottom: 15%;
  width: 72px;
  height: 72px;
  background: #ffd460;
  border-radius: 50%;
  animation: slide 2.5s ease-in-out infinite alternate;
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(60px);
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes slide {
  to {
    left: calc(90% - 72px);
  }
}
`;

/** What a new scene starts out as: a little of what CSS can do, to see moving at once and to change. */
export function sceneTemplate(name: string): {
  readonly scene: SceneManifest;
  readonly files: Readonly<Record<string, string>>;
} {
  const title = name.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return {
    scene: { name, entry: "index.html", runtime: CURRENT_SCENE_RUNTIME },
    files: { "index.html": PAGE(title), "style.css": STYLE },
  };
}
