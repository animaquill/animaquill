import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import type { Action } from "../workbench/actions.ts";
import { fuzzyMatch } from "../workbench/fuzzy.ts";
import { comboOf, formatCombo, isBindable, type KeyCombo } from "../workbench/keys.ts";
import styles from "./KeybindingsPanel.module.css";

interface Conflict {
  readonly combo: KeyCombo;
  readonly owner: string;
}

/** Waits for a key press. A key that is free is taken at once, one that is not has to be confirmed. */
function Recorder({ action, onClose }: { action: Action; onClose: () => void }) {
  const { actions, keybindings } = useWorkbench();
  const { t } = useTranslation();
  const [conflict, setConflict] = useState<Conflict>();
  const [refused, setRefused] = useState<KeyCombo>();
  const root = useRef<HTMLDivElement>(null);
  const { platform } = keybindings;

  useEffect(() => {
    const take = (combo: KeyCombo) => {
      keybindings.assign(action.id, combo);
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // While recording, no other part of the editor or the browser may react to the keys.
      event.preventDefault();
      event.stopPropagation();
      if (event.isComposing || event.repeat) return;
      const combo = comboOf(event, platform);
      if (!combo) return;
      if (combo === "escape") return onClose();
      if (combo === "enter" && conflict) return take(conflict.combo);
      setConflict(undefined);
      setRefused(undefined);
      if (!isBindable(combo)) return setRefused(combo);
      const owner = keybindings.ownerOf(combo);
      if (owner === action.id) return onClose();
      if (owner) return setConflict({ combo, owner });
      take(combo);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [action, conflict, keybindings, onClose, platform]);

  const ownerTitle = conflict && actions.get(conflict.owner)?.title(t);

  return (
    <div ref={root} className={styles.recorder} role="status">
      <span className={styles.prompt}>{t("keys.recording")}</span>
      {refused && (
        <span className={styles.warning}>
          {t("keys.reserved", { key: formatCombo(refused, platform) })}
        </span>
      )}
      {conflict && (
        <span className={styles.warning}>
          {t("keys.conflict", { key: formatCombo(conflict.combo, platform), action: ownerTitle })}
          <button
            type="button"
            onClick={() => {
              keybindings.assign(action.id, conflict.combo);
              onClose();
            }}
          >
            {t("keys.reassign")}
          </button>
          <button type="button" onClick={onClose}>
            {t("keys.cancel")}
          </button>
        </span>
      )}
    </div>
  );
}

interface RowProps {
  readonly action: Action;
  readonly recording: boolean;
  readonly onRecord: (id: string | undefined) => void;
}

function Row({ action, recording, onRecord }: RowProps) {
  const { keybindings } = useWorkbench();
  const { t } = useTranslation();
  const add = useRef<HTMLButtonElement>(null);
  const wasRecording = useRef(false);
  const title = action.title(t);
  const keys = keybindings.keysFor(action.id);

  // The button goes away while recording, so keyboard users need the focus put back.
  useEffect(() => {
    if (wasRecording.current && !recording) add.current?.focus();
    wasRecording.current = recording;
  }, [recording]);

  return (
    <div className={styles.row} data-action={action.id}>
      <span className={styles.name}>{title}</span>
      <div className={styles.keys}>
        {keys.map((combo) => {
          const label = formatCombo(combo, keybindings.platform);
          return (
            <span key={combo} className={styles.key}>
              <kbd>{label}</kbd>
              <button
                type="button"
                aria-label={t("keys.remove", { key: label })}
                onClick={() => keybindings.remove(action.id, combo)}
              >
                <X size={12} />
              </button>
            </span>
          );
        })}
        {keys.length === 0 && !recording && <span className={styles.none}>{t("keys.none")}</span>}
        {!recording && (
          <button
            ref={add}
            type="button"
            className={styles.add}
            aria-label={t("keys.add", { action: title })}
            onClick={() => onRecord(action.id)}
          >
            <Plus size={14} />
          </button>
        )}
        {recording && <Recorder action={action} onClose={() => onRecord(undefined)} />}
      </div>
      {keybindings.isCustomized(action.id) && (
        <button type="button" className={styles.reset} onClick={() => keybindings.reset(action.id)}>
          {t("keys.reset")}
        </button>
      )}
    </div>
  );
}

export function KeybindingsPanel() {
  const { actions, keybindings } = useWorkbench();
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string>();
  useSyncExternalStore(keybindings.subscribe, keybindings.getSnapshot);

  const matches = (action: Action) => {
    const text = query.trim().toLowerCase();
    if (!text) return true;
    const keys = keybindings.keysFor(action.id);
    const labels = keys.map((combo) => formatCombo(combo, keybindings.platform).toLowerCase());
    return fuzzyMatch(query, action.title(t)) !== undefined || labels.some((l) => l.includes(text));
  };
  const rows = actions.list().filter(matches);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          aria-label={t("keys.search")}
          placeholder={t("keys.search")}
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className={styles.reset}
          disabled={!keybindings.hasCustomizations}
          onClick={() => keybindings.resetAll()}
        >
          {t("keys.resetAll")}
        </button>
      </div>
      <p className={styles.hint}>{t("keys.browserHint")}</p>
      {rows.length === 0 && <p className={styles.hint}>{t("keys.empty")}</p>}
      {rows.map((action) => (
        <Row
          key={action.id}
          action={action}
          recording={recording === action.id}
          onRecord={setRecording}
        />
      ))}
    </div>
  );
}
