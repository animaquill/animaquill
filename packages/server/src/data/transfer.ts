import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { nodeDisk } from "../archive/local/disk.ts";
import { Objects, isTreeMode } from "../archive/local/objects.ts";
import { readRef } from "../archive/local/refs.ts";
import type pg from "pg";

/**
 * The server's data, taken out of its database and put into another: what is not in the
 * repositories of the projects (accounts, sessions, keys, conversations, marks, the list of
 * projects and their repositories, the working copies, batches), for rebuilding the database (O3c),
 * changing the major version of PostgreSQL (O4), or a copy away from the machine. Not by `pg_dump`,
 * which the PostgreSQL of `npx animaquill` does not have, and which is of the database's own make;
 * by the tables as the server has them.
 *
 * A folder, every file only its owner's (600, the folder 700):
 *
 * - `manifest.json`: what it is (`format`, `version`), the server that made it, when, which
 *   migrations the database had, and for each table its columns, how many rows, a digest of them
 *   (`digestOf`), and its chunks with theirs;
 * - `tables/<schema>.<table>/<n>.jsonl`: the rows, one a line, each as PostgreSQL's `to_jsonb` has it (column
 *   names, values in their text forms: bytes as `\x…`, times ISO in UTC), except that a value of
 *   a `jsonb` column is `{"v": <value>}` (SQL NULL stays `null`), so that the JSON `null` it may
 *   hold is told from no value at all; `CHUNK_ROWS` rows or `CHUNK_BYTES` bytes a chunk at most.
 *
 * What is sealed (keys of AI services, GitHub's tokens) goes as it is, sealed: the master key that
 * opens it is not in the database and not in here, and the database it goes into needs the same one.
 * Left out: the job queue (`pgboss`, made again as the server starts), the record of migrations
 * (`drizzle`, which the target has of its own, and has to have the same), and what is not in the
 * database at all, such as the pictures of conversations in the object storage, which stays where it
 * is.
 *
 * Which tables: those of the schemas of its scope (`DataScope`): the server's are in `public`; a
 * deployment adds the schemas of its own (the platform's `cloud`), with the record of their
 * migrations.
 *
 * Taken in one snapshot of the database (repeatable read), so that it is the data of one moment; put
 * in only into a database that has the same migrations and nothing in these tables, in one
 * transaction, which is undone unless every table then has what the manifest says.
 */

export const FORMAT = "animaquill-data";
export const FORMAT_VERSION = 3;
const CHUNK_ROWS = 5000;
const CHUNK_BYTES = 64 * 1024 * 1024;
/** Rows put in with one statement at most, and their bytes. */
const INSERT_ROWS = 500;
const INSERT_BYTES = 8 * 1024 * 1024;

export interface TableOfManifest {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: number;
  /** See `digestOf`. */
  readonly digest: string;
  readonly chunks: readonly {
    readonly file: string;
    readonly rows: number;
    readonly sha256: string;
  }[];
}

export interface Manifest {
  readonly format: typeof FORMAT;
  readonly version: number;
  /** The version of the server that made it. */
  readonly server: string;
  readonly exportedAt: string;
  /** The schemas and the records of migrations it is of. */
  readonly scope: DataScope;
  /** The migrations the database had: how many of each set, and the hash of the last. */
  readonly migrations: Migrations;
  readonly secrets: string;
  readonly leftOut: readonly string[];
  readonly tables: readonly TableOfManifest[];
  /**
   * Where the sequences of the database were (schema.name: the last value it gave, or null for
   * none yet), which an import sets again: the numbers of repositories of the server's own
   * (`local_repo_ids`). Missing in an export of a database without sequences.
   */
  readonly sequences?: Readonly<Record<string, number | null>>;
  /**
   * The repositories of the server's own (`repos/` of the data folder), copied into `repos/` here
   * after the tables, with every file and its SHA-256 in `repos.json`: missing where there were
   * none, or the export was told to leave them out.
   */
  readonly repos?: { readonly files: number; readonly bytes: number; readonly sha256: string };
}

/** For each record of migrations (a table of the schema `drizzle`): how many ran, and the last. */
export type Migrations = Readonly<
  Record<string, { readonly count: number; readonly last: string | null }>
>;

/**
 * What of a database the data is: the schemas of its tables, and the tables (of the schema
 * `drizzle`) that note their migrations. The server's alone, unless a deployment adds its own.
 */
