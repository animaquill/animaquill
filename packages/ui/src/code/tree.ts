import { entryOf, type ProjectState } from "@animaquill/core";

export interface FileNode {
  readonly kind: "file";
  readonly path: string;
  readonly name: string;
  /** The scene or sound starts with this file. */
  readonly entry: boolean;
}

/** What a folder stands for, which decides what can be done to it. */
export type FolderRole =
  /** A list of folders, which is not something that exists by itself. */
  | "group"
  /** The folder of a scene, which goes by the name of the scene. */
  | "scene"
  /** The folder of a sound. Nothing here can make or remove one yet. */
  | "sound"
  /** The folder for code that all share. */
  | "shared"
  | "folder";

export interface FolderNode {
  readonly kind: "folder";
  /** The path of the folder, with no slash at the end. */
  readonly path: string;
  readonly name: string;
  readonly role: FolderRole;
  /** The scene or sound it is the folder of. */
  readonly id?: string;
  readonly children: readonly TreeNode[];
}

export type TreeNode = FileNode | FolderNode;

interface Names {
  readonly scenes: string;
  readonly sounds: string;
  readonly shared: string;
}

const collator = new Intl.Collator(undefined, { numeric: true });

const sorted = (nodes: readonly TreeNode[]) =>
  nodes.toSorted(
    (a, b) =>
      Number(b.kind === "folder") - Number(a.kind === "folder") || collator.compare(a.name, b.name),
  );

interface Building {
  readonly files: Map<string, FileNode>;
  readonly folders: Map<string, Building>;
}

const emptyFolder = (): Building => ({ files: new Map(), folders: new Map() });

function addFile(root: Building, folder: string, parts: readonly string[], entry: string): void {
  let building = root;
  for (const part of parts.slice(0, -1)) {
    const next = building.folders.get(part) ?? emptyFolder();
    building.folders.set(part, next);
    building = next;
  }
  const name = parts.at(-1) as string;
  const path = `${folder}/${parts.join("/")}`;
  building.files.set(name, { kind: "file", path, name, entry: parts.join("/") === entry });
}

function nodesOf(building: Building, folder: string): readonly TreeNode[] {
  const folders = [...building.folders].map(([name, content]): FolderNode => {
    const path = `${folder}/${name}`;
    return { kind: "folder", path, name, role: "folder", children: nodesOf(content, path) };
  });
  return sorted([...folders, ...building.files.values()]);
}

/** All paths that start with this folder, by what they are inside of it. */
function inside(paths: readonly string[], folder: string): readonly (readonly string[])[] {
  return paths
    .filter((path) => path.startsWith(`${folder}/`))
    .map((path) => path.slice(folder.length + 1).split("/"));
}

function ownedFolders(
  paths: readonly string[],
  root: "scenes" | "sounds",
  known: ProjectState["scenes"] | ProjectState["sounds"],
): readonly FolderNode[] {
  const ids = new Set([
    ...Object.keys(known ?? {}),
    ...inside(paths, root).map(([id]) => id as string),
  ]);
  const folders = [...ids].map((id): FolderNode => {
    const manifest = entryOf(known, id);
    const path = `${root}/${id}`;
    const building = emptyFolder();
    for (const parts of inside(paths, path)) addFile(building, path, parts, manifest?.entry ?? "");
    return {
      kind: "folder",
      path,
      name: manifest?.name ?? id,
      role: root === "scenes" ? "scene" : "sound",
      id,
      children: nodesOf(building, path),
    };
  });
  return folders.toSorted((a, b) => collator.compare(a.name, b.name));
}

/** The code of a project as people work with it: scenes by their names, then what they share. */
export function fileTree(state: ProjectState, names: Names): readonly FolderNode[] {
  const paths = Object.keys(state.files);
  const scenes = ownedFolders(paths, "scenes", state.scenes);
  const sounds = ownedFolders(paths, "sounds", state.sounds);
  const shared = emptyFolder();
  for (const parts of inside(paths, "code")) addFile(shared, "code", parts, "");
  const group = (path: string, name: string, children: readonly TreeNode[]): FolderNode => ({
    kind: "folder",
    path,
    name,
    role: "group",
    children,
  });
  return [
    group("scenes", names.scenes, scenes),
    ...(sounds.length > 0 ? [group("sounds", names.sounds, sounds)] : []),
    {
      kind: "folder",
      path: "code",
      name: names.shared,
      role: "shared",
      children: nodesOf(shared, "code"),
    },
  ];
}

/** Whether a new file can go in here. What is in a file's folder counts for the file. */
export const takesFiles = (node: TreeNode): boolean =>
  node.kind === "file" || node.role !== "group";

/** Whether people can rename or remove this. What stands for a part of the format stays. */
export const canChange = (node: TreeNode): boolean =>
  node.kind === "file" || node.role === "folder" || node.role === "scene";

/** Every file below something, for what happens to a folder as a whole. */
export function filesIn(node: TreeNode): readonly string[] {
  return node.kind === "file" ? [node.path] : node.children.flatMap(filesIn);
}

/** What is on the screen, in order, for moving through with the keyboard. */
export function visibleRows(
  nodes: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): readonly { readonly node: TreeNode; readonly depth: number }[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === "folder" && !collapsed.has(node.path)
      ? visibleRows(node.children, collapsed, depth + 1)
      : []),
  ]);
}

export function findNode(nodes: readonly TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.kind === "folder" && path.startsWith(`${node.path}/`)) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}
