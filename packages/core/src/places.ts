/**
 * Where the file of an asset is kept, as it gets written down in a project: see `places` in
 * structure.ts, `withPlace` in model.ts for how an asset reads with it, and `AssetStorage` of the
 * format for what each place means.
 */
import { Asset, AssetHash, HttpsUrl, Id, isElsewhere, isSameHash } from "@animaquill/schema";
import { z } from "zod";
import { fail, type Draft } from "./draft.ts";
import { entryOf, withPlace } from "./model.ts";
import { STORAGE } from "./origin.ts";
import { deepEqual } from "./patch.ts";

/**
 * Where the editor puts a file, which is all a place can say: the person's own Git is no place
 * that the editor puts files in.
 */
const PlaceStorage = z.enum(["local", "lfs", "platform", "remote"]);

/** What a place is bound to: an id of a repository, a person or a storage, see `Place`. */
const Binding = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "要写成 id：英文字母、数字和 . _ : -");

/** What only one kind of place has, and has to: the others leave it out. */
const BINDINGS = { repo: "lfs", owner: "platform" } as const;

interface PlaceFields {
  readonly storage: string;
  readonly url?: string | undefined;
  readonly repo?: string | undefined;
  readonly owner?: string | undefined;
  readonly store?: string | undefined;
}

/** What a place of each kind has, and has not: see `Place`. */
function placeRules(place: PlaceFields, context: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    context.addIssue({ code: "custom", path: [path], message });
  if ((place.storage === "remote") !== (place.url !== undefined)) {
    issue("url", "remote 要写 url，别的不写");
  }
  for (const [field, storage] of Object.entries(BINDINGS)) {
    const has = place[field as keyof typeof BINDINGS] !== undefined;
    if (place.storage === storage && !has) issue(field, `${storage} 要写 ${field}`);
    if (place.storage !== storage && has) issue(field, `只有 ${storage} 写 ${field}`);
  }
  if (place.storage !== "remote" && place.store !== undefined)
    issue("store", "只有 remote 写 store");
}

/**
 * Where the file of an asset is kept, written down for the content the asset had then: another
 * file of the same asset is not there, see `withPlace`. And where that is: a place counts only
 * where it is bound to, see `Here`, as it does not for a copy of the project in another repository,
 * or for somebody else.
 */
export const Place = z
  .strictObject({
    storage: PlaceStorage,
    /** Where a `remote` file is. */
    url: HttpsUrl.optional(),
    /** The content it is about, as the asset had it. */
    hash: AssetHash,
    /** How large that is, which another file is not: what the asset says when it says nothing. */
    size: z.number().int().nonnegative().optional(),
    /** `lfs`: the repository, by its id on GitHub, whose LFS has the file. */
    repo: Binding.optional(),
    /** `platform`: whose cloud space has the file, by the id of the person on the platform. */
    owner: Binding.optional(),
    /** `remote`: which storage of the person has it, by its id, where it has one (step 14.5). */
    store: Binding.optional(),
  })
  .superRefine((place, context) => {
    placeRules(place, context);
    if (place.storage !== "local" && place.size === undefined) {
      context.addIssue({ code: "custom", path: ["size"], message: `${place.storage} 要写 size` });
    }
  });

export type Place = z.output<typeof Place>;

export const StorageChange = z
  .strictObject({
    asset: Id,
    storage: PlaceStorage,
    url: HttpsUrl.optional(),
    /** The content that went there: only while the asset still has it does this get written down. */
    hash: AssetHash,
    repo: Binding.optional(),
    owner: Binding.optional(),
    store: Binding.optional(),
  })
  .superRefine(placeRules);

/**
 * Writes down where the file of an asset is kept, for the content it has now, and what that is
 * bound to: what an upload says once the file got there and was checked (`STORAGE`), or what
 * people say to keep it here only. Nobody else can say that a file is somewhere it was never put.
 * Another computer gets the file by its hash and checks it by its size, so both have to be known.
 * It writes nothing of the asset itself, see structure.ts.
 */
