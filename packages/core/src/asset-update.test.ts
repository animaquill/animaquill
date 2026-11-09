import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { ProjectStore } from "./store.ts";

/** The example project without its locked tag: its overlay track is locked, and uses a logo. */
function example(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("The example did not open");
  return store;
}

const HASH = "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU=";
const OTHER = "sha256-LCa0a2j_xo_5m0U8HTBBNBNCLXBkg7-g-YpeiGJm564=";

function withAsset() {
  const store = ProjectStore.create(createProject({ name: "素材" }));
  const added = store.execute({
    type: "asset.add",
    params: {
      id: "asset_a",
      asset: {
        name: "a.png",
        kind: "image",
        path: "assets/a.png",
        storage: "local",
        hash: HASH,
        size: 3,
      },
    },
  });
  expect(added.ok).toBe(true);
  return store;
}

describe("updating an asset", () => {
  it("changes where its file is and what it is, as one step that can be undone", () => {
    const store = withAsset();
    const result = store.execute({
      type: "asset.update",
      params: { asset: "asset_a", changes: { path: "assets/新的.png", hash: OTHER, size: 5 } },
    });
    expect(result.ok).toBe(true);
    expect(store.getState().assets?.["asset_a"]).toMatchObject({
      path: "assets/新的.png",
      hash: OTHER,
      size: 5,
      name: "a.png",
    });
    store.undo();
    expect(store.getState().assets?.["asset_a"]).toMatchObject({
      path: "assets/a.png",
      hash: HASH,
    });
  });

  it("refuses what the format does not allow, and an asset that is not there", () => {
    const store = withAsset();
    const outside = store.execute({
      type: "asset.update",
      params: { asset: "asset_a", changes: { path: "../外面.png" } },
    });
    expect(outside).toMatchObject({ ok: false, error: { code: "invalid-value" } });
    const missing = store.execute({
      type: "asset.update",
      params: { asset: "asset_b", changes: { size: 1 } },
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("refuses another file for an asset that a clip on a locked track has, as any change there", () => {
    const store = example();
    const locked = store.execute({
      type: "asset.update",
      params: { asset: "logo", changes: { hash: OTHER } },
    });
    expect(locked).toMatchObject({ ok: false, error: { code: "track-locked" } });
    expect(store.getState().assets?.["logo"]?.hash).toBeUndefined();
    const open = store.execute({
      type: "asset.update",
      params: { asset: "interview", changes: { hash: OTHER } },
    });
    expect(open.ok).toBe(true);
  });
});
