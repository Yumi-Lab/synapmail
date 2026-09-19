/**
 * Transfert d'un message ENTIER en pièce jointe (lot M5).
 *
 * Le type MIME et l'extension d'un message joint ne se recopient nulle part :
 * le serveur les lit ici pour habiller la pièce, le banc les relit pour vérifier
 * ce qui a été attaché. Une seule définition, donc aucune divergence possible.
 */

/** Type MIME d'un message complet joint à un autre (RFC 2046 §5.2.1). */
export const EML_CONTENT_TYPE = 'message/rfc822'

/** Extension du fichier proposé au destinataire. */
export const EML_EXTENSION = '.eml'

/** Nom de secours quand le message transféré n'a pas d'objet. */
export const EML_FALLBACK_NAME = 'message'

/**
 * Nom de fichier d'un message joint, dérivé de son objet.
 * Les séparateurs de chemin et les caractères interdits par Windows sont
 * remplacés, la longueur est bornée : un objet de courrier peut faire des
 * centaines de caractères, or beaucoup de clients tronquent le nom au-delà.
 */
export const EML_MAX_NAME_LENGTH = 80

export function emlFilename(subject: string | null | undefined): string {
  const cleaned = (subject ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EML_MAX_NAME_LENGTH)
    .trim()
  return `${cleaned || EML_FALLBACK_NAME}${EML_EXTENSION}`
}
