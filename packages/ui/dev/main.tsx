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

const root = document.querySelector<HTMLElement>("#root");
if (root)
  await mountEditor(root, {
    host: createBrowserHost(),
    version: "dev",
    panels: [crashTest, frameTest],
  });
