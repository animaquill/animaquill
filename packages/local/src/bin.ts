/**
 * What `npx animaquill` runs (dist/cli.js once built): cli.ts, after one thing. Node 25 and later
 * warn, once, that `localStorage` is not there as soon as a library asks whether it is (lib0 of
 * Yjs does, as it loads): nothing of this program uses it, and the warning is no business of the
 * people at the terminal. Every other warning stays.
 */
import process from "node:process";

const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/localStorage is not available/.test(text)) return;
  (emit as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

await import("./cli.ts");
