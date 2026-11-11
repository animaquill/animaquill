import { describe, expect, it } from "vitest";
import { createProject, newFormat } from "./create.ts";
import { ProjectManifest } from "./documents.ts";

describe("the format of a new project", () => {
  it("is one of the shapes, at the frame rate people chose", () => {
    expect(newFormat("landscape", "30")).toEqual({
      id: "landscape",
      name: "横屏",
      width: 1920,
      height: 1080,
      fps: "30",
    });
    expect(newFormat("portrait", "60")).toMatchObject({ width: 1080, height: 1920, fps: "60" });
    expect(newFormat("square", "30")).toMatchObject({ width: 1080, height: 1080 });
  });

  it("is a size of people's own only where the format of a project takes it", () => {
    expect(newFormat("custom", "30", { width: 1280, height: 720 })).toMatchObject({
      id: "custom",
      width: 1280,
      height: 720,
    });
    expect(newFormat("custom", "30", { width: 0, height: 720 })).toBeUndefined();
    expect(newFormat("custom", "30", { width: 12.5, height: 720 })).toBeUndefined();
    expect(newFormat("custom", "30")).toBeUndefined();
    expect(newFormat("landscape", "abc")).toBeUndefined();
  });

  it("is what the project is made in, which the format takes", () => {
    const format = newFormat("portrait", "60");
    const project = createProject({ name: "竖的", ...(format && { format }) });
    expect(project.manifest.formats).toEqual([format]);
    expect(project.manifest.fps).toBe("60");
    expect(ProjectManifest.safeParse(project.manifest).success).toBe(true);
  });
});
