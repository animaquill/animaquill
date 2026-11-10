import { describe, expect, it, vi } from "vitest";
import { ErrorReports, MAX_ASKS, fingerprintOf, type ErrorReport } from "./errors.ts";
import { DiagnosticsRecorder } from "./recorder.ts";

const SITE = "https://editor.example";

function setup({
  send = vi.fn(async (_report: ErrorReport) => "20261107-1"),
  secrets = [] as string[],
  sends = true,
  names = vi.fn(() => secrets),
  now = (): number => 5000,
} = {}) {
  const recorder = new DiagnosticsRecorder(
    "0.3.6",
    () => () => {},
    () => ({}),
  );
  const reports = new ErrorReports({
    version: "0.3.6",
    recorder,
    ...(sends && { send }),
    origins: () => [SITE],
    secrets: names,
    device: () => ({ cores: 8 }),
    now,
  });
  return { recorder, reports, send, names };
}

/** An error the way the editor would throw it, thrown from a given place in its code. */
function thrown(message: string, column = 100, name = "TypeError"): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = [
    `${name}: ${message}`,
    `    at Ab (${SITE}/assets/index-1a2b3c4d.js:1:${column})`,
    `    at ${SITE}/assets/index-1a2b3c4d.js:1:50`,
  ].join("\n");
  return error;
}

describe("taking in errors", () => {
  it("asks about a new one, with a report of where it was and what came before", () => {
    const { recorder, reports } = setup();
    recorder.mark("action", { id: "view.open.timeline", way: "menu" });
    reports.capture("panel", thrown("x is not a function"), { panel: "timeline" });
    const { asking, errors } = reports.getSnapshot();
    expect(errors).toHaveLength(1);
    expect(asking?.status).toBe("asking");
    expect(asking?.report).toMatchObject({
      format: 1,
      kind: "error",
      version: "0.3.6",
      uptimeMs: 5000,
      device: { cores: 8 },
      error: {
        source: "panel",
        panel: "timeline",
        name: "TypeError",
        message: "x is not a function",
        count: 1,
        frames: [
          { fn: "Ab", file: "/assets/index-1a2b3c4d.js", line: 1, column: 100 },
          { file: "/assets/index-1a2b3c4d.js", line: 1, column: 50 },
        ],
        droppedFrames: 0,
      },
      trail: [
        { kind: "action", id: "view.open.timeline", way: "menu" },
        { kind: "error", source: "panel", name: "TypeError" },
      ],
    });
  });

  it("counts the same error again without asking again", () => {
    const { recorder, reports } = setup();
    reports.capture("window", thrown("first"));
    const [first] = reports.getSnapshot().errors;
    if (!first) throw new Error("Nothing caught");
    reports.decline(first.id);
    reports.capture("window", thrown("same place, other words"));
    const { errors, asking } = reports.getSnapshot();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.count).toBe(2);
    expect(errors[0]?.report.error.count).toBe(2);
    expect(errors[0]?.status).toBe("declined");
    expect(asking).toBeUndefined();
    // One line in the black box, which keeps room for what led to it.
    const said = recorder.trail.entries().filter(({ kind }) => kind === "error");
    expect(said).toEqual([expect.objectContaining({ source: "window", times: 2 })]);
  });

  it("takes one error that arrives on two ways once", () => {
    const { reports } = setup();
    const error = thrown("once");
    reports.capture("command", error, { commands: ["clip.move"] });
    reports.capture("window", error);
    const { errors } = reports.getSnapshot();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.count).toBe(1);
    expect(errors[0]?.report.error).toMatchObject({ source: "command", commands: ["clip.move"] });
  });

  it("asks about one at a time, and only a few times in all", () => {
    const { reports } = setup();
    reports.capture("window", thrown("a", 1));
    reports.capture("window", thrown("b", 2));
    expect(reports.getSnapshot().errors.map(({ status }) => status)).toEqual(["quiet", "asking"]);
    for (let column = 3; column < 3 + MAX_ASKS * 2; column++) {
      const { asking } = reports.getSnapshot();
      if (asking) reports.decline(asking.id);
      reports.capture("window", thrown("c", column));
    }
    const asked = reports.getSnapshot().errors.filter(({ status }) => status !== "quiet");
    expect(asked).toHaveLength(MAX_ASKS);
  });

  it("does not ask when there is nowhere to send it", () => {
    const { reports } = setup({ sends: false });
    reports.capture("window", thrown("a"));
    expect(reports.canSend).toBe(false);
    expect(reports.getSnapshot().errors[0]?.status).toBe("quiet");
  });

  it("leaves out what the browser says about nothing", () => {
    const { reports } = setup();
    reports.capture("window", {
      message: "ResizeObserver loop completed with undelivered notifications.",
    });
    expect(reports.getSnapshot().errors).toEqual([]);
  });

  it("keeps an error when the device says nothing", () => {
    const recorder = new DiagnosticsRecorder(
      "1",
      () => () => {},
      () => ({}),
    );
    const reports = new ErrorReports({
      version: "1",
      recorder,
      origins: () => [SITE],
      secrets: () => [],
      device: () => {
        throw new ReferenceError("screen is not defined");
      },
    });
    reports.capture("window", thrown("a"));
    expect(reports.getSnapshot().errors[0]?.report.device).toEqual({});
  });

  it("never fails itself", () => {
    const { reports } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hostile = {
      get message(): string {
        throw new Error("No");
      },
    };
    expect(() => reports.capture("window", hostile)).not.toThrow();
    warn.mockRestore();
  });
});

