#!/usr/bin/env node
/**
 * Banc du lot T12 : la priorité COMPOSITE — `scoreFocus()` de `lib/focus.ts`, LA fonction de
 * priorité du dépôt (« à traiter » et le tri « par priorité » la lisent tous les deux).
 *
 * Banc PUR : aucune base, aucun réseau, aucun crédit. `lib/focus.ts` s'importe sans ouvrir de
 * connexion (le pool de `lib/db.ts` est paresseux).
 *
 *   node --experimental-strip-types scripts/check-focus-priority.mjs
 *   node --experimental-strip-types scripts/check-focus-priority.mjs --negative
 *
 * Ce qu'il mesure :
 *   A. un mail NON trié garde exactement l'ancien calcul (mêmes points, même raison) ;
 *   B. les étiquettes effectives ENRICHISSENT le score (poids de `TAG_WEIGHTS`), une valeur
 *      non pesée (`non`, `calme`, `aucune`) pèse 0, une question inconnue est ignorée ;
 *   C. chaque composante est rendue dans `parts` et leur somme EST le score (l'infobulle dit tout) ;
 *   D. la pastille nomme la composante la plus forte : étiquette si elle pèse plus que tout
 *      signal de surface, sinon la raison de surface historique ;
 *   E. les poids négatifs (envoi automatique, hameçonnage) font descendre un « URGENT » en objet
 *      sous le seuil « à traiter » ;
 *   F. `byPriorityThenDate` trie par score décroissant puis date décroissante ; un message sans
 *      priorité vaut 0 ; `imapFilterOf('focus')` = 'unread', les autres filtres inchangés ;
 *   G. chaque question de `TAG_WEIGHTS` existe dans `DEFAULT_QUESTIONS` et chaque valeur pesée
 *      est une valeur de la question (un poids orphelin ne pèserait jamais rien) ;
 *   H. le jeu RÉALISTE du gate du 03/10 (infolettre fréquente, notification réseau social, code de
 *      connexion « sous 48 h », spam marqué qui crie à la fraude, relance fournisseur, facture à
 *      échéance J+2) : relance et facture devant tout le reste, infolettre et notification sous le
 *      seuil, spam EXCLU (plafond `SPAM_CEILING`) ; `echeancePoints` par proximité ; « fréquent »
 *      annulé par `automatique = oui`.
 *
 * CONTRÔLE NÉGATIF (`--negative`) : les étiquettes passées à `scoreFocus` sont VIDÉES (l'état
 * du produit si l'enrichissement n'existait pas). B, C (la part étiquette), D, E et H DOIVENT
 * tomber ; A, F et G tiennent (ils ne dépendent pas des étiquettes). Ce qu'il démontre : les
 * assertions mesurent l'enrichissement, pas la présence du code.
 */
import './alias-resolver.mjs'

const NEGATIVE = process.argv.includes('--negative')
const focus = await import('../lib/focus.ts')
const { DEFAULT_QUESTIONS, valuesOf } = await import('../lib/tagging/questions.ts')
const { scoreFocus, TAG_WEIGHTS, FOCUS_THRESHOLD, SPAM_CEILING, AUTO_CAP, echeancePoints, imapFilterOf } = focus
const { byPriorityThenDate } = await import('../lib/flags.ts')

const failures = []
let ok = 0
const check = (id, cond, detail) => { if (cond) ok++; else failures.push(`${id}: ${detail}`) }
const eq = (id, got, want) => check(id, JSON.stringify(got) === JSON.stringify(want), `attendu ${JSON.stringify(want)}, obtenu ${JSON.stringify(got)}`)

const none = new Set()
const row = (subject, extra = {}) => ({ subject, from_address: 'client@exemple.invalid', is_starred: false, has_attachments: false, ...extra })
const score = (r, tags = [], vip = none, frequent = none) => scoreFocus(r, vip, frequent, NEGATIVE ? [] : tags)
const sum = parts => parts.reduce((s, p) => s + p.points, 0)

