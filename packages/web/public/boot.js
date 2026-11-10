// Runs before anything else on the page, while the editor's code is still on its way. A browser opens
// a file that is dropped where nothing takes it, instead of the page: people who drop a file this
// early would find themselves out of the editor. Until the editor says it is there, with the event
// below (see `mountEditor`), nothing dropped does anything. A classic script, so that it runs at
// once, and a file of its own, which is what the policy of the site allows.
(() => {
  const hold = (event) => event.preventDefault();
  addEventListener("dragover", hold);
  addEventListener("drop", hold);
  addEventListener(
    "animaquill-editor",
    () => {
      removeEventListener("dragover", hold);
      removeEventListener("drop", hold);
    },
    { once: true },
  );
})();
