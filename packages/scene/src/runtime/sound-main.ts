import { loadProject } from "../loader/project.ts";
import { virtualUrl } from "../loader/paths.ts";
import {
  RUNTIME_VERSION,
  type FromScene,
  type SoundFailureReason,
  type SoundLoad,
} from "../protocol.ts";
import { ProblemLog } from "./problems.ts";
import { soundPrelude, type FromSoundWorker } from "./sound-worker.ts";
import { SCENE_EPOCH } from "./time.ts";
import { workerPrelude } from "./worker.ts";

/**
 * Makes one sound. Nothing of the project runs on this page: all of that is in a worker, which can
 * take as long as it likes, because this page goes on and ends it when its time is up. So what a
 * worker cannot do is keep this from happening, and the only way out of there is a message to here.
 */

const GLOBAL = "__aq";

/** Making a sound takes one message, and a few for what goes wrong. */
const MAX_WORKER_MESSAGES = 100;

const windowWithBoot = window as unknown as { aqBoot?: { readonly scene: SoundLoad } };
const { scene: load } = windowWithBoot.aqBoot as { readonly scene: SoundLoad };
delete windowWithBoot.aqBoot;

const compositor = parent;
const post = (message: unknown, transfer?: Transferable[]) =>
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- the compositor's sandbox has no origin to name
  compositor.postMessage(message, "*", transfer);
const send = (message: FromScene) => post(message);

const problems = new ProblemLog(
  (problem) => send({ type: "problem", problem }),
  () => 0,
);
problems.release(new Set());

const makeUrl = (content: Blob | string, type: string) =>
  URL.createObjectURL(
    content instanceof Blob ? content.slice(0, content.size, type) : new Blob([content], { type }),
  );

let worker: Worker | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let over = false;

function end(): void {
  over = true;
  clearTimeout(timer);
  worker?.terminate();
}

const fail = (reason: SoundFailureReason): void => {
  if (over) return;
  end();
  send({ type: "failed", message: reason });
};

function samples(channels: unknown): void {
  if (over) return;
  if (!Array.isArray(channels) || channels.length === 0 || channels.length > load.maxChannels) {
    fail("bad-result");
    return;
  }
  const [first] = channels as unknown[];
  if (!(first instanceof Float32Array) || first.length === 0) {
    fail("bad-result");
    return;
  }
  const frames = first.length;
  const same = (channels as unknown[]).every(
    (channel) => channel instanceof Float32Array && channel.length === frames,
  );
  if (!same) {
    fail("bad-result");
    return;
  }
  if (frames > load.frames) {
    fail("too-long");
    return;
  }
  end();
  const blob = new Blob(channels as Float32Array<ArrayBuffer>[]);
  post({ type: "samples", channels: channels.length, frames, samples: blob });
}

let messages = 0;

/** Anything can be in here. Past what it takes to make a sound, nobody needs to read more. */
function onWorkerMessage(event: MessageEvent<FromSoundWorker>): void {
  messages += 1;
  if (messages > MAX_WORKER_MESSAGES) {
    fail("flood");
    return;
  }
  const { data } = event;
  if (data?.type === "samples") samples(data.channels);
  else if (data?.type === "no-sound") fail("no-sound");
  else if (data?.type === "error") {
    problems.thrown("error", String(data.thrown));
    fail("error");
  }
}

async function main(): Promise<void> {
  const project = await loadProject({
    entry: load.entry,
    files: load.files,
    makeUrl,
    head: "",
    body: "",
    global: GLOBAL,
    report: ({ code, file, line, column, target }) =>
      problems.report({
        kind: "loader",
        code,
        file,
        ...(line !== undefined && { line }),
        ...(column !== undefined && { column }),
        ...(target !== undefined && { target }),
      }),
  });
  if (project.html === "" || !/\.m?js$/.test(load.entry)) {
    fail("no-entry");
    return;
  }
  const prelude = () => {
    const first = workerPrelude({
      files: Object.fromEntries(project.workerFiles()),
      base: virtualUrl(load.entry),
      seed: load.seed,
      epoch: SCENE_EPOCH,
      global: GLOBAL,
    });
    const { duration, frames, sampleRate, seed, params, output } = load;
    const runtime = RUNTIME_VERSION;
    const setup = { global: GLOBAL, runtime, duration, frames, sampleRate, seed, params, output };
    return makeUrl(first + soundPrelude(setup), "text/javascript");
  };
  const url = project.workerUrl(load.entry, true, prelude);
  problems.sources = project.sources;
  worker = new Worker(url);
  worker.addEventListener("message", onWorkerMessage);
  worker.addEventListener("messageerror", () => fail("bad-result"));
  worker.addEventListener("error", (event) => {
    problems.onError(event);
    event.preventDefault();
  });
  timer = setTimeout(() => fail("time"), load.limitMs);
  send({ type: "ready", width: 0, height: 0 });
}

addEventListener("securitypolicyviolation", problems.onBlocked);
main().catch((error: unknown) => {
  problems.thrown("error", error);
  fail("error");
});
