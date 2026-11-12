/**
 * The words AI reads of the tools, by key: the descriptions of tools and parameters, the summaries
 * and examples of operations, the types they share. Tools and their schemas only have structure;
 * whatever they say comes from a table like this, `DEFAULT_TEXTS` unless the host gives another, as
 * a model pack will (see `textKeys` for every key there is). Errors, problems and the pages of the
 * manual are not here: they are not for packs to change.
 */

/** One example of an operation: what it does, and its parameters without `op`. */
export interface OperationExample {
  readonly title: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** The `operations` of one call of aq_edit, as an example. */
export type EditExample = readonly Readonly<Record<string, unknown>>[];

export type TextValue = string | readonly OperationExample[] | readonly EditExample[];

export type TextTable = Readonly<Record<string, TextValue>>;

/**
 * What a parameter of a tool says it is, in its schema: the table has the words, by the path of
 * the parameter, `tools.<tool>.params.<path>`. A placeholder keeps the description where zod puts
 * it, so that the schema is the same to the byte whatever words go in.
 */
export const PARAM = "{{param}}";

/** The text of a key, which has to be there. */
export function textOf(texts: TextTable, key: string): string {
  const value = texts[key];
  if (typeof value !== "string") throw new Error(`No text for ${key}`);
  return value;
}

/** The text of a key, where there may be none. */
export function textIn(texts: TextTable, key: string): string | undefined {
  const value = texts[key];
  return typeof value === "string" ? value : undefined;
}

/** The examples of an operation. */
export function operationExamples(
  texts: TextTable,
  operation: string,
): readonly OperationExample[] {
  const value = texts[`ops.${operation}.examples`];
  return Array.isArray(value) ? (value as readonly OperationExample[]) : [];
}

/** The examples at the end of the description of aq_edit. */
export function editExamples(texts: TextTable): readonly EditExample[] {
  const value = texts["edit.examples"];
  return Array.isArray(value) ? (value as readonly EditExample[]) : [];
}

/**
 * How the description of aq_edit lists the operations, as `edit.list` says: their names by what
 * they change, with the summary of each in its branch of the schema, or their signatures with
 * their summaries in the description itself (toolset 2026.1).
 */
export const editList = (texts: TextTable): "names" | "signatures" =>
  textIn(texts, "edit.list") === "signatures" ? "signatures" : "names";

/** What an operation does, as a sentence: its summary, which is lower case and without a stop. */
export const sentenceOf = (summary: string): string =>
  `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`;

/** What a parameter of an operation is: its words in this operation, or what its name means. */
export const paramText = (texts: TextTable, operation: string, name: string): string | undefined =>
  textIn(texts, `ops.${operation}.params.${name}`) ?? textIn(texts, `params.${name}`);
