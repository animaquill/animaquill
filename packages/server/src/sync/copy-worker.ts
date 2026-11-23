import { getHeapStatistics } from "node:v8";
import { parentPort } from "node:worker_threads";
import {
  ProjectStore,
  checkUpdate,
  checkWhole,
  checkWritten,
  conflictAt,
  getIn,
  isEmptyUpdate,
  isUndoRecord,
  lateOf,
  mergeInRounds,
  mergeUpdates,
  piecesOf,
  platformClockOf,
  platformFromOf,
  repoBatch,
  valuesWithout,
  watch,
  writeBatch,
  type BatchCopy,
  type LateConflict,
  type MergeConflict,
  type MergeRound,
  type PlatformBatch,
  type Watched,
} from "@animaquill/core";
import { CURRENT_FORMAT_VERSION } from "@animaquill/schema";
import type { SyncRejection } from "@animaquill/host/sync";
import {
  DESCRIPTION_MOST,
  type Arrival,
  type CopyInfo,
  type CopyRequest,
  type CopyResponse,
  type ExecuteRequest,
  type Executed,
  type Late,
  type MergeRequest,
  type Merged,
  type Taken,
  type TakeBackRequest,
  type TakenBack,
  type WatchedBatch,
} from "./copies.ts";

/**
 * The working copies of projects, in a thread of their own (see copies.ts): taking in an update of
 * Yjs can take long and much memory, and a page that sends a large one only holds up this thread,
 * or makes it run out of its memory and start again, never the API.
 *
 * Whatever goes wrong once a change is in a copy, the copy goes: it never keeps what the database
 * may not get. Each answer says how much of the heap is in use, as the thread measures it.
 *
 * The platform writes into a copy itself only here, as one project at a time and one thing at a
 * time: merges from GitHub (`merge`), and where a change brings in again what such a merge did, the
 * text once (`apply`). Both as the platform (`ProjectStore.writeAsPlatform`), which only the copy of
 * the hub may do, and only once the database has what it wrote before, see `SyncHub`. What each of
 * the platform's batches wrote is kept with the copy (`batches`), to tell what changes that were made
 * without it, and arrive after it, took away of it, or it of them (late-writes.ts of core).
 */

const copies = new Map<string, ProjectStore>();
/** The id in animaquill.json that each project has to keep. */
const ids = new Map<string, string>();
/** Values inside of plain values in each copy, about: what it was read from and took in since. */
const values = new Map<string, number>();
/** The platform's batches of each copy, see above: the newest `BATCHES` of them. */
const batchesOf = new Map<string, WatchedBatch[]>();
const BATCHES = 50;

const valuesOf = (parts: readonly Uint8Array[]): number =>
  parts.reduce((sum, part) => sum + (piecesOf(part)?.values ?? 0), 0);

const infoOf = (project: string, store: ProjectStore): CopyInfo => {
  const { id, name, description, formatVersion } = store.getState().manifest;
  let structs = 0;
  for (const pieces of store.doc.store.clients.values()) structs += pieces.length;
  return {
    projectId: typeof id === "string" ? id : "",
    name: typeof name === "string" ? name.slice(0, 200) : "",
    description:
      typeof description === "string" ? [...description].slice(0, DESCRIPTION_MOST).join("") : "",
    formatVersion: typeof formatVersion === "number" ? formatVersion : 0,
    structs,
    values: values.get(project) ?? 0,
  };
};

function drop(project: string): void {
  copies.get(project)?.destroy();
  copies.delete(project);
  ids.delete(project);
  values.delete(project);
  batchesOf.delete(project);
}

function open(
  project: string,
  parts: readonly Uint8Array[],
  projectId: string,
  batches: readonly WatchedBatch[],
): CopyInfo {
  drop(project);
  const { store } = ProjectStore.fromUpdates(parts);
  if (!store || store.isMissingUpdates || store.getState().manifest.id !== projectId) {
    store?.destroy();
    throw new Error(`project ${project} does not open`);
  }
  copies.set(project, store);
  ids.set(project, projectId);
  values.set(project, valuesOf(parts));
  batchesOf.set(project, batches.toSorted((a, b) => a.seq - b.seq).slice(-BATCHES));
  return infoOf(project, store);
}

