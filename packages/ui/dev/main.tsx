import { createBrowserHost } from "@animaquill/host/browser";
import { Bug, Frame } from "lucide-react";
import { useState } from "react";
import { mountEditor, type PanelDefinition } from "../src/index.ts";

function CrashTest() {
  const [crashed, setCrashed] = useState(false);
  if (crashed) throw new Error("Crash on request");
  return (
    <button type="button" onClick={() => setCrashed(true)}>
      崩溃
    </button>
  );
}

/** Also shows how a host adds a panel of its own. */
const crashTest: PanelDefinition = {
  type: "dev.crash",
  title: () => "崩溃测试",
  icon: Bug,
  area: "center",
  component: CrashTest,
};

function FrameTest() {
  const [loads, setLoads] = useState(0);
  return (
    <>
      <p>加载次数：{loads}</p>
      <iframe
        title="内嵌页面"
        sandbox="allow-scripts"
        srcDoc="内嵌页面"
        onLoad={() => setLoads((count) => count + 1)}
      />
    </>
  );
}

/** An iframe reloads when it moves in the page, which a preview must not do. */
const frameTest: PanelDefinition = {
  type: "dev.frame",
  title: () => "内嵌页面",
  icon: Frame,
  area: "center",
  keepAlive: true,
  component: FrameTest,
};

/** Every scene has an origin of its own, and `*.localhost` is this computer in every browser. */
const sceneOrigins = [0, 1, 2, 3, 4, 5, 6, 7].map(
  (index) => `${location.protocol}//scene-${index}.localhost:${location.port}`,
);

/** A browser without capture can still run scenes as normal pages, which is enough for some tests. */
const sceneStage = new URLSearchParams(location.search).get("sceneStage") === "plain";

/** Waiting a whole minute for code that never ends is no way to test it. */
const soundLimit = new URLSearchParams(location.search).get("soundLimit");

/**
 * Reports go where they go on a site, which the development server does not answer: tests stand in
 * for the server there.
 */
const diagnostics = {
  async send(report: unknown): Promise<string> {
    const response = await fetch("/api/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    if (!response.ok) throw new Error(`The server answered ${response.status}`);
    const { id } = (await response.json()) as { id: string };
    return id;
  },
};

const host = { ...createBrowserHost(), diagnostics };
const root = document.querySelector<HTMLElement>("#root");
if (root)
  await mountEditor(root, {
    host,
    version: "dev",
    compositorUrl: "/compositor.html",
    sceneOrigins,
    ...(sceneStage && { sceneStage: "plain" }),
    ...(soundLimit !== null && { soundLimitMs: Number(soundLimit) }),
    panels: [crashTest, frameTest],
    onWorkbench: (workbench) => {
      Object.assign(window, {
        aqExecute: (call: never) => workbench.session.store?.execute(call),
        // Resolves once what changed is kept, as Ctrl+S does, for tests that reload right after.
        aqSave: () => workbench.save(),
        // For measuring the mix on its own, without an editor around it.
        aqAudio: () => import("@animaquill/audio"),
        // For keeping a project folder in step in the browser tests, without the editor around it.
        aqFolders: async () => ({ host, ...(await import("./folder-lab.ts")) }),
      });
    },
  });
