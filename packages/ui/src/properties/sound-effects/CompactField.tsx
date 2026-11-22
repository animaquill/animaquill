import type { PropertySpec } from "@animaquill/schema";
import { Diamond } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { CONTROLS, PlainValue, RowButton } from "../controls.tsx";
import { keyEdit, writeEdit } from "../inspect.ts";
import type { PropertyRows } from "../rows.ts";
import styles from "../PropertiesPanel.module.css";

/**
 * One property as a small field with its key beside it, for a row that has several: what the
 * equalizer shows under its graph, a band to a row.
 */
export function CompactField({
  rows,
  clip,
  spec,
  label,
  readOnly,
}: {
  rows: PropertyRows;
  clip: string;
  spec: PropertySpec;
  /** What it is called, with the band: “中频 2 增益”. */
  label: string;
  readOnly: boolean;
}) {
  const { properties } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(rows.subscribe, () => rows.signatureOf(clip, spec));
  const inspected = rows.inspect(clip, spec);
  if (!inspected) return null;
  const { row, blocked } = inspected;
  const still = readOnly || blocked !== undefined;
  const Control = CONTROLS[spec.type] ?? PlainValue;
  const now = () => rows.inspect(clip, spec) ?? inspected;
  const key = !still ? keyEdit(clip, row, inspected.time) : undefined;
  const onKey = row.keyTime !== undefined;
  return (
    <div
      className={styles.compactField}
      role="group"
      aria-label={label}
      onFocusCapture={() => properties.noteProperty(clip, spec)}
      onPointerDownCapture={() => properties.noteProperty(clip, spec)}
    >
      <Control
        row={row}
        label={label}
        readOnly={still}
        onPreview={(value) => {
          const { row: current, time } = now();
          properties.preview([writeEdit(clip, current, time, value)]);
        }}
        onCommit={(value) => {
          const { row: current, time, blocked: stopped } = now();
          if (stopped) properties.cancel();
          else properties.commit([writeEdit(clip, current, time, value)]);
        }}
        onCancel={() => properties.cancel()}
      />
      {spec.animatable !== false && (
        <RowButton
          name={onKey ? t("property.removeKey") : t("property.addKey")}
          usage={row.animated ? t("property.help.key") : t("property.help.firstKey")}
          unavailable={key === undefined}
          pressed={onKey}
          onClick={() => {
            if (key) properties.commit([key]);
          }}
        >
          <Diamond
            size={10}
            className={row.animated ? styles.keyed : undefined}
            {...(onKey ? { fill: "currentColor" } : {})}
          />
        </RowButton>
      )}
    </div>
  );
}
