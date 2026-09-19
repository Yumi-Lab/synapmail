#!/usr/bin/env node
// Self-check of lib/folderActions.ts — la règle que la route ET le menu appliquent.
// node --experimental-strip-types scripts/check-folder-actions.mjs
import assert from 'node:assert/strict'
import { folderCapabilities, sanitizeFolderName, joinFolderPath, renamedPath, isDescendant } from '../lib/folderActions.ts'

const owner = { canOrganize: true, canDelete: true }
const caps = (over) => folderCapabilities({ special: null, hasChildren: false, ...owner, ...over })

// Dossier ordinaire, propriétaire : tout sauf « vider » (réservé Corbeille/Indésirables).
assert.deepEqual(caps(), { create: true, createChild: true, rename: true, markRead: true, empty: false, remove: true })

// Dossier spécial : on ne renomme ni ne supprime ce dont le rôle est déclaré au serveur.
for (const special of ['inbox', 'sent', 'drafts', 'spam', 'trash']) {
  const c = caps({ special })
  assert.equal(c.rename, false, `${special} ne doit pas être renommable`)
  assert.equal(c.remove, false, `${special} ne doit pas être supprimable`)
  assert.equal(c.markRead, true, `${special} reste marquable comme lu`)
}

// « Vider » n'existe QUE pour la corbeille et les indésirables.
assert.equal(caps({ special: 'trash' }).empty, true)
assert.equal(caps({ special: 'spam' }).empty, true)
for (const special of [null, 'inbox', 'sent', 'drafts']) assert.equal(caps({ special }).empty, false)

// Un parent ne se supprime pas tant qu'il a des enfants ; le reste est inchangé.
assert.equal(caps({ hasChildren: true }).remove, false)
assert.equal(caps({ hasChildren: true }).rename, true)

// Session en lecture seule (partage sans droits) : plus rien n'est offert.
const readOnly = folderCapabilities({ special: null, hasChildren: false, canOrganize: false, canDelete: false })
assert.deepEqual(Object.values(readOnly), [false, false, false, false, false, false])

// Partage « organiser » sans « supprimer » : on range, on ne détruit pas.
const organizeOnly = folderCapabilities({ special: 'trash', hasChildren: false, canOrganize: true, canDelete: false })
assert.equal(organizeOnly.create, true)
assert.equal(organizeOnly.empty, false)
assert.equal(organizeOnly.remove, false)

// Noms : le délimiteur du serveur ne passe pas — il créerait une hiérarchie non demandée.
assert.equal(sanitizeFolderName('Factures', '/'), 'Factures')
assert.equal(sanitizeFolderName('  Factures  ', '/'), 'Factures')
assert.equal(sanitizeFolderName('a/b', '/'), null)
assert.equal(sanitizeFolderName('a.b', '.'), null)
assert.equal(sanitizeFolderName('a.b', '/'), 'a.b')      // un point n'est spécial que si c'est LE délimiteur
assert.equal(sanitizeFolderName('a\nb', '/'), null)
assert.equal(sanitizeFolderName('', '/'), null)
assert.equal(sanitizeFolderName('   ', '/'), null)
assert.equal(sanitizeFolderName(null, '/'), null)
assert.equal(sanitizeFolderName('x'.repeat(256), '/'), null)
assert.equal(sanitizeFolderName('x'.repeat(255), '/').length, 255)
assert.equal(sanitizeFolderName('Élodie 王小明 (2026)', '/'), 'Élodie 王小明 (2026)')

// Chemins : créer sous un parent, renommer sur place, reconnaître un descendant.
assert.equal(joinFolderPath('', 'Tests', '/'), 'Tests')
assert.equal(joinFolderPath('Archive', 'Tests', '/'), 'Archive/Tests')
assert.equal(joinFolderPath('INBOX', 'Tests', '.'), 'INBOX.Tests')
assert.equal(renamedPath('Archive/Old', 'Neuf', '/'), 'Archive/Neuf')
assert.equal(renamedPath('Old', 'Neuf', '/'), 'Neuf')
assert.equal(renamedPath('INBOX.Old', 'Neuf', '.'), 'INBOX.Neuf')
assert.equal(isDescendant('Archive/Old', 'Archive', '/'), true)
assert.equal(isDescendant('Archive', 'Archive', '/'), false)
assert.equal(isDescendant('ArchiveBis', 'Archive', '/'), false)  // le préfixe seul ne suffit pas

console.log('check-folder-actions: OK')
