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
 * Toutes les boîtes que cette personne peut RÉELLEMENT lire : les siennes, plus
 * celles reçues en partage actif et non expiré. Même règle que
 * `getAccessibleAccount(id, user, [])`, posée pour l'ENSEMBLE en une requête au
 * lieu d'une par boîte — ce dont ont besoin la recherche « Toutes les boîtes » et
 * l'historique des désabonnements, qui n'ont aucun identifiant à vérifier.
 *
 * Aucun identifiant venu du client n'entre ici : la liste vient de la base.
 */
export async function listAccessibleAccounts(userId: string): Promise<DbEmailAccount[]> {
  return query<DbEmailAccount>(
    `SELECT a.* FROM email_accounts a WHERE a.user_id = $1
     UNION
     SELECT a.* FROM email_accounts a
       JOIN account_shares sh ON sh.account_id = a.id
      WHERE sh.invitee_user_id = $1 AND ${ACTIVE_SHARE_SQL}
     ${accountOrderBy({ isDefault: 'is_default', createdAt: 'created_at', id: 'id' })}`,
    [userId]
  )
}
