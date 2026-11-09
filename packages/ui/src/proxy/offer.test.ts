import { ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import type { NotificationAction } from "../workbench/notifications.ts";
import type { QualityChoice } from "../preview/quality.ts";
import { offerProxy } from "./offer.ts";

const HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function setup({ quality = "auto", offers = true }: { quality?: QualityChoice; offers?: boolean }) {
  const store = ProjectStore.create(createProject({ name: "片子" }));
  const added = store.execute({
    type: "asset.add",
    params: {
      id: "asset_video",
      asset: {
        kind: "video",
        storage: "local",
        path: "assets/a.mp4",
        hash: HASH,
        name: "手机.mp4",
      },
    },
  });
  expect(added.ok).toBe(true);
  const made: string[] = [];
  const said: { message: string; actions: readonly NotificationAction[] }[] = [];
  const offer = (hash: string) =>
    offerProxy(
      {
        proxies: {
          offer: (_hash, show) => {
            if (offers) show();
          },
          make: (wanted) => void made.push(wanted),
        },
        store,
        quality: () => quality,
        notify: (message, actions) => void said.push({ message, actions }),
        words: { text: (name) => `“${name}”解码太慢`, make: "生成代理" },
      },
      hash,
    );
  return { offer, made, said };
}

describe("offering the proxy of a video that decodes too slowly", () => {
  it("names the video, and makes the proxy only when people say so", () => {
    const { offer, made, said } = setup({});
    offer(HASH);
    expect(said.map(({ message }) => message)).toEqual(["“手机.mp4”解码太慢"]);
    expect(made).toEqual([]);
    said[0]?.actions[0]?.run();
    expect(made).toEqual([HASH]);
  });

  it("says nothing at full quality, where the preview never decodes a proxy", () => {
    const { offer, said } = setup({ quality: "full" });
    offer(HASH);
    expect(said).toEqual([]);
  });

  it("says nothing where the proxies say no, as the second time", () => {
    const { offer, said } = setup({ offers: false });
    offer(HASH);
    expect(said).toEqual([]);
  });
});
