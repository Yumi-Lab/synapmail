/**
 * Recherche de courrier — source unique du contrat, partagée par la barre
 * d'application (qui écrit), la liste des messages (qui lit) et l'API.
 *
 * L'état de la recherche vit dans l'URL de la boîte (`/mail?q=…&scope=…`) : un
 * seul champ la pilote, un rechargement la conserve, et aucun composant n'en
 * garde une copie qui pourrait diverger.
 */
import { MAIL_PATH } from './compose'

export const SEARCH_PARAM = 'q'
export const SCOPE_PARAM = 'scope'
export const SCOPE_FOLDER = 'folder'
export const SCOPE_ALL = 'all'
/** Toutes les boîtes ACCESSIBLES (propres + reçues en partage), tous dossiers. */
export const SCOPE_ACCOUNTS = 'accounts'
/**
 * Les portées, dans l'ordre où le sélecteur les propose. Source unique : l'omnibar
 * boucle dessus, l'URL en porte la valeur, la route et la liste la relisent.
 */
export const SEARCH_SCOPES = [SCOPE_FOLDER, SCOPE_ALL, SCOPE_ACCOUNTS] as const
export type SearchScope = typeof SEARCH_SCOPES[number]

/**
 * Boîtes balayées EN PARALLÈLE par la portée « toutes les boîtes ». Ce plafond
 * s'ajoute à celui des dossiers par boîte (lot S2) : au pic, au plus
 * ACCOUNT_CONCURRENCY × (dossiers en parallèle) connexions IMAP ouvertes.
 * ponytail: mesuré le 20/09/2026 sur le compte de test (7 boîtes, 185 dossiers) —
 * le balayage boîte par boîte EN SÉRIE coûte 50,7 s, la boîte la plus lente 22,0 s
 * à elle seule. 3 suffit à ramener le total sous la boîte la plus lente + marge,
 * sans ouvrir 7 sessions IMAP de front chez le même hébergeur. Monter ce nombre
 * demande de re-mesurer le pic de connexions, pas seulement le temps total.
 */
export const ACCOUNT_CONCURRENCY = 3

/** En deçà, IMAP renverrait la boîte entière : la recherche reste inactive. */
export const MIN_QUERY_LENGTH = 2
/** Frappe → requête : même délai que celui de l'ancien champ de la liste. */
export const SEARCH_DEBOUNCE_MS = 400
/**
 * Nombre maximal de résultats renvoyés PAR DOSSIER interrogé. Au-delà, la réponse
 * porte le nombre total de correspondances (`total`) et l'interface le dit.
 * ponytail: 50 → 200 parce qu'une recherche d'adresse sur une vraie boîte dépasse
 * couramment 50 sans le dire ; passer au-delà demanderait une pagination de la
 * recherche (curseur sur les UID), pas un plafond plus haut.
 */
export const SEARCH_RESULT_LIMIT = 200

/**
 * Les champs interrogés par une recherche, dans l'ordre où l'interface les nomme.
 * Source unique : le serveur construit sa requête IMAP avec, l'interface dit
 * laquelle avec les mêmes clés de traduction (`searchField.<champ>`).
 *
 * Le CORPS des messages n'y est PAS, et ce n'est pas un oubli : mesuré le
 * 19/09/2026 sur IONOS (nicolas@3d-expert.fr), `BODY` comme `TEXT` renvoient 0
 * résultat en 2,5 s — et les ajouter au `OR` fait tomber le `OR` ENTIER à 0.
 * Ne rien y remettre sans l'avoir mesuré sur le serveur visé.
 */
export const SEARCH_FIELDS = ['from', 'to', 'cc', 'subject'] as const
export type SearchField = typeof SEARCH_FIELDS[number]

/** Le raccourci « / » de la boîte donne le focus au champ de la barre. */
export const SEARCH_FOCUS_EVENT = 'synapmail:focus-search'

export function focusSearch() {
  window.dispatchEvent(new CustomEvent(SEARCH_FOCUS_EVENT))
}

export function isSearchQuery(q: string | null | undefined): boolean {
  return (q?.trim().length ?? 0) >= MIN_QUERY_LENGTH
}

export function readScope(raw: string | null | undefined): SearchScope {
  return (SEARCH_SCOPES as readonly string[]).includes(raw ?? '') ? raw as SearchScope : SCOPE_FOLDER
}