function create(project: string, state: Uint8Array, projectId: string, most: number): Taken {
  const fault = checkUpdate(state, { most });
  if (fault) return { kind: "refused", reason: fault, detail: "the first version" };
  const { store } = ProjectStore.fromUpdates([state]);
  if (!store || store.isMissingUpdates || store.getState().manifest.id !== projectId) {
    store?.destroy();
    return { kind: "refused", reason: "identity", detail: "not a whole project of this id" };
  }
  const invalid = checkWhole(store.doc);
  if (invalid) {
    store.destroy();
    return { kind: "refused", reason: "invalid", detail: `${invalid.path}: ${invalid.problem}` };
  }
  if (store.getState().manifest.formatVersion > CURRENT_FORMAT_VERSION) {
    store.destroy();
    return { kind: "refused", reason: "too-new", detail: "a newer format" };
  }
  drop(project);
  copies.set(project, store);
  ids.set(project, projectId);
  values.set(project, valuesOf([state]));
  batchesOf.set(project, []);
  return { kind: "taken", delta: state, info: infoOf(project, store) };
}

function apply(project: string, update: Uint8Array, most: number, arrival: Arrival): Taken {
  const store = copies.get(project);
  if (!store) throw new Error(`project ${project} is not open`);
  // An editor may not write as the platform. What a window sends as a repair is whatever the
  // platform has less of than it, which can be what the platform wrote and lost: only from where
  // the platform is, on, so that nothing it writes later is numbered the same.
  const fault = checkUpdate(update, { most, fromEditor: arrival.fromEditor && !arrival.repair });
  if (fault) return { kind: "refused", reason: fault, detail: "the change" };
  if (arrival.repair) {
    const from = platformFromOf(update);
    if (from !== undefined && from > platformClockOf(store.doc)) {
      return { kind: "refused", reason: "incomplete", detail: "the platform's own, from later on" };
    }
  }
  // From the moment the change goes in, whatever is wrong or goes wrong, the copy goes, and comes
  // again from the database: it never has what the database does not.
  const refused = (reason: SyncRejection, detail: string): Taken => {
    drop(project);
    return { kind: "refused", reason, detail: detail.slice(0, 200), dropped: true };
  };
  // Batches of the platform's own the change may have been made without.
  const batches = batchesOf.get(project) ?? [];
  const isLate = (batch: PlatformBatch) => arrival.repair || arrival.base < batch.seq;
  const isWatched = batches.some(isLate) || arrival.unknown !== undefined;
  try {
    let change: ReturnType<ProjectStore["applyChecked"]>;
    let watched: Watched<ReturnType<ProjectStore["applyChecked"]>> | undefined;
    try {
      if (isWatched) {
        watched = watch(store, () => store.applyChecked(update, "platform"));
        change = watched.result;
      } else change = store.applyChecked(update, "platform");
    } catch {
      return refused("malformed", "it does not apply");
    }
    if (store.isMissingUpdates) return refused("incomplete", "it needs more");
    for (const written of change.written) {
      const wrong = checkWritten(written.path, written.raw);
      if (wrong) return refused("invalid", `${wrong.path}: ${wrong.problem}`);
    }
    const info = infoOf(project, store);
    if (info.projectId !== ids.get(project)) return refused("identity", "another project");
    if (info.formatVersion > CURRENT_FORMAT_VERSION) return refused("too-new", "a newer format");
    // What it took away can have been taken away already, by a batch it did not have: that it
    // did is still to be told, though the copy has nothing new.
    const late = watched && lateFor(store, batches, update, watched, isLate, arrival);
    if (late && "wrong" in late) return refused("invalid", late.wrong);
    if (late?.fix) {
      values.set(project, (values.get(project) ?? 0) + (piecesOf(late.fix.delta)?.values ?? 0));
    }
    if (!change.delta || isEmptyUpdate(change.delta)) {
      return late
        ? { kind: "nothing", info: infoOf(project, store), late }
        : { kind: "nothing", info };
    }
    values.set(project, (values.get(project) ?? 0) + (piecesOf(change.delta)?.values ?? 0));
    return {
      kind: "taken",
      delta: change.delta,
      info: infoOf(project, store),
      ...(late && { late }),
    };
  } catch (error) {
    return refused("invalid", `it could not be checked: ${String(error)}`);
  }
}

/** What people read, after what a conflict is about, where it cannot be told whether it is one. */
const UNKNOWN_SAID = "：离线太久，没法判断和 GitHub 上的改动有没有冲突，请检查";
/** Places of a change said that way, at most: one that wrote more says the first of them. */
const UNKNOWN_MOST = 20;

