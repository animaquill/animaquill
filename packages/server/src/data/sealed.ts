import { isNotNull } from "drizzle-orm";
import type { Executor } from "../database.ts";
import { keyContext } from "../me/ai-sync.ts";
import { githubTokens, userAiKeys } from "../schema.ts";
import type { Sealer } from "../seal.ts";

/**
 * Whether what the database keeps sealed opens with these master keys, as after the data was put
 * into another database (data/transfer.ts): GitHub's tokens of each person and the keys of their AI
 * services. Counts only; what opens is never said.
 */
export const openedOf = async (db: Executor, sealer: Sealer) => {
  const count = { total: 0, opened: 0 };
  const githubTokensCount = { ...count };
  const aiKeysCount = { ...count };
  const opens = (open: () => unknown) => {
    try {
      open();
      return true;
    } catch {
      return false;
    }
  };
  for (const row of await db.select().from(githubTokens)) {
    for (const [kind, sealed] of [
      ["access", row.accessToken],
      ["refresh", row.refreshToken],
    ] as const) {
      if (!sealed) continue;
      githubTokensCount.total += 1;
      if (opens(() => sealer.open(sealed, "github-token", `${kind}:${row.userId}`)))
        githubTokensCount.opened += 1;
    }
  }
  for (const row of await db.select().from(userAiKeys).where(isNotNull(userAiKeys.sealed))) {
    aiKeysCount.total += 1;
    if (opens(() => sealer.open(row.sealed!, "ai-key", keyContext(row.userId, row.service))))
      aiKeysCount.opened += 1;
  }
  return { githubTokens: githubTokensCount, aiKeys: aiKeysCount };
};
