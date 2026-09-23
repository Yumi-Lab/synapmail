#!/usr/bin/env node
/**
 * Auto-contrôle du plafond d'envoi (lot M10), sans base, sans boîte, sans
 * réseau : `lib/smtpSize.ts` traduit SEUL le nombre annoncé par le serveur en
 * un plafond, il s'exécute donc seul.
 *
 * Les questions posées ici viennent toutes de la mesure d'origine — IONOS
 * annonce `250 SIZE 141557760` (135 Mo) là où M9 plafonnait à 17 Mio :
 *  1. le plafond DÉDUIT tient-il une fois la pièce ré-encodée en base64, ou
 *     produit-on un message accepté par nous et refusé par le serveur APRÈS
 *     l'avoir tout entier transmis ?
 *  2. une annonce absente, nulle, négative ou absurde retombe-t-elle sur le
 *     plafond prudent de M9, au lieu d'un plafond calculé sur du vide ?
 *  3. l'avertissement destinataire AVERTIT-il sans bloquer, et son seuil
 *     vit-il à UN seul endroit ?
 *  4. la route et la sonde sont-elles CÂBLÉES sur ce module, ou reste-t-il un
 *     chiffre en dur quelque part ?
 *
 *   node --experimental-strip-types scripts/check-smtp-size.mjs
 *   node --experimental-strip-types scripts/check-smtp-size.mjs --break=wire
 *   node --experimental-strip-types scripts/check-smtp-size.mjs --break=fallback
 *   node --experimental-strip-types scripts/check-smtp-size.mjs --break=warning
 *   node --experimental-strip-types scripts/check-smtp-size.mjs --break=wiring
 *   node --experimental-strip-types scripts/check-smtp-size.mjs --break=refusal
 *   node --experimental-strip-types scripts/check-smtp-size.mjs --break=reread
 * Les formes `--break` abîment UNE attente et EXIGENT que le passage échoue :
 * un banc incapable d'échouer ne prouve rien.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ATTACHMENT_ERROR,
  MESSAGE_MAX_TOTAL_BYTES,
  checkTotalSize,
  parseAttachments,
} from '../lib/attachments.ts'
import {
  ANNOUNCED_SIZE_MAX_BYTES,
  SEND_WARNING,
  ANNOUNCED_SIZE_MIN_BYTES,
  CEILING_SOURCE,
  MESSAGE_ENVELOPE_RESERVE_BYTES,
  SEND_WARNING_BYTES,
  SEND_REFUSED_BY_SERVER,
  exceedsRecipientWarning,
  isSizeRefusal,
  parseAnnouncedSize,
  sizeRefusalReason,
  resolveSendCeiling,
  wireBytes,
} from '../lib/smtpSize.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BREAK = (process.argv.find(a => a.startsWith('--break=')) ?? '').slice('--break='.length)
const ok = msg => console.log(`  ok  ${msg}`)

/** La mesure d'origine, citée telle quelle. */
const IONOS_ANNOUNCED = 141557760

// 1. Le plafond déduit TIENT sur le fil.
{
  const ceiling = resolveSendCeiling(IONOS_ANNOUNCED, MESSAGE_MAX_TOTAL_BYTES)
  assert.equal(ceiling.source, CEILING_SOURCE.server)
  assert.equal(ceiling.announced, IONOS_ANNOUNCED)
  assert.ok(
    ceiling.limit > MESSAGE_MAX_TOTAL_BYTES,
    `135 Mo annoncés doivent lever le plafond de M9 (${MESSAGE_MAX_TOTAL_BYTES}), obtenu ${ceiling.limit}`,
  )
  const onWire = wireBytes(ceiling.limit) + MESSAGE_ENVELOPE_RESERVE_BYTES
  const budget = BREAK === 'wire' ? onWire - 1 : IONOS_ANNOUNCED
  assert.ok(
    onWire <= budget,
    `le plafond déduit pèse ${onWire} sur le fil pour ${budget} annoncés : le serveur refuserait`,
  )
  ok(`${IONOS_ANNOUNCED} annoncés → ${ceiling.limit} octets décodés, ${onWire} sur le fil`)

  // Un octet de plus DÉPASSE : le plafond est bien la borne, pas une marge molle.
  assert.ok(
    wireBytes(ceiling.limit + BASE64_STEP()) + MESSAGE_ENVELOPE_RESERVE_BYTES > IONOS_ANNOUNCED,
    'le plafond doit être la plus grande valeur qui tienne, pas une valeur timide',
  )
  ok('le plafond est serré : un groupe base64 de plus dépasse l’annonce')
}
function BASE64_STEP() {
  // Le plafond est un multiple de 3 (un groupe base64) : il faut donc ajouter
  // un groupe entier pour observer le dépassement.
  return 3
}