/**
 * What a change that may have been made without some batches took away of them, or they of it, and
 * what the copy writes as the platform after it: the text once where it brought in again what one of
 * them did, and the batch's side where people want GitHub's side kept (`prefer`). Where the change
 * may have been made without batches that are not watched any more (`unknown`), nothing can tell
 * what went: each place it wrote is said to be looked at. What the copy writes is checked as a
 * change of an editor is: `wrong` says what is wrong, and the copy goes.
 */
function lateFor(
  store: ProjectStore,
  batches: readonly WatchedBatch[],
  update: Uint8Array,
  watched: Watched<unknown>,
  isLate: (batch: PlatformBatch) => boolean,
  arrival: Arrival,
): Late | { readonly wrong: string } | undefined {
  const outcome = lateOf(store, batches, { update, watched }, isLate);
  // Of a batch that was taken back, or takes one back or does it again, only what went of the
  // change counts: what it wrote is nothing to bring back, and nothing to write again.
  const quiet = new Set(batches.filter((batch) => batch.quiet).map(({ batch }) => batch));
  let conflicts: LateConflict[] = outcome.conflicts.filter(
    (conflict) => conflict.lost !== "batch" || !quiet.has(conflict.batch),
  );
  const doubled = outcome.doubled.filter(({ batch }) => !quiet.has(batch));
  for (const { batch, file } of outcome.doubled) {
    if (!quiet.has(batch)) continue;
    // A part twice is still to be looked at: said, not put right.
    const conflict = conflictAt(watched.after, { path: ["files", file], kind: "check-duplicate" });
    conflicts.push({ ...conflict, batch, lost: "change" });
  }
  const made: Uint8Array[] = [];
  const fixed = new Set<string>();
  const take = (part: Uint8Array) => made.push(part);
  store.doc.on("update", take);
  let written: Watched<void>;
  try {
    written = watch(store, () => {
      for (const { batch, file, text } of doubled) {
        store.writeAsPlatform(() =>
          store.execute(
            { type: "file.write", params: { path: file, text } },
            { origin: repoBatch(batch) },
          ),
        );
        fixed.add(batch);
      }
      if (arrival.prefer !== "github") return;
      // GitHub's side first, also over what arrives late: the change's goes into the list.
      conflicts = conflicts.map((conflict) => {
        if (conflict.lost !== "batch") return conflict;
        const [took] = store.writeAsPlatform(() =>
          store.takeConflicts([conflict], repoBatch(conflict.batch)),
        );
        if (!took) return conflict;
        fixed.add(conflict.batch);
        const { ours, theirs, ...rest } = conflict;
        // What the change meant there, where that is said already, is what went of it.
        const meant = conflicts.find(
          (other) =>
            other.lost === "change" &&
            other.batch === conflict.batch &&
            other.path.join("/") === conflict.path.join("/"),
        );
        const went = meant ? meant.theirs : ours;
        return {
          ...rest,
          lost: "change",
          ...(theirs !== undefined && { ours: theirs }),
          ...(went !== undefined && { theirs: went }),
          taken: true,
        } as LateConflict;
      });
      // Of a place where GitHub's side was taken, only that one says what went.
      conflicts = conflicts.filter(
        (conflict) =>
          (conflict as { taken?: true }).taken ||
          conflict.lost !== "change" ||
          !conflicts.some(
            (other) =>
              (other as { taken?: true }).taken &&
              other.batch === conflict.batch &&
              other.path.join("/") === conflict.path.join("/"),
          ),
      );
    });
  } finally {
    store.doc.off("update", take);
  }
  for (const key of written.changes) {
    const raw = key.at?.map.get(key.at.key);
    if (raw === undefined) continue;
    const wrong = checkWritten(key.path, raw);
    if (wrong) return { wrong: `${wrong.path}: ${wrong.problem}` };
  }
  const unknown = arrival.unknown;
  let unknownPlaces: number | undefined;
  if (unknown !== undefined) {
    const every = watched.changes
      .map(({ path }) => path)
      .toSorted((a, b) => a.length - b.length)
      .filter((path, index, all) =>
        all.slice(0, index).every((above) => !above.every((part, at) => path[at] === part)),
      );
    const places = every.slice(0, UNKNOWN_MOST);
    unknownPlaces = every.length;
    if (every.length > places.length) {
      // The rest, in one: people look at all of it.
      const conflict = conflictAt(watched.after, { path: ["manifest"], kind: "check-duplicate" });
      conflicts.push({
        ...conflict,
        label: `还有 ${every.length - places.length} 处离线时的改动没列出${UNKNOWN_SAID}整个项目`,
        batch: unknown,
        lost: "change",
      });
    }
    for (const path of places) {
      const ours = getIn(watched.after, path);
      const conflict = conflictAt(watched.after, { path, kind: "check-duplicate", ours });
      conflicts.push({
        ...conflict,
        label: `${conflict.label}${UNKNOWN_SAID}`,
        batch: unknown,
        lost: "change",
      });
    }
  }
  const fix = made.length > 0 ? { delta: mergeUpdates(made), batches: [...fixed] } : undefined;
  if (conflicts.length === 0 && !fix) return undefined;
  return {
    conflicts,
    ...(fix && { fix }),
    ...(unknownPlaces !== undefined && { unknownPlaces }),
  };
}

