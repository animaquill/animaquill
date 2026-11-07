import type { PropertyNode } from "@animaquill/core";
import type { Value } from "@animaquill/schema";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Diamond,
  FoldVertical,
  Pin,
  PinOff,
  TriangleAlert,
  UnfoldVertical,
} from "lucide-react";
import { memo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
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
  const edit = (value: Value) => {
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

/** Moving less than this from where the edge was pressed is a click, as on the timeline. */
const EDGE_CLICK = 4;

/** Where a row made taller is pulled to another height, at its bottom edge. */
function TallEdge({ area, box, node, label, height }: PropertyControlsProps & { height: number }) {
  const { t } = useTranslation();
  const start = useRef<{ readonly y: number; readonly height: number; moved: boolean } | undefined>(
    undefined,
  );
  const { keyframes } = area;
  const { path } = node.spec;
  return (
    <div
      className={styles.tallEdge}
      role="separator"
      aria-orientation="horizontal"
      aria-label={t("keyframes.resizeRow", { name: label })}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        // From the height it shows, which rows that are taller as a whole can make more.
        start.current = { y: event.clientY, height, moved: false };
      }}
      onPointerMove={(event) => {
        const from = start.current;
        const by = from ? event.clientY - from.y : 0;
        // A click, or a hand that shakes a little, leaves the height it keeps as it is.
        if (!from || (!from.moved && Math.abs(by) < EDGE_CLICK)) return;
        from.moved = true;
        keyframes.setTallHeight(box.id, path, from.height + by);
      }}
      onPointerUp={() => {
        start.current = undefined;
      }}
      onPointerCancel={() => {
        start.current = undefined;
      }}
    />
  );
}

/** Makes one row taller, and back. */
function TallButton({ area, box, node, label }: PropertyControlsProps) {
  const { t } = useTranslation();
  const { keyframes } = area;
  const { path } = node.spec;
  const tall = useSyncExternalStore(keyframes.subscribeView, () => keyframes.isTall(box.id, path));
  const name = t(tall ? "keyframes.untall" : "keyframes.tall", { name: label });
  return (
    <Tip name={name} usage={t("keyframes.tallHelp")}>
      <button
        type="button"
        className={styles.chevron}
        aria-label={name}
        aria-pressed={tall}
        data-tall={tall || undefined}
        onClick={() => keyframes.toggleTall(box.id, path)}
      >
        {tall ? <FoldVertical size={12} /> : <UnfoldVertical size={12} />}
      </button>
    </Tip>
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
  const workbench = useWorkbench();
  const { trials, properties } = workbench;
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number }>();
  const { node, open, canOpen, row, box } = lane;
  const isProperty = node.kind === "property";
  const name = keyframes.nameOfNode(node, row);
  const label = keyframes.labelOf(lane);
  const tried = useSyncExternalStore(
    keyframes.subscribeView,
    () => isProperty && box !== undefined && keyframes.isTried(box.id, node.spec.path),
  );
  const chevronName = t(open ? "keyframes.close" : "keyframes.open", { name: label });
  // Keys that nothing describes can go somewhere that does, or away.
  const orphan = isProperty && node.orphan === true && box !== undefined;
  const changeable = box !== undefined && keyframes.canMove(box.id);

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
      data-tall={lane.tall || undefined}
      style={{ top: lane.top, height: lane.height }}
      onContextMenu={(event) => {
        if (!tried && !orphan) return;
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
        ) : node.kind === "property" && box ? (
          <TallButton area={area} box={box} node={node} label={label} />
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
      {lane.tall && node.kind === "property" && box && (
        <TallEdge area={area} box={box} node={node} label={label} height={lane.height} />
      )}
      {menu && box && node.kind === "property" && (
        <PopupMenu
          label={label}
          x={menu.x}
          y={menu.y}
          groups={[
            ...(orphan
              ? [
                  [
                    {
                      id: "connect",
                      label: t("keyframes.connect.action"),
                      disabled: !changeable,
                      run: () => void workbench.connectProperty(box.id, node.spec.path),
                    },
                    {
                      id: "remove",
                      label: t("keyframes.connect.remove"),
                      disabled: !changeable,
                      run: () =>
                        properties.commit([
                          { owner: { clip: box.id }, path: node.spec.path, op: "clear" },
                        ]),
                    },
                  ],
                ]
              : []),
            ...(tried
              ? [
                  [
                    {
                      id: "discard",
                      label: t("trial.discardProperty"),
                      run: () => trials.discardProperty(box.id, node.spec.path),
                    },
                  ],
                ]
              : []),
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
