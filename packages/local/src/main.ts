import { localSites, startEditor } from "@animaquill/web";

// The page of the editor on this computer, from the server of this package. There is nothing to
// sign in to, and reports stay here, where people can save or copy them.
const root = document.querySelector<HTMLElement>("#root");
if (root) {
  await startEditor({
    root,
    // The server takes the page to this site at whatever port it was started with.
    sites: localSites(Number(location.port || 80)),
    version: import.meta.env["VITE_VERSION"] ?? "local",
  });
}
