import type { LocalServerAccess, LocalServerState } from "@animaquill/host";
import { REQUEST_HEADER } from "./headers.ts";

/**
 * The server of `npx animaquill` for its settings (`/api/local/server`, see local/routes.ts of
 * `@animaquill/server`), with the fetch that gives its requests the key of binding.
 */
export function serverLocal(request: typeof fetch): LocalServerAccess {
  const change = { [REQUEST_HEADER]: "1" };
  const ask = async (path: string, init: RequestInit = {}) => {
    const response = await request(`/api/local/server${path}`, { cache: "no-store", ...init });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`The server answered ${response.status}`);
    }
    return response;
  };
  return {
    read: async () => (await (await ask("")).json()) as LocalServerState,
    masterKey: async () => (await ask("/master-key", { method: "POST", headers: change })).text(),
    keySaved: async (fingerprint) => {
      await ask("/master-key/saved", {
        method: "POST",
        headers: { ...change, "content-type": "application/json" },
        body: JSON.stringify({ fingerprint }),
      });
    },
    removeOld: async (name) => {
      await ask(`/old/${encodeURIComponent(name)}`, { method: "DELETE", headers: change });
    },
  };
}
