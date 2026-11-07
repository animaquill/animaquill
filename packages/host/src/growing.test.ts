import { describe, expect, it, vi } from "vitest";
import { dropTarget, growingFile, reopenTarget, type SaveFilePicker } from "./growing.ts";

const KIND = { description: "MP4 视频", mime: "video/mp4", extension: "mp4" };

/** A file of the File System Access API, which only counts once it is closed. */
class FakeFile {
  readonly name: string;
  content = new Uint8Array(0);
  pending = new Uint8Array(0);
  removed = false;
  aborted = false;
  lastModified = Date.now();
  remove?: () => Promise<void> = async () => {
    this.removed = true;
  };

  constructor(name: string) {
    this.name = name;
  }

  async createWritable() {
    this.pending = new Uint8Array(0);
    return {
      write: async ({ data, position }: { data: Uint8Array; position: number }) => {
        const grown = new Uint8Array(Math.max(this.pending.length, position + data.length));
        grown.set(this.pending);
        grown.set(data, position);
        this.pending = grown;
      },
      close: async () => {
        this.content = this.pending;
      },
      abort: async () => {
        this.aborted = true;
      },
    };
  }

  async getFile() {
    return Object.assign(new Blob([this.content]), { lastModified: this.lastModified });
  }
}

class FakeFolder {
  readonly files = new Map<string, FakeFile>();
  readonly folders = new Map<string, FakeFolder>();

  async getDirectoryHandle(name: string) {
    let folder = this.folders.get(name);
    if (!folder) {
      folder = new FakeFolder();
      this.folders.set(name, folder);
    }
    return folder;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    let file = this.files.get(name);
    if (!file && !options?.create) throw new DOMException("missing", "NotFoundError");
    if (!file) {
      file = new FakeFile(name);
      this.files.set(name, file);
    }
    return file;
  }

  async removeEntry(name: string) {
    this.files.delete(name);
  }

  async *keys() {
    yield* this.files.keys();
  }
}

const bytes = (...values: number[]) => new Uint8Array(values);

describe("a file people chose", () => {
  const chosen = () => {
    const file = new FakeFile("片子.mp4");
    const picker = vi.fn<SaveFilePicker>(async () => file as unknown as FileSystemFileHandle);
    return { file, picker };
  };

  it("asks with the name and the kind of file", async () => {
    const { picker } = chosen();
    await growingFile("片子.mp4", KIND, { picker, scratch: undefined, saveFile: vi.fn() });
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: "片子.mp4",
        types: [{ description: "MP4 视频", accept: { "video/mp4": [".mp4"] } }],
      }),
    );
  });

  it("takes writes anywhere, and only counts once it is finished", async () => {
    const { file, picker } = chosen();
    const target = await growingFile("片子.mp4", KIND, {
      picker,
      scratch: undefined,
      saveFile: vi.fn(),
    });
    await target?.write(bytes(1, 2, 3, 4) as Uint8Array<ArrayBuffer>, 0);
    await target?.write(bytes(9) as Uint8Array<ArrayBuffer>, 1);
    expect(file.content).toEqual(bytes());
    await target?.finish();
    expect(target?.kind).toBe("file");
    expect(file.content).toEqual(bytes(1, 9, 3, 4));
  });

  it("goes away when it is abandoned", async () => {
    const { file, picker } = chosen();
    const target = await growingFile("片子.mp4", KIND, {
      picker,
      scratch: undefined,
      saveFile: vi.fn(),
    });
    await target?.write(bytes(1) as Uint8Array<ArrayBuffer>, 0);
    await target?.abandon();
    expect(file.aborted).toBe(true);
    expect(file.removed).toBe(true);
  });

  it("leaves a file alone that has something in it now, which is not this export's", async () => {
    const { file, picker } = chosen();
    const target = await growingFile("片子.mp4", KIND, {
      picker,
      scratch: undefined,
      saveFile: vi.fn(),
    });
    // Another export to the same place, finished meanwhile.
    file.content = bytes(1, 2, 3);
    await target?.abandon();
    expect(file.removed).toBe(false);
  });

  it("says so when an empty file has to stay", async () => {
    const { file, picker } = chosen();
    delete file.remove;
    const target = await growingFile("片子.mp4", KIND, {
      picker,
      scratch: undefined,
      saveFile: vi.fn(),
    });
    await expect(target?.abandon()).rejects.toThrow();
  });

  it("is nothing when people change their minds", async () => {
    const picker = async () => {
      throw new DOMException("no", "AbortError");
    };
    expect(
      await growingFile("片子.mp4", KIND, { picker, scratch: undefined, saveFile: vi.fn() }),
    ).toBeUndefined();
  });
});

