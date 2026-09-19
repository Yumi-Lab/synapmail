#!/usr/bin/env node
/**
 * Guard on the deferred toolbar compose (app/(app)/mail/MailClient.tsx).
 *
 * A toolbar Reply / Reply all / Forward aimed at a message that is not loaded yet opens it
 * first and fires when it arrives. The pending slot must therefore remember WHICH message it
 * was aimed at, not only the gesture: between the click and the load, the open message can
 * change (another row clicked, a desktop notification, a thread opened) and the arriving
 * message would be answered in place of the one the person aimed at — silently.
 *
 * Exit 0 when the pending slot is addressed, 1 otherwise. Node built-ins only.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', '(app)', 'mail', 'MailClient.tsx')
const src = readFileSync(SOURCE, 'utf8')

assert.ok(/const pendingCompose = useRef</.test(src), 'the deferred compose slot was not found — this guard is stale')

/** The slot carries a uid alongside the kind. */
const declaration = src.slice(src.indexOf('const pendingCompose = useRef<'))
const declared = declaration.slice(0, declaration.indexOf('\n'))
assert.ok(/uid/.test(declared), `the pending slot must carry its target uid, got: ${declared.trim()}`)

/** And the firing side compares that uid to the message that actually arrived. */
const loaded = src.slice(src.indexOf('const pending = pendingCompose.current'))
const fire = loaded.slice(0, loaded.indexOf('// Show MDN toast'))
assert.ok(/pending\.uid === msg\.uid/.test(fire), 'the arriving message must match the aimed-at uid before composing')

console.log('check-deferred-compose: OK')
