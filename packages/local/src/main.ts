import { localSites, startEditor } from "@animaquill/web";
import { serverOnline, signInLocally } from "@animaquill/web/online";

// The page of the editor on this computer, from the server of this package. Where the backend of
// this computer runs with it (the page says so, see `BACKEND_META` of server.ts), the online mode
// is there too: the person who started it, without signing in, see `signInLocally`. Without it, as
// with `--offline`, only the offline mode. Reports stay here, where people can save or copy them.
const root = document.querySelector<HTMLElement>("#root");
if (root) {
  const backend =
    document.querySelector('meta[name="animaquill-backend"]')?.getAttribute("content") === "local";
  // The server takes the page to this site at whatever port it was started with.
  const sites = localSites(Number(location.port || 80));
  const version = import.meta.env["VITE_VERSION"] ?? "local";
  const signedIn = backend ? await signInLocally() : undefined;
  await startEditor({
    root,
    sites,
    version,
    ...(signedIn && {
      online: serverOnline({
        editor: sites.editor,
        version,
        local: { binding: signedIn.kind === "bound" ? signedIn.key : undefined },
      }),
    }),
  });
}
