import { z } from "zod";
import type { AgentCard, SendOutcome } from "../agents.ts";
import { MAX_MESSAGE } from "../agents.ts";
import { answer, failed, type Call } from "../context.ts";
import { PARAM } from "../texts/index.ts";
import type { ToolDefinition } from "../tool.ts";

/**
 * Other conversations of the project, and AI tools on this computer, which AI sees and sends words
 * to (docs/design/ai-teamwork.md of AnimaQuill Cloud, 2 and 3), the way Claude Code's sessions do
 * (ListAgents, SendMessage). Only words go; what comes back is a message of the other one.
 */

const NOT_HERE =
  "error not-available: there are no other conversations to see or talk to from here.";

/** The one of the list a name, an id or an address stands for: the id it has. */
function findIn(cards: readonly AgentCard[], to: string, call: Call): AgentCard | undefined {
  const wanted = to.trim();
  const byId = cards.find((card) => card.id === wanted);
  if (byId) return byId;
  const exact = cards.filter((card) => card.name === wanted);
  if (exact.length === 1) return exact[0];
  // A name as the last list said it, of one renamed since.
  const known = call.caller.agentNames.get(wanted);
  return known === undefined ? undefined : cards.find((card) => card.id === known);
}

const STATE: Readonly<Record<AgentCard["state"], string>> = {
  running: "running",
  waiting: "waiting for the user",
  idle: "idle",
  closed: "not open now; a message opens it",
  tool: "an AI tool on this computer; it cannot be woken and reads messages with its next call",
};

const ACCEPTS: Readonly<Record<AgentCard["accepts"], string>> = {
  yes: "",
  ask: "; the user is asked before it reads a message",
  no: "; it takes no messages",
};

const AgentsListParams = z.strictObject({});

export const agentsList: ToolDefinition<z.output<typeof AgentsListParams>> = {
  name: "aq_agents_list",
  title: "Other conversations",
  params: AgentsListParams,
  run: async (call) => {
    const agents = call.host.agents;
    if (!agents) return failed(NOT_HERE);
    const cards = await agents.list();
    for (const card of cards) call.caller.agentNames.set(card.name, card.id);
    if (cards.length === 0) {
      return answer(
        call,
        ["no other conversation of this project is open or kept, and no AI tool is connected"],
        {
          agents: [],
        },
      );
    }
    const lines = cards.map((card) => {
      const doing = card.doing ? `: ${card.doing}` : "";
      const changed =
        card.changed.length > 0 ? `; last changed ${card.changed.slice(0, 10).join(", ")}` : "";
      return `${JSON.stringify(card.name)} (${card.kind === "chat" ? "conversation" : "tool"}) ${STATE[card.state]}${doing}${changed}${ACCEPTS[card.accepts]}`;
    });
    return answer(
      call,
      [
        `${cards.length} other${cards.length === 1 ? "" : "s"} of this project; aq_send takes the name in quotes:`,
        ...lines,
      ],
      { agents: cards.map(({ id, name, kind, state }) => ({ id, name, kind, state })) },
    );
  },
};

const SendParams = z.strictObject({
  to: z.string().min(1).max(300).describe(PARAM),
  message: z.string().min(1).max(MAX_MESSAGE).describe(PARAM),
});

/** What a result says of a message sent, and the error of one that was not. */
const SENT: Readonly<Record<string, string>> = {
  read: "sent; it reads it after its next call, in the task it is running",
  turn: "sent; it was idle and started a turn with it",
  "waits:people": "sent; it waits for the user to answer it first, and reads it then",
  "waits:tool": "sent; it is an AI tool, which reads it with its next call",
  "waits:asked": "sent; the user is asked whether it may read it",
  "waits:paused":
    "sent; it stopped after many rounds with others and reads it once the user says something to it",
};

const REFUSED: Readonly<Record<string, string>> = {
  self: "error invalid-params: that is this conversation.",
  unknown: "error not-found: no conversation or tool of that name; aq_agents_list gives the names.",
  declines: "error declined: the user set it to take no messages from other conversations.",
  silent:
    "error declined: the user set this editor to take no messages from other conversations, and so it sends none either.",
  paused:
    "error paused: this conversation has answered other conversations many times in a row; it sends nothing more until the user says something here.",
  full: "error busy: it has 50 messages waiting already; send again once it has read them.",
  repeat: "error repeat: the same message went to it a moment ago; it was not sent again.",
};

const outcomeText = (outcome: SendOutcome) =>
  "sent" in outcome
    ? SENT[outcome.sent === "waits" ? `waits:${outcome.until}` : outcome.sent]
    : REFUSED[outcome.refused];

export const send: ToolDefinition<z.output<typeof SendParams>> = {
  name: "aq_send",
  title: "Message another conversation",
  params: SendParams,
  run: async (call, args) => {
    const agents = call.host.agents;
    if (!agents) return failed(NOT_HERE);
    const cards = await agents.list();
    const card = findIn(cards, args.to, call);
    if (!card) return failed(REFUSED.unknown ?? "");
    const outcome = await agents.send(card.id, args.message);
    const data = {
      to: { id: card.id, name: card.name, kind: card.kind },
      outcome: "sent" in outcome ? outcome : { refused: outcome.refused },
    };
    if ("refused" in outcome) return failed(outcomeText(outcome) ?? "", data);
    return answer(call, [`to ${JSON.stringify(card.name)}: ${outcomeText(outcome)}`], data);
  },
};

const NotifyParams = z.strictObject({
  to: z.string().min(1).max(300).describe(PARAM),
});

export const agentsNotify: ToolDefinition<z.output<typeof NotifyParams>> = {
  name: "aq_agents_notify",
  title: "Be told when another is idle",
  params: NotifyParams,
  run: async (call, args) => {
    const agents = call.host.agents;
    if (!agents) return failed(NOT_HERE);
    const card = findIn(await agents.list(), args.to, call);
    if (!card) return failed(REFUSED.unknown ?? "");
    const outcome = await agents.notifyWhenIdle(card.id);
    const data = { to: { id: card.id, name: card.name, kind: card.kind } };
    if ("refused" in outcome) {
      return failed(
        outcome.refused === "cannotTell"
          ? "error not-available: an AI tool on this computer does not say when it is idle."
          : (REFUSED[outcome.refused] ?? ""),
        data,
      );
    }
    return answer(
      call,
      [
        `you will get a message once ${JSON.stringify(card.name)} is next idle, within 12 hours; nothing to wait for meanwhile`,
      ],
      data,
    );
  },
};