/** Une portée qui sort du dossier affiché : la liste mêle alors des origines. */
export function isWideScope(scope: SearchScope): boolean {
  return scope === SCOPE_ALL || scope === SCOPE_ACCOUNTS
}

/**
 * Construit l'URL de la boîte portant la recherche, en conservant les autres
 * paramètres déjà présents (le dossier courant, notamment).
 */
export function buildSearchHref(current: string | URLSearchParams, q: string, scope: SearchScope): string {
  const params = new URLSearchParams(current)
  const trimmed = q.trim()
  if (trimmed) params.set(SEARCH_PARAM, trimmed)
  else params.delete(SEARCH_PARAM)
  if (trimmed && scope !== SCOPE_FOLDER) params.set(SCOPE_PARAM, scope)
  else params.delete(SCOPE_PARAM)
  const qs = params.toString()
  return qs ? `${MAIL_PATH}?${qs}` : MAIL_PATH
}

/**
 * Découpe une requête en TERMES, tous exigés (ET) : « 3d cpi » trouve les messages
 * où « 3d » ET « cpi » apparaissent chacun dans au moins un champ, dans n'importe
 * quel ordre — là où la version précédente cherchait la sous-chaîne « 3d cpi ».
 *
 * - une expression entre guillemets reste UNE sous-chaîne exacte : « "3d cpi" » ;
 * - espaces multiples et casse sont sans effet ;
 * - un terme de moins de MIN_QUERY_LENGTH caractères est ignoré (IMAP renverrait
 *   la boîte entière) ; entre guillemets, il est gardé tel quel s'il est non vide ;
 * - un guillemet non refermé ferme en fin de chaîne.
 *
 * Fonction PURE : aucun accès réseau, aucun état — son auto-contrôle exécutable
 * est `scripts/check-search-parse.mjs`.
 */
export function parseQuery(q: string | null | undefined): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  const add = (raw: string, quoted: boolean) => {
    const term = raw.trim()
    if (!term) return
    if (!quoted && term.length < MIN_QUERY_LENGTH) return
    const key = term.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    terms.push(term)
  }
  // Un seul balayage : on bascule à chaque guillemet entre « mots séparés par des
  // espaces » et « une seule expression ». Pas d'expression régulière à retenir.
  let buffer = ''
  let quoted = false
  for (const ch of q ?? '') {
    if (ch === '"') { add(buffer, quoted); buffer = ''; quoted = !quoted; continue }
    if (!quoted && /\s/.test(ch)) { add(buffer, false); buffer = ''; continue }
    buffer += ch
  }
  add(buffer, quoted)
  return terms
}

/**
 * Ce qu'une recherche « tous les dossiers » sait d'un dossier avant de l'ouvrir :
 * son chemin, son rôle éventuel (`\Inbox`, `\Sent`… via SPECIAL-USE), son nombre
 * de messages (LIST-STATUS, un seul aller-retour) et la date du message le plus
 * récent que le cache local en connaisse.
 */
export type FolderRank = {
  path: string
  specialUse?: string | null
  messages?: number | null
  lastKnownDate?: string | null
}

/**
 * Rôles privilégiés, dans l'ordre : ce sont les dossiers où l'on trouve ce qu'on
 * cherche neuf fois sur dix, donc ceux qu'une recherche progressive doit rendre
 * EN PREMIER pour être utile avant d'avoir tout couvert.
 */
const PRIORITY_SPECIAL_USE = ['\\Inbox', '\\Sent'] as const

/**
 * Ordonne les dossiers par UTILITÉ pour une recherche progressive : rôles
 * privilégiés d'abord (réception puis envoyés), ensuite les dossiers dont le cache
 * local connaît le message le plus récent (un dossier vivant vaut mieux qu'une
 * archive de 2019), le reste ensuite par nombre de messages décroissant, et les
 * dossiers VIDES écartés — les ouvrir coûte un aller-retour pour zéro résultat
 * possible.
 *
 * Fonction PURE : elle ne touche ni au réseau ni à la base, son auto-contrôle est
 * `scripts/check-search-order.mjs`.
 *
 * ponytail: un tri, pas un index. Tant que l'ouverture d'un dossier coûte ~300 ms
 * (mesuré sur IONOS), l'ordre suffit à rendre les premiers résultats utiles ;
 * seul un besoin mesuré de « tout, tout de suite » justifierait un index local.
 */
