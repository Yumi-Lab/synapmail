/**
 * The mailbox page URL — single source for the folder it shows.
 *
 * The current folder lives in the URL (`/mail?folder=…`): the sidebar highlights
 * it, MailClient reads it, the dashboard and the focus list link to it. This
 * module sits next to the page because it describes THIS page's URL; the other
 * components import it rather than keeping a copy of the parameter name.
 */
import { MAIL_PATH } from '@/lib/compose'

/** URL parameter carrying the displayed folder. */
export const FOLDER_PARAM = 'folder'

/** The folder shown when the URL names none: the inbox. */
export const DEFAULT_FOLDER = 'INBOX'

/** The address of one folder of the mailbox. */
export const folderHref = (path: string) => `${MAIL_PATH}?${FOLDER_PARAM}=${encodeURIComponent(path)}`

/**
 * Changing folder WITHIN the mailbox only changes URL parameters, so the URL is
 * pushed through the history API — which the Next 14.2 router patches and
 * follows (`useSearchParams` updates on the next render) — never through
 * `router.push`, which re-renders the route on the server: one `_rsc` request per
 * click (measured 06/10/2026 at ~1 s each from China) carrying no useful data.
 * Push, not replace: going back returns to the previous folder. A no-op when the
 * URL already shows this folder.
 */
export function pushFolder(path: string) {
  const href = folderHref(path)
  if (href !== `${window.location.pathname}${window.location.search}`) window.history.pushState(null, '', href)
}