// A. mail non trié : l'ancien calcul, à l'identique
eq('A1 rien', score(row('Bonjour')), { score: 0, reason: 'reply', parts: [] })
eq('A2 facture', score(row('Facture n° 42')).score, 3)
eq('A2 facture raison', score(row('Facture n° 42')).reason, 'invoice')
eq('A3 échéance', score(row('Rappel : deadline')).score, 4)
eq('A4 drapeau', score(row('x', { is_starred: true })).score, 5)
eq('A5 contact clé', score(row('x'), [], new Set(['client@exemple.invalid'])).reason, 'vip')
eq('A6 fréquent', score(row('x'), [], none, new Set(['client@exemple.invalid'])).score, 2)
eq('A7 Re + PJ', score(row('Re: devis', { has_attachments: true })).score, 3 + 2 + 1)
eq('A8 PJ seule', score(row('x', { has_attachments: true })).reason, 'attachment')

// B. les étiquettes enrichissent
eq('B1 urgence aujourd\'hui', score(row('Bonjour'), [{ question: 'urgence', valeur: 'aujourdhui' }]).score, TAG_WEIGHTS.urgence.aujourdhui)
eq('B2 réponse requise + facture', score(row('Facture'), [{ question: 'reponse_requise', valeur: 'oui' }]).score, 3 + TAG_WEIGHTS.reponse_requise.oui)
eq('B3 non pesés = 0', score(row('x'), [{ question: 'reponse_requise', valeur: 'non' }, { question: 'frustration', valeur: 'calme' }, { question: 'urgence', valeur: 'aucune' }]).score, 0)
eq('B4 question inconnue', score(row('x'), [{ question: 'categorie', valeur: 'support' }]).score, 0)
eq('B5 cumul', score(row('x'), [{ question: 'menace_juridique', valeur: 'oui' }, { question: 'frustration', valeur: 'colere' }]).score, 5 + 4)

// C. l'infobulle dit tout : parts ⊢ score
for (const [id, r, tags] of [
  ['C1', row('Re: Facture URGENT', { is_starred: true, has_attachments: true }), [{ question: 'urgence', valeur: 'sous_48h' }, { question: 'risque_depart', valeur: 'oui' }]],
  ['C2', row('x'), [{ question: 'automatique', valeur: 'oui' }]],
]) {
  const s = score(r, tags)
  check(`${id} somme`, sum(s.parts) === s.score, `parts=${sum(s.parts)} score=${s.score}`)
  check(`${id} part étiquette`, s.parts.some(p => p.kind === 'tag' && p.question === tags[0].question), `aucune part étiquette dans ${JSON.stringify(s.parts)}`)
}

// D. la pastille nomme la composante la plus forte
eq('D1 étiquette > surface', score(row('Facture'), [{ question: 'urgence', valeur: 'aujourdhui' }]).reason, 'tag')
eq('D2 surface ≥ étiquette', score(row('Rappel deadline'), [{ question: 'reponse_requise', valeur: 'oui' }]).reason, 'deadline')
eq('D3 égalité → surface', score(row('x', { is_starred: true }), [{ question: 'menace_juridique', valeur: 'oui' }]).reason, 'starred')

