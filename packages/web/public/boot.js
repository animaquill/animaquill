// Runs before anything else on the page, while the editor's code is still on its way. A browser opens
// a file that is dropped where nothing takes it, instead of the page: people who drop a file this
// early would find themselves out of the editor. Until the editor says it is there, with the event
// below (see `mountEditor`), this takes what is dropped and keeps the last of it in
// `animaquillDropped`, in the shape of `keepDropped` there: the editor opens it once it is there, as
// people dropping a folder on the page as soon as they see it expect. A classic script, so that it
// runs at once, and a file of its own, which is what the policy of the site allows.
(() => {
  const carriesFiles = (event) => event.dataTransfer?.types.includes("Files") === true;
  // The browser goes by the last of these two: the page changes under the pointer as it starts.
  const keep = (event) => {
    if (carriesFiles(event)) event.preventDefault();
  };
  const hold = (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    // The browser lets go of what was dropped once the event is over, but not of what it was asked.
    window.animaquillDropped = {
      items: Array.from(event.dataTransfer.items, (item) => {
        const { kind } = item;
        if (kind !== "file" || !item.getAsFileSystemHandle) return { kind };
        const handle = item.getAsFileSystemHandle();
        handle.catch(() => {});
        return { kind, getAsFileSystemHandle: () => handle };
      }),
    };
  };
  addEventListener("dragenter", keep);
  addEventListener("dragover", keep);
  addEventListener("drop", hold);
  addEventListener(
    "animaquill-editor",
    () => {
      removeEventListener("dragenter", keep);
      removeEventListener("dragover", keep);
      removeEventListener("drop", hold);
    },
    { once: true },
  );
})();
