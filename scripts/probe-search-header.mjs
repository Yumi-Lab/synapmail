#!/usr/bin/env node
/**
 * Lot N6 — SONDE, pas un gate. Elle répond à la question que Nicolas pose dans
 * le handoff : « le serveur répond-il à `SEARCH HEADER LIST-ID`, et en combien
 * de temps sur un gros dossier réel ? »
 *
 * LECTURE SEULE, sans exception : LIST, STATUS, SELECT, SEARCH et un FETCH
 * d'en-têtes de messages qu'elle choisit elle-même. Elle ne crée, ne déplace et
 * ne supprime RIEN, et n'imprime ni corps, ni adresse complète, ni mot de passe.
 *
 * Pourquoi ce n'est pas un banc : « ce serveur cherche-t-il par en-tête » n'a
 * pas de bonne réponse à affirmer. Chaque mesure porte donc SA RÉFÉRENCE DU MÊME
 * TOUR, et le script sort 0 quoi que réponde le serveur — les chiffres sont la
 * sortie. Une référence à zéro veut dire que le banc est cassé, pas que le
 * serveur ne sait pas chercher.
 *
 *  A. L'aiguille. Elle lit les en-têtes des messages récents de la réception
 *     jusqu'à trouver un `List-Id` réellement présent. Sans lettre d'information
 *     dans la boîte, aucune mesure n'est interprétable : la sonde le dit et
 *     s'arrête. L'identifiant trouvé n'est JAMAIS imprimé en entier.
 *  B. Le serveur répond-il ? `SEARCH HEADER LIST-ID <valeur>` sur la réception.
 *     RÉFÉRENCE DU MÊME TOUR : `SEARCH HEADER LIST-ID <valeur absurde>`, qui doit
 *     rendre 0, et un `SEARCH ALL` qui doit rendre le compte du dossier. Un
 *     serveur qui ignore le critère rendrait le même nombre aux deux premiers.
 *  C. Le repli. `SEARCH FROM <adresse>` sur le même dossier, même tour : c'est
 *     l'option de repli à chiffrer si le `HEADER` est refusé ou trop lent.
 *  D. Le coût sur un GROS dossier. Le dossier le plus peuplé du compte (mesuré
 *     par `STATUS`, pas deviné), puis les deux mêmes recherches chronométrées.
 *     C'est le chiffre qui décide si la fonction tient sur une vraie boîte.
 *
 *   node --experimental-strip-types scripts/probe-search-header.mjs
 */
import { openTestMailbox, harness } from './bench-imap.mjs'

const { client, close } = await openTestMailbox()

/**
 * Combien de messages récents la mesure A lit au plus pour trouver un List-Id.
 * 120 ne suffisait pas sur la boîte de test (163 819 messages en réception, zéro
 * `List-Id` dans les 120 derniers) : la sonde s'arrêtait en HARNESS, ce qui est
 * la bonne conclusion — aucune mesure n'était interprétable — mais pas une
 * réponse. Un FETCH d'en-têtes reste bon marché, seulement deux champs.
 */
const NEEDLE_SCAN = 1500
/** Un identifiant qu'aucune liste ne porte : la référence « doit rendre 0 ». */
const ABSURD = 'no-such-list.probe.invalid'

const ms = async work => {
  const started = process.hrtime.bigint()
  const value = await work()
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 }
}
/** Un identifiant ne s'imprime jamais en entier : sa forme suffit à juger. */
const masked = v => `${v.slice(0, 3)}…${v.slice(-6)} (${v.length} car.)`
const count = r => (Array.isArray(r) ? r.length : null)

