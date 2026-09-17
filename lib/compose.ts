/** Ouverture de la fenêtre « Nouveau message » — source unique pour la barre, le tableau de bord et la liste. */
export const COMPOSE_EVENT = 'synapmail:compose'
export const COMPOSE_QUERY = 'compose'
export const MAIL_PATH = '/mail'

/** Émet l'événement écouté par MailClient (n'a d'effet que sur la page de la boîte). */
export function dispatchCompose() {
  window.dispatchEvent(new CustomEvent(COMPOSE_EVENT))
}

/**
 * Ouvre la composition d'où qu'on soit : déjà sur la boîte → événement ;
 * ailleurs (tableau de bord, réglages…) → navigation vers la boîte avec
 * `?compose=1`, que MailClient consomme au montage. Pas de minuterie.
 */
export function openCompose(pathname: string | null, push: (href: string) => void) {
  if (pathname === MAIL_PATH || pathname?.startsWith(`${MAIL_PATH}/`)) dispatchCompose()
  else push(`${MAIL_PATH}?${COMPOSE_QUERY}=1`)
}
