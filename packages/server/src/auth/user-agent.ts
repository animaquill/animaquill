/**
 * Which browser on which system a session is, such as "Chrome 157, Windows", for people to tell their
 * sessions apart one day. Only that much: the whole User-Agent says more than anyone needs to keep.
 */
export const describeUserAgent = (header: string | undefined): string | null => {
  if (!header) return null;
  const browser =
    match(header, /\bEdg(?:e|A|iOS)?\/(\d+)/, "Edge") ??
    match(header, /\bOPR\/(\d+)/, "Opera") ??
    match(header, /\bFirefox\/(\d+)/, "Firefox") ??
    match(header, /\bChrome\/(\d+)/, "Chrome") ??
    match(header, /\bVersion\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//, "Safari");
  const system = /\bWindows\b/.test(header)
    ? "Windows"
    : /\b(?:iPhone|iPad|iPod)\b/.test(header)
      ? "iOS"
      : /\bMac OS X\b|\bMacintosh\b/.test(header)
        ? "macOS"
        : /\bAndroid\b/.test(header)
          ? "Android"
          : /\bCrOS\b/.test(header)
            ? "ChromeOS"
            : /\bLinux\b/.test(header)
              ? "Linux"
              : undefined;
  const parts = [browser, system].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join(", ") : null;
};

const match = (header: string, pattern: RegExp, name: string) => {
  const found = pattern.exec(header);
  return found ? `${name} ${found[1]}` : undefined;
};
