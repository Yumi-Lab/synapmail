/**
 * Ce que l'interface fait des étiquettes stockées — les projections PURES, en un endroit,
 * pour que la liste, le volet de lecture et le banc lisent exactement la même règle.
 *
 * Rien ici ne touche au réseau ni à la base : ce fichier est importable par un composant
 * client (les types de `store.ts` n'y entrent qu'en `import type`, donc effacés à la
 * compilation — le module serveur ne suit pas dans le paquet du navigateur).
 *
 * Les LIBELLÉS n'y sont pas : ils vivent dans `locales/{en,fr,zh}.json` sous `tags.*`
 * (décision 1). Ce fichier ne manipule que des identifiants de question et de valeur.
 */
import type { Message } from '@/types/email'
import { QUESTIONS, showsInList } from './questions'
import type { StoredTag, TaggedMessage } from './store'

/** La route qui sert les étiquettes, écrite UNE fois. */
export const TAGS_ENDPOINT = '/api/tags'

/** L'ordre d'affichage d'une étiquette : celui de `questions.ts`, jamais celui du SQL. */
const RANK = new Map(QUESTIONS.map((q, i) => [q.id, i]))
const byQuestionOrder = (a: StoredTag, b: StoredTag) =>
  (RANK.get(a.question) ?? Number.MAX_SAFE_INTEGER) - (RANK.get(b.question) ?? Number.MAX_SAFE_INTEGER)

/** Les étiquettes d'un message, dans l'ordre des questions. */
export const orderedTags = (tags: readonly StoredTag[]): StoredTag[] => [...tags].sort(byQuestionOrder)

/**
 * Les étiquettes qui méritent une pastille sur la LIGNE. `showsInList` décide (un `noul`
 * seulement sur `oui`, un `score` à partir du niveau déclaré) ; le reste du panneau n'est
 * pas perdu pour autant, il passe en infobulle. Une question inconnue de `questions.ts` ne
 * peut rien afficher : c'est la même fermeture qu'à l'écriture.
 */
export const listPills = (tags: readonly StoredTag[]): StoredTag[] =>
  orderedTags(tags.filter(tag => showsInList(tag.question, tag.valeur)))

/** Les étiquettes rangées par groupe, dans l'ordre de `questions.ts`, groupes vides omis. */
export function tagsByGroup(tags: readonly StoredTag[]): { group: string; tags: StoredTag[] }[] {
  const groups = new Map<string, StoredTag[]>()
  for (const tag of orderedTags(tags)) {
    const group = QUESTIONS[RANK.get(tag.question) ?? -1]?.group
    if (!group) continue
    const list = groups.get(group) ?? []
    list.push(tag)
    groups.set(group, list)
  }
  return Array.from(groups, ([group, tags]) => ({ group, tags }))
}

/**
 * Les lignes à afficher quand un filtre par étiquette est posé.
 *
 * `tagged_messages` ne retient que la dernière position CONNUE d'un mail (dossier, uid,
 * expéditeur, objet, date) : de quoi ouvrir une ligne, pas de quoi la décrire entièrement.
 * Quand la page chargée contient déjà ce mail, c'est SON message qui sort — non lu, drapeau
 * et pièces jointes compris. Sinon on rend ce que la position permet : c'est la raison d'être
 * de cette table, montrer un mail sorti de la fenêtre chargée.
 *
 * Un mail sans dossier ni uid connus n'est pas affichable (rien ne pourrait l'ouvrir) : il est
 * COMPTÉ et dit à l'écran, jamais tu en silence.
 */
export function taggedRows(hits: readonly TaggedMessage[], loaded: readonly Message[], accountId: string): {
  rows: Message[]; unpositioned: number
} {
  const byMessageId = new Map(loaded.filter(m => m.messageId).map(m => [m.messageId, m]))
  const rows: Message[] = []
  let unpositioned = 0
  for (const hit of hits) {
    const already = byMessageId.get(hit.messageId)
    if (already) { rows.push(already); continue }
    if (!hit.folder || hit.uid === null) { unpositioned += 1; continue }
    rows.push({
      uid: String(hit.uid), messageId: hit.messageId, folder: hit.folder, accountId,
      from: { name: hit.fromName ?? '', address: hit.fromAddress ?? '' }, to: [],
      subject: hit.subject ?? '', date: new Date(hit.date ?? 0).toISOString(),
      preview: '', isRead: true, isStarred: false, isFlagged: false, hasAttachments: false,
    })
  }
  return { rows, unpositioned }
}
