import { EDIT_TEXTS } from "./edit.ts";
import { OPERATION_TEXTS } from "./operations.ts";
import { PARAM_TEXTS } from "./params.ts";
import { TYPE_TEXTS } from "./shared.ts";
import type { TextTable } from "./table.ts";
import { TOOL_TEXTS } from "./tools.ts";

export * from "./table.ts";

/** The words of the tools as AnimaQuill writes them, for every model: the default model pack. */
export const DEFAULT_TEXTS: TextTable = {
  ...TOOL_TEXTS,
  ...EDIT_TEXTS,
  ...OPERATION_TEXTS,
  ...PARAM_TEXTS,
  ...TYPE_TEXTS,
};
