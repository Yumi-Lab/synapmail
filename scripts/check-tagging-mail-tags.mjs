/**
 * Lot T6 — les étiquettes DANS le courrier : les pastilles de la liste, le panneau du volet de
 * lecture et le filtre par étiquette.
 *
 * Ce banc porte deux rôles, pour éviter d'écrire deux fois les mêmes lignes de banc :
 *  - il MESURE ce que l'interface lit : une requête pour toute une page, la correction humaine
 *    qui n'efface pas la ligne du moteur, le filtre qui montre un mail HORS de la page ;
 *  - avec `--seed`, il LAISSE ses étiquettes en place au lieu de les effacer, pour que le gate
 *    visuel ait 5 messages étiquetés à regarder.
 *
 * Aucun appel à un vrai moteur (la source `jev` est écrite par une CLÉ API de banc, décision 7),
 * aucune connexion IMAP, aucun crédit dépensé. Les 5 messages viennent de la base : ce sont ceux
 * que `/api/messages` sert déjà, pris en lecture seule.
 */
// `lib/` importe ses dépendances à l'alias `@/…`, que `node` ne résout pas seul : le banc
// apprend l'alias au lieu de faire plier le code mesuré (voir scripts/alias-resolver.mjs).
import './alias-resolver.mjs'
import { existsSync, readFileSync } from 'node:fs'
import crypto from 'node:crypto'

const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const BASE = env.SYNAPMAIL_TEST_URL
// Le nettoyage écrit sur la base de la lane, qui vit dans `.env.local` et non dans `.env`.
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const NEGATIVE = process.argv.includes('--negative')
/** `--seed` laisse les étiquettes en base pour le gate visuel ; sans lui, tout est nettoyé. */
const SEED = process.argv.includes('--seed')