export interface DataScope {
  readonly schemas: readonly string[];
  readonly migrations: readonly string[];
}

export const SERVER_SCOPE: DataScope = {
  schemas: ["public"],
  migrations: ["__drizzle_migrations"],
};

const sameScope = (a: DataScope, b: DataScope) =>
  JSON.stringify([a.schemas, a.migrations]) === JSON.stringify([b.schemas, b.migrations]);

export class DataRefused extends Error {
  override name = "DataRefused";
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tableName = (schema: string, name: string) => `${quoted(schema)}.${quoted(name)}`;
/** A table as the manifest and the messages name it. */
export const nameOf = (table: { readonly schema: string; readonly name: string }) =>
  `${table.schema}.${table.name}`;

/**
 * A digest of the rows of a table, whatever their order: the sum, modulo 2^256, of the SHA-256 of
 * each row's text as `to_jsonb` has it. Two databases with the same rows in a table have the same.
 */
export class Digest {
  #sum = 0n;
  #rows = 0;
  add(row: string) {
    this.#sum =
      (this.#sum + BigInt(`0x${createHash("sha256").update(row).digest("hex")}`)) % 2n ** 256n;
    this.#rows += 1;
  }
  get rows() {
    return this.#rows;
  }
  get value() {
    return this.#sum.toString(16).padStart(64, "0");
  }
}

/** The tables of the scope, with their columns in order, as the database has them. */
const tablesOf = async (client: pg.ClientBase, scope: DataScope) => {
  const { rows } = await client.query<{
    schema: string;
    name: string;
    columns: string[];
    json: string[];
  }>(
    `select n.nspname::text as schema, c.relname::text as name,
       array_agg(a.attname::text order by a.attnum) as columns,
       coalesce(array_agg(a.attname::text order by a.attnum) filter (where a.atttypid = 'jsonb'::regtype), '{}'::text[]) as json
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where n.nspname = any($1) and c.relkind in ('r', 'p')
     group by n.nspname, c.relname
     order by array_position($1, n.nspname::text), c.relname`,
    [scope.schemas],
  );
  return rows;
};

/**
 * The tables in an order in which every one comes after those it refers to, so that rows can go in
 * as they are. One that refers to itself comes where it would; its rows go in in the order of their
 * key, see `importData`.
 */
const orderOf = async (client: pg.ClientBase, tables: readonly string[]) => {
  const { rows } = await client.query<{ from: string; to: string }>(
    `select n.nspname || '.' || c.relname as from, rn.nspname || '.' || r.relname as to
     from pg_constraint k
     join pg_class c on c.oid = k.conrelid
     join pg_class r on r.oid = k.confrelid
     join pg_namespace n on n.oid = c.relnamespace
     join pg_namespace rn on rn.oid = r.relnamespace
     where k.contype = 'f' and k.conrelid <> k.confrelid`,
  );
  const needs = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const { from, to } of rows) needs.get(from)?.add(to);
  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < tables.length) {
    const next = tables.find(
      (table) => !placed.has(table) && [...needs.get(table)!].every((other) => placed.has(other)),
    );
    if (next === undefined) throw new DataRefused("the tables refer to each other in a circle");
    ordered.push(next);
    placed.add(next);
  }
  return ordered;
};

/** The columns of a table's primary key, to put its rows in in that order. */
const keyOf = async (client: pg.ClientBase, schema: string, table: string) => {
  const { rows } = await client.query<{ column: string }>(
    `select a.attname as column
     from pg_index i
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indrelid = $1::regclass and i.indisprimary
     order by array_position(i.indkey, a.attnum)`,
    [tableName(schema, table)],
  );
  return rows.map((row) => row.column);
};

const migrationsOf = async (client: pg.ClientBase, scope: DataScope): Promise<Migrations> => {
  const of: Record<string, { count: number; last: string | null }> = {};
  for (const table of scope.migrations) {
    const name = tableName("drizzle", table);
    const there = await client.query<{ there: boolean }>(
      `select to_regclass($1) is not null as there`,
      [name],
    );
    if (!there.rows[0]?.there) {
      of[table] = { count: 0, last: null };
      continue;
    }
    const { rows } = await client.query<{ count: string; last: string | null }>(
      `select count(*)::text as count,
         (select hash from ${name} order by created_at desc, id desc limit 1) as last
       from ${name}`,
    );
    of[table] = { count: Number(rows[0]!.count), last: rows[0]!.last };
  }
  return of;
};

