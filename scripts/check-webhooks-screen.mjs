/**
 * Contrôle du lot W5 : l'écran « Webhooks » se rend pour une VRAIE session, il est atteignable
 * par la navigation des réglages dans les trois langues, et ce qu'il affiche vient bien des
 * routes qu'il appelle — un webhook créé, son secret rendu UNE fois, un déclencheur qui EST une
 * règle, un essai inscrit au journal.
 *
 * Aucun appel sortant : l'essai est seulement INSCRIT (le planificateur l'enverrait, et le banc
 * ne le laisse pas partir — il supprime le webhook dans le `finally`). Aucune boîte n'est
 * balayée, aucun mail n'est lu.
 *
 *   node --experimental-strip-types scripts/check-webhooks-screen.mjs [--negative]
 */
import './alias-resolver.mjs'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const BASE = env.SYNAPMAIL_TEST_URL
const NEGATIVE = process.argv.includes('--negative')

const { WEBHOOKS_ENDPOINT, webhookTriggerHref } =
  await import(new URL('../lib/webhookRoutes.ts', import.meta.url).href)

// La table de navigation se LIT dans la source, elle ne s'importe pas : `node` ne sait pas
// parser le JSX du composant qui la porte. C'est déjà ainsi que `check-omnibar-commands.mjs`
// l'interroge — le banc suit la convention de la lane plutôt que d'en inventer une seconde.
const NAV_SRC = readFileSync(new URL('../components/settings/SettingsSidebar.tsx', import.meta.url), 'utf8')
const navFrom = NAV_SRC.indexOf('export const SETTINGS_NAV')
const NAV_BLOCK = navFrom < 0 ? '' : NAV_SRC.slice(navFrom, NAV_SRC.indexOf('] as const', navFrom))

