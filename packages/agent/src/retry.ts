/**
 * Which failures of a service are worth trying again by themselves, and when: too many requests and
 * the troubles of the service itself pass. A wrong key, a model that is not there or a request the
 * service will not take come back the same, and so does an account out of credit.
 */

/** How many times a failed request is tried again on its own. */
export const AUTO_RETRIES = 3;

/** How long to wait before each try again, without a word from the service: 2, 4, 8 seconds. */
export const RETRY_DELAYS_MS: readonly number[] = [2000, 4000, 8000];

/** The longest a service may ask to wait, beyond which waiting here makes no sense. */
const MOST_WAIT_MS = 60_000;

const PASSING =
  /\b429\b|rate[ _-]?limit|too many requests|\b5\d\d\b|overloaded|internal server error|bad gateway|service unavailable|temporarily unavailable/i;
const LASTING = /insufficient[_ ](?:quota|balance)|billing|credit|quota exceeded|exceeded your/i;

/** Whether a failure is one that passes, see above. */
export const passes = (message: string): boolean => PASSING.test(message) && !LASTING.test(message);

/**
 * How long to wait before try `attempt` (1 for the first), as the service asked where its words say
 * (`retry-after: 7`, "try again in 7s", "retry after 7 seconds"), else as `RETRY_DELAYS_MS` has it.
 */
export function retryDelay(attempt: number, message: string): number {
  const said =
    /retry[-_ ]after["':\s]*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i.exec(message) ??
    /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)/i.exec(message);
  if (said) {
    const value = Number(said[1]);
    const ms = said[2]?.toLowerCase() === "ms" ? value : value * 1000;
    if (Number.isFinite(ms) && ms >= 0) return Math.min(Math.ceil(ms), MOST_WAIT_MS);
  }
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1] ?? 8000;
}