/** The migrations folders of them have, as a database that ran them all says them. */
export const migrationsOfCode = (
  sets: readonly { readonly folder: string; readonly table: string }[],
): Migrations =>
  Object.fromEntries(
    sets.map(({ folder, table }) => {
      const files = readMigrationFiles({ migrationsFolder: folder });
      return [table, { count: files.length, last: files.at(-1)?.hash ?? null }];
    }),
  );

const sameMigrationsAs = (a: Migrations, b: Migrations) =>
  JSON.stringify(Object.entries(a).toSorted()) === JSON.stringify(Object.entries(b).toSorted());
const said = (migrations: Migrations) =>
  Object.entries(migrations)
    .map(([table, { count }]) => `${table} ${count}`)
    .join(", ");

/**
 * Refuses a database whose migrations are not those of the code that reads it: data is taken out
 * and compared only by the code of the database's own version, never by a newer one, which would
 * have to change the database first (and must not, on a copy kept as it was).
 */
const sameMigrations = async (
  client: pg.ClientBase,
  scope: DataScope,
  code: Migrations | undefined,
) => {
  if (!code) return;
  const here = await migrationsOf(client, scope);
  if (!sameMigrationsAs(here, code))
    throw new DataRefused(
      `the database has other migrations (${said(here)}) than this code (${said(code)}): use the code of the database's own version, which is not to be migrated for this`,
    );
};

/** Bytes of rows one fetch of a cursor takes at most, unless one row alone is more. */
const FETCH_BYTES = 16 * 1024 * 1024;
/** Sizes read ahead at a time, which are small. */
const SIZES_AHEAD = 1000;

let cursors = 0;

/**
 * Reads the rows of `query` with a cursor of the transaction the client is in, never more than about
 * `FETCH_BYTES` a fetch: a second cursor of `sizes` (the same rows in the same order, only how large
 * each is) says beforehand how many of the next rows fit, so that small rows followed by rows of
 * megabytes are fetched a few at a time once they come, and never hundreds at once.
 */
async function* cursorOf(client: pg.ClientBase, query: string, sizes: string) {
  cursors += 1;
  const rows = `aq_rows_${cursors}`;
  const ahead = `aq_sizes_${cursors}`;
  await client.query(`declare ${rows} no scroll cursor for ${query}`);
  await client.query(`declare ${ahead} no scroll cursor for ${sizes}`);
  try {
    let known: number[] = [];
    let done = false;
    for (;;) {
      if (known.length < SIZES_AHEAD && !done) {
        const more = await client.query<{ size: number }>(`fetch ${SIZES_AHEAD} from ${ahead}`);
        if (more.rows.length < SIZES_AHEAD) done = true;
        known = known.concat(more.rows.map((row) => Number(row.size)));
      }
      if (known.length === 0) return;
      // As many as fit, and at least one.
      let take = 0;
      let bytes = 0;
      while (take < known.length && (take === 0 || bytes + known[take]! <= FETCH_BYTES)) {
        bytes += known[take]!;
        take += 1;
      }
      known = known.slice(take);
      const fetched = await client.query<{ row: string }>(`fetch ${take} from ${rows}`);
      for (const { row } of fetched.rows) yield row;
      if (fetched.rows.length < take) return;
    }
  } finally {
    await client.query(`close ${rows}`);
    await client.query(`close ${ahead}`);
  }
}

/**
 * Each table's rows as the export has them: `to_jsonb`, with what a `jsonb` column has wrapped as
 * `{"v": …}` where it is not SQL NULL.
 */
