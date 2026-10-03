/**
 * L'arbre des dossiers virtuels côté écran — fonctions PURES sur la liste À PLAT que
 * `GET /api/documents/folders` rend (`parentId` dit la place). Importable par un composant
 * client ; aucun accès réseau ni base. Auto-contrôle : `scripts/check-ged-tree.mjs`.
 */
import type { GedFolder } from './documents'

export interface TreeRow { folder: GedFolder; depth: number }

/** Les dossiers dans l'ordre d'affichage (parents puis enfants, profondeur connue) — un orphelin remonte à la racine. */
export function flattenTree(folders: readonly GedFolder[]): TreeRow[] {
  const ids = new Set(folders.map(f => f.id))
  const children = new Map<string | null, GedFolder[]>()
  for (const f of folders) {
    const parent = f.parentId && ids.has(f.parentId) ? f.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), f])
  }
  const out: TreeRow[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const f of children.get(parent) ?? []) { out.push({ folder: f, depth }); walk(f.id, depth + 1) }
  }
  walk(null, 0)
  return out
}

/** `true` si `candidate` est `id` lui-même ou un de ses descendants : on ne déplace ni ne fusionne un dossier dans sa propre branche. */
export function isWithin(folders: readonly GedFolder[], id: string, candidate: string): boolean {
  return ancestry(folders, candidate).some(f => f.id === id)
}

/** Un dossier puis ses parents jusqu'à la racine — bornée par la taille de la liste, pour qu'un cycle (données corrompues) ne bloque jamais l'écran. */
function ancestry(folders: readonly GedFolder[], id: string | null): GedFolder[] {
  const byId = new Map(folders.map(f => [f.id, f]))
  const out: GedFolder[] = []
  for (let cur = id ? byId.get(id) : undefined; cur && out.length < folders.length; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.push(cur)
  return out
}

/** Le chemin lisible d'un dossier (« Fournisseurs › FedEx »), pour une puce ou une infobulle. */
export function folderPath(folders: readonly GedFolder[], id: string | null, sep = ' › '): string {
  return ancestry(folders, id).reverse().map(f => f.nom).join(sep)
}

/** Documents d'un dossier ET de sa branche — le compteur qu'une ligne repliée porte. */
export function branchCount(folders: readonly GedFolder[], id: string): number {
  return flattenTree(folders).filter(r => r.folder.id === id || isWithin(folders, id, r.folder.id)).reduce((s, r) => s + r.folder.documents, 0)
}
