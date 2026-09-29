/**
 * Contrôle de fumée du lot T5 : l'écran se rend pour une VRAIE session, et les routes qu'il
 * appelle ne rendent jamais la clé d'un moteur. Aucun appel moteur, aucune connexion IMAP.
 *
 * La section H y ajoute l'échantillon (lot T10b) : l'état porte la taille, la graine et le coût
 * estimé de CET échantillon ; l'écran rendu propose le bouton, nomme la taille et a de quoi
 * montrer la répartition ; la route refuse une taille ou une graine hors du prévu en la NOMMANT ;
 * un échantillon accepté est annoncé dans l'état sans que le tirage soit fait dans le temps de la
 * requête ; et « lancer le tri complet » efface le mode échantillon. Rien n'est trié : le travail
 * appartient au planificateur, et la boîte est remise en pause avant de rendre la main.
 *
 * CE QUE H NE DIT PAS : à quoi l'écran RESSEMBLE. La page est un composant client dont les données
 * viennent de SWR, donc le HTML rendu par le serveur ne porte pas encore la ligne de l'échantillon
 * (seulement le paquet de traductions) : H3/H4 mesurent le BRANCHEMENT dans la source, pas le
 * rendu. L'apparence reste un gate humain, comme pour T5 et T6.
 */
import { readFileSync } from 'node:fs'
import crypto from 'node:crypto'

const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const BASE = env.SYNAPMAIL_TEST_URL
const NEGATIVE = process.argv.includes('--negative')

