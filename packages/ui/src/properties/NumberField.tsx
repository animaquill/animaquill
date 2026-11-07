import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { NumberEdit, type NumberEditProps } from "./number-edit.ts";
import { formatNumber } from "./scrub.ts";
import styles from "./PropertiesPanel.module.css";

interface NumberFieldProps extends NumberEditProps {
  readonly label: string;
  /** Shown instead of a number that is not its own. */
  readonly placeholder: string;
  readonly animated: boolean;
}

/** Moves the keyboard back to the tab, where undo means the project again. */
const leave = (input: HTMLInputElement) =>
  input.closest<HTMLElement>("[tabindex]")?.focus({ preventScroll: true });

export function NumberField(props: NumberFieldProps) {
  const { label, spec, value, automatic, placeholder, animated, readOnly } = props;
  const [field] = useState(() => new NumberEdit(props));
  const { typed, dragged } = useSyncExternalStore(field.subscribe, field.getSnapshot);
  const input = useRef<HTMLInputElement>(null);
  const isDragged = dragged !== undefined;

  useLayoutEffect(() => field.update(props));
  useEffect(() => () => field.dispose(), [field]);

  useEffect(() => {
    if (!isDragged) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      field.cancelDrag();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [field, isDragged]);

  const shown = dragged ?? value;
  const text = automatic && !isDragged ? placeholder : formatNumber(shown, spec);

  const onPointerDown = (event: PointerEvent<HTMLInputElement>) => {
    if (event.button !== 0) return;
    const { activeElement } = document;
    if (activeElement !== event.currentTarget && activeElement instanceof HTMLInputElement) {
      activeElement.blur();
    }
    if (!field.press(event.pointerId, event.clientX)) return;
    leave(event.currentTarget);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || typed === undefined) return;
    if (event.key === "Escape") field.discardTyping();
    else if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    leave(event.currentTarget);
  };

  return (
    <input
      ref={input}
      className={styles.number}
      role="spinbutton"
      aria-label={label}
      aria-valuenow={shown}
      aria-valuetext={text}
      {...(spec.min === undefined ? {} : { "aria-valuemin": spec.min })}
      {...(spec.max === undefined ? {} : { "aria-valuemax": spec.max })}
      {...(field.isInvalid ? { "aria-invalid": true } : {})}
      data-animated={animated || undefined}
      data-typing={typed !== undefined || undefined}
      value={typed ?? text}
      readOnly={readOnly || typed === undefined}
      spellCheck={false}
      autoComplete="off"
      inputMode="decimal"
      onChange={(event) => field.type(event.target.value)}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        const keys = { shift: event.shiftKey, alt: event.altKey };
        field.move(event.pointerId, event.clientX, keys);
      }}
      onPointerUp={(event) => {
        if (field.release(event.pointerId)) input.current?.focus();
      }}
      onPointerCancel={() => field.cancelDrag()}
      onLostPointerCapture={() => field.cancelDrag()}
      // The mouse would put the caret in and start selecting, and this is about to be a drag.
      onMouseDown={(event) => {
        if (!readOnly && typed === undefined) event.preventDefault();
      }}
      onFocus={() => {
        field.startTyping();
        // Selecting takes the focus as well, and people can have left by the next frame.
        requestAnimationFrame(() => {
          if (document.activeElement === input.current) input.current?.select();
        });
      }}
      onBlur={() => field.finishTyping()}
      onKeyDown={onKeyDown}
    />
  );
}
