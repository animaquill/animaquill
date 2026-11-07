import type { PropertyNode } from "@animaquill/core";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Diamond,
  Pin,
  PinOff,
  TriangleAlert,
} from "lucide-react";
import { memo, useState, useSyncExternalStore, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu } from "../app/Menu.tsx";
import { Tip } from "../app/Tip.tsx";
import { useWorkbench } from "../app/context.ts";
import { CONTROLS, PlainValue, RowButton } from "../properties/controls.tsx";
import {
  keyEdit,
  writeEdit,
  type InspectedProperty,
  type PropertyRow,
} from "../properties/inspect.ts";
import type { ClipBox } from "../timeline/model.ts";
import type { KeyArea } from "./area.ts";
import { firstLaneBelow, type Lane } from "./lanes.ts";
import styles from "./LaneRows.module.css";

/** Where a value comes from, which is not the same as what it is. */
export type ValueSource = "trial" | "override" | "keys" | "value" | "default";

export function sourceOf({ tried, animated, stored }: PropertyRow): ValueSource {
  if (tried) return "trial";
  if (animated) return "keys";
  return stored === undefined ? "default" : "value";
}

/** How far each level of the list goes in. */
const INDENT = 12;
/** A few lanes more than show, so that scrolling does not show them being made. */
const EXTRA_LANES = 4;

/** What the lanes on screen are, as text, because that is what can tell two moments apart. */
function visibleRange(area: KeyArea): string {
  const lanes = area.getLanes();
  const first = firstLaneBelow(lanes, area.laneY(0));
  const last = firstLaneBelow(lanes, area.laneY(area.screenHeight));
  return `${Math.max(first - EXTRA_LANES, 0)} ${last + EXTRA_LANES + 1}`;
}

function SourceMark({ source }: { source: ValueSource }) {
  const { t } = useTranslation();
  const text = t(`keyframes.source.${source}`);
  return (
    <Tip name={t("keyframes.source.label")} usage={text}>
      <span
        className={styles.source}
        role="img"
        aria-label={`${t("keyframes.source.label")}：${text}`}
        data-source={source}
      />
    </Tip>
  );
}

interface PropertyControlsProps {
  readonly area: KeyArea;
  readonly box: ClipBox;
  readonly node: PropertyNode;
  readonly label: string;
}

/**
 * Follows what a row shows of its property, as far as `signature` says. A row re-renders for what it
 * shows and not for every frame: playing goes through here all the time, and most rows stay the same.
 */
function useInspected(
  { area: { keyframes }, box, node }: PropertyControlsProps,
  signature: (inspected: InspectedProperty) => unknown,
): InspectedProperty | undefined {
  const read = () => keyframes.inspect(box, node.spec);
  useSyncExternalStore(keyframes.subscribeView, () => {
    const inspected = read();
    return inspected && JSON.stringify(signature(inspected));
  });
  return read();
}

function ValueControl(props: PropertyControlsProps) {
  const { area, box, node, label } = props;
  const { properties } = useWorkbench();
  const inspected = useInspected(props, ({ row, blocked }) => [
    row.value,
    row.automatic,
    row.animated,
    row.tried,
    blocked,
  ]);
  if (!inspected) return null;
  const { row, blocked } = inspected;
  const readOnly = blocked !== undefined;
  const Control = CONTROLS[node.spec.type] ?? PlainValue;
  /** What a change writes, for the moment it happens. Its key can be somewhere else by then. */
  const edit = (value: number | string) => {
    const now = area.keyframes.inspect(box, node.spec) ?? inspected;
    return writeEdit(box.id, now.row, now.time, value);
  };
  return (
    <span className={styles.value} data-readonly={readOnly || undefined}>
      <Control
        row={row}
        label={label}
        readOnly={readOnly}
        // As it reads on its band.
        format={(value) => area.keyframes.labelOfValue(node.spec, value)}
        onPreview={(number) => properties.preview([edit(number)])}
        // The playhead can leave the clip while a value is still in somebody's hands.
        onCommit={(number) => {
          if (area.keyframes.inspect(box, node.spec)?.blocked) properties.cancel();
          else properties.commit([edit(number)]);
        }}
        onCancel={() => properties.cancel()}
      />
    </span>
  );
}

function ValueMarks(props: PropertyControlsProps) {
  const { t } = useTranslation();
  const inspected = useInspected(props, ({ row }) => [sourceOf(row), row.changedElsewhere]);
  if (!inspected) return null;
  const { row } = inspected;
  return (
    <>
      <SourceMark source={sourceOf(row)} />
      {row.changedElsewhere && (
        <Tip name={t("trial.changedElsewhere")} usage={t("trial.conflictsHelp")}>
          <span className={styles.elsewhere} role="img" aria-label={t("trial.changedElsewhere")}>
            <TriangleAlert size={11} />
          </span>
        </Tip>
      )}
    </>
  );
}

