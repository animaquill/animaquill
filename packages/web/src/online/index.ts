import type { AiRelay, Host } from "@animaquill/host";
import { relayAddressOf } from "@animaquill/host/relay";
import type { EditorSite } from "../start.ts";
import { serverAccount, type ServerAccountOptions } from "./account.ts";
import { serverCloud } from "./cloud.ts";
import { REQUEST_HEADER } from "./headers.ts";
import { BINDING_HEADER, bindingFetch } from "./local.ts";

/**
 * The online mode against the backend of the editor's own site (`@animaquill/server`, under /api of
 * the same origin): the account, keeping projects and the relay of AI services. What a deployment has besides (its own report service, an invite
 * page of its own) it adds around this.
 */

export {
  describeSession,
  describeSpace,
  GITHUB_PICTURES,
  serverAccount,
  type ServerAccountOptions,
} from "./account.ts";
export { serverCloud, type ServerCloudOptions } from "./cloud.ts";
export { EDITOR_HEADER, REQUEST_HEADER } from "./headers.ts";
export {
  BINDING_HEADER,
  bindingFetch,
  fetchEventSource,
  signInLocally,
  syncProtocols,
  type LocalSignIn,
} from "./local.ts";

/**
 * The relay of AI services of the server, for the browser agent (relay/ of the server). The browser
 * brings what shows its session along; the header says that the request comes from a page of this
 * site.
 */
export function serverRelay(binding?: string): AiRelay {
  return {
    addressOf: (baseUrl) => relayAddressOf(baseUrl, location.origin),
    headers: {
      [REQUEST_HEADER]: "1",
      ...(binding !== undefined && { [BINDING_HEADER]: binding }),
    },
  };
}

export interface ServerOnlineOptions extends ServerAccountOptions {
  /** The editor's site. */
  readonly editor: string;
  /** The version of this page. */
  readonly version: string;
  /** Where reports go, where the deployment has a place for them: none unless said. */
  readonly diagnostics?: Host["diagnostics"];
  /**
   * The key of binding of this page, for the backend of `npx animaquill`: see local.ts. People sign
   * in there from its terminal, not here. None unless said.
   */
  readonly binding?: string | undefined;
}

/** What `startEditor` takes as `online`, for the backend of this site. */
export function serverOnline(options: ServerOnlineOptions): NonNullable<EditorSite["online"]> {
  const { editor, version, diagnostics, binding } = options;
  return {
    account: () =>
      serverAccount({
        ...(options.pictures !== undefined && { pictures: options.pictures }),
        ...(binding !== undefined && { fetch: bindingFetch(binding), signInFrom: "terminal" }),
      }),
    parts: () => ({
      ...(diagnostics && { diagnostics }),
      cloud: serverCloud({ editor, version, binding }),
      aiRelay: serverRelay(binding),
    }),
  };
}
