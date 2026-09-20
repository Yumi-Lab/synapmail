import { query } from './db'
import { accountOrderBy } from './accountColor'
import type { DbEmailAccount } from './accounts'

/**
 * « Ce partage n'a pas expiré » — source unique de la clause de date.
 *
 * Elle vaut pour un partage ACTIF (accès à une boîte) comme pour une invitation
 * EN ATTENTE (lien d'acceptation) : deux états différents, une seule notion de
 * péremption. L'alias est fixe (`sh`) pour que ce soit une CONSTANTE et non un
 * gabarit à interpoler ; les appelants nomment l'alias `sh`.
 */
export const SHARE_NOT_EXPIRED_SQL = '(sh.expires_at IS NULL OR sh.expires_at > NOW())'

/**
 * « Ce partage donne accès MAINTENANT » — source unique de la règle d'accès.
 *
 * Elle s'écrivait en QUATRE exemplaires (ici, la liste des comptes, la recherche
 * « Toutes les boîtes », `lib/subscriptions.ts`) : quatre endroits à corriger le
 * jour où un partage gagne un état ou une date, et celui qu'on oublie ouvre une
 * boîte qu'on croyait fermée. `scripts/check-share-rule.mjs` refuse toute copie.
 *
 * Une invitation en ATTENTE n'est PAS un accès : elle ne passe pas par ici (voir
 * `app/api/invites/[token]/route.ts`, qui teste son propre état et réutilise la
 * seule clause de date).
 */
export const ACTIVE_SHARE_SQL = `sh.status = 'active' AND ${SHARE_NOT_EXPIRED_SQL}`

export type AccountPermission = 'send' | 'delete' | 'organize' | 'manageRules' | 'manageSignatures'

export interface AccountPermissions {
  send: boolean
  delete: boolean
  organize: boolean
  manageRules: boolean
  manageSignatures: boolean
}

export interface AccessibleAccount extends DbEmailAccount {
  isOwner: boolean
  permissions: AccountPermissions
}

type Row = DbEmailAccount & {
  is_owner: boolean
  can_send: boolean | null
  can_delete: boolean | null
  can_organize: boolean | null
  can_manage_rules: boolean | null
  can_manage_signatures: boolean | null
}

/**
 * Propriétaire OU partage actif non expiré. `required` liste les permissions
 * nécessaires ; si l'une manque, retourne null — même forme qu'un échec de
 * vérification de propriété classique, pour ne jamais révéler l'existence du compte.
 */
export async function getAccessibleAccount(
  accountId: string,
  userId: string,
  required: AccountPermission[] = []
): Promise<AccessibleAccount | null> {
  const rows = await query<Row>(
    `SELECT a.*,
            (a.user_id = $2) AS is_owner,
            sh.can_send, sh.can_delete, sh.can_organize, sh.can_manage_rules, sh.can_manage_signatures
     FROM email_accounts a
     LEFT JOIN account_shares sh
       ON sh.account_id = a.id
      AND sh.invitee_user_id = $2
      AND ${ACTIVE_SHARE_SQL}
     WHERE a.id = $1
       AND (a.user_id = $2 OR sh.id IS NOT NULL)
     LIMIT 1`,
    [accountId, userId]
  )
  if (!rows.length) return null
  const r = rows[0]
  const permissions: AccountPermissions = r.is_owner
    ? { send: true, delete: true, organize: true, manageRules: true, manageSignatures: true }
    : {
        send: !!r.can_send,
        delete: !!r.can_delete,
        organize: !!r.can_organize,
        manageRules: !!r.can_manage_rules,
        manageSignatures: !!r.can_manage_signatures,
      }
  if (!required.every((p) => permissions[p])) return null
  return { ...r, isOwner: r.is_owner, permissions }
}

/**
 * Les boîtes qu'un utilisateur VOIT, comme UNE règle : les siennes plus celles reçues
 * en partage actif et non expiré — la même condition que `getAccessibleAccount`, posée
 * pour l'ENSEMBLE en une requête au lieu d'une par boîte. Écrite comme un sous-`SELECT`
 * d'identifiants pour que chaque écran projette les colonnes qui lui servent (la
 * recherche a besoin des identifiants de connexion, le tableau de bord du nom et de la
 * couleur) sans réécrire la règle. `$1` est l'utilisateur.
 */
export const ACCESSIBLE_ACCOUNT_IDS = `(
    SELECT a.id FROM email_accounts a WHERE a.user_id = $1
    UNION
    SELECT sh.account_id FROM account_shares sh
     WHERE sh.invitee_user_id = $1 AND ${ACTIVE_SHARE_SQL}
  )`

/**
 * L'ordre TOTAL de ces boîtes, identique à celui que sert `/api/accounts` : une boîte
 * REÇUE n'est jamais la boîte par défaut, même si son propriétaire l'a marquée telle —
 * c'est pourquoi le premier terme teste la propriété en plus du drapeau. Il va avec
 * `ACCESSIBLE_ACCOUNT_IDS` : les deux se lisent ensemble ou pas du tout.
 */
export const ACCESSIBLE_ORDER_BY = accountOrderBy({
  isDefault: '(a.user_id = $1 AND a.is_default)',
  createdAt: 'a.created_at',
  id: 'a.id',
})

/**
 * Le même ordre, exprimé sur les noms de SORTIE camelCase : un `UNION` ne peut être
 * classé que par les colonnes qu'il produit, et c'est la forme dont `/api/accounts` a
 * besoin — la liste que lisent la barre latérale et les réglages. Les deux clauses
 * disent la MÊME chose : une boîte reçue n'est jamais la boîte par défaut (la branche
 * partagée publie déjà `false AS "isDefault"`), puis la plus ancienne, puis l'identifiant.
 */
export const ACCESSIBLE_ORDER_BY_ALIASED = accountOrderBy({
  isDefault: '"isDefault"',
  createdAt: '"createdAt"',
  id: 'id',
})

/**
 * Toutes les boîtes que cette personne peut RÉELLEMENT lire : les siennes, plus celles
 * reçues en partage actif et non expiré — ce dont ont besoin la recherche « Toutes les
 * boîtes » et l'historique des désabonnements, qui n'ont aucun identifiant à vérifier.
 *
 * Son ORDRE fait partie du contrat : le RANG d'une boîte dans cette liste décide de sa
 * couleur automatique. C'est l'ENSEMBLE, pas seulement l'ordre, qui doit être unique —
 * deux écrans qui classent deux ensembles différents peignent forcément la même boîte
 * de deux couleurs. Le tableau de bord listait `WHERE user_id = $1` seul : dès qu'un
 * compte a UNE boîte partagée, les rangs glissaient et ses pastilles n'étaient plus
 * celles de la barre ni des réglages (mesuré au banc navigateur le 20/09/2026). Toute
 * surface qui a besoin du rang lit CETTE liste — son index EST le rang, sans second
 * parcours — jamais sa propre requête.
 *
 * Aucun identifiant venu du client n'entre ici : la liste vient de la base.
 */
export async function listAccessibleAccounts(userId: string): Promise<DbEmailAccount[]> {
  return query<DbEmailAccount>(
    `SELECT a.* FROM email_accounts a
      WHERE a.id IN ${ACCESSIBLE_ACCOUNT_IDS}
      ${ACCESSIBLE_ORDER_BY}`,
    [userId]
  )
}