export function setStorage(
  draft: Draft,
  { asset: id, storage, url, hash, repo, owner, store }: z.output<typeof StorageChange>,
): void {
  const asset = entryOf(draft.state.assets, id);
  if (!asset) return fail("not-found", { kind: "asset", id });
  const held = asset.hash;
  if (held === undefined || !isSameHash(held, hash)) {
    return fail("asset-file-changed", { asset: id });
  }
  const isHere = storage === "local";
  if (!isHere && draft.origin !== STORAGE) {
    return fail("upload-only", {});
  }
  if (!isHere && asset.size === undefined) {
    return fail("invalid-value", { rule: "size-unknown", asset: id });
  }
  const place: Place = {
    storage,
    ...(url !== undefined && { url }),
    hash: held,
    ...(!isHere && asset.size !== undefined && { size: asset.size }),
    ...(repo !== undefined && { repo }),
    ...(owner !== undefined && { owner }),
    ...(store !== undefined && { store }),
  };
  const placed = withPlace(asset, place);
  const checked = Asset.safeParse(placed);
  if (!checked.success || placed.storage !== storage) {
    const issue = checked.success ? undefined : checked.error.issues[0];
    const path = ["storage", ...(issue?.path.map(String) ?? [])].join(".");
    return fail("invalid-value", { rule: "format", path, message: issue?.message ?? "" });
  }
  // What the asset says itself needs no place. What is written down already is not written again.
  const isOwn = isHere && asset.storage === "local";
  draft.replace(["places", id], isOwn ? undefined : place);
}

/** Whether a place says about the file of an asset what the asset, as files have it, says. */
const agrees = (place: Place, asset: Asset): boolean =>
  asset.hash !== undefined &&
  isSameHash(place.hash, asset.hash) &&
  (place.size === undefined || asset.size === undefined || place.size === asset.size) &&
  place.storage === asset.storage &&
  place.url === asset.url;

/**
 * What an asset is to say itself, so that it reads as `wanted` with a place that agrees with that:
 * the same object where it does already, and what it said itself about where its file is. That is
 * about the file it had then: of another file, or of the same one with another size, the asset
 * says it is only here, and the place says the rest. The asset has to hold on its own, because its
 * place can go while the asset stays, as when one window takes the asset away and another one
 * changes it at the same time: then it must not say of a file what was said of another one.
 */
function withoutPlace(body: Asset | undefined, place: Place, wanted: Asset): Asset {
  if (!body) return wanted;
  if (deepEqual(withPlace(body, place), wanted)) return body;
  const { url: _url, ...rest } = wanted;
  const isSameFile =
    body.hash !== undefined &&
    wanted.hash !== undefined &&
    isSameHash(body.hash, wanted.hash) &&
    body.size === wanted.size;
  const own: Asset =
    isElsewhere(body.storage) && !isSameFile
      ? { ...rest, storage: "local" }
      : { ...rest, storage: body.storage, ...(body.url !== undefined && { url: body.url }) };
  return Asset.safeParse(own).success ? own : wanted;
}

/**
 * Makes the assets of a project what a document says, which has them as files do, with where each
 * file is kept: assets.json, as it comes in or merges. Where the place of an asset says the same
 * about the same content, it stays, and the asset goes on saying what it said itself: only its
 * other fields follow. Anywhere else the asset says what the document says, and its place goes.
 * So taking back what people said about where a file is still goes back to what the asset says.
 * The place of an asset that the document does not have stays: a merge can keep the asset all the
 * same, as one that is still in use, and without it the place says nothing.
 */
export function writeAssets(
  draft: Draft,
  wanted: Readonly<Record<string, Asset>> | undefined,
): void {
  const { assets: bodies, places } = draft.state;
  let next: Record<string, Asset> | undefined;
  if (wanted) {
    next = {};
    for (const [id, asset] of Object.entries(wanted)) {
      const place = entryOf(places, id);
      next[id] =
        place && agrees(place, asset) ? withoutPlace(entryOf(bodies, id), place, asset) : asset;
    }
  }
  draft.replace(["assets"], next);
  for (const [id, place] of Object.entries(places ?? {})) {
    const asset = wanted && entryOf(wanted, id);
    if (asset && !agrees(place, asset)) draft.delete(["places", id]);
  }
}

/**
 * An asset a file brings with another file than the asset had, `known` as files have it: where it
 * says of the new file what was said of the one before, that is about the one before. Only what
 * the file says anew holds, so the new file is only here. Another file is one of another hash, or
 * of another size where the file says one: of one content there is one size, as for `asset.update`.
 */
export function anotherFileIsHere(known: Asset | undefined, wanted: Asset): Asset {
  if (!known || known.hash === undefined || wanted.hash === undefined) return wanted;
  const isAnotherFile =
    !isSameHash(known.hash, wanted.hash) ||
    (wanted.size !== undefined && wanted.size !== known.size);
  if (!isAnotherFile || !isElsewhere(wanted.storage)) return wanted;
  if (wanted.storage !== known.storage || wanted.url !== known.url) return wanted;
  const { url: _url, ...rest } = wanted;
  return { ...rest, storage: "local" };
}
