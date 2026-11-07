/**
 * The response headers of the scene page. The policy is the sandbox, so it has to come from the
 * server: a page cannot be trusted to restrict itself, and `sandbox` here means the page has no
 * origin of its own even when somebody opens it directly.
 *
 * The scene's code is arbitrary anyway, so `'unsafe-inline'` and `'unsafe-eval'` add nothing to what
 * it can do. What matters is what is not here: no source outside the document itself.
 */
export const SCENE_POLICY: Readonly<Record<string, string>> = {
  "default-src": "'none'",
  // The page's own script, and code the project runs. The blob: is every script of the project.
  // Workers fall back to this, and 'unsafe-eval' also covers WebAssembly.
  "script-src": "'unsafe-inline' 'unsafe-eval' blob:",
  // <style> and style attributes, and stylesheets.
  "style-src": "'unsafe-inline' blob:",
  "img-src": "blob: data:",
  "font-src": "blob: data:",
  "media-src": "blob: data:",
  // fetch() of what the scene already has.
  "connect-src": "blob: data:",
  "base-uri": "'none'",
  "form-action": "'none'",
  // No `allow-same-origin`: the document has an opaque origin, which is what keeps it from storage.
  sandbox: "allow-scripts",
};

/**
 * The value of the `Content-Security-Policy` header of the scene page. It has no `frame-ancestors`:
 * the compositor has no origin of its own, and nothing that directive can say matches a page without
 * one, not even `*`. `scenePage` does that job instead.
 */
export const scenePolicyHeader = (policy: Readonly<Record<string, string>> = SCENE_POLICY) =>
  Object.entries(policy)
    .map(([name, value]) => `${name} ${value}`)
    .join("; ");

/**
 * The scene page of a deployment, from the file in `page/`. `editors` are the origins of the pages
 * it may run under. Any other site could put the page in a frame and start it. A frame with no origin
 * cannot be told apart by what the server gets to see, so the page looks at `location.ancestorOrigins`
 * itself, which is the browser's word, and it does that before anything else can run.
 */
export function scenePage(template: string, editors: readonly string[]): string {
  const attribute = JSON.stringify(editors)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
  return template.replace("[]", () => attribute);
}

/**
 * What the compositor's own policy needs in order to show scenes. Without it a scene can navigate
 * itself anywhere, because `frame-src` is what stops a frame from loading another site.
 */
export const compositorFrameSource = (origins: readonly string[]) =>
  `frame-src ${origins.join(" ")}`;

/** The attribute of every scene frame. The header says the same for a page opened directly. */
export const SCENE_SANDBOX = "allow-scripts";

/** Where the page is on every scene origin. */
export const SCENE_PAGE_PATH = "/scene.html";