const failures = []
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else { failures.push(label); console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`) }
}

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

const KEY_PLAIN = `t5-probe-key-${crypto.randomBytes(8).toString('hex')}`

/**
 * Contrôle négatif : on retire ce que le banc prétend mesurer — le secret de la clé (on la
 * cherche dans une réponse qui la porte pour de bon), et le filtre des boîtes partagées (on
 * prend la première boîte venue). Les assertions correspondantes DOIVENT virer au rouge ;
 * si elles restent vertes, elles ne mesuraient rien.
 */
let engineId = null

try {
  // --- B. l'écran se rend pour une session ------------------------------------------
  const pageRes = await get('/settings/tagging')
  const html = await pageRes.text()
  check(pageRes.status === 200, 'B1 /settings/tagging se rend pour une session', `statut ${pageRes.status}`)
  check(/Tri automatique|Automatic sorting|自动分类/.test(html), 'B2 le titre de l’écran est rendu')
  check(/Réglages|Settings|设置/.test(html), 'B3 l’écran est bien dans le cadre des réglages')
  // La section « Questions » (lot T-Q) est montée dans CET écran : la liste se remplit côté
  // client (SWR), mais le conteneur et son bouton d'ajout sont dans le HTML servi.
  check(/data-tag-questions=/.test(html) && /data-tag-question-add/.test(html), 'B4 la section « Questions » est montée dans l’écran (conteneur + bouton d’ajout rendus)')

  // --- C. un moteur se crée, se lit, et sa clé ne ressort jamais ---------------------
  const created = await fetch(`${BASE}/api/decision-engines`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'probe engine', kind: 'jev', url: 'https://engine.bench.invalid/v1', model: 'probe-model', apiKey: KEY_PLAIN }),
  })
  const createdBody = await created.text()
  engineId = JSON.parse(createdBody).data?.id
  check(created.status === 201 && !!engineId, 'C1 un moteur se crée', `statut ${created.status}`)
  check(!createdBody.includes(KEY_PLAIN), 'C2 la création ne renvoie PAS la clé', createdBody.slice(0, 200))
  check(JSON.parse(createdBody).data?.hasKey === true, 'C3 elle dit seulement qu’une clé est enregistrée')

  let listBody = await get('/api/decision-engines').then(r => r.text())
  if (NEGATIVE) listBody = JSON.stringify({ data: [{ id: engineId, key: KEY_PLAIN, key_encrypted: 'x', usdPerBillionInput: 0 }] })
  check(!listBody.includes(KEY_PLAIN), 'C4 la liste ne renvoie pas la clé non plus')
  check(!/key_encrypted|keyEncrypted/.test(listBody), 'C5 ni le chiffré de la clé')

  // Le préréglage du type a prérempli le tarif : 42 $ par milliard pour JEV.
  const listed = JSON.parse(listBody).data.find(e => e.id === engineId)
  check(listed?.usdPerBillionInput === 42, 'C6 le tarif du préréglage est prérempli', String(listed?.usdPerBillionInput))

  // --- D. modifier sans clé garde la clé enregistrée ---------------------------------
  const patched = await fetch(`${BASE}/api/decision-engines/${engineId}`, {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'probe-model-2' }),
  }).then(r => r.json())
  check(patched.data?.model === 'probe-model-2', 'D1 la modification prend')
  check(patched.data?.hasKey === true, 'D2 une modification SANS clé garde la clé enregistrée')

  const badName = await fetch(`${BASE}/api/decision-engines`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '   ', kind: 'jev' }),
  })
  const badBody = await badName.json()
  check(badName.status === 400 && badBody.field === 'name', 'D3 un nom vide est refusé, et le champ fautif est nommé', JSON.stringify(badBody))

  // --- E. l'écran attribue le moteur à une boîte et lit l'estimation -----------------
  // La MÊME sélection que l'écran : les boîtes partagées sont écartées, car ces réglages sont
  // propriétaire seul. Un banc qui prendrait la première boîte venue mesurerait le 404 d'une
  // boîte partagée et accuserait l'écran à tort.
  const all = (await json('/api/accounts')).data ?? []
  const accounts = NEGATIVE ? all : all.filter(a => !a.isShared)
  check(accounts.length > 0, 'E0 la session a au moins une boîte possédée', `${all.length} boîte(s), dont ${all.length - accounts.length} partagée(s)`)
  const accountId = accounts[0].id

  // Et une boîte PARTAGÉE reste refusée, ce qui est la raison de ce filtre.
  const shared = all.find(a => a.isShared)
  if (shared) {
    const refused = await get(`/api/tagging/settings?account=${shared.id}`)
    check(refused.status === 404, 'E0b une boîte partagée n’atteint pas ces réglages', `statut ${refused.status}`)
  }

  const put = await fetch(`${BASE}/api/tagging/settings`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, engineId, budgetUsd: 2.5, live: false }),
  })
  const putBody = await put.text()
  // Un refus laisse `data` absent : le banc doit le SIGNALER, pas mourir dessus — sinon le
  // contrôle négatif s'arrête à la première assertion rouge et ne prouve pas la sensibilité
  // des suivantes.
  const status = JSON.parse(putBody).data ?? {}
  check(put.status === 200 && status.engineId === engineId, 'E1 la boîte adopte le moteur choisi', `statut ${put.status}`)
  check(status.budgetUsd === 2.5, 'E2 le plafond réglé est celui qui revient', String(status.budgetUsd))
  check(!putBody.includes(KEY_PLAIN), 'E3 les réglages ne portent pas la clé')
  check(status.engine?.hasKey === true, 'E4 ils disent seulement qu’une clé est enregistrée')
  check(typeof status.estimateUsd === 'number', 'E5 l’estimation du coût est un nombre', String(status.estimateUsd))
  check(status.questions > 0, 'E6 le nombre de questions posées est annoncé', String(status.questions))

  // Un moteur qui n'est pas le sien (identifiant inventé) : 404, et la boîte n'est pas touchée.
  const ghost = await fetch(`${BASE}/api/tagging/settings`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, engineId: crypto.randomUUID() }),
  })
  check(ghost.status === 404, 'E7 un moteur inconnu est refusé (404)', `statut ${ghost.status}`)

  // --- F. sans moteur, l'écran a de quoi le dire ------------------------------------
  const cleared = await fetch(`${BASE}/api/tagging/settings`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, engineId: null }),
  }).then(r => r.json())
  check(cleared.data?.engine === null, 'F1 une boîte sans moteur le dit clairement')
  check(cleared.data?.estimateUsd === null, 'F2 et n’annonce aucune estimation', String(cleared.data?.estimateUsd))

  // --- G. lancer SANS moteur ne laisse pas la boîte « en cours » pour rien -----------
  // Le planificateur ne réveille QUE les boîtes qui ONT un moteur : sans cette pause posée
  // à l'instant de l'ordre, la boîte affichait « tri en cours » à vie sans trier un mail.
  const run = (action) => fetch(`${BASE}/api/tagging/run`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, action }),
  }).then(async r => ({ status: r.status, body: await r.json() }))

  const started = await run('start')
  const after = NEGATIVE ? { pausedReason: null, pausedDetail: null } : (started.body.data ?? {})
  check(after.pausedReason === 'no_engine', 'G1 lancer sans moteur met la boîte en pause `no_engine`', JSON.stringify(started.body).slice(0, 200))
  check(typeof after.pausedDetail === 'string' && after.pausedDetail.length > 0, 'G2 et la cause est dite en clair', String(after.pausedDetail))

  const resumed = await run('resume')
  const afterResume = NEGATIVE ? { pausedReason: null } : (resumed.body.data ?? {})
  check(afterResume.pausedReason === 'no_engine', 'G3 reprendre sans moteur ne la remet pas en marche', JSON.stringify(resumed.body).slice(0, 200))

  // Et AVEC un moteur, la pause tombe : la règle porte sur l'absence de moteur, pas sur le bouton.
  await fetch(`${BASE}/api/tagging/settings`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, engineId }),
  })
  const withEngine = await run('resume')
  const afterEngine = withEngine.body.data ?? {}
  check(afterEngine.pausedReason === null, 'G4 avec un moteur, la reprise lève bien la pause', JSON.stringify(withEngine.body).slice(0, 200))

  // La boîte est remise en pause à la main : le banc ne laisse JAMAIS un tri qui tournerait
  // sur une vraie boîte IONOS au prochain passage du planificateur (règle absolue de GOAL.md).
  await run('pause')

  // --- H. l'échantillon : ce que l'écran propose, et ce que la route accepte (lot T10b) ----
  // L'écran ne doit RIEN écrire de la taille ni de la graine : il les lit de l'état, qui est le
  // seul endroit où elles sont nommées (`lib/tagging/runner.ts`).
  const stateH = (await json(`/api/tagging/settings?account=${accountId}`)).data ?? {}
  check(stateH.sampleDefaults?.size > 0 && Number.isInteger(stateH.sampleDefaults?.seed),
    'H1 l’état porte la taille et la graine par défaut d’un échantillon',
    JSON.stringify(stateH.sampleDefaults))
  check(typeof stateH.sampleEstimateUsd === 'number',
    'H2 et le coût estimé de CET échantillon, pour l’annoncer avant de le lancer',
    String(stateH.sampleEstimateUsd))

  // L'écran est un composant CLIENT : ses données viennent de SWR, donc le HTML rendu par le
  // serveur ne contient PAS encore la ligne de l'échantillon (il ne porte que le paquet de
  // traductions de next-intl — une assertion sur ce HTML serait verte en ne mesurant rien, c'est
  // le piège vérifié ici avant d'écrire H3). Ce qui se mesure SANS navigateur, c'est donc le
  // BRANCHEMENT dans la source de l'écran ; l'apparence, elle, est un gate humain (voir T10b).
  const screen = readFileSync('app/(app)/settings/tagging/page.tsx', 'utf8')
  check(/action: 'sample'|run\('sample'\)/.test(screen) && /sampleSize/.test(screen),
    'H3 l’écran pilote bien l’action « sample » de la route, avec une taille')
  // La taille n'est écrite NULLE PART dans l'écran : elle vient de `sampleDefaults`, seul endroit
  // qui la nomme (lib/tagging/runner.ts). Un 1000 en dur ici serait une seconde source de vérité.
  check(/sampleDefaults/.test(screen) && !/\b1000\b|\b1_000\b/.test(screen),
    'H4 la taille et la graine viennent de l’état, pas d’un nombre écrit dans l’écran')
  check(/distribution=1/.test(screen) && /data-distribution-question/.test(screen),
    'H4b l’écran demande la répartition à la route et la rend par question')

  // Les bornes de la route. Une taille ou une graine hors du prévu est REFUSÉE, pas corrigée en
  // silence : un échantillon dont la taille n'est pas celle demandée ne mesure rien.
  const sample = (body) => fetch(`${BASE}/api/tagging/run`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, action: 'sample', ...body }),
  }).then(async r => ({ status: r.status, body: await r.json() }))

  for (const [label, body] of [
    ['une taille de 0', { sampleSize: 0 }],
    ['une taille non entière', { sampleSize: 12.5 }],
    ['une taille démesurée', { sampleSize: 10_000_000 }],
    ['une graine négative', { sampleSeed: -1 }],
  ]) {
    const refused = await sample(body)
    check(refused.status === 400 && /sampleS(ize|eed)/.test(JSON.stringify(refused.body)),
      `H5 ${label} est refusée, et la route DIT laquelle`,
      `statut ${refused.status} ${JSON.stringify(refused.body).slice(0, 160)}`)
  }

  // Un échantillon accepté met la boîte en marche, avec `sample` renseigné — c'est ce qui
  // distingue « échantillon de N » d'un tri complet à l'écran. Rien n'est trié ici : le travail
  // appartient au planificateur, et la boîte est remise en pause juste après.
  const ok = await sample({ sampleSize: 3, sampleSeed: 4242 })
  const okData = NEGATIVE ? { sample: null } : (ok.body.data ?? {})
  check(ok.status === 200 && okData.sample?.size === 3 && okData.sample?.seed === 4242,
    'H6 un échantillon accepté est ANNONCÉ dans l’état (taille et graine)',
    `statut ${ok.status} ${JSON.stringify(okData.sample)}`)
  check(okData.sample?.done === 0 && okData.sample?.drawn === 0,
    'H7 le tirage n’est pas fait dans le temps d’une requête HTTP (il appartient au trieur)',
    JSON.stringify(okData.sample))

  // Et « lancer le tri complet » efface le mode échantillon : sinon « lancer le reste » après un
  // échantillon relancerait l'échantillon.
  const full = await run('start')
  check((full.body.data ?? {}).sample === null,
    'H8 « lancer le tri complet » efface le mode échantillon',
    JSON.stringify((full.body.data ?? {}).sample))

  await run('pause')
} finally {
  if (engineId) {
    await fetch(`${BASE}/api/decision-engines/${engineId}`, { method: 'DELETE', headers: { cookie } }).catch(() => {})
  }
  // La boîte est rendue sans moteur, comme elle a été trouvée : le banc n'en attribue aucun durablement.
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET'); process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nécran de tri automatique : OK')
