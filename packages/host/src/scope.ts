/**
 * Where in the browser the editor keeps what it keeps: every database, every key of the local
 * storage, every lock and every channel between windows gets its name through `scoped`, so that
 * the two modes, and the accounts of the online one, never see each other's (docs/design/
 * online-offline.md of AnimaQuill Cloud, 2.1). A page is in one scope for all its life: a page that
 * changes the mode or the account loads again, see `setStorageScope`.
 */

/** Offline: a page that connects to no backend. */
export const OFFLINE_SCOPE = "aq-offline-";

/** What a part of a scope can be: anything else becomes "_", as names of databases are text anyway. */
const part = (text: string) => text.replaceAll(/[^\w.:@]/gu, "_");

/** Online: a backend (the site of the page), and the account on it. */
export const onlineScope = (backend: string, account: string): string =>
  `aq-online-${part(backend)}-${part(account)}-`;

let current: string | undefined;

/**
 * Sets the scope of this page, once, before anything opens what the browser keeps. The same scope
 * again changes nothing; another one is a mistake, as what is open already is of the first.
 */
export function setStorageScope(scope: string): void {
  if (current !== undefined && current !== scope)
    throw new Error(`This page keeps what it keeps in ${current} already`);
  current = scope;
}

/** The scope of this page: the offline one where none was set, as for tests. */
export const storageScope = (): string => current ?? OFFLINE_SCOPE;

/** A name of something the browser keeps, in the scope of this page. */
export const scoped = (name: string): string => storageScope() + name;

/** For tests: a page that starts anew. */
export function resetStorageScope(): void {
  current = undefined;
}

/**
 * What the editor kept before there were scopes (0.3.117 and before), all of it: a page of this
 * version takes it away, see `dropUnscoped`. The names of databases, and the beginning of the keys
 * in the local storage.
 */
export const UNSCOPED_DATABASES: readonly string[] = [
  "animaquill",
  "animaquill-trials",
  "animaquill-drafts",
  "animaquill-folders",
  "animaquill-cloud",
  "animaquill-keys",
  "animaquill-account-keys",
  "animaquill-chats",
  "animaquill-chat-images",
  "animaquill-uploads",
  "animaquill-downloads",
  "animaquill-cache",
  "animaquill-exports",
  "animaquill-undo",
  "animaquill-organizer",
  "animaquill-covers",
];
