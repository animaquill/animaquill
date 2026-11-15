import { isAddress, parseAddress, type Address } from "@animaquill/tools";

/**
 * What people point at in their words to AI, and AI in its answers: a moment of a timeline, an
 * object, lines of code, or several objects. In the input box and in the conversation each is a
 * block of its own; in the text that is kept and that AI gets, a Markdown link to an address of the
 * editor (`aq:`), see docs/design/settings-and-properties.md of AnimaQuill Cloud, 10.2:
 *
 *   [0:12/05](aq://time?timeline=main&t=73/6)
 *   [片段「标题」](aq://object/clip_7Hq2?timeline=main)
 */

/** A block: what it says, and where it points. */
export interface ChatRef {
  readonly label: string;
  readonly href: string;
}

export type Piece = { readonly text: string } | { readonly ref: ChatRef };

/** What a block is of, which its icon says. */
export type RefKind = Address["kind"] | "unknown";

export const kindOfRef = (href: string): RefKind => parseAddress(href)?.kind ?? "unknown";

/** A label as the text of a Markdown link: brackets and backslashes are escaped. */
export const escapeLabel = (label: string): string => label.replace(/[\\[\]]/g, (c) => `\\${c}`);

const unescapeLabel = (label: string): string => label.replace(/\\([\\[\]])/g, "$1");

/** A block as it is written: a Markdown link to its address. */
export const linkOf = ({ label, href }: ChatRef): string => `[${escapeLabel(label)}](${href})`;

/** A link to an address of the editor: its label, with escapes, and the address up to `)`. */
const LINK = /\[((?:\\[\\[\]]|[^\\[\]\n])*)\]\((aq:\/\/[^\s)]*)\)/g;

/** Text with its links to the editor's addresses as blocks; anything else stays text. */
export function piecesOf(text: string): readonly Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK)) {
    const [whole, label = "", href = ""] = match;
    if (!isAddress(href)) continue;
    const start = match.index;
    if (start > at) pieces.push({ text: text.slice(at, start) });
    pieces.push({ ref: { label: unescapeLabel(label), href } });
    at = start + whole.length;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

/** Text as people read it: each block as what it says. For copying, titles and searches. */
export const plainOf = (text: string): string =>
  piecesOf(text)
    .map((piece) => ("ref" in piece ? piece.ref.label : piece.text))
    .join("");

/** Pieces as text again, see `piecesOf`. */
export const textOf = (pieces: readonly Piece[]): string =>
  pieces.map((piece) => ("ref" in piece ? linkOf(piece.ref) : piece.text)).join("");

/** How long a name in a block is at most, before it ends in "…". */
export const NAME_LENGTH = 16;

/** A name as a block shows it: at most `NAME_LENGTH` characters. */
export function shortName(name: string): string {
  const chars = [...name.replace(/\s+/g, " ").trim()];
  return chars.length > NAME_LENGTH
    ? `${chars.slice(0, NAME_LENGTH - 1).join("")}…`
    : chars.join("");
}
