import { query } from './db'
import type { DbEmailAccount } from './accounts'
import { accountOrderBy } from './accountColor'

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

/**
 * Les boîtes qu'un utilisateur VOIT, comme UNE règle : les siennes plus celles reçues
 * en partage actif et non expiré — la même condition que `getAccessibleAccount`, en un
 * seul passage au lieu d'un par boîte. Écrite comme un sous-`SELECT` d'identifiants
 * pour que les écrans qui en ont besoin la réutilisent telle quelle, chacun projetant
 * les colonnes qui lui servent (la recherche a besoin des identifiants de connexion,
 * le tableau de bord seulement du nom et de la couleur) sans réécrire la règle.
 * `$1` est l'utilisateur.
 */
export const ACCESSIBLE_ACCOUNT_IDS = `(
    SELECT a.id FROM email_accounts a WHERE a.user_id = $1
    UNION
    SELECT sh.account_id FROM account_shares sh
     WHERE sh.invitee_user_id = $1 AND sh.status = 'active'
       AND (sh.expires_at IS NULL OR sh.expires_at > NOW())
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

/** Une boîte, telle que son RANG la lit : de quoi la nommer, la peindre et savoir à qui elle est. */
export interface RankedAccount {
  id: string
  name: string
  email: string
  badge_color: string | null
  /** Son PROPRIÉTAIRE, pour qu'un écran puisse distinguer les siennes des reçues sans seconde requête. */
  owner_id: string
}

/**
 * Les boîtes visibles, dans l'ORDRE qui décide de leur couleur automatique.
 *
 * C'est l'ENSEMBLE, pas seulement l'ordre, qui doit être unique : la couleur
 * automatique est une fonction du RANG, donc deux écrans qui classent deux ENSEMBLES
 * différents peignent forcément la même boîte de deux couleurs. Le tableau de bord
 * listait ici `WHERE user_id = $1` seul : dès qu'un compte a UNE boîte partagée, les
 * rangs glissent et ses pastilles ne sont plus celles de la barre ni des réglages
 * (mesuré au banc navigateur le 20/09/2026). Toute surface qui a besoin du rang d'une
 * boîte lit CETTE liste, jamais sa propre requête.
 */
export async function listAccessibleAccounts(userId: string): Promise<RankedAccount[]> {
  return query<RankedAccount>(
    `SELECT a.id, a.name, a.email, a.badge_color, a.user_id AS owner_id
       FROM email_accounts a
      WHERE a.id IN ${ACCESSIBLE_ACCOUNT_IDS}
      ${ACCESSIBLE_ORDER_BY}`,
    [userId]
  )
}