const locales = Object.fromEntries(['en', 'fr', 'zh'].map(code =>
  [code, JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8'))]))

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
const send = (method, path, body) => fetch(`${BASE}${path}`, {
  method, headers: { cookie, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

const SCREEN_PATH = '/settings/webhooks'
const NAME = `bench-webhook-${Date.now()}`
let webhookId = null
let ruleId = null

try {
  // --- B. l'écran existe, et la navigation des réglages y mène ----------------------
  const pageRes = await get(SCREEN_PATH)
  const html = await pageRes.text()
  check(pageRes.status === 200, `B1 ${SCREEN_PATH} se rend pour une session`, `statut ${pageRes.status}`)
  check(/Réglages|Settings|设置/.test(html), 'B2 l’écran est bien dans le cadre des réglages')

  // L'entrée vient de la source UNIQUE des réglages, pas d'une seconde table.
  const navEntry = NEGATIVE ? null
    : new RegExp(`href:\\s*'${SCREEN_PATH}',\\s*key:\\s*'([^']+)'`).exec(NAV_BLOCK)
  check(!!navEntry, 'B3 l’entrée est dans SETTINGS_NAV',
    NAV_BLOCK ? `${SCREEN_PATH} absent de la table` : 'SETTINGS_NAV introuvable dans la source')
  for (const [code, dict] of Object.entries(locales)) {
    const label = NEGATIVE ? '' : dict.settings?.nav?.[navEntry?.[1] ?? '']
    check(typeof label === 'string' && label.length > 0, `B4 ${code} : l’entrée a son libellé`, String(label))
  }

  // --- C. un webhook se crée, et son secret ne sort qu'UNE fois ---------------------
  const accounts = ((await json('/api/accounts')).data ?? []).filter(a => !a.isShared)
  check(accounts.length > 0, 'C0 la session a au moins une boîte possédée', `${accounts.length}`)
  const accountId = accounts[0].id

  // La MÊME adresse que le banc W4 : `WEBHOOK_ALLOWED_HOSTS=127.0.0.1` est posé dans
  // l'environnement du serveur de dev, le port est fermé, et ce banc supprime le webhook
  // avant que le planificateur puisse tenter quoi que ce soit. Rien ne sort de la machine.
  const createRes = await send('POST', WEBHOOKS_ENDPOINT, {
    accountId, name: NAME, url: 'http://127.0.0.1:9/bench-w5',
  })
  const createdBody = await createRes.text()
  const created = JSON.parse(createdBody).data ?? {}
  webhookId = created.id
  check(createRes.status === 201 && !!webhookId, 'C1 un webhook se crée depuis l’écran', `statut ${createRes.status}`)
  check(typeof created.secret === 'string' && created.secret.startsWith('whsec_'),
    'C2 la création rend le secret, une fois', String(created.secret).slice(0, 12))

  let listBody = await get(WEBHOOKS_ENDPOINT).then(r => r.text())
  if (NEGATIVE) listBody = JSON.stringify({ data: [{ id: webhookId, secret: created.secret }] })
  check(!listBody.includes(created.secret), 'C3 la liste que l’écran affiche ne porte PAS le secret')
  check(!/secret_encrypted|secretEncrypted/.test(listBody), 'C4 ni le chiffré du secret')

  const rotated = await send('POST', `${WEBHOOKS_ENDPOINT}/${webhookId}/secret`).then(r => r.json())
  check(typeof rotated.data?.secret === 'string' && rotated.data.secret !== created.secret,
    'C5 régénérer rend un secret NEUF, une fois', String(rotated.data?.secret).slice(0, 12))

  // --- D. une adresse privée est refusée AVANT d'être enregistrée -------------------
  const refused = await send('POST', WEBHOOKS_ENDPOINT, {
    accountId, name: `${NAME}-privee`, url: 'https://10.0.0.7/hook',
  })
  const refusedBody = await refused.json()
  check(refused.status === 422, 'D1 une adresse privée est refusée (422)', `statut ${refused.status}`)
  check(typeof refusedBody.error === 'string' && refusedBody.error.length > 0,
    'D2 et le refus dit pourquoi', String(refusedBody.error))

  // --- E. un déclencheur EST une règle, écrite avec l'éditeur existant --------------
  const href = webhookTriggerHref({ id: webhookId, accountId })
  check(href.includes('/settings/rules') && href.includes(webhookId),
    'E1 « ajouter un déclencheur » mène à l’éditeur de RÈGLES, armé sur ce webhook', href)
  const editorRes = await get(href)
  check(editorRes.status === 200, 'E2 cette adresse se rend', `statut ${editorRes.status}`)

  const ruleRes = await send('POST', '/api/rules', {
    accountId, name: `${NAME}-regle`,
    conditionLogic: 'all',
    conditions: [{ id: 'c1', field: 'subject', operator: 'matches', value: '^facture n°\\d+' }],
    actions: [{ id: 'a1', type: 'webhook', value: webhookId }],
  })
  const ruleBody = await ruleRes.json()
  ruleId = ruleBody.data?.id
  check(ruleRes.status === 201 && !!ruleId, 'E3 une règle regex qui vise ce webhook s’enregistre', `statut ${ruleRes.status}`)

  const hook = NEGATIVE ? { ruleCount: 0 } : (await json(`${WEBHOOKS_ENDPOINT}/${webhookId}`)).data ?? {}
  check(hook.ruleCount === 1, 'E4 l’écran compte ce déclencheur sur la ligne du webhook', String(hook.ruleCount))

  // Un webhook d'une AUTRE boîte reste hors de portée d'une règle : la barrière tient.
  const otherAccount = accounts.find(a => a.id !== accountId)
  if (otherAccount) {
    const crossed = await send('POST', '/api/rules', {
      accountId: otherAccount.id, name: `${NAME}-croisee`,
      conditionLogic: 'all',
      conditions: [{ id: 'c1', field: 'subject', operator: 'contains', value: 'x' }],
      actions: [{ id: 'a1', type: 'webhook', value: webhookId }],
    })
    check(crossed.status === 422, 'E5 une règle d’une autre boîte ne peut pas viser ce webhook', `statut ${crossed.status}`)
  }

  // --- F. l'essai s'inscrit au journal que l'écran déplie ---------------------------
  const before = (await json(`${WEBHOOKS_ENDPOINT}/${webhookId}/deliveries`)).data ?? []
  const testRes = await send('POST', `${WEBHOOKS_ENDPOINT}/${webhookId}/test`)
  check(testRes.status === 202, 'F1 « envoyer un test » est accepté', `statut ${testRes.status}`)

  const after = NEGATIVE ? before : ((await json(`${WEBHOOKS_ENDPOINT}/${webhookId}/deliveries`)).data ?? [])
  check(after.length === before.length + 1, 'F2 le journal que l’écran affiche gagne une ligne',
    `${before.length} → ${after.length}`)
  const entryLine = after[0] ?? {}
  check(entryLine.event === 'webhook.test', 'F3 et cette ligne est bien l’essai', String(entryLine.event))

  const retried = await send('POST', `${WEBHOOKS_ENDPOINT}/deliveries/${entryLine.id}/retry`)
  check(retried.status === 202, 'F4 « renvoyer » est accepté sur cette ligne', `statut ${retried.status}`)
  const afterRetry = (await json(`${WEBHOOKS_ENDPOINT}/${webhookId}/deliveries`)).data ?? []
  check(afterRetry.length === after.length, 'F5 renvoyer ne crée PAS une seconde ligne',
    `${after.length} → ${afterRetry.length}`)
} finally {
  // Rien ne survit au banc : ni la règle, ni le webhook, donc rien que le planificateur
  // pourrait tenter d'envoyer après coup.
  if (ruleId) await send('DELETE', `/api/rules/${ruleId}`).catch(() => {})
  if (webhookId) await send('DELETE', `${WEBHOOKS_ENDPOINT}/${webhookId}`).catch(() => {})
}

if (NEGATIVE) {
  if (failures.length) { console.log(`\ncontrôle négatif : ${failures.length} refus tombés, comme attendu`); process.exit(0) }
  console.error('\nCONTRÔLE NÉGATIF MUET'); process.exit(1)
}
if (failures.length) { console.error(`\n${failures.length} échec(s)`); process.exit(1) }
console.log('\nécran des webhooks : OK')
