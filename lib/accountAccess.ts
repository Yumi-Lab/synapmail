import { query } from './db'
import type { DbEmailAccount } from './accounts'

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
            s.can_send, s.can_delete, s.can_organize, s.can_manage_rules, s.can_manage_signatures
     FROM email_accounts a
     LEFT JOIN account_shares s
       ON s.account_id = a.id
      AND s.invitee_user_id = $2
      AND s.status = 'active'
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
     WHERE a.id = $1
       AND (a.user_id = $2 OR s.id IS NOT NULL)
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
