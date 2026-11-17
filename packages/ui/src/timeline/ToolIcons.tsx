import { TOOL_SHAPES, type ShapedTool } from "./tool-shapes.ts";

/** An icon of an editing tool, drawn like the icons of the rest of the toolbar. */
function shaped(tool: ShapedTool) {
  const Icon = ({ size = 24 }: { size?: number }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={TOOL_SHAPES[tool]} />
    </svg>
  );
  Icon.displayName = `${tool}ToolIcon`;
  return Icon;
}

export const RippleToolIcon = shaped("ripple");
export const RollToolIcon = shaped("roll");
export const SlipToolIcon = shaped("slip");
export const SlideToolIcon = shaped("slide");
