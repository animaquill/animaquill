/**
 * Loads the code editor, in the language of the editor around it.
 *
 * Monaco looks its messages up while its modules run. In a build, the modules it shares with its
 * languages are a chunk of their own, and what a chunk imports runs before the chunk itself: an
 * import of the messages in `monaco.ts` runs after them however early it is written, and the editor
 * comes out in English. The development server runs modules one by one, so it does not show this.
 * The messages come in a step of their own, which is over before any of Monaco runs.
 */
export async function loadCodeEditor(): Promise<typeof import("./monaco.ts")> {
  await import("monaco-editor/nls/lang/zh-cn.js");
  return import("./monaco.ts");
}
