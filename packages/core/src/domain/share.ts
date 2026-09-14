/**
 * The link that opens a post in this app.
 *
 * `apps/web/app/page.tsx` already reads `?post=<id>` on load and opens that
 * post — it was built for push-notification deep links (see its own
 * `openPostById`). Sharing to another app needs exactly the same link, so
 * this builds it rather than inventing a second URL shape that would then
 * need its own handler.
 *
 * WHY THE CALLER PASSES THE PAGE URL
 * ---------------------------------------------------------------------
 * This package has no DOM and no build config, and the app's origin is not
 * knowable from either. Worse, the deployed path is not fixed: GitHub Pages
 * serves it under NEXT_BASE_PATH (see apps/web/next.config.ts), so a
 * hardcoded "/" would produce a link to the wrong place on the real
 * deployment and the right one only in development.
 *
 * The caller hands in `window.location.href`, and everything below it —
 * origin, base path, page — is preserved. That is correct by construction
 * for every deployment, including ones that do not exist yet.
 *
 * QUERY AND HASH ARE DROPPED
 * ---------------------------------------------------------------------
 * The current URL may itself carry a `?post=`/`?dm=` from a link the sharer
 * followed, or a `#` from the map. Neither belongs in a link being handed
 * to someone else: the point is to share ONE post, not to forward whatever
 * state this tab happens to be in.
 */

export const POST_SHARE_PARAM = 'post';

export function postShareUrl(pageUrl: string, postId: string): string {
  const url = new URL(pageUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set(POST_SHARE_PARAM, postId);
  return url.toString();
}

/**
 * The one-line message that travels with a shared link.
 *
 * Deliberately short and free of detail. A share sheet shows this text to
 * whoever is doing the sharing, and it ends up in a tweet, an SMS, a
 * pasted note — places with no audience check at all. So it names the
 * category and nothing else: never the body, never the address. Anyone who
 * follows the link gets exactly what they are entitled to, decided by the
 * server, and anyone who does not follow it learns nothing they should not
 * have.
 */
export function postShareText(categoryLabel: string): string {
  return `${categoryLabel} on SoSo`;
}