const failures = []
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`) }
}

// Ce que le banc étiquette : des questions de GROUPES différents et de TYPES différents, pour
// que le panneau ait plus d'un groupe à ranger et que la liste ait de quoi masquer en infobulle.
// `listBadge` de questions.ts décide seul ce qui monte en pastille : le banc ne le redit pas.
const SEEDS = [
  [{ question: 'categorie', valeur: 'ecommerce', confiance: 0.91 },
   { question: 'intention', valeur: 'livraison', confiance: 0.84 },
   { question: 'urgence', valeur: 'sous_48h', confiance: 0.72 },
   { question: 'langue', valeur: 'fr', confiance: 0.99 },
   { question: 'reponse_requise', valeur: 'oui', confiance: 0.88 }],
  [{ question: 'categorie', valeur: 'banque', confiance: 0.95 },
   { question: 'document', valeur: 'releve', confiance: 0.9 },
   { question: 'montant_mentionne', valeur: 'oui', confiance: 0.8 },
   { question: 'automatique', valeur: 'oui', confiance: 0.93 }],
  [{ question: 'categorie', valeur: 'spam', confiance: 0.97 },
   { question: 'spam_hameconnage', valeur: 'oui', confiance: 0.94 },
   { question: 'demande_identifiants', valeur: 'oui', confiance: 0.81 },
   { question: 'urgence', valeur: 'aucune', confiance: 0.6 }],
  [{ question: 'categorie', valeur: 'correspondance', confiance: 0.76 },
   { question: 'intention', valeur: 'reclamation', confiance: 0.83 },
   { question: 'frustration', valeur: 'agace', confiance: 0.7 },
   { question: 'demande_remboursement', valeur: 'oui', confiance: 0.79 },
   { question: 'equipe', valeur: 'sav', confiance: 0.86 }],
  [{ question: 'categorie', valeur: 'newsletter', confiance: 0.92 },
   { question: 'intention', valeur: 'information', confiance: 0.71 },
   { question: 'demande_desinscription', valeur: 'non', confiance: 0.68 },
   { question: 'langue', valeur: 'en', confiance: 0.96 }],
]

// --- session humaine, comme le ferait un navigateur ---------------------------------
const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
let cookie = (csrfRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ')
const { csrfToken } = await csrfRes.json()
const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
  method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  body: new URLSearchParams({ csrfToken, email: env.SYNAPMAIL_TEST_EMAIL, password: env.SYNAPMAIL_TEST_PASSWORD }),
})
cookie = [...(loginRes.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]), cookie].join('; ')
const session = await (await fetch(`${BASE}/api/auth/session`, { headers: { cookie } })).json()
check(!!session?.user?.id, 'A1 la session de banc est ouverte')

const get = (path) => fetch(`${BASE}${path}`, { headers: { cookie } })
const json = (path) => get(path).then(r => r.json())
const tagsPath = (mid, q = '') => `/api/messages/${encodeURIComponent(mid)}/tags${q}`

let engineKeyId = null
let accountId = null
let taggedIds = []

try {
  // --- B. une boîte possédée, et 5 messages RÉELS pris en lecture seule --------------
  const all = (await json('/api/accounts')).data ?? []
  const owned = all.filter(a => !a.isShared)
  check(owned.length > 0, 'B1 la session a une boîte possédée', `${all.length} boîte(s)`)
  accountId = owned[0].id

  const list = await json(`/api/messages?folder=INBOX&filter=all&page=1&perPage=8&account=${accountId}`)
  const messages = (list.messages ?? []).filter(m => m.messageId).slice(0, SEEDS.length)
  check(messages.length === SEEDS.length, `B2 ${SEEDS.length} messages réels servent de support`, `${messages.length} trouvé(s)`)
  if (messages.length < SEEDS.length) throw new Error('pas assez de messages pour le banc')

  // --- C. une clé API écrit la source d'un MOTEUR (décision 7) -----------------------
  // C'est la clé, et non la session, qui pose les étiquettes `jev` : une session n'a pas le
  // droit d'écrire une source de moteur, et c'est précisément ce que le panneau doit corriger.
  const keyRes = await fetch(`${BASE}/api/api-keys`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `bench etiquettes ${crypto.randomBytes(4).toString('hex')}`, scopes: ['tags:read', 'tags:write'], accountIds: [accountId] }),
  })
  const keyBody = await keyRes.json()
  const engineKey = keyBody.data?.key
  engineKeyId = keyBody.data?.id
  check(keyRes.status === 201 && !!engineKey, 'C1 une clé de banc porte tags:read + tags:write', `statut ${keyRes.status}`)

  for (const [i, msg] of messages.entries()) {
    const res = await fetch(`${BASE}${tagsPath(msg.messageId)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${engineKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId, source: 'jev', model: 'bench-1.0', tags: SEEDS[i],
        folder: msg.folder, uid: Number(msg.uid), fromName: msg.from?.name,
        fromAddress: msg.from?.address, subject: msg.subject, date: msg.date,
      }),
    })
    const body = await res.json()
    check(res.status === 200 && body.data?.written === SEEDS[i].length,
      `C2.${i + 1} ${SEEDS[i].length} étiquettes de moteur posées sur un message`, JSON.stringify(body).slice(0, 200))
    if (res.status === 200) taggedIds.push(msg.messageId)
  }

  // --- D. UNE requête sert toute la page, jamais une par ligne (décision 11) ---------
  const idsQuery = taggedIds.map(id => `&id=${encodeURIComponent(id)}`).join('')
  const page = await get(`/api/tags?account=${accountId}${idsQuery}`)
  const effective = (await page.json()).data?.effective ?? {}
  check(page.status === 200, 'D1 une seule requête rend les étiquettes de la page', `statut ${page.status}`)
  check(Object.keys(effective).length === taggedIds.length,
    `D2 elle couvre les ${taggedIds.length} messages demandés`, `${Object.keys(effective).length} rendu(s)`)
  // Une seule ligne par question : c'est l'EFFECTIVE, pas toutes les sources.
  const first = effective[taggedIds[0]] ?? []
  const questionsSeen = new Set(first.map(tag => tag.question))
  check(first.length === questionsSeen.size, 'D3 une seule étiquette par question (l’effective)', `${first.length} ligne(s), ${questionsSeen.size} question(s)`)
  // Toute effective dit d'OÙ elle vient. La confiance, elle, n'existe que pour un MOTEUR : une
  // ligne humaine n'en a pas par nature (un humain ne devine pas), et une correction laissée par
  // un passage précédent doit donc être acceptée telle quelle, pas comptée comme un défaut.
  check(first.every(tag => (tag.source === 'humain'
    ? tag.confiance === null
    : tag.source === 'jev' && typeof tag.confiance === 'number')),
    'D4 chaque étiquette dit sa source, et sa confiance quand elle vient d’un moteur', JSON.stringify(first[0]))

  // --- E. la correction humaine AJOUTE, elle n'efface pas (décision 5) ---------------
  const target = taggedIds[0]
  const corrected = await fetch(`${BASE}${tagsPath(target)}`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, tags: [{ question: 'categorie', valeur: 'logistique' }] }),
  })
  const after = await corrected.json()
  const rows = after.data?.tags ?? []
  const engineRow = rows.find(r => r.question === 'categorie' && r.source === 'jev')
  const humanRow = rows.find(r => r.question === 'categorie' && r.source === 'humain')
  const effectiveRow = (after.data?.effective ?? []).find(r => r.question === 'categorie')
  check(corrected.status === 200, 'E1 la correction d’un clic passe', `statut ${corrected.status}`)
  check(engineRow?.valeur === 'ecommerce', 'E2 la ligne du moteur reste lisible (infobulle)', JSON.stringify(engineRow))
  check(humanRow?.valeur === 'logistique', 'E3 la correction humaine est enregistrée à côté', JSON.stringify(humanRow))
  check(effectiveRow?.source === 'humain', 'E4 l’effective affichée est celle de l’humain', JSON.stringify(effectiveRow))
  check(humanRow?.entrainementAutorise === true && engineRow?.entrainementAutorise === false,
    'E5 seule la ligne humaine est entraînable', `humain=${humanRow?.entrainementAutorise} moteur=${engineRow?.entrainementAutorise}`)

  // Confirmer SANS changer de valeur écrit aussi une ligne humaine : c'est ce qui rend la
  // réponse du moteur réutilisable, donc « Confirmer » n'est pas un geste vide.
  const confirmTarget = taggedIds[1]
  const confirmed = await fetch(`${BASE}${tagsPath(confirmTarget)}`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, tags: [{ question: 'categorie', valeur: 'banque' }] }),
  }).then(r => r.json())
  const confirmedRow = (confirmed.data?.effective ?? []).find(r => r.question === 'categorie')
  check(confirmedRow?.source === 'humain' && confirmedRow?.entrainementAutorise === true,
    'E6 confirmer la valeur du moteur la rend entraînable', JSON.stringify(confirmedRow))

  // --- F. le filtre montre un mail HORS de la page chargée (décision 4) --------------
  // La valeur corrigée en E : elle n'appartient à AUCUNE des étiquettes posées par le moteur,
  // donc si le filtre la trouve, c'est bien l'effective qu'il lit.
  const hit = await json(`/api/tags?account=${accountId}&question=categorie&valeur=logistique`)
  const hits = hit.data?.messages ?? []
  check(hits.some(m => m.messageId === target), 'F1 le filtre trouve le mail par son étiquette effective', JSON.stringify(hits).slice(0, 200))
  const row = hits.find(m => m.messageId === target)
  check(!!row?.folder && row?.uid !== null, 'F2 il rend la position qui permet de l’ouvrir', JSON.stringify(row))
  check(row?.subject !== undefined, 'F3 et de quoi l’afficher sans la page chargée', JSON.stringify(row))

  // L'ANCIENNE valeur ne ressort plus : une correction déplace le mail d'un filtre à l'autre.
  const stale = await json(`/api/tags?account=${accountId}&question=categorie&valeur=ecommerce`)
  // Contrôle négatif : on fait DIRE au filtre que l'ancienne valeur rend encore le mail. F4 doit
  // tomber. Une liste VIDE ne saboterait rien — elle ferait passer F4 pour la mauvaise raison.
  const staleHits = NEGATIVE ? [{ messageId: target }] : (stale.data?.messages ?? [])
  check(!staleHits.some(m => m.messageId === target), 'F4 son ancienne valeur ne le rend plus', JSON.stringify(staleHits).slice(0, 200))

  // --- G. un libellé existe pour TOUT ce que l'interface peut afficher ---------------
  // Sans cela, une pastille afficherait la clé brute `tags.v.xxx` au lieu d'un mot. Le contrôle
  // lit les VRAIS fichiers de langue et les VRAIES questions : aucune liste recopiée à la main.
  const { QUESTIONS, valuesOf } = await import('../lib/tagging/questions.ts')
  const missing = []
  for (const locale of ['en', 'fr', 'zh']) {
    const dict = JSON.parse(readFileSync(`locales/${locale}.json`, 'utf8')).tags ?? {}
    for (const q of QUESTIONS) {
      if (!dict.q?.[q.id]) missing.push(`${locale}:tags.q.${q.id}`)
      if (!dict.g?.[q.group]) missing.push(`${locale}:tags.g.${q.group}`)
      for (const v of valuesOf(q)) if (!dict.v?.[v]) missing.push(`${locale}:tags.v.${v}`)
    }
  }
  check(missing.length === 0, 'G1 les 3 langues nomment chaque question, groupe et valeur', missing.slice(0, 8).join(' '))

  // Un libellé qui porte un NOMBRE le décline : « 1 étiqueté », pas « 1 étiquetés ». C'est la
  // forme ICU de next-intl, celle que le reste de `locales/` emploie déjà (`mail.searchCount`).
  // Le zh n'a qu'une forme — `other` seul suffit et c'est ce qui est vérifié : une clause, pas
  // un « one » recopié pour la forme.
  const COUNTED = ['filterCount', 'unpositioned']
  const unplural = []
  for (const locale of ['en', 'fr', 'zh']) {
    const dict = JSON.parse(readFileSync(`locales/${locale}.json`, 'utf8')).tags ?? {}
    for (const key of COUNTED) {
      if (!/\{count, plural,/.test(dict[key] ?? '')) unplural.push(`${locale}:tags.${key}`)
    }
  }
  check(unplural.length === 0, 'G2 un libellé qui compte décline son nombre (ICU)', unplural.join(' '))

  // --- H. l'écran de courrier se rend avec tout cela -------------------------------
  const mailRes = await get('/mail')
  check(mailRes.status === 200, 'H1 /mail se rend pour une session', `statut ${mailRes.status}`)
} finally {
  // Les étiquettes du banc sont RETIRÉES, sauf en mode graine : la boîte est réelle, le banc ne
  // laisse rien derrière lui par défaut. Pas de route de suppression (aucune corbeille par
  // étiquette, décision 11) : le nettoyage passe par la base, comme les autres bancs DB.
  // Un `.gate-handoff` en attente signifie qu'un humain regarde CES étiquettes : les effacer
  // viderait l'écran qu'il est en train de juger. Le banc se tait alors plutôt que de nettoyer.
  if (!SEED && taggedIds.length && !existsSync('.gate-handoff')) {
    const { query } = await import('../lib/db.ts')
    await query('DELETE FROM message_tags WHERE account_id = $1 AND message_id = ANY($2::text[])', [accountId, taggedIds])
    await query('DELETE FROM tagged_messages WHERE account_id = $1 AND message_id = ANY($2::text[])', [accountId, taggedIds])
  }
  if (engineKeyId) {
    await fetch(`${BASE}/api/api-keys/${engineKeyId}`, { method: 'DELETE', headers: { cookie } }).catch(() => {})
  }
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET'); process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log(SEED ? `\nétiquettes dans le courrier : OK (${taggedIds.length} messages étiquetés, laissés pour le gate)` : '\nétiquettes dans le courrier : OK')
