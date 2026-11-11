/**
 * An address that came from outside, such as a repository's from the platform, as a link people
 * can press: only where it is an https address. Anything else, as `javascript:`, is left out.
 */
export function httpsLink(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  try {
    return new URL(address).protocol === "https:" ? address : undefined;
  } catch {
    return undefined;
  }
}
