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
import { isEnabled, type QuestionSet } from './questions'
import type { StoredTag, TaggedMessage } from './store'

/** La route qui sert les étiquettes, écrite UNE fois. */
export const TAGS_ENDPOINT = '/api/tags'

/**
 * Le filtre « audit aléatoire » (lot T14) : la valeur du sélecteur d'étiquettes de la liste ET
 * le paramètre d'URL (`/mail?tag=audit`) par lequel l'écran « Fiabilité » y mène. Une seule
 * chaîne, écrite ici, lue par les deux.
 */
export const AUDIT_FILTER = 'audit'
export const TAG_FILTER_PARAM = 'tag'

/** Émis par le panneau après chaque correction écrite : la liste en mode audit se relit dessus. */
export const TAGS_CHANGED_EVENT = 'synapmail:tags-changed'

/** L'écran « À valider » (lot T15, décision 17) : son chemin et le paramètre de la boîte. */
export const VALIDATE_PATH = '/validate'
export const VALIDATE_ACCOUNT_PARAM = 'account'

/**
 * La route qui sert le JEU de questions de l'utilisateur (lot T-Q), écrite UNE fois : c'est la
 * clé SWR que la liste, le panneau et l'écran de réglages partagent (mêmes règles que
 * `/api/settings` : `{ data }`, un seul fetcher, une mutation la rafraîchit partout).
 */
export const QUESTIONS_ENDPOINT = '/api/tags/questions'

/** La route qui sert les RÈGLES d'étiquetage de l'utilisateur (lot T-Q2), écrite UNE fois. */
export const TAG_RULES_ENDPOINT = '/api/tags/rules'

/** Les groupes de questions conditionnels (lot T-Q3). */
export const TAG_GROUPS_ENDPOINT = '/api/tags/groups'

/** Le statut et les réglages d'une boîte (`?account=`) — clé SWR de l'écran de tri, aussi revalidée par les groupes. */
export const TAGGING_SETTINGS_ENDPOINT = '/api/tagging/settings'
/** Le trieur d'une boîte : où il en est (`?account=`), et l'ordre qu'on lui donne (`POST { accountId, action }`). */
export const TAGGING_STATUS_ENDPOINT = '/api/tagging/status'
export const TAGGING_RUN_ENDPOINT = '/api/tagging/run'

/** L'ordre d'affichage d'une étiquette : celui du jeu de l'utilisateur, jamais celui du SQL. */
const byQuestionOrder = (set: QuestionSet) => (a: StoredTag, b: StoredTag) => set.rankOf(a.question) - set.rankOf(b.question)

/**
 * Les étiquettes d'un message que l'interface MONTRE : celles d'une question du jeu ACTIF de
 * l'utilisateur, dans l'ordre des questions. Une question désactivée (ou retirée) garde ses
 * lignes en base — elles reviendraient si on la réactivait — mais n'a plus rien à dire à
 * l'écran : ni pastille, ni ligne de panneau, ni compteur.
 */
export const orderedTags = (set: QuestionSet, tags: readonly StoredTag[]): StoredTag[] =>
  tags.filter(tag => { const q = set.questionById(tag.question); return !!q && isEnabled(q) }).sort(byQuestionOrder(set))

/**
 * Les étiquettes qui méritent une pastille sur la LIGNE. `showsInList` décide (un `noul`
 * seulement sur `oui`, un `score` à partir du niveau déclaré) ; le reste du panneau n'est
 * pas perdu pour autant, il passe en infobulle. Une question inconnue du jeu ne peut rien
 * afficher : c'est la même fermeture qu'à l'écriture.
 */
export const listPills = (set: QuestionSet, tags: readonly StoredTag[]): StoredTag[] =>
  orderedTags(set, tags.filter(tag => set.showsInList(tag.question, tag.valeur)))

/** Les étiquettes rangées par groupe, dans l'ordre du jeu, groupes vides omis. */
export function tagsByGroup(set: QuestionSet, tags: readonly StoredTag[]): { group: string; tags: StoredTag[] }[] {
  const groups = new Map<string, StoredTag[]>()
  for (const tag of orderedTags(set, tags)) {
    const group = set.questionById(tag.question)!.group
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