/**
 * Merges files from GitHub into a copy as the platform, as one batch, see `SyncHub.mergeRepo`:
 * whatever the merge refuses of them is left out, as for a folder (`mergeInRounds`). Where people
 * want GitHub's side kept where both changed the same thing, that is taken right after, in the same
 * write, as `conflict.take` would. What it wrote is checked as an editor's change would be.
 */
function merge(project: string, request: MergeRequest): Merged {
  const store = copies.get(project);
  if (!store) throw new Error(`project ${project} is not open`);
  const started = performance.now();
  const origin = repoBatch(request.batch);
  const rounds: MergeRound[] = [];
  let taken = new Set<MergeConflict>();
  const made: Uint8Array[] = [];
  const take = (part: Uint8Array) => made.push(part);
  const refused = (reason: string, detail: string): Merged => {
    drop(project);
    return { kind: "refused", reason, detail: detail.slice(0, 200), dropped: true };
  };
  let written: ReturnType<typeof writeBatch<void>>;
  store.doc.on("update", take);
  try {
    written = writeBatch(store, request.batch, () => {
      mergeInRounds(
        store,
        request.changes,
        { origin, baseOf: undefined, here: request.here },
        (round) => rounds.push(round),
      );
      if (request.prefer === "github") {
        const conflicts = rounds.flatMap((round) => (round.ok ? round.result.conflicts : []));
        taken = new Set(store.takeConflicts(conflicts, origin));
      }
    });
  } catch (error) {
    return refused("failed", String(error));
  } finally {
    store.doc.off("update", take);
  }
  for (const key of written.watched.changes) {
    const raw = key.at?.map.get(key.at.key);
    if (raw === undefined) continue;
    const wrong = checkWritten(key.path, raw);
    if (wrong) return refused("invalid", `${wrong.path}: ${wrong.problem}`);
  }
  const info = infoOf(project, store);
  if (info.projectId !== ids.get(project)) return refused("identity", "another project");
  if (info.formatVersion > CURRENT_FORMAT_VERSION) return refused("too-new", "a newer format");
  const merged = made.length > 0 ? mergeUpdates(made) : undefined;
  const delta = merged && !isEmptyUpdate(merged) ? merged : undefined;
  if (delta) values.set(project, (values.get(project) ?? 0) + (piecesOf(delta)?.values ?? 0));

  const files: { path: string; status: string }[] = [];
  const blocked: { path: string; detail: string; code?: string }[] = [];
  const copied: BatchCopy[] = [];
  for (const round of rounds) {
    if (!round.ok) {
      const detail =
        round.error.problems?.map(({ message }) => message).join("；") || round.error.code;
      for (const { path } of round.changes) {
        files.push({ path, status: "blocked" });
        // The code says what it was, as "project-locked" for a project with locked tags.
        blocked.push({ path, detail, code: round.error.code });
      }
      continue;
    }
    for (const file of round.result.files) {
      files.push({ path: file.path, status: file.status });
      if (file.status === "blocked") {
        const detail = round.result.problems
          .filter((problem) => problem.file === file.path)
          .map(({ message }) => message)
          .join("；");
        blocked.push({ path: file.path, detail });
      }
      if (file.copied) copied.push({ file: file.path, insertion: file.copied });
    }
  }
  const conflicts = rounds.flatMap((round) =>
    round.ok
      ? round.result.conflicts.map((conflict) => {
          if (!taken.has(conflict)) return conflict;
          // GitHub's side is in the project now: the editor's is what went.
          const { ours, theirs, ...rest } = conflict;
          return {
            ...rest,
            ...(theirs !== undefined && { ours: theirs }),
            ...(ours !== undefined && { theirs: ours }),
            taken: true as const,
          };
        })
      : [],
  );
  const batch: PlatformBatch = { ...written.batch, seq: request.seq, copied };
  if (delta) {
    const known = batchesOf.get(project) ?? [];
    batchesOf.set(project, [...known, batch].slice(-request.watched));
  }
  return {
    kind: "merged",
    delta,
    info,
    files,
    conflicts,
    blocked,
    batch,
    undo: store.saveUndo(origin),
    ms: Math.round(performance.now() - started),
  };
}

