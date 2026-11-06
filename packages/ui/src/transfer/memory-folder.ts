import type { FolderFile, SourceFolder, TargetFolder, WriteOptions } from "@animaquill/host";

type Content = string | Uint8Array<ArrayBuffer> | Blob;

/** For tests: a folder people chose, with these files in it. */
export function memorySource(
  name: string,
  contents: Iterable<readonly [string, Content]>,
): SourceFolder {
  const entries = [...contents];
  return {
    name,
    async *files() {
      for (const [path, content] of entries) {
        const file: FolderFile = {
          path,
          read: async () => new File([content], path.split("/").at(-1) as string),
        };
        yield file;
      }
    },
  };
}

/** For tests: a new folder, which remembers what happened to it. */
export class MemoryTarget implements TargetFolder {
  readonly name: string;
  readonly kind: "folder" | "archive" = "folder";
  readonly files = new Map<string, Blob>();
  /** Paths in the order they were written. */
  readonly written: string[] = [];
  finished = false;
  abandoned = false;
  /** Runs before every file. Throw from it to make writing fail at that point. */
  beforeWrite: ((path: string) => Promise<void> | void) | undefined;
  /** Some of it stays when taking it back. */
  stuck = false;
  /** Says which paths this folder cannot have. */
  refuses: (path: string) => boolean = () => false;

  constructor(name = "导出") {
    this.name = name;
  }

  async write(path: string, content: Blob, { signal, onProgress }: WriteOptions = {}) {
    await this.beforeWrite?.(path);
    signal?.throwIfAborted();
    if (this.refuses(path)) return false;
    this.files.set(path, content);
    this.written.push(path);
    onProgress?.(content.size);
    return true;
  }

  async remove(path: string) {
    this.files.delete(path);
  }

  async finish() {
    this.finished = true;
  }

  async abandon() {
    if (this.stuck) throw new Error("in use");
    this.abandoned = true;
    this.files.clear();
  }

  /** What people get when they choose this folder later. */
  asSource(): SourceFolder {
    return memorySource(this.name, this.files);
  }

  async text(path: string): Promise<string | undefined> {
    return this.files.get(path)?.text();
  }

  /** The text files, to compare two exports. */
  async texts(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const [path, file] of this.files) {
      if (!path.startsWith("assets/")) result.set(path, await file.text());
    }
    return result;
  }
}