describe("storms", () => {
  it("throw away what is harmless before anything that costs", () => {
    const { reports, names } = setup();
    for (let index = 0; index < 100; index++) {
      reports.capture("window", { message: "ResizeObserver loop limit exceeded" });
    }
    expect(names).not.toHaveBeenCalled();
    expect(reports.getSnapshot().errors).toEqual([]);
  });

  it("clean an error once, and only count it after that", () => {
    const { reports, names } = setup();
    const listener = vi.fn();
    reports.subscribe(listener);
    for (let index = 0; index < 15; index++) reports.capture("window", thrown("again"));
    expect(names).toHaveBeenCalledOnce();
    expect(reports.getSnapshot().errors[0]?.count).toBe(15);
    expect(reports.getSnapshot().errors[0]?.report.error.count).toBe(15);
    // The first one, and the counts together a moment later.
    expect(listener).toHaveBeenCalledOnce();
  });

  it("clean an error without a place once as well", () => {
    const { reports, names } = setup();
    for (let index = 0; index < 10; index++) reports.capture("promise", "same words");
    expect(names).toHaveBeenCalledOnce();
    expect(reports.getSnapshot().errors[0]?.count).toBe(10);
  });

  it("are only counted in the black box beyond a few a second", () => {
    const { recorder, reports } = setup();
    for (let column = 1; column <= 200; column++) reports.capture("window", thrown("many", column));
    expect(reports.getSnapshot().errors.length).toBeLessThanOrEqual(20);
    const storm = recorder.trail.entries().find(({ kind }) => kind === "error.storm");
    expect(storm?.times).toBe(180);
  });

  it("are over once a second went by", () => {
    let at = 5000;
    const { recorder, reports } = setup({ now: () => at });
    for (let column = 1; column <= 30; column++) reports.capture("window", thrown("many", column));
    expect(reports.getSnapshot().errors).toHaveLength(20);
    at += 999;
    reports.capture("window", thrown("many", 31));
    expect(reports.getSnapshot().errors).toHaveLength(20);
    at += 2;
    for (let column = 32; column <= 40; column++) reports.capture("window", thrown("many", column));
    expect(reports.getSnapshot().errors).toHaveLength(29);
    const storm = recorder.trail.entries().find(({ kind }) => kind === "error.storm");
    expect(storm?.times).toBe(11);
  });
});

