/**
 * The origin an OUTSIDE reader reaches this instance at — for a link put in a
 * mail, in an invitation, in an OAuth redirect, or in the served reference.
 *
 * `new URL(req.url).origin` must never be used for this: behind a reverse proxy
 * it is the container's own host and port, which nobody outside can reach and
 * which discloses an internal name. The owner's configured address wins; the
 * forwarded headers are the fallback when it is absent.
 */

/**
 * Read through a variable key ON PURPOSE. Spelled literally,
 * `process.env.NEXT_PUBLIC_APP_URL` is replaced by its value AT BUILD TIME, even
 * in server code — an image built without it would carry an empty string for the
 * life of the image. The deployment supplies the address at RUN time
 * (`env_file` in docker-compose), which is what this reads. Measured: with the
 * literal spelling, a value set at run time was ignored in favour of the one
 * present during `npm run build`.
 */
const APP_URL_KEY = 'NEXT_PUBLIC_APP_URL'

/**
 * A host name (or IPv4 / bracketed IPv6) with an optional port — and nothing else.
 * `X-Forwarded-Host` is a header, so the caller may have written it: what it holds
 * ends up in an invitation link sent from the account's real SMTP. Anything that is
 * not a plain host (a path, credentials, a second host, a control character) is
 * refused, and the link falls back to relative rather than carry a stranger's name.
 */
const FORWARDED_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i

export function appOrigin(req?: Request): string {
  const configured = process.env[APP_URL_KEY]?.trim()
  if (configured) return configured.replace(/\/+$/, '')

  // A chain of proxies may append several hosts: the first is what the outside
  // reader typed, and the only one worth putting back in front of them.
  const host = req?.headers.get('x-forwarded-host')?.split(',')[0].trim()
  if (host && FORWARDED_HOST.test(host)) {
    const proto = req!.headers.get('x-forwarded-proto')?.split(',')[0].trim()
    return `${proto === 'http' ? 'http' : 'https'}://${host}`
  }

  // Nothing said what this instance is called: relative links, never a guess.
  return ''
}
