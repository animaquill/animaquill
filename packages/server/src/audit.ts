import type { Executor } from "./database.ts";

/**
 * Where whoever runs the server keeps a record of what was changed by hand, such as a setting
 * (settings.ts): who, what, of what, and the plain details, in the transaction that makes the
 * change, so that one is never there without the other. Nothing is recorded unless the server is
 * given one; the platform records into the record of its admin site.
 */
export interface Audit {
  record(tx: Executor, entry: AuditEntry): Promise<void>;
}

export interface AuditEntry {
  /** Who did it; null for the command line on the server. */
  readonly by: string | null;
  /** Such as "setting.change". */
  readonly action: string;
  /** Such as "setting:relay". */
  readonly target?: string | undefined;
  /** Plain values only, chosen where the change is made, so that no secret finds its way in. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  readonly at?: Date | undefined;
}