export function orderFoldersForSearch(folders: FolderRank[]): string[] {
  const rank = (f: FolderRank): number => {
    const special = PRIORITY_SPECIAL_USE.indexOf(f.specialUse as typeof PRIORITY_SPECIAL_USE[number])
    if (special >= 0) return special
    return PRIORITY_SPECIAL_USE.length
  }
  const freshness = (f: FolderRank): number => {
    const t = f.lastKnownDate ? Date.parse(f.lastKnownDate) : NaN
    return Number.isNaN(t) ? -Infinity : t
  }
  return folders
    // `messages` absent = inconnu, donc gardé : seul un ZÉRO mesuré écarte un dossier.
    .filter(f => f.messages !== 0)
    .slice()
    .sort((a, b) =>
      rank(a) - rank(b) ||
      freshness(b) - freshness(a) ||
      (b.messages ?? 0) - (a.messages ?? 0) ||
      a.path.localeCompare(b.path))
    .map(f => f.path)
}

/** Un dossier PRIVILÉGIÉ : réception ou envoyés, les deux de la première passe. */
function isPriorityFolder(f: FolderRank): boolean {
  return PRIORITY_SPECIAL_USE.includes(f.specialUse as typeof PRIORITY_SPECIAL_USE[number])
}

/**
 * Découpe les dossiers d'une boîte en DEUX passes, chacune déjà ordonnée par
 * `orderFoldersForSearch` : la PREMIÈRE ne contient que la réception et les
 * envoyés, la SECONDE tout le reste.
 *
 * Pourquoi deux passes : avec plusieurs boîtes, balayer une boîte ENTIÈRE avant
 * d'attaquer la suivante fait attendre la réception de la 7ᵉ boîte derrière les
 * 97 dossiers de la 4ᵉ. Mesuré le 20/09/2026 sur le compte de test (7 boîtes,
 * 185 dossiers) : le balayage complet d'une boîte va de 2,0 s à 22,0 s, alors que
 * son PREMIER résultat arrive en 1,6-2,7 s. Faire d'abord les deux dossiers
 * utiles de CHAQUE boîte rend les résultats utiles en quelques secondes même
 * avec 50 boîtes.
 *
 * Fonction PURE : auto-contrôle `scripts/check-search-accounts.mjs`.
 */
export function splitFolderPasses(folders: FolderRank[]): { first: string[]; rest: string[] } {
  const priority = new Set(folders.filter(isPriorityFolder).map(f => f.path))
  const ordered = orderFoldersForSearch(folders)
  return {
    first: ordered.filter(p => priority.has(p)),
    rest: ordered.filter(p => !priority.has(p)),
  }
}

/** Ce qu'une recherche « toutes les boîtes » sait d'une boîte avant de l'ouvrir. */
export type AccountRank = { id: string; email?: string | null }

/**
 * Ordonne les boîtes d'une recherche « toutes les boîtes » : la boîte ACTIVE
 * d'abord (celle que l'utilisateur regarde, donc celle dont il attend les
 * résultats), puis l'ordre de la liste, inchangé. Les entrées sans identifiant
 * sont écartées, les doublons aussi — une boîte balayée deux fois coûterait deux
 * sessions IMAP pour les mêmes résultats.
 *
 * Fonction PURE : auto-contrôle `scripts/check-search-accounts.mjs`.
 */
export function orderAccountsForSearch(accounts: readonly AccountRank[], activeId?: string | null): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const push = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  push(accounts.find(a => a.id === activeId)?.id)
  for (const a of accounts) push(a.id)
  return ids
}

/**
 * Lance `run` sur chaque élément avec au plus `limit` exécutions EN COURS, et
 * rend les résultats dans l'ordre d'ARRIVÉE (pas celui des entrées) : une boîte
 * lente ne retient pas l'affichage de celles qui ont déjà répondu. Un `run` qui
 * échoue rend son erreur au lieu de casser le balayage — une boîte injoignable
 * n'arrête pas les autres.
 *
 * Générateur PUR au sens du banc : il n'ouvre rien lui-même, il ORDONNANCE ce
 * qu'on lui donne. Auto-contrôle `scripts/check-search-accounts.mjs`.
 */
