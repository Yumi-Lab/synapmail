#!/usr/bin/env node
// Self-check of lib/specialFolders.ts — run with: node --experimental-strip-types scripts/check-special-folders.mjs
import assert from 'node:assert/strict'
import { detectSpecials } from '../lib/specialFolders.ts'

const f = (path, specialUse) => ({ path, name: path.split('/').pop(), delimiter: '/', specialUse })
const pick = (folders, type) => [...detectSpecials(folders)].filter(([, t]) => t === type).map(([p]) => p)

// A server that declares its special folders (IONOS): sub-folders keep their own identity.
const ionos = [f('INBOX', '\\Inbox'), f('Objets envoyés', '\\Sent'), f('Brouillons', '\\Drafts'), f('Spam', '\\Junk'),
  f('Corbeille', '\\Trash'), f('Archive', '\\Archive'), f('Spam/AMELI'), f('Spam/Crypto'), f('Corbeille/CONVENTIONS'),
  f('Corbeille/CONVENTIONS/Manga'), f('Newsletters/SpamBrevo'), f('Administratif/Spam')]
assert.deepEqual(pick(ionos, 'spam'), ['Spam'])
assert.deepEqual(pick(ionos, 'trash'), ['Corbeille'])
assert.deepEqual(pick(ionos, 'inbox'), ['INBOX'])

// A server that declares nothing: top-level names are still recognised, sub-folders are not.
const bare = [f('INBOX'), f('Sent'), f('Drafts'), f('Junk'), f('Trash'), f('Trash/Old'), f('Projects/Sent'), f('Sentiments')]
assert.deepEqual(pick(bare, 'sent'), ['Sent'])
assert.deepEqual(pick(bare, 'trash'), ['Trash'])
assert.deepEqual(pick(bare, 'spam'), ['Junk'])

// An `INBOX.`-namespaced server keeps its system folders directly under INBOX.
const courier = ['INBOX', 'INBOX.Sent', 'INBOX.Trash', 'INBOX.Trash.2019'].map(path => ({ path, name: path.split('.').pop(), delimiter: '.' }))
assert.deepEqual(pick(courier, 'sent'), ['INBOX.Sent'])
assert.deepEqual(pick(courier, 'trash'), ['INBOX.Trash'])

console.log('check-special-folders: OK')
