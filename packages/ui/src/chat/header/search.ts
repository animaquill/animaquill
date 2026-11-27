import { useEffect, useState } from "react";
import { useWorkbench } from "../../app/context.ts";
import type { Found } from "../conversations.ts";
import { SEARCH_DELAY_MS } from "./title.ts";

/**
 * What a search of the conversations of the project found, a moment after typing rests: nothing
 * while there is nothing to look for, or while it looks.
 */
export function useFound(query: string): readonly Found[] | undefined {
  const { chat } = useWorkbench();
  const [found, setFound] = useState<{ readonly query: string; readonly hits: readonly Found[] }>();
  useEffect(() => {
    if (!query.trim()) return;
    let current = true;
    const timer = setTimeout(() => {
      void chat.search(query).then((hits) => {
        if (current) setFound({ query, hits });
      });
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [chat, query]);
  return query.trim() && found?.query === query ? found.hits : undefined;
}
