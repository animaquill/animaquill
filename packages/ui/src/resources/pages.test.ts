import { ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeDocuments } from "../code/documents.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { ResourcePages } from "./pages.ts";

const MAIN = "scenes/a/main.js";
const OTHER = "scenes/a/other.js";

function storeWithScene(): ProjectStore {
  const store = ProjectStore.create(createProject({ name: "项目" }));
  const result = store.execute({
    type: "scene.add",
    params: {
      id: "a",
      scene: { name: "场景", entry: "index.html", runtime: 1 },
      files: { "index.html": "<!doctype html>", "main.js": "one", "other.js": "two" },
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return store;
}

class FakeSession {
  readonly #emitter = new Emitter();
  store: ProjectStore | undefined;
  subscribe = this.#emitter.subscribe;
  constructor(store: ProjectStore) {
    this.store = store;
  }
  change(store: ProjectStore | undefined): void {
    this.store = store;
    this.#emitter.emit();
  }
}

describe("the tabs of the resources tab", () => {
  let store: ProjectStore;
  let session: FakeSession;
  let code: CodeDocuments;
  let pages: ResourcePages;

  /** The tabs in order, as `code:<path>` and `page:<id>`. */
  const tabs = () =>
    pages
      .getSnapshot()
      .tabs.map((tab) => (tab.kind === "code" ? `code:${tab.path}` : `page:${tab.id}`));
  const shown = () => {
    const { page } = pages.getSnapshot();
    return page === undefined ? `code:${code.getSnapshot().active ?? ""}` : `page:${page}`;
  };

  beforeEach(() => {
    store = storeWithScene();
    session = new FakeSession(store);
    code = new CodeDocuments(
      session as unknown as ProjectSession,
      { commandFailed: vi.fn(), closedRemoved: vi.fn() },
      { unsaved: () => Promise.resolve("discard"), overwrite: () => Promise.resolve(undefined) },
    );
    pages = new ResourcePages(session as unknown as ProjectSession, code);
  });

  it("puts files and resources side by side, in the order they were opened", () => {
    code.open(MAIN);
    pages.open("image", "封面");
    code.open(OTHER);
    pages.showCode();
    pages.open("fade", "淡入");
    expect(tabs()).toEqual([`code:${MAIN}`, "page:image", `code:${OTHER}`, "page:fade"]);
    expect(shown()).toBe("page:fade");
    pages.open("image", "封面");
    expect(tabs()).toHaveLength(4);
    expect(shown()).toBe("page:image");
    pages.showCode(MAIN);
    expect(shown()).toBe(`code:${MAIN}`);
  });

  it("shows the tab next to a page that closes, a file as well as another page", () => {
    code.open(MAIN);
    pages.open("image", "封面");
    pages.open("fade", "淡入");
    pages.close("fade");
    expect(shown()).toBe("page:image");
    code.open(OTHER);
    pages.show("image");
    pages.close("image");
    expect(tabs()).toEqual([`code:${MAIN}`, `code:${OTHER}`]);
    // The file after it took its place.
    expect(shown()).toBe(`code:${OTHER}`);
  });

  it("closing a page that is not showing leaves what shows", () => {
    code.open(MAIN);
    pages.open("image", "封面");
    pages.showCode();
    pages.close("image");
    expect(shown()).toBe(`code:${MAIN}`);
  });

  it("shows a page when the last file closes, and the editor when there is no page", async () => {
    code.open(MAIN);
    pages.open("image", "封面");
    pages.showCode();
    await code.close(MAIN);
    expect(tabs()).toEqual(["page:image"]);
    expect(shown()).toBe("page:image");
    pages.close("image");
    expect(pages.getSnapshot()).toEqual({ tabs: [], page: undefined });
    // There is nothing for the code editor to show.
    pages.showCode();
    expect(pages.showsCode).toBe(true);
  });

  it("keeps the place of a file that moved", () => {
    code.open(MAIN);
    pages.open("image", "封面");
    code.open(OTHER);
    code.moving(new Map([[MAIN, "scenes/a/moved.js"]]), () => {
      const result = store.execute({
        type: "file.rename",
        params: { from: MAIN, to: "scenes/a/moved.js" },
      });
      return result.ok;
    });
    expect(tabs()).toEqual(["code:scenes/a/moved.js", "page:image", `code:${OTHER}`]);
  });

  it("follows files that go away in the project", () => {
    code.open(OTHER);
    pages.open("image", "封面");
    store.execute({ type: "file.remove", params: { path: OTHER } });
    expect(tabs()).toEqual(["page:image"]);
    expect(shown()).toBe("page:image");
  });

  it("starts over with another project", () => {
    code.open(MAIN);
    pages.open("image", "封面");
    session.change(storeWithScene());
    expect(pages.getSnapshot()).toEqual({ tabs: [], page: undefined });
  });
});
