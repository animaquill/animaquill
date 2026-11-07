import { ChevronDown, ChevronRight, FilePlus, FileCode, Folder, Plus, Star } from "lucide-react";
import { useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { PopupMenu, type MenuItem } from "../app/Menu.tsx";
import { Tip } from "../app/Tip.tsx";
import { formatCombo } from "../workbench/keys.ts";
import { canChange, takesFiles, visibleRows, type TreeNode } from "./tree.ts";
import styles from "./FilesPanel.module.css";

interface Popup {
  readonly x: number;
  readonly y: number;
  readonly groups: readonly (readonly MenuItem[])[];
}

const rowId = (path: string) => `file-${encodeURIComponent(path)}`;

function isSceneFile(node: TreeNode) {
  return node.kind === "file" && node.path.startsWith("scenes/") && !node.entry;
}

export function FilesPanel() {
  const { files, timeline, keybindings } = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  // The tree comes from the project, so every change of the project can change it.
  useProject(store);
  const { selected, collapsed } = useSyncExternalStore(files.subscribe, files.getSnapshot);
  const [popup, setPopup] = useState<Popup>();
  const rows = visibleRows(files.tree, collapsed);

  const shortcut = (id: string) => {
    const [key] = keybindings.keysFor(id);
    return key === undefined ? {} : { shortcut: formatCombo(key, keybindings.platform) };
  };

  const openMenu = (event: MouseEvent, node: TreeNode) => {
    event.preventDefault();
    event.stopPropagation();
    files.select(node.path);
    const items: MenuItem[] = [];
    if (takesFiles(node)) {
      items.push({ id: "new", label: t("files.newFile"), run: () => void files.newFile(node) });
    }
    if (isSceneFile(node)) {
      items.push({
        id: "entry",
        label: t("files.setEntry"),
        run: () => files.setEntry(node.path),
      });
    }
    const changes: MenuItem[] = canChange(node)
      ? [
          {
            id: "rename",
            label: t("files.renameAction"),
            run: () => void files.rename(node),
            ...shortcut("files.rename"),
          },
          {
            id: "remove",
            label: t("files.removeAction"),
            run: () => void files.remove(node),
            ...shortcut("files.remove"),
          },
        ]
      : [];
    const groups = [items, changes].filter((group) => group.length > 0);
    if (groups.length > 0) setPopup({ x: event.clientX, y: event.clientY, groups });
  };

  /** The keys of a tree, as in any other: arrows move, and left and right close and open. */
  const onKeyDown = (event: KeyboardEvent) => {
    const index = rows.findIndex(({ node }) => node.path === selected);
    const current = rows[index]?.node;
    const moveTo = (next: number) => {
      const row = rows[Math.max(Math.min(next, rows.length - 1), 0)];
      if (row) files.select(row.node.path);
    };
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "ArrowDown") {
      handled();
      moveTo(index + 1);
    } else if (event.key === "ArrowUp") {
      handled();
      moveTo(index - 1);
    } else if (event.key === "Home") {
      handled();
      moveTo(0);
    } else if (event.key === "End") {
      handled();
      moveTo(rows.length - 1);
    } else if (event.key === "Enter" && current) {
      handled();
      files.activate(current);
    } else if (event.key === "ArrowRight" && current?.kind === "folder") {
      handled();
      if (collapsed.has(current.path)) files.setCollapsed(current.path, false);
      else moveTo(index + 1);
    } else if (event.key === "ArrowLeft" && current?.kind === "folder") {
      handled();
      if (!collapsed.has(current.path)) files.setCollapsed(current.path, true);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <button type="button" onClick={() => void files.newFile()}>
          <FilePlus size={14} />
          {t("files.newFile")}
        </button>
        <button type="button" onClick={() => timeline.createScene()}>
          <Plus size={14} />
          {t("assets.newScene")}
        </button>
      </div>
      <div
        className={styles.tree}
        role="tree"
        tabIndex={0}
        aria-label={t("panel.files.title")}
        {...(selected !== undefined && { "aria-activedescendant": rowId(selected) })}
        onKeyDown={onKeyDown}
      >
        {rows.map(({ node, depth }) => {
          const open = node.kind === "folder" && !collapsed.has(node.path);
          return (
            <div
              key={node.path}
              id={rowId(node.path)}
              className={styles.row}
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={node.path === selected}
              {...(node.kind === "folder" && { "aria-expanded": open })}
              data-group={(node.kind === "folder" && node.role === "group") || undefined}
              style={{ paddingLeft: `${depth * 12 + 6}px` }}
              title={node.path}
              onClick={() => files.activate(node)}
              onContextMenu={(event) => openMenu(event, node)}
            >
              {node.kind === "folder" ? (
                <>
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Folder size={14} className={styles.icon} />
                </>
              ) : (
                <FileCode size={14} className={styles.icon} />
              )}
              <span className={styles.name}>{node.name}</span>
              {node.kind === "file" && node.entry && (
                <Tip name={t("files.entry")} usage={t("files.entryUsage")}>
                  <Star size={11} className={styles.entry} aria-label={t("files.entry")} />
                </Tip>
              )}
            </div>
          );
        })}
      </div>
      {popup && (
        <PopupMenu
          label={t("panel.files.title")}
          x={popup.x}
          y={popup.y}
          groups={popup.groups}
          onClose={() => setPopup(undefined)}
        />
      )}
    </div>
  );
}