function KeyButtons(props: PropertyControlsProps) {
  const { area, box, node } = props;
  const { properties, timeline } = useWorkbench();
  const { t } = useTranslation();
  const inspected = useInspected(props, ({ row, blocked }) => [
    row.keyTime,
    row.previousKey,
    row.nextKey,
    row.animated,
    row.value === undefined,
    blocked,
  ]);
  if (!inspected) return null;
  const { row, blocked } = inspected;
  const { animated, keyTime, previousKey, nextKey } = row;
  const onKey = keyTime !== undefined;
  const canKey = blocked === undefined && row.value !== undefined;
  const toggleKey = () => {
    const now = area.keyframes.inspect(box, node.spec);
    const key = now && keyEdit(box.id, now.row, now.time);
    if (key) properties.commit([key]);
  };
  return (
    <div className={styles.buttons}>
      <RowButton
        name={t("property.previousKey")}
        usage={t("property.help.previousKey")}
        unavailable={previousKey === undefined}
        onClick={() => timeline.seek(previousKey as number)}
      >
        <ChevronLeft size={13} />
      </RowButton>
      <RowButton
        name={onKey ? t("property.removeKey") : t("property.addKey")}
        usage={animated ? t("property.help.key") : t("property.help.firstKey")}
        unavailable={!canKey}
        pressed={onKey}
        onClick={toggleKey}
      >
        <Diamond
          size={12}
          className={animated ? styles.keyed : undefined}
          {...(onKey ? { fill: "currentColor" } : {})}
        />
      </RowButton>
      <RowButton
        name={t("property.nextKey")}
        usage={t("property.help.nextKey")}
        unavailable={nextKey === undefined}
        onClick={() => timeline.seek(nextKey as number)}
      >
        <ChevronRight size={13} />
      </RowButton>
    </div>
  );
}

function Pinning({ area, lane, label }: { area: KeyArea; lane: Lane; label: string }) {
  const { keyframes } = area;
  const { t } = useTranslation();
  const { pinned } = useSyncExternalStore(keyframes.subscribe, keyframes.getSnapshot);
  const isPinned = pinned.has(lane.id);
  const Icon = isPinned ? PinOff : Pin;
  const name = t(isPinned ? "keyframes.unpin" : "keyframes.pin", { name: label });
  return (
    <span className={styles.pin} data-pinned={isPinned || undefined}>
      <RowButton
        name={name}
        usage={t("keyframes.pinHelp")}
        unavailable={false}
        pressed={isPinned}
        onClick={() => keyframes.togglePin(lane.id)}
      >
        <Icon size={12} />
      </RowButton>
    </span>
  );
}

interface LaneRowProps {
  readonly area: KeyArea;
  readonly lane: Lane;
  /** Whether a row can stay in the list no matter where the playhead is. */
  readonly canPin: boolean;
}

const LaneRow = memo(function LaneRow({ area, lane, canPin }: LaneRowProps) {
  const { keyframes } = area;
  const { t } = useTranslation();
  const { trials } = useWorkbench();
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number }>();
  const { node, open, canOpen, row, box } = lane;
  const isProperty = node.kind === "property";
  const name = keyframes.nameOfNode(node, row);
  const label = keyframes.labelOf(lane);
  const tried = useSyncExternalStore(
    keyframes.subscribeView,
    () => isProperty && box !== undefined && keyframes.isTried(box.id, node.spec.path),
  );
  const chevronName = isProperty
    ? t(open ? "keyframes.hideCurve" : "keyframes.showCurve", { name: label })
    : t(open ? "keyframes.close" : "keyframes.open", { name: label });

  const selectKeys = (event: MouseEvent) => {
    area.selectLane(lane, event.shiftKey || event.ctrlKey || event.metaKey);
  };

  return (
    <div
      className={styles.lane}
      role="treeitem"
      aria-level={lane.depth + 1}
      aria-label={label}
      {...(canOpen ? { "aria-expanded": open } : {})}
      data-kind={node.kind}
      data-tried={tried || undefined}
      style={{ top: lane.top, height: lane.height }}
      onContextMenu={(event) => {
        if (!tried) return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div
        className={styles.line}
        style={{ height: lane.keyHeight, paddingLeft: lane.depth * INDENT + 2 }}
      >
        {canOpen ? (
          <button
            type="button"
            className={styles.chevron}
            aria-label={chevronName}
            aria-expanded={open}
            onClick={() => area.toggleLane(lane)}
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className={styles.noChevron} />
        )}
        <button type="button" className={styles.name} title={label} onClick={selectKeys}>
          {name}
        </button>
        {node.kind === "property" && box && (
          <>
            <ValueControl area={area} box={box} node={node} label={label} />
            <ValueMarks area={area} box={box} node={node} label={label} />
            <KeyButtons area={area} box={box} node={node} label={label} />
          </>
        )}
        {canPin && (node.kind === "clip" || (node.kind === "object" && !node.orphans)) && (
          <Pinning area={area} lane={lane} label={label} />
        )}
      </div>
      {menu && box && node.kind === "property" && (
        <PopupMenu
          label={label}
          x={menu.x}
          y={menu.y}
          groups={[
            [
              {
                id: "discard",
                label: t("trial.discardProperty"),
                run: () => trials.discardProperty(box.id, node.spec.path),
              },
            ],
          ]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
});

/** The left side of lanes on screen, wherever they are. Lanes are placed by their own height. */
export function LaneRows({ area, canPin = false }: { area: KeyArea; canPin?: boolean }) {
  const lanes = useSyncExternalStore(area.subscribeLanes, area.getLanes);
  const range = useSyncExternalStore(area.keyframes.subscribeView, () => visibleRange(area));
  const [first = 0, last = 0] = range.split(" ").map(Number);
  return lanes
    .slice(first, last)
    .map((lane) => <LaneRow key={lane.id} area={area} lane={lane} canPin={canPin} />);
}
