import { add } from "./scripts/util.js";
import { useA } from "./scripts/cycle-b.js";
import { shared } from "../../code/shared.js";

const probe = (window.probe = window.probe || {});
const attempt = async (name, run) => {
  try {
    probe[name] = await run();
  } catch (error) {
    probe[name] = `failed: ${error?.name}: ${String(error?.message).slice(0, 80)}`;
  }
};
const imageLoads = (url) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth);
    image.onerror = () => reject(new Error("image error"));
    image.src = url;
  });
const workerSays = (url, options) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(url, options);
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = (event) => reject(new Error(`worker error ${event.message}`));
  });

probe.moduleImport = add(2, 2) === 4;
probe.sharedCode = shared;
await attempt("moduleCycle", () => useA() === "ab");
await attempt("dynamicImport", async () => (await import("./scripts/lazy.js")).lazy);
await attempt("computedImport", async () => {
  const name = ["lazy", "js"].join(".");
  return (await import(`./scripts/${name}`)).lazy;
});
await attempt("importMetaUrl", () => new URL("./data.json", import.meta.url).href);
await attempt("importMetaResolve", () => import.meta.resolve("./data.json"));
await attempt("jsonModule", async () => {
  const { default: data } = await import("./data.json", { with: { type: "json" } });
  return data.value;
});
await attempt("fetchRelative", async () => (await (await fetch("./data.json")).json()).value);
await attempt("fetchFromUrl", async () => {
  const url = new URL("./data.json", import.meta.url);
  return (await (await fetch(url)).json()).value;
});
await attempt("fetchFromLocation", async () => {
  const url = new URL("data.json", location.href);
  return (await (await fetch(url)).json()).value;
});
await attempt("fetchMissing", async () => (await fetch("./nothing.json")).status);
await attempt(
  "xhr",
  () =>
    new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("GET", "./data.json");
      request.onload = () => resolve(JSON.parse(request.responseText).value);
      request.onerror = () => reject(new Error("xhr error"));
      request.send();
    }),
);
await attempt("jsImage", () => imageLoads("images/logo.png"));
await attempt(
  "setAttributeImage",
  () =>
    new Promise((resolve, reject) => {
      const image = document.createElement("img");
      image.onload = () => resolve(image.naturalWidth);
      image.onerror = () => reject(new Error("image error"));
      image.setAttribute("src", "images/tile.svg");
    }),
);
await attempt("assetImage", () => imageLoads(aq.asset("logo")));
await attempt("assetFont", async () => {
  const font = new FontFace("Asset Font", `url(${aq.asset("font")})`);
  await font.load();
  return font.status;
});
await attempt("projectFontFace", async () => {
  const font = new FontFace("Path Font", "url(fonts/tiny.ttf)");
  await font.load();
  return font.status;
});
await attempt("classicWorker", () => workerSays(new URL("./scripts/worker.js", import.meta.url)));
await attempt("moduleWorker", () =>
  workerSays(new URL("./scripts/worker-module.js", import.meta.url), { type: "module" }),
);
await attempt("fetchBlobUrl", async () =>
  (await fetch(URL.createObjectURL(new Blob(["blob text"])))).text(),
);
await attempt("fetchDataUrl", async () => (await fetch("data:text/plain,hello")).text());
await attempt("eval", () => eval("1 + 1"));
await attempt("newFunction", () => new Function("return 3")());
await attempt("wasm", async () =>
  Boolean(await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))),
);
probe.moduleDone = true;
