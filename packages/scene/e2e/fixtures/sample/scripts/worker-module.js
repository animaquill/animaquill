import { add } from "./util.js";

const [lazy, data] = await Promise.all([
  import("./lazy.js"),
  fetch("../data.json").then((response) => response.json()),
]);
postMessage(`module ${add(1, 1)} ${lazy.lazy} ${data.value}`);