const rowsOf = (
  client: pg.ClientBase,
  schema: string,
  table: string,
  json: readonly string[],
  key: readonly string[],
) => {
  const wrapped =
    json.length === 0
      ? ""
      : ` || jsonb_build_object(${json
          .map(
            (column) =>
              `'${column.replaceAll("'", "''")}', case when t.${quoted(column)} is null then null else jsonb_build_object('v', t.${quoted(column)}) end`,
          )
          .join(", ")})`;
  const order =
    key.length > 0 ? ` order by ${key.map((column) => `t.${quoted(column)}`).join(", ")}` : "";
  return cursorOf(
    client,
    `select (to_jsonb(t)${wrapped})::text as row from ${tableName(schema, table)} t${order}`,
    // About as long as the row's text: bytes as hex either way.
    `select octet_length(t::text) as size from ${tableName(schema, table)} t${order}`,
  );
};

/** What a session needs for the text forms to be the same on either side. */
const settle = async (client: pg.ClientBase) => {
  await client.query("set time zone 'UTC'");
  await client.query("set extra_float_digits = 1");
  await client.query("set statement_timeout = 0");
  // Two cursors of a table without a key read it in the same order only so.
  await client.query("set synchronize_seqscans = off");
};

export const writePrivate = (path: string, text: string) => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
};

/** Makes `dir` the empty folder of an export, only its owner's. */
export const startExport = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (readdirSync(dir).length > 0) throw new DataRefused(`${dir} is not empty`);
  mkdirSync(join(dir, "tables"), { mode: 0o700 });
};

/** Writes the rows of one table into its chunks, and says what the manifest has of it. */
export class TableWriter {
  readonly #dir: string;
  readonly #schema: string;
  readonly #name: string;
  readonly #columns: readonly string[];
  readonly #digest = new Digest();
  readonly #chunks: { file: string; rows: number; sha256: string }[] = [];
  #lines: string[] = [];
  #bytes = 0;

  constructor(dir: string, schema: string, name: string, columns: readonly string[]) {
    this.#dir = dir;
    this.#schema = schema;
    this.#name = name;
    this.#columns = columns;
    mkdirSync(join(dir, "tables", `${schema}.${name}`), { mode: 0o700 });
  }

  add(row: string) {
    this.#digest.add(row);
    this.#lines.push(row);
    this.#bytes += Buffer.byteLength(row) + 1;
    if (this.#lines.length >= CHUNK_ROWS || this.#bytes >= CHUNK_BYTES) this.#flush();
  }

  #flush() {
    if (this.#lines.length === 0) return;
    const file = `tables/${this.#schema}.${this.#name}/${String(this.#chunks.length + 1).padStart(5, "0")}.jsonl`;
    const text = `${this.#lines.join("\n")}\n`;
    writePrivate(join(this.#dir, file), text);
    this.#chunks.push({
      file,
      rows: this.#lines.length,
      sha256: createHash("sha256").update(text).digest("hex"),
    });
    this.#lines = [];
    this.#bytes = 0;
  }

  finish(): TableOfManifest {
    this.#flush();
    return {
      schema: this.#schema,
      name: this.#name,
      columns: this.#columns,
      rows: this.#digest.rows,
      digest: this.#digest.value,
      chunks: this.#chunks,
    };
  }
}

/** The manifest of an export, written last: an export without one is no export. */
export const finishExport = (
  dir: string,
  of: Pick<Manifest, "server" | "exportedAt" | "scope" | "migrations" | "tables"> &
    Pick<Partial<Manifest>, "sequences" | "repos">,
): Manifest => {
  const manifest: Manifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    server: of.server,
    exportedAt: of.exportedAt,
    scope: of.scope,
    migrations: of.migrations,
    secrets:
      "Keys of AI services and GitHub's tokens are in here sealed, as the database has them. The master key that opens them is not in here: the server this goes into needs the same one.",
    leftOut: [
      "the job queue (pgboss)",
      "the record of migrations (drizzle)",
      "what is not in the database, such as the pictures of conversations in the object storage",
    ],
    tables: of.tables,
    ...(of.sequences && Object.keys(of.sequences).length > 0 && { sequences: of.sequences }),
    ...(of.repos && { repos: of.repos }),
  };
  writePrivate(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
};

/**
 * Writes the data of the database into `dir`, which must be empty or not there. Resolves to the
 * manifest.
 */