export async function* mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  run: (item: TItem, index: number) => Promise<TResult>,
): AsyncGenerator<{ item: TItem; index: number; value?: TResult; error?: unknown }> {
  // `Math.max(1, …)` sur une liste VIDE démarrerait une tâche sur `items[0]`,
  // qui n'existe pas : le plancher ne s'applique qu'à une liste non vide.
  const width = items.length === 0 ? 0 : Math.max(1, Math.min(limit, items.length))
  let next = 0
  const settle = (index: number) => run(items[index], index)
    .then(value => ({ item: items[index], index, value }))
    .catch(error => ({ item: items[index], index, error }))
  type Slot = ReturnType<typeof settle>
  const running = new Map<number, Slot>()
  const start = () => { const i = next++; running.set(i, settle(i)) }
  while (next < width) start()
  while (running.size) {
    // `Promise.race` sur les tâches EN COURS : la première arrivée est rendue,
    // puis sa place est reprise par la suivante. Sans le retrait explicite, une
    // tâche déjà rendue gagnerait toutes les courses suivantes.
    const done = await Promise.race(Array.from(running.values()))
    running.delete(done.index)
    yield done
    if (next < items.length) start()
  }
}

/**
 * Paramètre par lequel le client demande la restitution PROGRESSIVE : la réponse
 * est alors une suite de lignes JSON (NDJSON), une par dossier couvert, au lieu
 * d'un seul objet livré à la fin. Le contrat de l'objet final est identique, ce
 * qui laisse la portée « ce dossier » et tout appel machine inchangés.
 */
export const STREAM_PARAM = 'stream'

/** Une ligne de la réponse progressive : un dossier couvert, ce qu'il rapporte. */
export type SearchStreamChunk<TMessage> = {
  messages: TMessage[]
  total: number
  folder: string
  /** Dossiers couverts jusqu'ici / dossiers à couvrir — « 312 sur 1 226 ». */
  searched: number
  folders: number
}

/**
 * Découpe un flux NDJSON en objets, en gardant la ligne incomplète d'un morceau
 * pour le suivant. Fonction PURE (elle ne lit aucun flux) : on lui passe le texte
 * reçu et le reste précédent, elle rend les objets complets et le nouveau reste.
 * Auto-contrôle : `scripts/check-search-order.mjs`.
 */
export function parseNdjsonChunk<T>(pending: string, received: string): { items: T[]; pending: string } {
  const lines = (pending + received).split('\n')
  // La dernière tranche n'est suivie d'aucun saut de ligne : elle peut être coupée.
  const rest = lines.pop() ?? ''
  const items: T[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { items.push(JSON.parse(trimmed) as T) } catch { /* ligne tronquée par une coupure : ignorée */ }
  }
  return { items, pending: rest }
}

/** L'état accumulé d'une recherche progressive côté client. */
export type SearchStreamState<TMessage> = {
  messages: TMessage[]
  total: number
  searched: number
  folders: number
}

/** Un message rendu par la recherche, réduit à ce dont l'accumulation a besoin. */
type StreamedMessage = { folder: string; uid: number | string; date: string }

export const EMPTY_SEARCH_STREAM: SearchStreamState<never> = {
  messages: [], total: 0, searched: 0, folders: 0,
}

/**
 * Ajoute à l'état courant les lignes NDJSON reçues : dédoublonne par dossier+uid
 * (un même message peut revenir si un dossier est couvert deux fois), trie du plus
 * récent au plus ancien, et PLAFONNE à `SEARCH_RESULT_LIMIT` — le même plafond que
 * les deux chemins non diffusés de la route. Sans ce plafond, une requête large
 * rendrait des milliers de lignes dans une liste non virtualisée, et `total >
 * messages.length` ne serait jamais vrai : le bandeau ne dirait jamais
 * « X premiers sur N ».
 *
 * Fonction PURE : elle ne lit aucun flux et ne mute pas l'état reçu. Auto-contrôle :
 * `scripts/check-search-order.mjs`.
 */
export function accumulateSearchStream<TMessage extends StreamedMessage>(
  prev: SearchStreamState<TMessage>,
  items: (Partial<SearchStreamChunk<TMessage>> & { error?: string })[]
): SearchStreamState<TMessage> {
  const seen = new Set(prev.messages.map(m => `${m.folder}#${m.uid}`))
  const next = [...prev.messages]
  let { total, searched, folders } = prev
  for (const item of items) {
    if (item.error) continue
    for (const m of item.messages ?? []) {
      const key = `${m.folder}#${m.uid}`
      if (seen.has(key)) continue
      seen.add(key)
      next.push(m)
    }
    total += item.total ?? 0
    searched = Math.max(searched, item.searched ?? 0)
    folders = Math.max(folders, item.folders ?? 0)
  }
  next.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  return { messages: next.slice(0, SEARCH_RESULT_LIMIT), total, searched, folders }
}