// wireBytes suit la RFC 2045, pas une approximation.
{
  assert.equal(wireBytes(0), 0)
  assert.equal(wireBytes(3), 4 + 2, 'un groupe = 4 caractères + CRLF')
  assert.equal(wireBytes(57), 76 + 2, '57 octets = une ligne pleine de 76 caractères')
  assert.equal(wireBytes(60), 80 + 2 * 2, '60 octets = 80 caractères, donc deux lignes')
  ok('wireBytes respecte le découpage en lignes de 76 caractères')
}

// 2. Rien d'annoncé → plafond prudent de M9, jamais un plafond calculé sur du vide.
{
  const nothing = [undefined, null, 0, -1, NaN, Infinity, '', 'beaucoup', {}, [], true]
  for (const value of nothing) {
    assert.equal(parseAnnouncedSize(value), null, `${String(value)} n'annonce rien d'exploitable`)
    const ceiling = resolveSendCeiling(value, MESSAGE_MAX_TOTAL_BYTES)
    const expected = BREAK === 'fallback' ? MESSAGE_MAX_TOTAL_BYTES + 1 : MESSAGE_MAX_TOTAL_BYTES
    assert.equal(ceiling.limit, expected, `${String(value)} doit retomber sur le plafond prudent`)
    assert.equal(ceiling.source, CEILING_SOURCE.fallback)
    assert.equal(ceiling.announced, null)
  }
  ok(`${nothing.length} annonces inexploitables retombent sur ${MESSAGE_MAX_TOTAL_BYTES} (M9), source « fallback »`)

  // Les bornes elles-mêmes.
  assert.equal(parseAnnouncedSize(ANNOUNCED_SIZE_MIN_BYTES - 1), null)
  assert.equal(parseAnnouncedSize(ANNOUNCED_SIZE_MIN_BYTES), ANNOUNCED_SIZE_MIN_BYTES)
  assert.equal(parseAnnouncedSize(ANNOUNCED_SIZE_MAX_BYTES), ANNOUNCED_SIZE_MAX_BYTES)
  assert.equal(parseAnnouncedSize(ANNOUNCED_SIZE_MAX_BYTES + 1), null)
  // `250 SIZE 141557760` lu comme chaîne, comme il arrive du réseau.
  assert.equal(parseAnnouncedSize(String(IONOS_ANNOUNCED)), IONOS_ANNOUNCED)
  ok('les bornes de crédibilité et la lecture d’une chaîne sont tenues')

  // Une annonce si basse que la réserve d'en-têtes la mange entièrement ne
  // produit JAMAIS un plafond négatif.
  const tiny = resolveSendCeiling(ANNOUNCED_SIZE_MIN_BYTES, MESSAGE_MAX_TOTAL_BYTES)
  assert.ok(tiny.limit >= 0, 'un plafond ne peut pas être négatif')
  ok('une annonce minuscule donne un plafond plancher, jamais négatif')
}

