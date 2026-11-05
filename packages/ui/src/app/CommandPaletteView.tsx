import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { formatCombo } from "../workbench/keys.ts";
import styles from "./CommandPaletteView.module.css";
import { useWorkbench } from "./context.ts";

const PAGE = 8;

const reveal = (element: HTMLElement | null) => element?.scrollIntoView({ block: "nearest" });

function Highlighted({ text, positions }: { text: string; positions: readonly number[] }) {
  const marked = new Set(positions);
  const parts: { start: number; text: string; marked: boolean }[] = [];
  [...text].forEach((character, index) => {
    const last = parts.at(-1);
    if (last && last.marked === marked.has(index)) last.text += character;
    else parts.push({ start: index, text: character, marked: marked.has(index) });
  });
  return (
    <span className={styles.title}>
      {parts.map((part) => (part.marked ? <mark key={part.start}>{part.text}</mark> : part.text))}
    </span>
  );
}

function Dialog() {
  const { palette, keybindings } = useWorkbench();
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [previousFocus] = useState(() => document.activeElement as HTMLElement | null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const entries = useMemo(() => palette.search(query, t), [palette, query, t]);

  useEffect(() => {
    input.current?.focus();
    return () => previousFocus?.focus();
  }, [previousFocus]);

  const move = (step: number) => {
    if (entries.length === 0) return;
    setActive((active + step + entries.length) % entries.length);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // During composition Enter and Esc belong to the input method.
    if (event.nativeEvent.isComposing) return;
    const handlers: Record<string, () => void> = {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      PageDown: () => setActive(Math.min(active + PAGE, entries.length - 1)),
      PageUp: () => setActive(Math.max(active - PAGE, 0)),
      Enter: () => {
        const entry = entries[active];
        if (entry) palette.run(entry.action);
      },
      Escape: () => palette.close(),
      Tab: () => {},
    };
    const handler = handlers[event.key];
    if (!handler) return;
    event.preventDefault();
    handler();
  };

  const showGroups = !query.trim() && entries.some((entry) => entry.recent);
  const optionId = (index: number) => `${id}-${index}`;

  return (
    <div
      className={styles.overlay}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) palette.close();
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
      >
        <input
          ref={input}
          className={styles.input}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={entries.length > 0 ? optionId(active) : undefined}
          aria-label={t("palette.title")}
          placeholder={t("palette.placeholder")}
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div id={`${id}-list`} className={styles.list} role="listbox">
          {entries.length === 0 && <div className={styles.empty}>{t("palette.empty")}</div>}
          {entries.map((entry, index) => {
            const combo = keybindings.keysFor(entry.action.id)[0];
            const shortcut = combo && formatCombo(combo, keybindings.platform);
            const startsOthers = showGroups && !entry.recent && entries[index - 1]?.recent;
            return (
              <div key={entry.action.id} role="presentation">
                {showGroups && index === 0 && (
                  <div className={styles.group}>{t("palette.recent")}</div>
                )}
                {startsOthers && <div className={styles.group}>{t("palette.others")}</div>}
                <div
                  ref={index === active ? reveal : undefined}
                  id={optionId(index)}
                  className={styles.option}
                  role="option"
                  aria-selected={index === active}
                  {...(shortcut ? { "aria-keyshortcuts": shortcut } : {})}
                  onMouseMove={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => palette.run(entry.action)}
                >
                  <Highlighted text={entry.title} positions={entry.positions} />
                  {shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function CommandPaletteView() {
  const { palette } = useWorkbench();
  const open = useSyncExternalStore(palette.subscribe, palette.isOpen);
  return open ? <Dialog /> : null;
}
