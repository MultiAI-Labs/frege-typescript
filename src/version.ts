/**
 * The published version of this package.
 *
 * It rides on every request's `User-Agent`, which is how support pins a call
 * down to a build — everywhere except a browser, where `User-Agent` is a
 * forbidden header that `fetch` drops without saying so.
 * `version.test.ts` fails if it drifts from package.json.
 */
export const VERSION = '0.1.0';