// 3bis. Le plafond du serveur est celui que l'ENVOI applique vraiment, pièce
// par pièce comme au total : une annonce de 135 Mo doit faire PASSER une pièce
// que le plafond de M9 refusait.
{
  const ceiling = resolveSendCeiling(IONOS_ANNOUNCED, MESSAGE_MAX_TOTAL_BYTES).limit
  const between = MESSAGE_MAX_TOTAL_BYTES + 1024 * 1024
  assert.ok(between < ceiling, 'la mesure exigée suppose un intervalle entre l’ancien plafond et le nouveau')

  const b64 = n => {
    const groups = Math.ceil(n / 3)
    return 'A'.repeat(groups * 4)
  }
  const wasRefused = parseAttachments([{ filename: 'entre.bin', content: b64(between) }], MESSAGE_MAX_TOTAL_BYTES)
  assert.equal(wasRefused.ok, false, 'cette pièce DEVAIT être refusée avant M10')
  assert.equal(wasRefused.code, ATTACHMENT_ERROR.tooLarge)

  const nowPasses = parseAttachments([{ filename: 'entre.bin', content: b64(between) }], ceiling)
  assert.equal(nowPasses.ok, BREAK === 'fallback' ? false : true, 'la même pièce doit PASSER sous le plafond annoncé')
  ok(`une pièce de ${between} octets, refusée sous ${MESSAGE_MAX_TOTAL_BYTES} (M9), passe sous ${ceiling} (annoncé)`)

  // Au-delà du plafond annoncé, le refus cite CE chiffre — pas celui de M9.
  const over = parseAttachments([{ filename: 'trop.bin', content: b64(ceiling + 3) }], ceiling)
  assert.equal(over.ok, false)
  assert.equal(over.limit, ceiling, 'le refus doit citer le plafond du SERVEUR')
  assert.equal(checkTotalSize([{ filename: 'x', contentType: 'application/octet-stream', content: Buffer.alloc(1) }], 0).limit, 0)
  ok('au-delà du plafond annoncé, le refus cite ce chiffre-là')
}

// 3. L'avertissement destinataire avertit, il ne bloque pas.
{
  assert.equal(exceedsRecipientWarning(SEND_WARNING_BYTES), false, 'le seuil lui-même n’avertit pas')
  assert.equal(exceedsRecipientWarning(SEND_WARNING_BYTES + 1), true)
  assert.equal(exceedsRecipientWarning(0), false)
  // Il doit rester SOUS le plafond IONOS, sinon il n'avertirait jamais.
  assert.ok(
    SEND_WARNING_BYTES < resolveSendCeiling(IONOS_ANNOUNCED, MESSAGE_MAX_TOTAL_BYTES).limit,
    'un seuil d’avertissement au-dessus du plafond ne se déclencherait jamais',
  )
  ok(`avertissement à ${SEND_WARNING_BYTES} octets, sous le plafond serveur : il se déclenche vraiment`)
}

// 4. Câblage : le nombre vit à UN endroit, lu par la sonde et par l'envoi.
{
  const read = p => readFileSync(join(ROOT, p), 'utf8')
  const route = read('app/api/messages/send/route.ts')
  const attachments = read('lib/attachments.ts')
  const probe = read('lib/accountProbe.ts')
  const source = BREAK === 'wiring' ? route.replace(/resolveSendCeiling/g, 'autreChose') : route

  assert.ok(source.includes('resolveSendCeiling'), 'la route doit déduire son plafond du serveur')
  // L'avertissement part avec un envoi RÉUSSI, pas avec un refus.
  const warned = BREAK === 'warning' ? route.replace(/exceedsRecipientWarning/g, 'autreChose') : route
  assert.ok(warned.includes('exceedsRecipientWarning'), 'la route doit AVERTIR au-delà du seuil')
  assert.ok(
    /success: true, \.\.\.warning/.test(warned),
    'l’avertissement voyage avec la réussite : il ne bloque pas',
  )
  assert.ok(warned.includes('SEND_WARNING.recipientMayRefuse'), 'la route lit le code d’avertissement du module')
  assert.ok(
    !warned.includes(`'${SEND_WARNING.recipientMayRefuse}'`),
    'la route ne recopie pas la valeur du code d’avertissement',
  )
  // Le refus DIT d'où sort son plafond, sinon « 17 Mio » se lit comme une
  // limite du serveur alors que c'est notre repli.
  assert.ok(source.includes('limitSource'), 'un refus de taille doit dire d’où vient son plafond')
  assert.ok(
    /maxAllowedSize|smtp_max_size|announcedSize/.test(probe),
    'la sonde doit lire la taille annoncée par le serveur',
  )
  // Le seuil d'avertissement et la réserve d'en-têtes ne se recopient nulle part.
  for (const [name, value] of [
    ['SEND_WARNING_BYTES', SEND_WARNING_BYTES],
    ['MESSAGE_ENVELOPE_RESERVE_BYTES', MESSAGE_ENVELOPE_RESERVE_BYTES],
  ]) {
    assert.ok(!source.includes(String(value)), `la route ne recopie pas ${name} (${value})`)
    assert.ok(!attachments.includes(String(value)), `lib/attachments.ts ne recopie pas ${name}`)
  }
  ok('le plafond et le seuil ne sont écrits qu’une fois, dans lib/smtpSize.ts')
}

