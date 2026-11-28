/**
 * Where the conversations and AI tools of a project in the windows of this browser, or online of
 * the person's windows anywhere, see each other and leave each other messages
 * (docs/design/ai-teamwork.md of AnimaQuill Cloud, 3; chat6 technical design, 6.2 and 6.3): without
 * a window that relays. Each window holds a lock for each one it has, which goes with the window
 * (the browser's, or the platform's once the window stops saying it is there); what they are is
 * kept where all windows read it; messages wait there until the window that holds the one they are
 * for takes them, which only one can; and a window is told that there is something for it. What a
 * card, a message or an answer says is for the editor to read: this only keeps and carries it.
 */
export interface AgentPost {
  /**
   * Whose windows take part: those of this browser (offline, agents-browser.ts), or the person's on
   * any computer, through the platform (online, agents-account.ts).
   */
  readonly reach: "browser" | "account";
  /** What this window takes part in for a project, until `close`. */
  enter(project: string, events: AgentRoomEvents): AgentRoom;
}

/** What a window of a project is told of the others, see `AgentPost.enter`. */
export interface AgentRoomEvents {
  /**
   * This window holds one of those it has now: none had it, or the window that had it let go of
   * it (`waited`), which may have changed it meanwhile.
   */
  readonly owned: (id: string, waited: boolean) => void;
  /** Something may wait for one of those this window holds. */
  readonly mail: (to: string) => void;
  /** Another window changed how many turns went on with nobody there, see `AgentRoom.budget`. */
  readonly budget: () => void;
  /** Another window has one this one has too: this one waits for it, see `AgentRoom.want`. */
  readonly queued?: (id: string) => void;
  /**
   * Another window wants one this window holds, see `AgentRoom.want`: where this window only keeps
   * it for messages, or `take` (people there asked for it), it lets go of it once nothing runs in it.
   */
  readonly wanted?: (id: string, take: boolean) => void;
  /** Another window deleted one: this one lets go of it, and keeps nothing more of it. */
  readonly gone?: (id: string) => void;
  /**
   * The page came back from the browser's cache after it went (`pageshow`): what it had taken it
   * gave back as it went.
   */
  readonly resumed?: () => void;
  /**
   * This window had one, and has it no more although it still wants it: it was not there for a
   * while (asleep, or its timers held back), and another window has it now. What goes on in it here
   * stops (the conversation is written to a copy; the tool call already running still ends and may
   * change the project); online only.
   */
  readonly lost?: (id: string) => void;
}

/** One a window of the project has, as all windows see it, see `AgentRoom.roster`. */
export interface AgentRosterEntry {
  readonly id: string;
  /** What the window that holds it, or held it last, said of it. */
  readonly card: unknown;
  /** A window holds it now. */
  readonly live: boolean;
  /** When that window last said it. */
  readonly at: number;
}

/** A message for one of the project, as it waits, see `AgentRoom.post`. */
export interface PostedMail {
  readonly id: string;
  readonly to: string;
  /** Who sent it, and its words: the same from the same within a while go once. */
  readonly from: string;
  readonly text: string;
  readonly at: number;
  /** No window had the one it is for when it was sent: it waits to be opened again. */
  readonly left: boolean;
  /** All of it, as the editor reads it. */
  readonly body: unknown;
}

/** What a window of a project does with the others, see `AgentPost`. */
export interface AgentRoom {
  /**
   * The ones this window has now, which it holds where no other window does, and else once the
   * others let go of them (`owned`). Those it no longer has it lets go of, and what it said of them.
   */
  serve(ids: readonly string[]): void;
  /** Holds one right away, where no window does; whether it does. `serve` keeps it then. */
  tryServe(id: string): Promise<boolean>;
  /** Whether this window holds one now. */
  owns(id: string): boolean;
  /** Whether any window holds one now; rejects where the browser cannot tell. */
  held(id: string): Promise<boolean>;
  /** What this window says of those it holds, in place of what it said before. */
  publish(cards: readonly { readonly id: string; readonly card: unknown }[]): Promise<void>;
  /**
   * All the windows said of the ones they have or had lately, by any window but this one: as read a
   * moment ago, unless `fresh`.
   */
  roster(fresh?: boolean): Promise<readonly AgentRosterEntry[]>;
  /**
   * Leaves a message for one, and tells the window that holds it: unless as many wait for it
   * already, or the same words from the same one came within the while.
   */
  post(
    mail: PostedMail,
    limits: { readonly most: number; readonly repeatMs: number },
  ): Promise<"posted" | "full" | "repeat">;
  /**
   * Takes the messages that wait for one, and those another window took and went away with: from
   * then on they are this window's, until it says they are `done` with or gives them `back`. They
   * stay kept meanwhile, so that a window that goes away with them loses none.
   */
  claim(to: string): Promise<readonly PostedMail[]>;
  /** Messages this window took that are read now, or answered: they go. */
  done(ids: readonly string[]): Promise<void>;
  /** Messages this window took and does not keep after all: they wait again, for whoever opens it. */
  back(ids: readonly string[]): Promise<void>;
  /**
   * Messages this window took that a conversation read, before that is written: as the page goes
   * they go, rather than back, so that nobody gets them again (see `done`).
   */
  read(ids: readonly string[]): void;
  /** Messages `read` that the conversation did not get to read after all. */
  unread(ids: readonly string[]): void;
  /**
   * Asks the window that holds one to let go of it: the window that keeps it for messages only
   * does, and the one that shows it only where people here asked (`take`).
   */
  want(id: string, take: boolean): void;
  /**
   * Lets go of one this window keeps showing, for the window that wants it (`want`): it waits for
   * it again after that one.
   */
  yieldTo(id: string): void;
  /** Tells the other windows that one was deleted, see `AgentRoomEvents.gone`. */
  gone(id: string): void;
  /** Tells the window that sent a message what came of it. */
  answer(mail: string, outcome: unknown): void;
  /** What came of a message this window sends, where the window that took it said within `ms`. */
  outcome(mail: string, ms: number): Promise<unknown>;
  /** One asks to be told when another is next idle, until then. */
  watch(target: string, watcher: string, until: number): Promise<void>;
  /** Takes who asked to be told of one, and until when. */
  watchers(
    target: string,
  ): Promise<readonly { readonly watcher: string; readonly until: number }[]>;
  /** One that went away for good: what was said of it, what waits for it, who waits on it. */
  forget(id: string): Promise<void>;
  /**
   * How many turns, and messages read on the way, went on in all conversations of the project in
   * this browser since people last said something in any: shared by the windows.
   */
  readonly budget: {
    get(): number;
    add(count: number): void;
    reset(): void;
  };
  /** This window takes part no more: it lets go of all it holds. */
  close(): void;
}