describe("a file without a dialog to save it", () => {
  const scratchSetup = () => {
    const root = new FakeFolder();
    const saveFile = vi.fn();
    const options = {
      picker: undefined,
      scratch: async () => root as unknown as FileSystemDirectoryHandle,
      saveFile,
    };
    return { root, saveFile, options };
  };

  it("becomes a download once it is finished, from the disk", async () => {
    const { root, saveFile, options } = scratchSetup();
    const target = await growingFile("片子.mp4", KIND, options);
    expect(target?.kind).toBe("download");
    await target?.write(bytes(5, 6) as Uint8Array<ArrayBuffer>, 0);
    expect(saveFile).not.toHaveBeenCalled();
    await target?.finish();
    expect(saveFile).toHaveBeenCalledOnce();
    const [file, name] = saveFile.mock.calls[0] as [Blob, string];
    expect(name).toBe("片子.mp4");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes(5, 6));
    expect(root.folders.get("exports")?.files.size).toBe(1);
  });

  it("leaves nothing when it is abandoned", async () => {
    const { root, saveFile, options } = scratchSetup();
    const target = await growingFile("片子.mp4", KIND, options);
    await target?.write(bytes(5) as Uint8Array<ArrayBuffer>, 0);
    expect(root.folders.get("exports")?.files.size).toBe(1);
    await target?.abandon();
    expect(saveFile).not.toHaveBeenCalled();
    expect(root.folders.get("exports")?.files.size).toBe(0);
  });

  it("cleans up after downloads that are long over, and leaves the others", async () => {
    const { root, options } = scratchSetup();
    const folder = await root.getDirectoryHandle("exports");
    (await folder.getFileHandle("old.mp4", { create: true })).lastModified =
      Date.now() - 2 * 3600_000;
    await folder.getFileHandle("recent.mp4", { create: true });
    const target = await growingFile("片子.mp4", KIND, options);
    // Only once there is something to write.
    expect([...folder.files.keys()]).toContain("old.mp4");
    await target?.write(bytes(5) as Uint8Array<ArrayBuffer>, 0);
    expect([...folder.files.keys()]).not.toContain("old.mp4");
    expect([...folder.files.keys()]).toContain("recent.mp4");
  });
});

describe("a file to go back to after a reload", () => {
  it("is the file people chose, if it is there and may be written", async () => {
    const file = new FakeFile("片子.mp4");
    const picker = async () => file as unknown as FileSystemFileHandle;
    const chosen = await growingFile("片子.mp4", KIND, {
      picker,
      scratch: undefined,
      saveFile: vi.fn(),
    });
    const reopened = await reopenTarget(chosen?.target, KIND, {
      picker: undefined,
      scratch: undefined,
      saveFile: vi.fn(),
    });
    if (typeof reopened === "string") throw new Error(reopened);
    await reopened.write(bytes(1, 2) as Uint8Array<ArrayBuffer>, 0);
    await reopened.finish();
    expect(file.content).toEqual(bytes(1, 2));
  });

  it("asks whether it may be written, and says so when not", async () => {
    const file = Object.assign(new FakeFile("片子.mp4"), {
      queryPermission: async () => "prompt" as const,
      requestPermission: vi.fn(async () => "denied" as const),
    });
    const target = { kind: "file", handle: file };
    const options = { picker: undefined, scratch: undefined, saveFile: vi.fn() };
    expect(await reopenTarget(target, KIND, options)).toBe("denied");
    expect(file.requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  it("says so when the file is gone", async () => {
    const file = Object.assign(new FakeFile("片子.mp4"), {
      getFile: async () => {
        throw new DOMException("gone", "NotFoundError");
      },
    });
    const options = { picker: undefined, scratch: undefined, saveFile: vi.fn() };
    expect(await reopenTarget({ kind: "file", handle: file }, KIND, options)).toBe("gone");
  });

  it("is a download again for a download", async () => {
    const root = new FakeFolder();
    const saveFile = vi.fn();
    const options = {
      picker: undefined,
      scratch: async () => root as unknown as FileSystemDirectoryHandle,
      saveFile,
    };
    const reopened = await reopenTarget({ kind: "download", name: "片子.mp4" }, KIND, options);
    if (typeof reopened === "string") throw new Error(reopened);
    expect(reopened.kind).toBe("download");
    await reopened.write(bytes(3) as Uint8Array<ArrayBuffer>, 0);
    await reopened.finish();
    expect(saveFile.mock.calls[0]?.[1]).toBe("片子.mp4");
  });
});

describe("the file of an export that is given up", () => {
  /** A handle as Chrome has it, which knows whether it is the same file as another. */
  const handleOf = (file: FakeFile, permission: PermissionState = "granted") =>
    Object.assign(file, {
      isSameEntry: async (other: unknown) => other === file,
      queryPermission: async () => permission,
      requestPermission: vi.fn(async () => "granted" as PermissionState),
    });

  it("goes while it is the empty one the export made", async () => {
    const file = handleOf(new FakeFile("片子.mp4"));
    expect(await dropTarget({ kind: "file", handle: file }, [], false)).toBe(false);
    expect(file.removed).toBe(true);
  });

  it("stays when another export goes to the same place", async () => {
    const file = handleOf(new FakeFile("片子.mp4"));
    const target = { kind: "file", handle: file };
    const other = { kind: "file", handle: file };
    expect(await dropTarget(target, [{ kind: "download", name: "x" }, other], false)).toBe(false);
    expect(file.removed).toBe(false);
  });

  it("stays when there is something in it, from somewhere else", async () => {
    const file = handleOf(new FakeFile("片子.mp4"));
    file.content = new Uint8Array([1]);
    expect(await dropTarget({ kind: "file", handle: file }, [], false)).toBe(false);
    expect(file.removed).toBe(false);
  });

  it("asks only when it may, and else stays and says so", async () => {
    const file = handleOf(new FakeFile("片子.mp4"), "prompt");
    expect(await dropTarget({ kind: "file", handle: file }, [], false)).toBe(true);
    expect(file.requestPermission).not.toHaveBeenCalled();
    expect(file.removed).toBe(false);
    expect(await dropTarget({ kind: "file", handle: file }, [], true)).toBe(false);
    expect(file.removed).toBe(true);
  });

  it("is nothing to take away for a download", async () => {
    expect(await dropTarget({ kind: "download", name: "片子.mp4" }, [], true)).toBe(false);
  });
});