// 5. Un refus de TAILLE, et lui seul, relit l'annonce (complément de Nicolas du
// 23/09/2026). La distinction est tout l'intérêt : un mot de passe faux ne doit
// RIEN réécrire sur la boîte.
{
  // Les trois formes réelles d'un refus de taille : le code de l'extension SIZE
  // (RFC 1870), celui de la RFC 5321, et le refus que nodemailer prononce seul
  // avant d'écrire sur le fil (aucun code, seulement sa phrase).
  const refusals = [
    { responseCode: 523, response: '523 5.3.4 Message too big for system' },
    { responseCode: 552, response: '552 5.3.4 Message size exceeds fixed maximum' },
    { message: 'Message size larger than allowed 141557760' },
  ]
  for (const err of refusals) {
    assert.equal(isSizeRefusal(err), BREAK === 'refusal' ? false : true, `${JSON.stringify(err)} est un refus de taille`)
  }
  // Tout le reste ne l'est PAS : ni une authentification refusée, ni un serveur
  // injoignable, ni une valeur qui n'est pas un objet.
  const others = [
    { responseCode: 535, response: '535 Authentication credentials invalid' },
    { responseCode: 550, response: '550 5.1.1 Recipient unknown' },
    { message: 'connect ETIMEDOUT 1.2.3.4:465' },
    { message: 'self signed certificate in certificate chain' },
    null, undefined, 'trop gros', 552, {},
  ]
  for (const err of others) {
    assert.equal(isSizeRefusal(err), false, `${JSON.stringify(err) ?? String(err)} n'est PAS un refus de taille`)
  }
  ok(`${refusals.length} refus de taille reconnus, ${others.length} autres échecs laissés tranquilles`)

  // La raison REMONTÉE est celle du serveur, pas une phrase de notre cru.
  assert.equal(sizeRefusalReason(refusals[0]), '523 5.3.4 Message too big for system')
  assert.equal(sizeRefusalReason(refusals[2]), 'Message size larger than allowed 141557760')
  assert.equal(sizeRefusalReason({}), '')
  assert.equal(sizeRefusalReason(null), '')
  ok('la raison remontée est la phrase du serveur, jamais une reformulation')
}

// 6. Câblage du complément : la route relit et ENREGISTRE, et seulement sur un
// refus de taille.
{
  const route = readFileSync(join(ROOT, 'app/api/messages/send/route.ts'), 'utf8')
  const probe = readFileSync(join(ROOT, 'lib/accountProbe.ts'), 'utf8')
  const wired = BREAK === 'reread' ? route.replace(/relearnAnnouncedSize/g, 'autreChose') : route

  assert.ok(wired.includes('relearnAnnouncedSize'), 'la route doit RELIRE l’annonce après un refus de taille')
  assert.ok(
    /if \(!isSizeRefusal\(err\)\) throw err/.test(route),
    'tout échec qui n’est PAS un refus de taille doit repartir intact',
  )
  // La relecture et son enregistrement vivent dans la sonde, à UN endroit,
  // partagés avec l'essai de connexion : la route ne les réécrit pas.
  assert.ok(probe.includes('saveAnnouncedSize'), 'la sonde doit ENREGISTRER ce qu’elle vient de relire')
  assert.ok(
    /if \(size !== null\) await saveAnnouncedSize/.test(probe),
    'une relecture infructueuse ne doit pas EFFACER le plafond connu',
  )
  assert.ok(route.includes('SEND_REFUSED_BY_SERVER'), 'le refus du serveur a son propre code')
  assert.ok(
    !route.includes(`'${SEND_REFUSED_BY_SERVER}'`),
    'la route ne recopie pas la valeur du code de refus',
  )
  assert.ok(route.includes('sizeRefusalReason(err)'), 'le refus remonte la raison du serveur')
  ok('la route relit l’annonce, l’enregistre, et ne touche à rien sur un autre échec')
}

if (BREAK) {
  console.error(`check-smtp-size: --break=${BREAK} devait ÉCHOUER et n'a pas échoué`)
  process.exit(1)
}
console.log('check-smtp-size: OK')
