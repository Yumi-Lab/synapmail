/**
 * Un identifiant saisi à la main ne dépend ni de la casse ni des espaces autour :
 * « Bruno@3d-expert.fr » et « bruno@3d-expert.fr  » désignent la même personne.
 * Seule façon de normaliser une adresse dans le dépôt — la connexion, l'inscription,
 * le partage d'une boîte et le carnet d'adresses passent tous par ici, sinon une
 * adresse enregistrée en minuscules devient introuvable dès qu'on la retape autrement.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}