export const exportData = async (
  client: pg.ClientBase,
  dir: string,
  options: {
    readonly server: string;
    readonly now?: Date;
    /** What of the database: the server's tables unless said. */
    readonly scope?: DataScope;
    /** The migrations of the code, which the database has to have: see `sameMigrations`. */
    readonly migrations?: Migrations;
    /**
     * The data folder of the server, whose repositories of its own (`repos/`) go along, after the
     * tables: none where it has none, or unless said.
     */
    readonly dataDir?: string | undefined;
  },
): Promise<Manifest> => {
  const scope = options.scope ?? SERVER_SCOPE;
  await sameMigrations(client, scope, options.migrations);
  startExport(dir);
  await client.query("begin isolation level repeatable read read only");
  let of: Parameters<typeof finishExport>[1];
  try {
    await settle(client);
    const migrations = await migrationsOf(client, scope);
    const tables: TableOfManifest[] = [];
    for (const { schema, name, columns, json } of await tablesOf(client, scope)) {
      const writer = new TableWriter(dir, schema, name, columns);
      for await (const row of rowsOf(client, schema, name, json, await keyOf(client, schema, name)))
        writer.add(row);
      tables.push(writer.finish());
    }
    of = {
      server: options.server,
      exportedAt: (options.now ?? new Date()).toISOString(),
      scope,
      migrations,
      tables,
      sequences: await sequencesOf(client, scope),
    };
  } finally {
    await client.query("rollback");
  }
  // After the snapshot of the tables: a repository newer than the database that comes back with
  // it is merged as changes in the repository, never one older that misses what it has.
  const repos = options.dataDir === undefined ? undefined : await exportRepos(options.dataDir, dir);
  return finishExport(dir, { ...of, ...(repos && { repos }) });
};

/** Where the sequences of the schemas are: the last value each gave, or null for none yet. */
const sequencesOf = async (client: pg.ClientBase, scope: DataScope) => {
  const { rows } = await client.query<{ schema: string; name: string; last: string | null }>(
    `select schemaname as schema, sequencename as name, last_value::text as last
       from pg_sequences where schemaname = any($1) order by 1, 2`,
    [scope.schemas],
  );
  return Object.fromEntries(
    rows.map((row) => [`${row.schema}.${row.name}`, row.last === null ? null : Number(row.last)]),
  );
};

