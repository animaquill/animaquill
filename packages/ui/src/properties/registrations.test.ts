import { ProjectStore, sceneSourceOf, type ClipState } from "@animaquill/core";
import type { WorkCache } from "@animaquill/host";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { ClipDescriptions, SceneRegistrations } from "./registrations.ts";

class MemoryCache implements WorkCache {
  readonly kept = new Map<string, unknown>();
  reads = 0;

  async read(key: string) {
    this.reads += 1;
    return structuredClone(this.kept.get(key));
  }

  async write(key: string, value: unknown) {
    this.kept.set(key, structuredClone(value));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const registered = (id = "arm") => ({
  objects: [{ id, properties: [{ path: "x", type: "number" }] }],
  elements: [{ id: "logo", kind: "html" }],
  complete: true,
});

/** What a clip holds for parameters, the way a registration compares it. */
const holding =
  (params: Readonly<Record<string, unknown>> = {}) =>
  (path: string) =>
    JSON.stringify(params[path] ?? null);

describe("what scenes registered", () => {
  it("is what came, read like anything from a sandbox, also as JSON", () => {
    const registrations = new SceneRegistrations();
    registrations.open("p");
    registrations.note(
      "r1",
      JSON.stringify({
        ...registered(),
        objects: [{ id: "bad id", properties: [] }, ...registered().objects],
      }),
    );
    const found = registrations.registrationOf("r1", holding());
    expect(found?.registration.objects.map(({ id }) => id)).toEqual(["arm"]);
    expect(found?.exact).toBe(true);
    expect(registrations.problemsOf("r1")).toEqual([{ code: "object-id", target: "bad id" }]);
    expect(registrations.registrationOf("r2", holding())).toBeUndefined();
  });

  it("only says that something changed when it did", () => {
    const registrations = new SceneRegistrations();
    registrations.open("p");
    let heard = 0;
    registrations.subscribe(() => (heard += 1));
    registrations.note("r1", registered());
    const first = registrations.registrationOf("r1", holding())?.registration;
    registrations.note("r1", structuredClone(registered()));
    expect(heard).toBe(1);
    expect(registrations.registrationOf("r1", holding())?.registration).toBe(first);
    registrations.note("r1", registered("leg"));
    expect(heard).toBe(2);
    registrations.note("r1", "nothing of the kind");
    expect(heard).toBe(2);
  });

  it("goes by the parameters that code read, for each clip of a scene", () => {
    const registrations = new SceneRegistrations();
    registrations.open("p");
    const counted = (count: number, ids: readonly string[]) => ({
      objects: ids.map((id) => ({ id, properties: [] })),
      elements: [],
      complete: true,
      params: { "param.count": count },
    });
    registrations.note("r1", counted(1, ["bar0"]));
    registrations.note("r1", counted(2, ["bar0", "bar1"]));
    const one = registrations.registrationOf("r1", holding({ "param.count": 1 }));
    const two = registrations.registrationOf("r1", holding({ "param.count": 2 }));
    const three = registrations.registrationOf("r1", holding({ "param.count": 3 }));
    expect(one?.registration.objects.map(({ id }) => id)).toEqual(["bar0"]);
    expect(two?.registration.objects.map(({ id }) => id)).toEqual(["bar0", "bar1"]);
    // Nothing ran with three yet: what ran last shows what there probably is.
    expect(three?.exact).toBe(false);
    expect(three?.registration).toBe(two?.registration);
  });

  it("is not all there is once the scene says it is not sure any more", () => {
    const registrations = new SceneRegistrations();
    registrations.open("p");
    const params = registrations.note("r1", registered()) ?? "";
    registrations.unsure("r1", params);
    expect(registrations.registrationOf("r1", holding())?.registration.complete).toBe(false);
    expect(registrations.registrationOf("r1", holding())?.registration.objects).toHaveLength(1);
  });

  it("is there for the next page, by project, with every run of a scene", async () => {
    const cache = new MemoryCache();
    const before = new SceneRegistrations(cache);
    before.open("p");
    before.note("r1", { ...registered(), params: { "param.n": 1 } });
    before.note("r1", { ...registered("leg"), params: { "param.n": 2 } });
    await settle();
    const after = new SceneRegistrations(cache);
    after.open("p");
    let heard = 0;
    after.subscribe(() => (heard += 1));
    expect(after.registrationOf("r1", holding({ "param.n": 1 }))).toBeUndefined();
    await settle();
    expect(heard).toBe(1);
    const one = after.registrationOf("r1", holding({ "param.n": 1 }));
    expect(one?.registration.objects[0]?.id).toBe("arm");
    expect(after.registrationOf("r1", holding({ "param.n": 2 }))?.registration.objects[0]?.id).toBe(
      "leg",
    );
    const other = new SceneRegistrations(cache);
    other.open("another");
    other.registrationOf("r1", holding());
    await settle();
    expect(other.registrationOf("r1", holding())).toBeUndefined();
  });

  it("takes nothing from the cache that does not make sense, and asks it once", async () => {
    const cache = new MemoryCache();
    cache.kept.set("scene-objects p r1", { version: 2, runs: [{ objects: "x" }] });
    cache.kept.set("scene-objects p r2", { version: 1, registration: registered() });
    const registrations = new SceneRegistrations(cache);
    registrations.open("p");
    registrations.registrationOf("r1", holding());
    registrations.registrationOf("r2", holding());
    registrations.registrationOf("r1", holding());
    await settle();
    expect(registrations.registrationOf("r1", holding())).toBeUndefined();
    expect(registrations.registrationOf("r2", holding())).toBeUndefined();
    expect(cache.reads).toBe(2);
  });

  it("forgets what another project registered", () => {
    const registrations = new SceneRegistrations();
    registrations.open("p");
    registrations.note("r1", registered());
    registrations.open("q");
    expect(registrations.registrationOf("r1", holding())).toBeUndefined();
  });
});

describe("what describes a clip", () => {
  function setup() {
    const store = ProjectStore.create(createProject({ name: "描述" }));
    const scene = { name: "场景", entry: "index.html", runtime: 1 };
    store.execute({
      type: "scene.add",
      params: { id: "a", manifest: scene, files: { "index.html": "<p>a</p>" } },
    });
    const clip = {
      id: "c",
      start: "0",
      duration: "5",
      track: "t",
      source: { kind: "scene", scene: "a" },
    } as ClipState;
    const registrations = new SceneRegistrations();
    registrations.open("p");
    return { store, clip, registrations, descriptions: new ClipDescriptions(registrations) };
  }

  it("stays the same object for as long as it says the same", () => {
    const { store, clip, descriptions } = setup();
    const first = descriptions.describe(store.getState(), clip);
    store.execute({ type: "project.rename", params: { name: "另一个名字" } });
    expect(descriptions.describe(store.getState(), clip)).toBe(first);
  });

  it("is another one once the scene registered something", () => {
    const { store, clip, registrations, descriptions } = setup();
    const before = descriptions.describe(store.getState(), clip);
    expect(before.ran).toBe("never");
    const source = sceneSourceOf(store.getState(), "a");
    registrations.note(source?.revision ?? "", registered());
    const after = descriptions.describe(store.getState(), clip);
    expect(after).not.toBe(before);
    expect(after.ran).toBe("complete");
    expect(after.objects.map(({ id }) => id)).toContain("object.arm");
  });
});
