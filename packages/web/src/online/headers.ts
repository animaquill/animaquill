/**
 * What the server asks of requests from its pages that change something, see auth/guard.ts of
 * `@animaquill/server`: a page elsewhere can only send it after asking first, which the server never
 * answers.
 */
export const REQUEST_HEADER = "x-animaquill";
/** The version of the page, which the server asks of conversations, see me/routes.ts there. */
export const EDITOR_HEADER = "x-animaquill-editor";
