import { Pool } from 'pg'
import { LEGACY_SCOPES } from '@/lib/apiScopes'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

export async function query<T = Record<string, unknown>>(
  sql: string,
  values?: unknown[]
): Promise<T[]> {
  const { rows } = await pool.query(sql, values)
  return rows as T[]
}

export async function initDb(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      avatar_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS email_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      imap_host VARCHAR(255) NOT NULL,
      imap_port INTEGER NOT NULL DEFAULT 993,
      imap_secure BOOLEAN NOT NULL DEFAULT true,
      smtp_host VARCHAR(255) NOT NULL,
      smtp_port INTEGER NOT NULL DEFAULT 587,
      smtp_secure BOOLEAN NOT NULL DEFAULT false,
      username VARCHAR(255) NOT NULL,
      password_encrypted TEXT NOT NULL,
      oauth_provider VARCHAR(50),
      oauth_access_token TEXT,
      oauth_refresh_token TEXT,
      oauth_expires_at BIGINT,
      is_default BOOLEAN NOT NULL DEFAULT false,
      color VARCHAR(20) NOT NULL DEFAULT '#6366f1',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS signatures (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      content_html TEXT NOT NULL DEFAULT '',
      is_default BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS messages_cache (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      folder VARCHAR(255) NOT NULL,
      uid VARCHAR(255) NOT NULL,
      message_id VARCHAR(512),
      from_address VARCHAR(255),
      from_name VARCHAR(255),
      subject TEXT,
      date TIMESTAMPTZ,
      is_read BOOLEAN DEFAULT false,
      is_starred BOOLEAN DEFAULT false,
      is_flagged BOOLEAN DEFAULT false,
      has_attachments BOOLEAN DEFAULT false,
      preview TEXT,
      thread_id VARCHAR(512),
      cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(account_id, folder, uid)
    )
  `)

  // Partial index for the per-account / per-folder unread aggregates
  // (GET /api/accounts unread badges + GET /api/folders unreadCount, polled every 60s)
  await query(`CREATE INDEX IF NOT EXISTS messages_cache_unread_idx ON messages_cache(account_id, folder) WHERE is_read = false`)

  // Authoritative per-folder counts from a server-side IMAP SEARCH UNSEEN
  // (written by lib/imap.ts listMessages on page 1). Unlike counting
  // messages_cache rows, this is NOT capped by the fetched page size — a folder
  // with 300 unread reports 300, not 50. Read by GET /api/accounts + /api/folders.
  await query(`
    CREATE TABLE IF NOT EXISTS mailbox_stats (
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      folder VARCHAR(255) NOT NULL,
      unread_count INTEGER NOT NULL DEFAULT 0,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, folder)
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme VARCHAR(20) NOT NULL DEFAULT 'system',
      language VARCHAR(10) NOT NULL DEFAULT 'en',
      messages_per_page INTEGER NOT NULL DEFAULT 30,
      thread_view BOOLEAN NOT NULL DEFAULT true,
      reading_pane BOOLEAN NOT NULL DEFAULT true,
      notifications BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // Migrations — colonnes ajoutées après la création initiale
  await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS undo_send_delay INTEGER NOT NULL DEFAULT 10`)
  await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS start_view VARCHAR(20) NOT NULL DEFAULT 'inbox'`)
  // Préférences UI auparavant en localStorage — persistées ici pour survivre au reload / multi-device
  await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS active_account_id UUID REFERENCES email_accounts(id) ON DELETE SET NULL`)
  await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sidebar_collapsed BOOLEAN NOT NULL DEFAULT false`)
  await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS mail_density VARCHAR(20) NOT NULL DEFAULT 'comfortable'`)
  await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS list_width INTEGER NOT NULL DEFAULT 320`)
  await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dashboard_account_id UUID REFERENCES email_accounts(id) ON DELETE SET NULL`)
  // Bandeau de mise à jour : version dont l'utilisateur a fermé l'annonce (auparavant en sessionStorage)
  await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS update_dismissed_version VARCHAR(50)`)
  // Garde contre l'injection d'instructions, par boîte. Activée par défaut : la sécurité est le défaut.
  await query(`ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS prompt_guard BOOLEAN NOT NULL DEFAULT true`)
  // Couleur de badge choisie par l'utilisateur. NULL = couleur automatique par rang :
  // aucune boîte existante ne change d'apparence à la mise à jour.
  await query(`ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS badge_color VARCHAR(7)`)

  await query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL DEFAULT '',
      email VARCHAR(255) NOT NULL,
      frequency INTEGER NOT NULL DEFAULT 1,
      sent_count INTEGER NOT NULL DEFAULT 0,
      received_count INTEGER NOT NULL DEFAULT 0,
      last_contact_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_starred BOOLEAN NOT NULL DEFAULT false,
      is_manual BOOLEAN NOT NULL DEFAULT false,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, email)
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS contacts_user_email_idx ON contacts(user_id, email)`)
  await query(`CREATE INDEX IF NOT EXISTS contacts_user_score_idx ON contacts(user_id, is_starred, frequency, last_contact_at)`)

  await query(`
    CREATE TABLE IF NOT EXISTS sent_tracking (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token VARCHAR(36) UNIQUE NOT NULL,
      message_id VARCHAR(512),
      account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      sent_to TEXT NOT NULL,
      subject TEXT,
      opened_at TIMESTAMPTZ,
      open_count INTEGER NOT NULL DEFAULT 0,
      user_agent TEXT,
      ip_address VARCHAR(45),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS sent_tracking_token_idx ON sent_tracking(token)`)
  await query(`CREATE INDEX IF NOT EXISTS sent_tracking_user_msgid_idx ON sent_tracking(user_id, message_id)`)

  await query(`
    CREATE TABLE IF NOT EXISTS scheduled_emails (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      to_addresses TEXT NOT NULL,
      cc_addresses TEXT,
      bcc_addresses TEXT,
      subject TEXT NOT NULL,
      html TEXT,
      in_reply_to TEXT,
      forwarded_attachments TEXT,
      send_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      error TEXT,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await query(`
    CREATE TABLE IF NOT EXISTS email_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      priority INTEGER NOT NULL DEFAULT 0,
      condition_logic VARCHAR(10) NOT NULL DEFAULT 'all',
      conditions JSONB NOT NULL DEFAULT '[]',
      actions JSONB NOT NULL DEFAULT '[]',
      stop_processing BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS email_rules_user_idx ON email_rules(user_id)`)
  await query(`CREATE INDEX IF NOT EXISTS email_rules_account_idx ON email_rules(account_id)`)
  await query(`CREATE INDEX IF NOT EXISTS email_rules_enabled_idx ON email_rules(account_id, enabled, priority)`)

  await query(`
    CREATE TABLE IF NOT EXISTS compose_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      subject VARCHAR(500) NOT NULL DEFAULT '',
      content_html TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS compose_templates_user_idx ON compose_templates(user_id)`)

  // Migrations — stats columns added after initial creation
  await query(`ALTER TABLE email_rules ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ`)
  await query(`ALTER TABLE email_rules ADD COLUMN IF NOT EXISTS total_processed INTEGER NOT NULL DEFAULT 0`)
  await query(`ALTER TABLE email_rules ADD COLUMN IF NOT EXISTS total_matched INTEGER NOT NULL DEFAULT 0`)

  await query(`
    CREATE TABLE IF NOT EXISTS rule_execution_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rule_id UUID NOT NULL REFERENCES email_rules(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder VARCHAR(255) NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed INTEGER NOT NULL DEFAULT 0,
      matched INTEGER NOT NULL DEFAULT 0
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS rule_exec_log_rule_idx ON rule_execution_log(rule_id, executed_at DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS rule_exec_log_user_idx ON rule_execution_log(user_id, executed_at DESC)`)

  await query(`
    CREATE TABLE IF NOT EXISTS snoozed_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      folder VARCHAR(255) NOT NULL,
      uid VARCHAR(255) NOT NULL,
      subject TEXT,
      from_address VARCHAR(255),
      from_name VARCHAR(255),
      snooze_until TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(account_id, folder, uid)
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS snoozed_until_idx ON snoozed_messages(snooze_until)`)
  await query(`CREATE INDEX IF NOT EXISTS snoozed_account_folder_idx ON snoozed_messages(account_id, folder)`)

  await query(`
    CREATE TABLE IF NOT EXISTS ai_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(20) NOT NULL DEFAULT 'ollama',
      api_key_encrypted TEXT,
      base_url TEXT DEFAULT 'http://localhost:11434',
      model VARCHAR(100) NOT NULL DEFAULT 'llama3',
      system_prompt TEXT,
      feature_summarize BOOLEAN NOT NULL DEFAULT true,
      feature_reply_draft BOOLEAN NOT NULL DEFAULT true,
      feature_improve BOOLEAN NOT NULL DEFAULT true,
      feature_translate BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // PGP end-to-end encryption — server stores public keys only.
  // Private keys are generated and kept exclusively in browser IndexedDB (lib/pgp/keystore.ts).
  await query(`
    CREATE TABLE IF NOT EXISTS pgp_public_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      fingerprint VARCHAR(64) NOT NULL,
      armored_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, email)
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS pgp_public_keys_user_idx ON pgp_public_keys(user_id, email)`)

  await query(`
    CREATE TABLE IF NOT EXISTS user_pgp_identity (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      fingerprint VARCHAR(64) NOT NULL,
      armored_public_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // Brouillons de composition — un par (utilisateur, compte), remplace le localStorage `synapmail:draft:${accountId}`
  await query(`
    CREATE TABLE IF NOT EXISTS drafts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      to_addresses TEXT[] NOT NULL DEFAULT '{}',
      cc_addresses TEXT[] NOT NULL DEFAULT '{}',
      bcc_addresses TEXT[] NOT NULL DEFAULT '{}',
      subject TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, account_id)
    )
  `)

  // Clés API — accès Bearer lecture+écriture pour usage machine/agent, en plus du cookie de session
  await query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      key_prefix VARCHAR(12) NOT NULL,
      key_hash VARCHAR(64) NOT NULL,
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(key_hash)`)

  // Portées par clé (lot P8) : ce que la clé a le droit de faire, source unique dans
  // lib/apiScopes.ts. Les clés déjà créées reçoivent EXACTEMENT ce qu'elles pouvaient
  // déjà faire (LEGACY_SCOPES) — l'écriture sur les boîtes n'est donnée à personne,
  // il faut la cocher. Le DEFAULT ne vaut que pour une insertion sans portées.
  await query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT '{}'`)
  await query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes_migrated_at TIMESTAMPTZ`)
  await query(
    `UPDATE api_keys SET scopes = $1::text[], scopes_migrated_at = NOW() WHERE scopes_migrated_at IS NULL`,
    [LEGACY_SCOPES]
  )

  // Journal des requêtes Bearer par clé — un log léger (méthode + chemin + IP), pas les
  // requêtes de session. Alimenté fire-and-forget par lib/apiAuth.ts à chaque auth réussie ;
  // purgé par le scheduler au-delà de 30 jours (voir lib/scheduler.ts processApiKeyLogCleanup).
  await query(`
    CREATE TABLE IF NOT EXISTS api_key_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      method VARCHAR(10) NOT NULL,
      path TEXT NOT NULL,
      ip_address VARCHAR(45),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS api_key_requests_key_idx ON api_key_requests(api_key_id, created_at DESC)`)

  // Ce qui s'est PASSÉ (lot P11) : la ligne ouverte à l'entrée se complète au RETOUR avec le
  // statut HTTP, la durée, la boîte visée et le motif du refus — voir lib/apiLog.ts. Toutes
  // nullables : une ligne écrite avant ce lot, ou une requête dont la réponse n'est jamais
  // revenue, reste lisible sans mentir sur ce qu'elle ne sait pas.
  await query(`ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS status INTEGER`)
  await query(`ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS duration_ms INTEGER`)
  await query(`ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS account_id UUID`)
  await query(`ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS denial_reason VARCHAR(20)`)
  await query(`ALTER TABLE api_key_requests ADD COLUMN IF NOT EXISTS denial_detail TEXT`)

  // Boîtes autorisées PAR CLÉ (lot P10) : les portées disent quelle capacité, cette table
  // dit sur quelle boîte. Les deux sont exigées — voir lib/apiKeyAccounts.ts, qui est la
  // SEULE barrière, appelée depuis lib/apiAuth.ts. Une boîte connectée PAR une clé lui
  // appartient (colonne ci-dessous) et n'a pas besoin d'y figurer.
  await query(`ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS created_by_api_key UUID REFERENCES api_keys(id) ON DELETE SET NULL`)
  await query(`
    CREATE TABLE IF NOT EXISTS api_key_accounts (
      api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (api_key_id, account_id)
    )
  `)

  // Migration : une clé qui existait avant cette barrière atteignait TOUTES les boîtes de
  // son propriétaire. On lui coche exactement celles-là, sinon `yumi-ai` et `scripts-import`
  // cessent de fonctionner en production. Les boîtes créées APRÈS ne sont accordées à
  // personne : il faut les cocher. Le drapeau porte la date pour ne migrer qu'une fois —
  // sans lui, un redémarrage re-cocherait ce que Nicolas vient de décocher.
  await query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS accounts_migrated_at TIMESTAMPTZ`)
  await query(`
    INSERT INTO api_key_accounts (api_key_id, account_id)
    SELECT ak.id, a.id FROM api_keys ak
      JOIN email_accounts a ON a.user_id = ak.user_id
     WHERE ak.accounts_migrated_at IS NULL
    ON CONFLICT DO NOTHING
  `)
  await query(`UPDATE api_keys SET accounts_migrated_at = NOW() WHERE accounts_migrated_at IS NULL`)

  // Invité en attente d'acceptation : bloque la connexion tant que le mot de passe placeholder
  // n'a pas été remplacé via /api/invites/[token] (voir account_shares ci-dessous)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'`)

  // Partage de compte — invitation d'un autre utilisateur avec permissions fines par action.
  // Pas de colonne can_read : l'existence d'une ligne status='active' EST le droit de lecture ;
  // il n'y a pas de cas d'usage pour "invité mais lecture coupée" en v1.
  await query(`
    CREATE TABLE IF NOT EXISTS account_shares (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invitee_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
      invite_token_hash VARCHAR(64),
      can_send BOOLEAN NOT NULL DEFAULT false,
      can_delete BOOLEAN NOT NULL DEFAULT false,
      can_organize BOOLEAN NOT NULL DEFAULT false,
      can_manage_rules BOOLEAN NOT NULL DEFAULT false,
      can_manage_signatures BOOLEAN NOT NULL DEFAULT false,
      expires_at TIMESTAMPTZ,
      accepted_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS account_shares_account_idx ON account_shares(account_id)`)
  await query(`CREATE INDEX IF NOT EXISTS account_shares_invitee_idx ON account_shares(invitee_user_id)`)
  await query(`CREATE INDEX IF NOT EXISTS account_shares_token_hash_idx ON account_shares(invite_token_hash)`)
  // Empêche un second partage pending/active vers la même personne pour le même compte ;
  // une relance après révocation insère simplement une nouvelle ligne (l'ancienne reste en historique)
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS account_shares_active_unique_idx
    ON account_shares(account_id, invitee_user_id)
    WHERE status IN ('pending', 'active')
  `)

  // Désabonnements effectués — pour qu'un agent ne recommence pas une lettre déjà quittée.
  // La clé de regroupement (List-Id ou adresse d'expéditeur) est stockée telle quelle :
  // c'est elle qui relie une ligne au groupe listé par `GET /api/subscriptions`.
  await query(`
    CREATE TABLE IF NOT EXISTS unsubscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      group_key TEXT NOT NULL,
      method VARCHAR(20) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(account_id, group_key)
    )
  `)
  // L'historique survit au rangement : une fois les messages déplacés, le groupe
  // disparaît de `GET /api/subscriptions` mais la ligne reste, avec de quoi la
  // lire sans la boîte (expéditeur, List-Id, résultat).
  await query(`ALTER TABLE unsubscriptions ADD COLUMN IF NOT EXISTS sender_address TEXT`)
  await query(`ALTER TABLE unsubscriptions ADD COLUMN IF NOT EXISTS sender_name TEXT`)
  await query(`ALTER TABLE unsubscriptions ADD COLUMN IF NOT EXISTS list_id TEXT`)

  // Identité de l'instance — UNE seule ligne, forcée par `id BOOLEAN PRIMARY KEY DEFAULT TRUE`
  // contraint à TRUE : une deuxième insertion viole la clé primaire. Tout à NULL = apparence
  // d'origine, donc aucune instance ne change d'aspect à la mise à jour.
  await query(`
    CREATE TABLE IF NOT EXISTS instance_settings (
      id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
      app_name VARCHAR(60),
      favicon BYTEA,
      favicon_type VARCHAR(40),
      favicon_updated_at TIMESTAMPTZ
    )
  `)
}

export default pool