/** Why a step back of the store did not go, as `TakenBack` says it. */
function whyOf(error: { readonly code: string; readonly obstacle?: string }): TakenBack {
  if (error.code === "undo-blocked")
    return { kind: "refused", why: error.obstacle === "inUse" ? "inUse" : "changed" };
  if (error.code === "project-locked") return { kind: "refused", why: "locked" };
  return { kind: "refused", why: "failed", detail: error.code };
}

/**
 * Takes a batch of the platform's back as a whole, or does it again, as the platform, see
 * `SyncHub.takeBack`: from what the batch keeps (`UndoRecord` of core), which says, by the marks
 * the document has now, what was changed since by anybody and stays. What it writes is a batch of
 * its own, watched as merges are, and checked as an editor's change would be.
 */
function takeBack(project: string, request: TakeBackRequest): TakenBack {
  const store = copies.get(project);
  if (!store) throw new Error(`project ${project} is not open`);
  const record = request.record;
  if (!isUndoRecord(record)) return { kind: "refused", why: "gone" };
  if (record.doc.formatVersion !== CURRENT_FORMAT_VERSION)
    return { kind: "refused", why: "format" };
  const { origin } = record;
  // Always from what the database keeps: the copy may have been read again since, or not.
  if (!store.restoreUndo([record], { replace: true }).includes(origin))
    return { kind: "refused", why: "rebuilt" };
  const undo = request.direction === "undo";
  if (undo ? !store.canUndoOrigin(origin) : !store.canRedoOrigin(origin))
    return { kind: "refused", why: undo ? "undone" : "done" };
  if (request.look) {
    const { blocked } = store.undoOutlook(origin);
    return blocked
      ? { kind: "refused", why: blocked === "inUse" ? "inUse" : "changed" }
      : { kind: "could" };
  }
  const made: Uint8Array[] = [];
  const take = (part: Uint8Array) => made.push(part);
  const refused = (detail: string): TakenBack => {
    drop(project);
    return { kind: "refused", why: "failed", detail: detail.slice(0, 200), dropped: true };
  };
  let written: ReturnType<typeof writeBatch<ReturnType<ProjectStore["undoOrigin"]>>>;
  store.doc.on("update", take);
  try {
    written = writeBatch(store, request.batch, () =>
      undo ? store.undoOrigin(origin) : store.redoOrigin(origin),
    );
  } catch (error) {
    return refused(String(error));
  } finally {
    store.doc.off("update", take);
  }
  const result = written.result;
  if (!result.ok) {
    // Nothing was written: the copy is as it was, and the record too.
    if (made.length > 0) return refused(`${result.error.code} after writing`);
    return whyOf(result.error as { code: string; obstacle?: string });
  }
  for (const key of written.watched.changes) {
    const raw = key.at?.map.get(key.at.key);
    if (raw === undefined) continue;
    const wrong = checkWritten(key.path, raw);
    if (wrong) return refused(`${wrong.path}: ${wrong.problem}`);
  }
  const info = infoOf(project, store);
  if (info.projectId !== ids.get(project)) return refused("another project");
  const merged = made.length > 0 ? mergeUpdates(made) : undefined;
  const delta = merged && !isEmptyUpdate(merged) ? merged : undefined;
  if (delta) values.set(project, (values.get(project) ?? 0) + (piecesOf(delta)?.values ?? 0));
  const batch: PlatformBatch = { ...written.batch, seq: request.seq, copied: [] };
  // The batch it took back says what went of theirs no more, nor does a step that takes it back
  // (what it wrote is what was there before); one that does it again writes GitHub's side once
  // more, and says what goes of that, see `WatchedBatch`.
  const known = (batchesOf.get(project) ?? []).map((each) =>
    each.batch === request.of ? { ...each, quiet: true } : each,
  );
  batchesOf.set(
    project,
    delta ? [...known, { ...batch, quiet: undo }].slice(-request.watched) : known,
  );
  const keyOf = (path: readonly string[]) => path.join("\n");
  const kept = new Set(result.kept.map(keyOf));
  const back = new Map<string, readonly string[]>();
  for (const { path } of result.patches) if (!kept.has(keyOf(path))) back.set(keyOf(path), path);
  return {
    kind: "taken",
    delta,
    info,
    batch,
    undo: store.saveUndo(origin),
    back: [...back.values()],
    kept: result.kept,
    ...(result.obstacle !== undefined && {
      obstacle: result.obstacle === "inUse" ? "inUse" : "changed",
    }),
  };
}

