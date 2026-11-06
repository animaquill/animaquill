/**
 * For tests: which names Chrome does not allow for a file or folder on a disk, as measured with
 * Chromium 156. Asking for one fails with a TypeError, also where the system would be fine with it,
 * and listing a folder leaves such entries out without a word. The private folder of a site, which
 * is what browser tests have instead of a dialog, does not have these rules.
 */
export const isRefusedByChrome = (name: string): boolean =>
  /[<>:"/\\|?*\p{Cc}\p{Cf}\p{Noncharacter_Code_Point}]/u.test(name) ||
  /^[\p{White_Space}~]|[\p{White_Space}.~]$/u.test(name) ||
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(\.|$)/i.test(name) ||
  /^(desktop\.ini|thumbs\.db)$/i.test(name) ||
  /\.(lnk|scf|url|\{.*\})$/i.test(name);
