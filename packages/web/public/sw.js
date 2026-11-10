// Only so that the editor can be installed as an app, which keeps the folders people opened
// allowed. It keeps nothing and answers nothing: every page and file still comes from the site.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