// E. un envoi automatique / hameçonnage « URGENT » n'est pas à traiter
check('E1 URGENT seul ≥ seuil', score(row('URGENT : action requise')).score >= FOCUS_THRESHOLD, 'un mot d\'échéance doit suffire sans étiquette')
check('E2 URGENT + automatique < seuil', score(row('URGENT : action requise'), [{ question: 'automatique', valeur: 'oui' }]).score < FOCUS_THRESHOLD, `score=${score(row('URGENT : action requise'), [{ question: 'automatique', valeur: 'oui' }]).score}`)
check('E3 URGENT + hameçonnage < seuil', score(row('URGENT : action requise'), [{ question: 'spam_hameconnage', valeur: 'oui' }]).score < FOCUS_THRESHOLD, 'hameçonnage doit faire descendre')
// Le veto (gate 03/10 : « HuffyB sent you a message », spam = oui, valait 20 et menait « À traiter »).
const phishing = score(row('URGENT : votre compte', { is_starred: true, has_attachments: true }), [
  { question: 'spam_hameconnage', valeur: 'oui' }, { question: 'urgence', valeur: 'aujourdhui' },
  { question: 'fraude_paiement', valeur: 'oui' }, { question: 'menace_juridique', valeur: 'oui' }, { question: 'risque_depart', valeur: 'oui' },
])
check('E4 spam + tout le reste = plafond', phishing.score === SPAM_CEILING && phishing.score < FOCUS_THRESHOLD, `score=${phishing.score}`)
check('E4 somme des parts = score', sum(phishing.parts) === phishing.score, `parts=${sum(phishing.parts)} score=${phishing.score}`)
eq('E4 pastille = spam', phishing.reason, 'spam')
// Un automatique « aujourd'hui » (code de connexion) : l'urgence plafonne, le mail reste sous le seuil.
const otp = score(row('Your verification code', { has_attachments: true }), [{ question: 'automatique', valeur: 'oui' }, { question: 'urgence', valeur: 'aujourdhui' }])
check('E5 automatique plafonne l\'urgence', otp.parts.find(p => p.kind === 'tag' && p.question === 'urgence')?.points === AUTO_CAP && otp.score < FOCUS_THRESHOLD, JSON.stringify(otp))
check('E5 somme des parts = score', sum(otp.parts) === otp.score, `parts=${sum(otp.parts)} score=${otp.score}`)
// E6 (gate du 03/10, réserves) : une notification « agacée » ne pèse rien, et les mots d'échéance /
// de facture en objet sont plafonnés comme l'urgence quand l'envoi est automatique.
const angryBot = score(row('Mrcreatesuk sent you a message'), [{ question: 'automatique', valeur: 'oui' }, { question: 'frustration', valeur: 'agace' }])
check('E6 frustration ignorée si automatique', !angryBot.parts.some(p => p.kind === 'tag' && p.question === 'frustration') && angryBot.score === TAG_WEIGHTS.automatique.oui, JSON.stringify(angryBot))
const botDeadline = score(row('Action required: your invoice is ready'), [{ question: 'automatique', valeur: 'oui' }])
eq('E6 échéance + facture d\'objet plafonnées si automatique', botDeadline.parts.filter(p => p.kind === 'reason').map(p => `${p.reason}:${p.points}`), [`invoice:${AUTO_CAP}`, `deadline:${AUTO_CAP}`])
check('E6 … et sous le seuil', botDeadline.score < FOCUS_THRESHOLD && sum(botDeadline.parts) === botDeadline.score, `score=${botDeadline.score}`)
eq('E6 témoin : humain non plafonné', score(row('Action required: your invoice is ready')).parts.map(p => p.points), [3, 4])

// F. le tri et le filtre IMAP
const d = (iso, s) => ({ date: iso, priority: s === undefined ? undefined : { score: s, reason: 'reply', parts: [] } })
const sorted = [d('2026-09-01', 2), d('2026-09-03'), d('2026-09-02', 7), d('2026-09-04', 2)].sort(byPriorityThenDate)
eq('F1 tri', sorted.map(x => `${x.priority?.score ?? 0}@${x.date}`), ['7@2026-09-02', '2@2026-09-04', '2@2026-09-01', '0@2026-09-03'])
eq('F2 focus → unread', imapFilterOf('focus'), 'unread')
eq('F3 autres inchangés', ['all', 'unread', 'flagged'].map(imapFilterOf), ['all', 'unread', 'flagged'])

// G. chaque poids désigne une question et une valeur qui existent
const byId = new Map(DEFAULT_QUESTIONS.map(q => [q.id, q]))
for (const [qid, weights] of Object.entries(TAG_WEIGHTS)) {
  const q = byId.get(qid)
  check(`G ${qid} existe`, !!q, 'question absente de DEFAULT_QUESTIONS')
  if (!q) continue
  const values = valuesOf(q)
  for (const v of Object.keys(weights)) check(`G ${qid}.${v}`, values.includes(v), `valeur hors liste (${values.join(', ')})`)
}