/** What `repos.json` of an export says: each file of `repos/`, by its path there. */
interface ReposList {
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

/** How much of a file is copied at a time: objects of Git LFS are as large as 2 GiB. */
const COPY_BYTES = 1024 * 1024;

/**
 * Copies a file into a new one (EEXIST where it is there), a piece at a time, as it is read: its
 * length and SHA-256. ENOENT where it is not there.
 */
const copyHashing = (from: string, to: string, mode: number): { size: number; sha256: string } => {
  const source = openSync(from, "r");
  try {
    const target = openSync(to, "wx", mode);
    try {
      const hash = createHash("sha256");
      const piece = Buffer.allocUnsafe(COPY_BYTES);
      let size = 0;
      for (;;) {
        const read = readSync(source, piece, 0, COPY_BYTES, null);
        if (read === 0) break;
        hash.update(piece.subarray(0, read));
        for (let at = 0; at < read;) at += writeSync(target, piece, at, read - at);
        size += read;
      }
      return { size, sha256: hash.digest("hex") };
    } finally {
      closeSync(target);
    }
  } finally {
    closeSync(source);
  }
};

/** A file of `repos/` whose name says it is half written, as a crash leaves one. */
const isTemporary = (name: string) =>
  name.startsWith(".tmp-") || name.startsWith("tmp_obj_") || name.endsWith(".lock");

/**
 * Copies the repositories of the server's own into `repos/` of an export, as Git can be copied
 * while it is written: first what names commits (HEAD, refs, packed-refs, config, logs), then the
 * objects, listed only after that, which are only ever added, so that every commit a branch of
 * the copy names is in it. Half-written files stay behind. Last, the branch `main` of each
 * repository in the copy is read from its commit down, and the export fails, saying which, where
 * anything of it is not there (as after a `git gc` that packed objects away meanwhile). Undefined
 * where the data folder has no repositories. `afterRefs`: for tests, what happens between the two.
 */
export const exportRepos = async (
  dataDir: string,
  dir: string,
  hooks: { readonly afterRefs?: () => Promise<void> } = {},
): Promise<{ files: number; bytes: number; sha256: string } | undefined> => {
  const from = join(dataDir, "repos");
  if (!existsSync(join(from, ".animaquill-repos"))) return undefined;
  const isObjects = (path: string) => /(^|\/)objects$/.test(path);
  /** The files of `repos/`, by their paths there: the objects, or all but them. */
  const listed = (objects: boolean): string[] => {
    const all: string[] = [];
    const walk = (folder: string, prefix: string, inObjects: boolean) => {
      let entries;
      try {
        entries = readdirSync(folder, { withFileTypes: true });
      } catch (error) {
        // A folder of objects that `git gc` took away meanwhile.
        if ((error as { code?: unknown }).code === "ENOENT" && inObjects) return;
        throw error;
      }
      for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
        if (isTemporary(entry.name)) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const within = inObjects || (entry.isDirectory() && isObjects(path));
        // Not into the objects while listing the rest; through everything else for the objects.
        if (entry.isDirectory()) {
          if (objects || !within) walk(join(folder, entry.name), path, within);
        } else if (entry.isFile() && within === objects) all.push(path);
      }
    };
    walk(from, "", false);
    return all;
  };
  const files: { path: string; size: number; sha256: string }[] = [];
  let bytes = 0;
  const copy = (path: string, mayBeGone: boolean) => {
    const target = join(dir, "repos", path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    let copied: { size: number; sha256: string };
    try {
      copied = copyHashing(join(from, path), target, 0o600);
    } catch (error) {
      // A loose object `git gc` packed meanwhile: the pack it went into is listed too, or the
      // check below says what is missing.
      if (mayBeGone && (error as { code?: unknown }).code === "ENOENT") return;
      throw error;
    }
    files.push({ path, ...copied });
    bytes += copied.size;
  };
  for (const path of listed(false)) copy(path, false);
  await hooks.afterRefs?.();
  for (const path of listed(true)) copy(path, true);
  // Each repository of the copy: its branch names a commit that is there, with all of its tree.
  const copied = join(dir, "repos");
  const missing: string[] = [];
  for (const name of readdirSync(copied).filter((each) => each.endsWith(".git"))) {
    const gitdir = join(copied, name);
    const tip = await readRef(nodeDisk(), gitdir, "refs/heads/main").catch(() => undefined);
    if (tip === undefined) continue;
    const objects = new Objects(gitdir, nodeDisk(), process.platform);
    const whole = async (): Promise<boolean> => {
      const commit = await objects.commit(tip);
      if (!commit) return false;
      const walk = async (tree: string): Promise<boolean> => {
        if (!(await objects.find(tree))) return false;
        for (const item of await objects.tree(tree)) {
          if (item.mode === "160000") continue;
          if (isTreeMode(item.mode)) {
            if (!(await walk(item.sha))) return false;
          } else if (!(await objects.find(item.sha))) return false;
        }
        return true;
      };
      return walk(commit.tree);
    };
    const ok = await whole().catch(() => false);
    if (!ok) missing.push(`repos/${name} (main ${tip})`);
  }
  if (missing.length > 0)
    throw new DataRefused(
      `the copy of these repositories misses what their branch names, as when Git rewrote them meanwhile: ${missing.join(", ")}; export again`,
    );
  const list = `${JSON.stringify({ files } satisfies ReposList)}\n`;
  writePrivate(join(dir, "repos.json"), list);
  return { files: files.length, bytes, sha256: createHash("sha256").update(list).digest("hex") };
};

/**
 * Puts the repositories of an export into the data folder of this server, each file checked
 * against its SHA-256: only where it has none yet (nothing in `repos/` but its mark). All or
 * nothing: they go into a folder of their own first, which becomes `repos/` once whole.
 */
export const importRepos = (dir: string, dataDir: string, manifest: Manifest): number => {
  if (!manifest.repos) return 0;
  const listText = readFileSync(join(dir, "repos.json"), "utf8");
  if (createHash("sha256").update(listText).digest("hex") !== manifest.repos.sha256)
    throw new DataRefused("repos.json is not what was exported");
  const list = JSON.parse(listText) as ReposList;
  const to = join(dataDir, "repos");
  if (existsSync(to) && readdirSync(to).some((name) => name !== ".animaquill-repos"))
    throw new DataRefused(`${to} has repositories already: import only into a server without any`);
  const building = join(dataDir, `.repos-importing-${process.pid}-${Date.now()}`);
  mkdirSync(building, { recursive: true, mode: 0o755 });
  try {
    for (const file of list.files) {
      if (
        file.path.split("/").some((part) => part === ".." || part === "") ||
        isAbsolute(file.path)
      )
        throw new DataRefused(`${file.path} is no file of a repository`);
      const target = join(building, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      const copied = copyHashing(join(dir, "repos", file.path), target, 0o644);
      if (copied.sha256 !== file.sha256 || copied.size !== file.size)
        throw new DataRefused(`repos/${file.path} is not what was exported`);
    }
    if (!existsSync(join(building, ".animaquill-repos")))
      writeFileSync(
        join(building, ".animaquill-repos"),
        "AnimaQuill keeps repositories in here.\n",
      );
    rmSync(to, { recursive: true, force: true });
    renameSync(building, to);
  } catch (error) {
    rmSync(building, { recursive: true, force: true });
    throw error;
  }
  return list.files.length;
};

export const readManifest = (dir: string): Manifest => {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    throw new DataRefused(`${dir} has no manifest.json that can be read`);
  }
  if (manifest.format !== FORMAT || manifest.version !== FORMAT_VERSION)
    throw new DataRefused(
      `${dir} is not data of this version (${FORMAT} ${FORMAT_VERSION}): ${manifest.format} ${manifest.version}`,
    );
  return manifest;
};

/** The digest and rows of every table of the database now, as the export says them. */
export const digestsOf = async (client: pg.ClientBase, scope: DataScope) => {
  const ours = new Map<string, { rows: number; digest: string; columns: readonly string[] }>();
  for (const { schema, name, columns, json } of await tablesOf(client, scope)) {
    const digest = new Digest();
    for await (const row of rowsOf(client, schema, name, json, await keyOf(client, schema, name)))
      digest.add(row);
    ours.set(nameOf({ schema, name }), { rows: digest.rows, digest: digest.value, columns });
  }
  return ours;
};

/**
 * What differs between the data of the database and that of `dir`: nothing, where they are the
 * same. In a snapshot of its own, as after an import, or to compare a database with its export.
 */
export const verifyData = async (
  client: pg.ClientBase,
  dir: string,
  options: { readonly migrations?: Migrations } = {},
) => {
  const manifest = readManifest(dir);
  await client.query("begin isolation level repeatable read read only");
  try {
    await sameMigrations(client, manifest.scope, options.migrations);
    await settle(client);
    return { manifest, differences: await differencesFrom(client, manifest) };
  } finally {
    await client.query("rollback");
  }
};

/** What differs between the database now, in the transaction of the caller, and a manifest. */
const differencesFrom = async (client: pg.ClientBase, manifest: Manifest) => {
  const ours = await digestsOf(client, manifest.scope);
  const differences: string[] = [];
  for (const table of manifest.tables) {
    const name = nameOf(table);
    const here = ours.get(name);
    if (!here) differences.push(`${name}: not here`);
    else if (here.rows !== table.rows)
      differences.push(`${name}: ${here.rows} rows here, ${table.rows} in the export`);
    else if (here.digest !== table.digest) differences.push(`${name}: other rows`);
  }
  for (const name of ours.keys())
    if (!manifest.tables.some((table) => nameOf(table) === name))
      differences.push(`${name}: not in the export`);
  return differences;
};

/** The lines of a chunk, as it is read, after its SHA-256 is checked. */
export async function* linesOf(dir: string, chunk: TableOfManifest["chunks"][number]) {
  if (chunk.file.includes("..") || !/^tables\/[^/]+\/\d+\.jsonl$/.test(chunk.file))
    throw new DataRefused(`${chunk.file} is no chunk of the export`);
  const path = join(dir, chunk.file);
  const hash = createHash("sha256");
  for await (const piece of createReadStream(path)) hash.update(piece as Buffer);
  if (hash.digest("hex") !== chunk.sha256)
    throw new DataRefused(`${chunk.file} is not what was exported`);
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) if (line.length > 0) yield line;
}