try {
  // --- A. l'aiguille ------------------------------------------------------
  console.log('A. une lettre d’information réellement présente dans la réception')
  const lock = await client.getMailboxLock('INBOX')
  let needle = null
  let inboxTotal = 0
  try {
    const all = await client.search({ all: true }, { uid: true })
    const uids = Array.isArray(all) ? all : []
    inboxTotal = uids.length
    console.log(`   réception : ${inboxTotal} messages`)
    for await (const msg of client.fetch(
      uids.slice(-NEEDLE_SCAN).join(','),
      { uid: true, headers: ['list-id', 'from'] },
      { uid: true }
    )) {
      const raw = Buffer.isBuffer(msg.headers) ? msg.headers.toString('utf8') : ''
      const listId = raw.match(/^list-id:\s*(.+)$/im)?.[1]
      const from = raw.match(/^from:.*<([^>]+)>/im)?.[1] ?? raw.match(/^from:\s*(\S+@\S+)/im)?.[1]
      const bracketed = listId?.match(/<([^<>]+)>/)?.[1] ?? listId?.trim()
      if (bracketed && from) { needle = { listId: bracketed.trim(), from: from.trim() }; break }
    }
  } finally {
    lock.release()
  }
  if (!needle) {
    harness(
      `aucun List-Id dans les ${NEEDLE_SCAN} derniers messages de la réception : ` +
      'sans lettre d’information, aucune mesure de cette sonde n’est interprétable'
    )
  }
  console.log(`   aiguille : List-Id ${masked(needle.listId)}, expéditeur ${masked(needle.from)}`)

  // --- B, C. la réception -------------------------------------------------
  const measure = async folder => {
    const l = await client.getMailboxLock(folder)
    try {
      const all = await ms(() => client.search({ all: true }, { uid: true }))
      const header = await ms(() =>
        client.search({ header: { 'list-id': needle.listId } }, { uid: true })
      )
      const absurd = await ms(() => client.search({ header: { 'list-id': ABSURD } }, { uid: true }))
      const from = await ms(() => client.search({ from: needle.from }, { uid: true }))
      return { all, header, absurd, from }
    } finally {
      l.release()
    }
  }

  const report = (folder, m) => {
    console.log(`   dossier « ${folder} »`)
    console.log(`     SEARCH ALL                 → ${count(m.all.value)} en ${m.all.ms.toFixed(0)} ms   [référence]`)
    console.log(`     SEARCH HEADER LIST-ID      → ${count(m.header.value)} en ${m.header.ms.toFixed(0)} ms`)
    console.log(`     SEARCH HEADER LIST-ID (∅)  → ${count(m.absurd.value)} en ${m.absurd.ms.toFixed(0)} ms   [référence, doit valoir 0]`)
    console.log(`     SEARCH FROM                → ${count(m.from.value)} en ${m.from.ms.toFixed(0)} ms   [repli]`)
    const h = count(m.header.value)
    const a = count(m.absurd.value)
    const total = count(m.all.value)
    if (a === null || h === null) console.log('     VERDICT : le serveur n’a pas répondu à un SEARCH HEADER')
    else if (a !== 0) console.log(`     VERDICT : le critère est IGNORÉ (un identifiant absurde rend ${a})`)
    else if (h === total && total > 0) console.log('     VERDICT : suspect — autant que SEARCH ALL, critère probablement ignoré')
    else console.log(`     VERDICT : le serveur FILTRE bien par en-tête (${h} sur ${total})`)
  }

  console.log('\nB/C. réception : le serveur filtre-t-il, et à quel prix face au repli FROM')
  report('INBOX', await measure('INBOX'))

  // --- D. le gros dossier -------------------------------------------------
  console.log('\nD. le dossier le plus peuplé du compte — le chiffre qui décide')
  const list = await client.list({ statusQuery: { messages: true } })
  const selectable = list
    .filter(f => !f.flags?.has('\\Noselect'))
    .map(f => ({ path: f.path, messages: f.status?.messages ?? null }))
  const counted = selectable.filter(f => typeof f.messages === 'number')
  console.log(`   ${selectable.length} dossiers, dont ${counted.length} dénombrés par STATUS`)
  const biggest = counted.sort((a, b) => b.messages - a.messages)[0]
  if (!biggest || biggest.path === 'INBOX') {
    console.log('   pas de dossier plus gros que la réception : la mesure B/C est déjà le pire cas')
  } else {
    console.log(`   le plus gros : ${biggest.messages} messages`)
    report(biggest.path, await measure(biggest.path))
  }

  console.log('\nsonde : terminée (lecture seule — aucun message créé, déplacé ni supprimé)')
} finally {
  await close()
}