/**
 * Runs commands as the platform, as one batch, see `SyncHub.rename`: in one write, all of them or
 * none, checked as an editor's change would be, with what takes the batch back as a whole
 * (`saveUndo`). Not watched for changes made without it: what it writes is what a person asked for,
 * as an editor's change, and goes by the order Yjs gives where another one meets it.
 */
function execute(project: string, request: ExecuteRequest): Executed {
  const store = copies.get(project);
  if (!store) throw new Error(`project ${project} is not open`);
  const origin = repoBatch(request.batch);
  const made: Uint8Array[] = [];
  const take = (part: Uint8Array) => made.push(part);
  const refused = (detail: string): Executed => {
    drop(project);
    return { kind: "refused", reason: "failed", detail: detail.slice(0, 200), dropped: true };
  };
  let written: ReturnType<typeof writeBatch<ReturnType<ProjectStore["executeBatch"]>>>;
  store.doc.on("update", take);
  try {
    written = writeBatch(store, request.batch, () => store.executeBatch(request.calls, { origin }));
  } catch (error) {
    return refused(String(error));
  } finally {
    store.doc.off("update", take);
  }
  const result = written.result;
  if (!result.ok) {
    // All of it or none: nothing was written, and the copy is as it was.
    if (made.length > 0) return refused(`${result.error.code} after writing`);
    const reason = result.error.code === "project-locked" ? "locked" : "invalid";
    return { kind: "refused", reason, detail: result.error.code };
  }
  for (const key of written.watched.changes) {
    const raw = key.at?.map.get(key.at.key);
    if (raw === undefined) continue;
    const wrong = checkWritten(key.path, raw);
    if (wrong) return refused(`${wrong.path}: ${wrong.problem}`);
  }
  const info = infoOf(project, store);
  if (info.projectId !== ids.get(project)) return refused("another project");
  const merged = made.length > 0 ? mergeUpdates(made) : undefined;
  const delta = merged && !isEmptyUpdate(merged) ? merged : undefined;
  if (delta) values.set(project, (values.get(project) ?? 0) + (piecesOf(delta)?.values ?? 0));
  return {
    kind: "executed",
    delta,
    info,
    batch: { ...written.batch, seq: request.seq, copied: [] },
    undo: store.saveUndo(origin),
  };
}

function handle(request: CopyRequest): unknown {
  switch (request.op) {
    case "open":
      return open(request.project, request.parts, request.projectId, request.batches);
    case "create":
      return create(request.project, request.state, request.projectId, request.most);
    case "apply":
      return apply(request.project, request.update, request.most, request.arrival);
    case "merge":
      return merge(request.project, request.merge);
    case "takeBack":
      return takeBack(request.project, request.takeBack);
    case "execute":
      return execute(request.project, request.execute);
    case "without":
      return valuesWithout(request.parts, request.paths);
    case "vector":
    case "deletions":
    case "encode": {
      const store = copies.get(request.project);
      if (!store) throw new Error(`project ${request.project} is not open`);
      if (request.op === "vector") return store.stateVector();
      if (request.op === "deletions") return store.deletions();
      const whole = store.encodeWhole();
      // From now on it is what the database reads it from: what it took in and lost since is gone.
      values.set(request.project, valuesOf([whole]));
      return whole;
    }
    case "drop":
      drop(request.project);
      return undefined;
  }
}

parentPort?.on("message", (request: CopyRequest) => {
  let response: CopyResponse;
  try {
    const result = handle(request);
    response = { id: request.id, ok: true, result, heap: getHeapStatistics().used_heap_size };
  } catch (error) {
    // A copy that something went wrong with goes: what it has is not known any more.
    if ("project" in request && request.op !== "drop") drop(request.project);
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
  parentPort?.postMessage(response);
});
