/**
 * The origin an OUTSIDE reader reaches this instance at — for a link put in a
 * mail, in an invitation, in an OAuth redirect, or in the served reference.
 *
 * `new URL(req.url).origin` must never be used for this: behind a reverse proxy
 * it is the container's own host and port, which nobody outside can reach and
 * which discloses an internal name. The owner's configured address wins; the
 * forwarded headers are the fallback when it is absent.
 */
export function appOrigin(req?: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')

  const host = req?.headers.get('x-forwarded-host')
  if (host) return `${req!.headers.get('x-forwarded-proto') ?? 'https'}://${host}`

  // Nothing said what this instance is called: relative links, never a guess.
  return ''
}
