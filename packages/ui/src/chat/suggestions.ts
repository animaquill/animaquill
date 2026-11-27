/**
 * What an empty conversation offers to say (docs/design/chat-panel.md of AnimaQuill Cloud, 7 "空对
 * 话"), by how the project is right now, without asking any model: something about what is
 * selected, the problems where there are some, a first cut where the timeline is empty, and always
 * a marker at the playhead. A pick goes to the box, not out.
 */

/** What of the project the suggestions go by. */
export interface ProjectFacts {
  /** How many clips are selected on the timeline. */
  readonly selectedClips: number;
  /** How many problems the project has. */
  readonly problems: number;
  /** How many clips the timeline open has; undefined without one. */
  readonly clips: number | undefined;
  /** How many assets the project has. */
  readonly assets: number;
  /** The playhead as a block of the editor (its Markdown link), where there is a timeline. */
  readonly playhead: string | undefined;
}

/** One suggestion: what it says, by its words (`chat.suggest.<key>`) and what goes in them. */
export interface Suggestion {
  readonly key:
    "moveSelected" | "fadeSelected" | "problems" | "cutAssets" | "titleScene" | "marker";
  readonly values: Readonly<Record<string, string | number>>;
}

/** At most this many. */
const MOST = 4;

export function suggestionsOf(facts: ProjectFacts): readonly Suggestion[] {
  const found: Suggestion[] = [];
  if (facts.selectedClips > 0) {
    found.push({ key: "moveSelected", values: { count: facts.selectedClips } });
    found.push({ key: "fadeSelected", values: { count: facts.selectedClips } });
  }
  if (facts.problems > 0) found.push({ key: "problems", values: { count: facts.problems } });
  if (facts.clips === 0)
    found.push(
      facts.assets > 0 ? { key: "cutAssets", values: {} } : { key: "titleScene", values: {} },
    );
  // A project with nothing to go by still offers something to start with.
  if (found.length === 0 && facts.playhead === undefined)
    found.push({ key: "titleScene", values: {} });
  // The marker at the playhead is always there, where there is a playhead.
  if (facts.playhead === undefined) return found.slice(0, MOST);
  return [...found.slice(0, MOST - 1), { key: "marker", values: { time: facts.playhead } }];
}