/**
 * Puts the data of `dir` into the database, which has to have the same migrations and nothing in
 * these tables: in one transaction, undone unless each table then has exactly what the manifest
 * says. Resolves to the manifest.
 */
export const importData = async (
  client: pg.ClientBase,
  dir: string,
  options: {
    readonly scope?: DataScope;
    /**
     * The data folder of this server, where the repositories of the export go (`importRepos`):
     * once everything about the database is checked, before the rows go in, and away again where
     * they do not. Left where they are unless said.
     */
    readonly dataDir?: string | undefined;
  } = {},
): Promise<Manifest> => {
  const manifest = readManifest(dir);
  const scope = options.scope ?? SERVER_SCOPE;
  /** The repositories this put into the data folder, which go again where the rest does not. */
  let repos: string | undefined;
  if (!sameScope(scope, manifest.scope))
    throw new DataRefused(
      `the export is of other schemas (${manifest.scope.schemas.join(", ")}) than this server (${scope.schemas.join(", ")})`,
    );
  await client.query("begin");
  try {
    await settle(client);
    const migrations = await migrationsOf(client, scope);
    if (!sameMigrationsAs(migrations, manifest.migrations))
      throw new DataRefused(
        `the database has other migrations (${said(migrations)}) than the export (${said(manifest.migrations)}): import into a database of the same version`,
      );
    const tables = await tablesOf(client, scope);
    const here = new Map(tables.map((table) => [nameOf(table), table]));
    for (const table of manifest.tables) {
      const name = nameOf(table);
      const there = here.get(name);
      if (!there) throw new DataRefused(`the database has no table ${name}`);
      if (JSON.stringify(there.columns) !== JSON.stringify(table.columns))
        throw new DataRefused(`${name} has other columns here than in the export`);
    }
    for (const name of here.keys())
      if (!manifest.tables.some((table) => nameOf(table) === name))
        throw new DataRefused(`the export has no table ${name}, which the database has`);
    for (const [name, table] of here) {
      const { rows } = await client.query<{ any: boolean }>(
        `select exists (select 1 from ${tableName(table.schema, table.name)}) as any`,
      );
      if (rows[0]?.any)
        throw new DataRefused(`${name} is not empty: import only into an empty database`);
    }
    // Only now that the database takes the export: what is put here goes again on any failure.
    if (options.dataDir !== undefined && manifest.repos !== undefined) {
      importRepos(dir, options.dataDir, manifest);
      repos = join(options.dataDir, "repos");
    }
    const byName = new Map(manifest.tables.map((table) => [nameOf(table), table]));
    for (const name of await orderOf(client, [...here.keys()])) {
      const table = byName.get(name)!;
      const target = tableName(table.schema, table.name);
      let batch: string[] = [];
      let bytes = 0;
      // Each column from the record PostgreSQL makes of the line, but the `jsonb` ones: their
      // `{"v": …}` unwrapped, which keeps a JSON null a JSON null (`null` itself has no `v`: NULL).
      const json = new Set(here.get(name)!.json);
      const values = table.columns
        .map((column) =>
          json.has(column)
            ? `x.e -> '${column.replaceAll("'", "''")}' -> 'v'`
            : `(x.r).${quoted(column)}`,
        )
        .join(", ");
      const insert = `insert into ${target} (${table.columns.map(quoted).join(", ")})
        select ${values}
        from (select e, jsonb_populate_record(null::${target}, e) as r
              from jsonb_array_elements($1::jsonb) as e) as x`;
      const put = async () => {
        if (batch.length === 0) return;
        await client.query(insert, [`[${batch.join(",")}]`]);
        batch = [];
        bytes = 0;
      };
      for (const chunk of table.chunks)
        for await (const line of linesOf(dir, chunk)) {
          batch.push(line);
          bytes += line.length;
          if (batch.length >= INSERT_ROWS || bytes >= INSERT_BYTES) await put();
        }
      await put();
    }
    // The sequences go on from where they were, as the numbers they gave are in the rows.
    for (const [name, last] of Object.entries(manifest.sequences ?? {})) {
      const [schema, sequence] = name.split(".") as [string, string];
      if (!scope.schemas.includes(schema)) throw new DataRefused(`${name} is of no schema here`);
      const { rows } = await client.query<{ there: boolean }>(
        "select exists (select 1 from pg_sequences where schemaname = $1 and sequencename = $2) as there",
        [schema, sequence],
      );
      if (!rows[0]?.there) throw new DataRefused(`the database has no sequence ${name}`);
      await client.query(
        last === null
          ? "select setval($1::regclass, 1, false)"
          : "select setval($1::regclass, $2, true)",
        last === null ? [tableName(schema, sequence)] : [tableName(schema, sequence), last],
      );
    }
    const differences = await differencesFrom(client, manifest);
    if (differences.length > 0)
      throw new DataRefused(`what went in is not what was exported: ${differences.join("; ")}`);
    await client.query("commit");
    return manifest;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    // What this put in goes again: nothing of the export is left half in.
    if (repos !== undefined) rmSync(repos, { recursive: true, force: true });
    throw error;
  }
};