describe("what leaves", () => {
  it("has nothing of the project: no names, paths or code", () => {
    const secrets = ["SecretLaunch", "TeaserCut", "scenes/launch/intro.html", "intro"];
    const { recorder, reports } = setup({ secrets });
    recorder.mark("command", { name: "clip.move", file: "scenes/launch/intro.html" });
    const error = thrown(
      `SecretLaunch: clip TeaserCut in scenes/launch/intro.html failed at 'document.title = "预算"' 片头`,
    );
    error.stack += "\n    at secretScene (https://scene-1.example/scene.html:3:7)";
    reports.capture("window", error, {
      componentStack: "\n    at TeaserCut (https://scene-1.example/x.js:1:1)",
      commands: ["clip.move", "TeaserCut 片头"],
      panel: "我的面板",
    });
    const text = JSON.stringify(reports.getSnapshot().errors[0]?.report);
    for (const secret of [
      "SecretLaunch",
      "TeaserCut",
      "launch",
      "intro",
      "document",
      "预算",
      "片头",
      "secretScene",
      "scene-1",
      "我的面板",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(reports.getSnapshot().errors[0]?.report.error).toMatchObject({
      message: "<name>: … <name> in <name> failed at <…> …",
      commands: ["clip.move"],
      droppedFrames: 1,
    });
  });

  it("says nothing of an error that is not in the code of the editor but its kind", () => {
    const { reports } = setup();
    const error = new Error("budget is 10000 for the client Acme");
    error.stack = `Error: ${error.message}\n    at run (https://scene-2.example/scene.html:1:1)`;
    reports.capture("compositor", error);
    const report = reports.getSnapshot().errors[0]?.report;
    expect(report?.error).toMatchObject({
      name: "Error",
      message: "",
      frames: [],
      droppedFrames: 1,
    });
    expect(JSON.stringify(report)).not.toMatch(/budget|Acme|10000/);
  });

  it("goes only when people send it, and says what became of it", async () => {
    const { reports, send } = setup();
    reports.capture("panel", thrown("a"));
    expect(send).not.toHaveBeenCalled();
    const { asking } = reports.getSnapshot();
    if (!asking) throw new Error("Nothing to send");
    await reports.send(asking.id);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toEqual(asking.report);
    expect(reports.getSnapshot().errors[0]).toMatchObject({ status: "sent", sentId: "20261107-1" });
    await reports.send(asking.id);
    expect(send).toHaveBeenCalledOnce();
  });

  it("can be sent again when it did not arrive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async () => {
      throw new Error("Offline");
    });
    const { reports } = setup({ send });
    reports.capture("panel", thrown("a"));
    const id = reports.getSnapshot().errors[0]?.id ?? 0;
    await reports.send(id);
    expect(reports.getSnapshot().errors[0]?.status).toBe("failed");
    send.mockResolvedValueOnce("again" as never);
    await reports.send(id);
    expect(reports.getSnapshot().errors[0]).toMatchObject({ status: "sent", sentId: "again" });
    warn.mockRestore();
  });
});

describe("fingerprints", () => {
  const frames = [{ fn: "Ab", file: "/assets/index-1a2b3c4d.js", line: 1, column: 100 }];

  it("are the same for the same place, whatever the message says", () => {
    expect(fingerprintOf("window", "TypeError", "a", frames)).toBe(
      fingerprintOf("window", "TypeError", "b", frames),
    );
    expect(fingerprintOf("window", "TypeError", "a", frames)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differ for another place, kind or way it was caught", () => {
    const other = [{ ...frames[0], column: 101 }] as typeof frames;
    const base = fingerprintOf("window", "TypeError", "a", frames);
    expect(fingerprintOf("window", "TypeError", "a", other)).not.toBe(base);
    expect(fingerprintOf("window", "RangeError", "a", frames)).not.toBe(base);
    expect(fingerprintOf("panel", "TypeError", "a", frames)).not.toBe(base);
  });

  it("go by the message when there is no place", () => {
    expect(fingerprintOf("window", "Error", "a", [])).not.toBe(
      fingerprintOf("window", "Error", "b", []),
    );
  });
});
