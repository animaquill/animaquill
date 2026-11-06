import type { ComponentType, MouseEvent } from "react";
import { Tip } from "../app/Tip.tsx";
import { useWorkbench } from "../app/context.ts";
import { formatCombo } from "../workbench/keys.ts";
import type { TimelineAction } from "./actions.ts";
import styles from "./TimelinePanel.module.css";

interface ToolButtonProps {
  readonly name: string;
  readonly usage: string;
  /** The action whose key to show. People can change it, so it is looked up. */
  readonly action?: TimelineAction;
  readonly icon: ComponentType<{ size?: number }>;
  /** Written next to the icon, where there is room. */
  readonly text?: string;
  readonly pressed?: boolean;
  /** Turns something on and off, as opposed to choosing what the mouse does. */
  readonly isSwitch?: boolean;
  readonly unavailable?: boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

export function ToolButton(props: ToolButtonProps) {
  const { name, usage, action, icon: Icon, text, pressed, isSwitch, unavailable, onClick } = props;
  const { keybindings } = useWorkbench();
  const combo = action && keybindings.keysFor(`timeline.${action}`)[0];
  return (
    <Tip
      name={name}
      usage={usage}
      shortcut={combo ? formatCombo(combo, keybindings.platform) : undefined}
    >
      <button
        type="button"
        className={isSwitch ? styles.switch : styles.button}
        aria-label={name}
        aria-description={usage}
        // Not `disabled`: a disabled button gets no mouse events, and it still has to explain itself.
        {...(unavailable ? { "aria-disabled": true } : {})}
        {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
        onClick={(event) => {
          if (!unavailable) onClick(event);
        }}
      >
        <Icon size={15} />
        {text && <span className={styles.buttonLabel}>{text}</span>}
      </button>
    </Tip>
  );
}