// H. le jeu réaliste du gate du 03/10
const today = new Date('2026-10-03T09:00:00Z')
const iso = d => new Date(+today + d * 86_400_000).toISOString().slice(0, 10)
eq('H1 échéance J+2', echeancePoints(iso(2), today), 6)
eq('H1 échéance J+7', echeancePoints(iso(7), today), 4)
eq('H1 échéance J+20', echeancePoints(iso(20), today), 2)
eq('H1 échéance J+60', echeancePoints(iso(60), today), 0)
eq('H1 échéance passée J-10', echeancePoints(iso(-10), today), 6)
eq('H1 échéance passée J-40', echeancePoints(iso(-40), today), 0)
eq('H1 sans échéance', echeancePoints(null, today), 0)
const mails = {
  newsletter: score(row("Tom's Hardware: the best GPUs this week", { from_address: 'news@tomshardware.invalid' }),
    [{ question: 'automatique', valeur: 'oui' }, { question: 'urgence', valeur: 'aucune' }], none, new Set(['news@tomshardware.invalid'])),
  notification: score(row('Xebec sent you a message'), [{ question: 'automatique', valeur: 'oui' }, { question: 'urgence', valeur: 'sous_48h' }]),
  otp: score(row('Sign in to Cursor'), [{ question: 'automatique', valeur: 'oui' }, { question: 'urgence', valeur: 'aujourdhui' }]),
  spam: score(row('URGENT: verify your account now'), [
    { question: 'spam_hameconnage', valeur: 'oui' }, { question: 'urgence', valeur: 'aujourdhui' },
    { question: 'fraude_paiement', valeur: 'oui' }, { question: 'menace_juridique', valeur: 'oui' }]),
  relance: score(row('Re: Yumi HZ documents for June bookkeeping -REMINDER', { has_attachments: true }),
    [{ question: 'reponse_requise', valeur: 'oui' }, { question: 'urgence', valeur: 'sous_48h' }]),
  facture: score(row('Facture F-2026-118', { has_attachments: true, echeance: NEGATIVE ? null : iso(2) }),
    [{ question: 'reponse_requise', valeur: 'oui' }]),
}
const order = Object.entries(mails).sort((a, b) => b[1].score - a[1].score).map(([k]) => k)
const treated = Object.entries(mails).filter(([, s]) => s.score >= FOCUS_THRESHOLD).map(([k]) => k).sort()
eq('H2 à traiter = relance + facture seulement', treated, ['facture', 'relance'])
check('H3 relance et facture devant tout le reste', order.slice(0, 2).sort().join(',') === 'facture,relance', `ordre=${order.join(' > ')}`)
check('H4 infolettre et notification sous le seuil', mails.newsletter.score < FOCUS_THRESHOLD && mails.notification.score < FOCUS_THRESHOLD, `infolettre=${mails.newsletter.score} notification=${mails.notification.score}`)
check('H5 infolettre fréquente : part « fréquent » absente', !mails.newsletter.parts.some(p => p.kind === 'reason' && p.reason === 'frequent'), JSON.stringify(mails.newsletter.parts))
check('H6 code de connexion sous le seuil', mails.otp.score < FOCUS_THRESHOLD, `otp=${mails.otp.score}`)
check('H7 spam exclu : dernier et plafonné', order[order.length - 1] === 'spam' && mails.spam.score === SPAM_CEILING, `spam=${mails.spam.score} ordre=${order.join(' > ')}`)
check('H8 facture : part « échéance extraite » +6 dans l\'infobulle', mails.facture.parts.some(p => p.kind === 'reason' && p.reason === 'echeance' && p.points === 6), JSON.stringify(mails.facture.parts))
eq('H8 pastille de la facture = échéance', mails.facture.reason, 'echeance')
console.log(`ordre réaliste : ${Object.entries(mails).sort((a, b) => b[1].score - a[1].score).map(([k, s]) => `${k}=${s.score}`).join(' > ')}`)

for (const f of failures) console.log(`FAIL ${f}`)
console.log(`check-focus-priority${NEGATIVE ? ' --negative' : ''}: ${ok} ok, ${failures.length} FAIL`)
process.exit(failures.length ? 1 : 0)
