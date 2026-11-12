/**
 * Words in a pack worth a second look before people install it. They do not keep a pack out: the
 * checks in code hold whatever a pack says, and people decide. The install dialog marks the words
 * that have them, with why. More rules can come.
 */
export const HINT_RULES = [
  {
    rule: "secrets",
    pattern:
      /\b(?:api[\s_-]?keys?|passwords?|passwd|passphrases?|tokens?|secrets?|credentials?|private[\s_-]keys?)\b|密钥|口令|密码|令牌|凭据/i,
  },
  { rule: "address", pattern: /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|cn)\b/i },
  {
    rule: "ignore",
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|other|system|all)\b[^.\n]{0,20}\b(?:instructions?|rules?|prompts?|messages?|guidelines?)\b|忽略(?:之前|以上|前面|上面|所有)|无视/i,
  },
  {
    rule: "hide",
    pattern:
      /\b(?:do not|don't|never|without)\b[^.\n]{0,30}\b(?:tell|telling|inform|informing|mention|mentioning|show|showing|report|reporting|summar\w*)\b[^.\n]{0,20}\b(?:user|people|them)\b|\bno summary\b|\bwithout (?:a )?summary\b|\bsecretly\b|\bquietly\b|不要告诉|别告诉|不告诉|瞒着|不要提|不写.{0,6}摘要/i,
  },
  {
    rule: "network",
    pattern:
      /\b(?:upload\w*|send(?:s|ing)? (?:it |them |this |the \w+ )?to|post(?:s|ing)? (?:it |them |this )?to|exfiltrat\w*|webhook\w*|fetch(?:es|ing)? (?:from|the url)|network requests?)\b|上传|发送到|发给|联网/i,
  },
] as const;

export type HintRule = (typeof HINT_RULES)[number]["rule"];

/** The rules some words meet, in the order of the table. */
export function hintsIn(text: string): readonly HintRule[] {
  return HINT_RULES.filter(({ pattern }) => pattern.test(text)).map(({ rule }) => rule);
}
