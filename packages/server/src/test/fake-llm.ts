import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";

/**
 * A pretend AI service on this machine, over TLS with a certificate of the tests, that speaks like an
 * OpenAI-compatible one and streams its answers. It keeps what each request carried, and whether
 * the one who asked went before the answer was over, so that tests can see what got through the
 * relay and that stopping reaches the service. See test/fake-llm-server.ts for the browser tests.
 *
 * Like the services it stands for, it sends nothing that lets a page read its answers (no CORS).
 */

export interface Seen {
  readonly method: string;
  /** As it came, with the query. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
  /** Whoever asked went before the answer was over. */
  cut: boolean;
  /** The connection the request came on is closed. */
  closed: boolean;
}

export type Answer = (
  request: IncomingMessage,
  response: ServerResponse,
  seen: Seen,
) => void | Promise<void>;

export interface FakeLlm {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  /** Every request, oldest first. */
  readonly seen: Seen[];
  /** How the requests from now on are answered: as an OpenAI-compatible service unless changed. */
  answer: Answer;
  /** Connections open now. */
  readonly connections: number;
  close(): Promise<void>;
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const chunkOf = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

/** What people said last, as the service gets it. */
const lastWords = (body: string): string => {
  try {
    const messages = (JSON.parse(body) as { messages?: { role?: string; content?: unknown }[] })
      .messages;
    const last = messages?.findLast((message) => message.role === "user")?.content;
    return typeof last === "string" ? last : JSON.stringify(last ?? "");
  } catch {
    return "";
  }
};

/** The answer to an ordinary request, a few words at a time. */
export const FAKE_REPLY = ["你好，", "我是", "假的", "服务。"];
/** The word a slow answer repeats until whoever asked goes. */
export const SLOW_WORD = "字";

/**
 * An OpenAI-compatible service: `GET …/models`, and `POST …/chat/completions`, which streams
 * `FAKE_REPLY`, or `SLOW_WORD` every tenth of a second for a minute when the last message asks for
 * it to be slow (慢慢来). Without a key it says so, as services do.
 */
export const openAiCompatible: Answer = (request, response, seen) => {
  const url = new URL(request.url ?? "/", "https://fake.invalid");
  if (request.method === "OPTIONS") {
    // What a browser asks before it sends the key: no CORS here, so it never does.
    response.writeHead(204);
    response.end();
    return;
  }
  const authorized = /^Bearer \S{8,}$/.test(String(request.headers.authorization ?? ""));
  if (!authorized) {
    json(response, 401, {
      error: { message: "Incorrect API key provided", type: "invalid_request_error" },
    });
    return;
  }
  if (request.method === "GET" && url.pathname.endsWith("/models")) {
    json(response, 200, {
      object: "list",
      data: [
        { id: "fake-model", object: "model" },
        { id: "fake-model-large", object: "model" },
      ],
    });
    return;
  }
  if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    json(response, 404, { error: { message: "Not found", type: "invalid_request_error" } });
    return;
  }
  const slow = /慢慢来|slowly/.test(lastWords(seen.body));
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(chunkOf({ role: "assistant", content: "" }));
  const words = slow ? Array<string>(600).fill(SLOW_WORD) : FAKE_REPLY;
  let next = 0;
  const timer = setInterval(
    () => {
      if (response.destroyed) {
        clearInterval(timer);
        return;
      }
      const word = words[next++];
      if (word !== undefined) {
        response.write(chunkOf({ content: word }));
        return;
      }
      clearInterval(timer);
      response.write(chunkOf({}, "stop"));
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          created: 1,
          model: "fake-model",
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: next, total_tokens: 3 + next },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    },
    slow ? 100 : 40,
  );
  response.on("close", () => clearInterval(timer));
};

export async function startFakeLlm(options: {
  readonly key: string;
  readonly cert: string;
  readonly host: string;
  /** 0 for any. */
  readonly port: number;
}): Promise<FakeLlm> {
  const seen: Seen[] = [];
  let connections = 0;
  const fake: { answer: Answer } = { answer: openAiCompatible };
  const server = createServer({ key: options.key, cert: options.cert }, (request, response) => {
    const record: Seen = {
      method: request.method ?? "",
      path: request.url ?? "",
      headers: { ...request.headers },
      body: "",
      cut: false,
      closed: false,
    };
    seen.push(record);
    request.socket.once("close", () => (record.closed = true));
    response.on("close", () => {
      if (!response.writableFinished) record.cut = true;
    });
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", () => {});
    request.on("end", () => {
      record.body = Buffer.concat(chunks).toString("utf8");
      void Promise.resolve(fake.answer(request, response, record)).catch(() => {
        response.destroy();
      });
    });
  });
  server.on("connection", (socket) => {
    connections += 1;
    socket.once("close", () => (connections -= 1));
  });
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    host: options.host,
    port,
    seen,
    get answer() {
      return fake.answer;
    },
    set answer(answer) {
      fake.answer = answer;
    },
    get connections() {
      return connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
