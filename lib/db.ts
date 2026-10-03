import { Pool } from 'pg'
import { LEGACY_SCOPES, OPT_IN_SCOPES } from '@/lib/apiScopes'
import { TRANSLATE_MODE_DEFAULT } from '@/lib/quickTranslate'
import { ACTIVE_SHARE_SQL } from '@/lib/accountAccess'
import { FILING_SOURCES, OCR_STATUSES, OCR_STATUS_PENDING, PATTERN_KINDS } from '@/lib/ged/model'
import { BULK_STATES, ENGINES, HUMAN_SOURCE, PAUSE_REASONS, TAG_SOURCES } from '@/lib/tagging/engine'
import { DEFAULT_QUESTIONS, GED_GROUP, RETIRED_DEFAULT_IDS, defaultQuestionColumns } from '@/lib/tagging/questions'

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

/** Une liste de valeurs du code, telle qu'un CHECK SQL l'attend. Les valeurs sont des
 * identifiants du code (pas des entrées d'utilisateur) ; le doublement des quotes garde
 * la fonction correcte même si l'une d'elles en contenait une. */
const sqlList = (values: readonly string[]): string =>
  values.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')

/** Le plafond de dépense d'une boîte, tant que personne ne l'a relevé à l'écran : prudent
 * par défaut, parce qu'un tri complet d'une grosse boîte coûte plus que ça. */
export const TAGGING_BUDGET_USD_DEFAULT = 1

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
  // Ordre des cartes du tableau de bord, rangees a la souris. NULL = ordre d'origine :
  // aucun tableau de bord existant ne bouge a la mise a jour. Les identites sont celles
  // de lib/dashboardOrder.ts, qui remet d'office toute carte absente de la valeur lue.
  await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS dashboard_card_order JSONB`)
  // Bandeau de mise à jour : version dont l'utilisateur a fermé l'annonce (auparavant en sessionStorage)
  await query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS update_dismissed_version VARCHAR(50)`)
  // Garde contre l'injection d'instructions, par boîte. Activée par défaut : la sécurité est le défaut.
  await query(`ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS prompt_guard BOOLEAN NOT NULL DEFAULT true`)
  // Couleur de badge choisie par l'utilisateur. NULL = couleur automatique par rang :
  // aucune boîte existante ne change d'apparence à la mise à jour.
  await query(`ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS badge_color VARCHAR(7)`)
  // Taille maximale d'un message ANNONCÉE par le serveur SMTP dans sa réponse EHLO
  // (`250 SIZE <octets>`), lue par lib/accountProbe.ts au moment où la connexion est
  // essayée. NULL = le serveur n'a rien annoncé, ou n'a pas encore été essayé : l'envoi
  // retombe alors sur le plafond prudent de lib/attachments.ts. BIGINT car la valeur est
  // un nombre d'octets (IONOS annonce 141557760).
  await query(`ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS smtp_max_size BIGINT`)

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
  // Moteur derrière le bouton « Traduire » (lib/quickTranslate.ts en porte les valeurs).
  // Défaut « quick » : la traduction depuis le navigateur ne demande ni modèle ni réglage,
  // donc le bouton marche dès l'installation. Se change, ou s'éteint, dans Réglages → IA.
  // ALTER après le CREATE TABLE ci-dessus : sur une base neuve, la table n'existe pas encore
  // avant cette ligne (défaut n°1 de la revue amont — l'ALTER tournait avant le CREATE).
  await query(`ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS translate_mode VARCHAR(20) NOT NULL DEFAULT '${TRANSLATE_MODE_DEFAULT}'`)

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

  // Une portée OPTIONNELLE ne s'obtient qu'en la cochant (règle : « les capacités
  // nouvelles ne sont accordées à personne par défaut »). Or une migration antérieure
  // en a distribué : `contacts:write` a brièvement fait partie de LEGACY_SCOPES, et
  // les clés créées avant l'ont reçue sans que personne ne la coche — inoffensif tant
  // qu'aucune route d'écriture n'acceptait de clé, plus du tout depuis qu'elles s'ouvrent.
  // Ce rattrapage passe UNE fois par clé (le marqueur le garantit) : une portée cochée
  // APRÈS ce passage n'est jamais reprise.
  await query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS optin_scopes_revoked_at TIMESTAMPTZ`)
  await query(
    `UPDATE api_keys
        SET scopes = ARRAY(SELECT unnest(scopes) EXCEPT SELECT unnest($1::text[])),
            optin_scopes_revoked_at = NOW()
      WHERE optin_scopes_revoked_at IS NULL`,
    [OPT_IN_SCOPES]
  )

  // Revoir une clé (lot P14) : le clair est gardé CHIFFRÉ avec la clé maître hors base
  // (lib/encrypt.ts, la même mécanique que les mots de passe IMAP), jamais en clair.
  // `key_hash` reste seul utilisé pour l'AUTHENTIFICATION — on ne déchiffre que pour
  // afficher, après re-saisie du mot de passe. Nullable : les clés créées AVANT ce lot
  // n'ont pas de clair à stocker, il n'existe nulle part, et elles restent irrécupérables.
  await query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_encrypted TEXT`)

  // Restreindre une clé à des adresses (lot P14) : liste vide = aucune restriction,
  // ce qui est le cas de toute clé existante — la migration ne restreint personne.
  // Le verrou est appliqué dans lib/apiAuth.ts, à côté des portées et des boîtes.
  await query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_ips TEXT[] NOT NULL DEFAULT '{}'`)

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

  // OÙ une adresse a été vue (lot P15) — le résultat d'ip-api.com, écrit à la PREMIÈRE
  // apparition de l'adresse et relu ensuite. C'est cette table qui fait la différence entre
  // « une interrogation par adresse » et « une interrogation par ouverture d'écran ».
  // Un verdict d'échec du service ('unlocatable') s'y écrit aussi : sans lui, une adresse
  // privée repartirait chez le service à chaque fois. Voir lib/ipLocation.ts.
  await query(`
    CREATE TABLE IF NOT EXISTS ip_locations (
      ip_address VARCHAR(45) PRIMARY KEY,
      status VARCHAR(20) NOT NULL,
      city TEXT,
      region TEXT,
      country TEXT,
      country_code VARCHAR(4),
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      located_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

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

  // Le drapeau de la migration ci-dessous est posé ici (colonne créée avant d'être lue),
  // mais la migration elle-même tourne plus bas : elle doit aussi backfill les boîtes
  // PARTAGÉES actives (table account_shares), pas encore créée à ce point du fichier.
  await query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS accounts_migrated_at TIMESTAMPTZ`)

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

  // Suite du backfill posé plus haut (colonne accounts_migrated_at) : une clé migrée doit
  // aussi voir les boîtes qu'elle lisait déjà PAR PARTAGE actif (account_shares), sinon une
  // clé qui lisait une boîte partagée perd l'accès (403) au déploiement — défaut n°6 de la
  // revue amont. `sh` est l'alias attendu par ACTIVE_SHARE_SQL (source unique de la règle).
  await query(`
    INSERT INTO api_key_accounts (api_key_id, account_id)
    SELECT ak.id, sh.account_id FROM api_keys ak
      JOIN account_shares sh ON sh.invitee_user_id = ak.user_id
     WHERE ak.accounts_migrated_at IS NULL
       AND ${ACTIVE_SHARE_SQL}
    ON CONFLICT DO NOTHING
  `)
  await query(`
    INSERT INTO api_key_accounts (api_key_id, account_id)
    SELECT ak.id, a.id FROM api_keys ak
      JOIN email_accounts a ON a.user_id = ak.user_id
     WHERE ak.accounts_migrated_at IS NULL
    ON CONFLICT DO NOTHING
  `)
  await query(`UPDATE api_keys SET accounts_migrated_at = NOW() WHERE accounts_migrated_at IS NULL`)

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

  // ── Tagging : étiquettes d'un mail, décidées par un moteur System One ou par un humain ──
  //
  // Les listes de valeurs des CHECK ci-dessous sont dérivées des constantes de
  // `lib/tagging/engine.ts` : `TAG_SOURCES`, `ENGINES`, `PAUSE_REASONS`,
  // `BULK_STATES`. Aucun vocabulaire n'est recopié à la main ici — ajouter un type de moteur
  // dans le code met la base d'accord au prochain démarrage (les CHECK sont remplacées plus bas).

  // Un moteur de décision est un OUTIL que l'utilisateur AJOUTE (décision 13), pas un choix
  // entre deux valeurs figées : N moteurs par utilisateur, chacun avec sa clé et son tarif.
  // La clé est chiffrée comme un mot de passe IMAP et ne ressort JAMAIS d'une API (`hasKey`).
  await query(`
    CREATE TABLE IF NOT EXISTS decision_engines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(80) NOT NULL,
      kind VARCHAR(20) NOT NULL CHECK (kind IN (${sqlList(ENGINES)})),
      url TEXT NOT NULL DEFAULT '',
      key_encrypted TEXT,
      model VARCHAR(100) NOT NULL DEFAULT '',
      usd_per_billion_input REAL NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS decision_engines_user_idx ON decision_engines(user_id)`)

  // Une étiquette = une réponse à UNE question, par UN auteur, sous UN modèle annoncé et UNE
  // version de question (décision 23). La clé primaire porte tout cela : rejouer EXACTEMENT le
  // même auteur + modèle + version remplace la ligne (idempotent) ; un autre moteur du même type,
  // une nouvelle version annoncée ou une seconde main AJOUTENT une ligne, l'ancienne est gardée.
  // `auteur_nom` est un INSTANTANÉ, sans clé étrangère : l'origine reste lisible après la
  // suppression du moteur. `id` sert uniquement à paginer l'export.
  await query(`
    CREATE TABLE IF NOT EXISTS message_tags (
      id BIGSERIAL UNIQUE,
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      question VARCHAR(60) NOT NULL,
      valeur VARCHAR(60) NOT NULL,
      probabilites JSONB,
      confiance REAL,
      source VARCHAR(20) NOT NULL CHECK (source IN (${sqlList(TAG_SOURCES)})),
      modele VARCHAR(100) NOT NULL DEFAULT '',
      cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valide_par UUID REFERENCES users(id) ON DELETE SET NULL,
      question_version VARCHAR(12) NOT NULL DEFAULT '',
      taxonomy_version VARCHAR(12) NOT NULL DEFAULT '',
      auteur_id TEXT NOT NULL DEFAULT '',
      auteur_nom TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (account_id, message_id, question, source, auteur_id, modele, question_version)
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS message_tags_filter_idx ON message_tags(account_id, question, valeur)`)
  // La VERSION de la question à laquelle chaque ligne répond (`lib/tagging/store.ts`
  // `questionVersion`). Sur une base antérieure au lot T10, les lignes existantes gardent la
  // chaîne vide : elles ont bien été écrites, mais sous une définition qu'on ne peut plus
  // nommer — les dire « inconnues » vaut mieux que leur prêter la version d'aujourd'hui.
  await query(`ALTER TABLE message_tags ADD COLUMN IF NOT EXISTS question_version VARCHAR(12) NOT NULL DEFAULT ''`)
  // Le JEU de questions sous lequel la ligne a été écrite (`TAXONOMY_VERSION`). Le trieur ne saute
  // un mail que s'il porte la version COURANTE : une question AJOUTÉE ne change la
  // `question_version` d'aucune autre, donc sans cette colonne le mail serait sauté et ne
  // recevrait jamais la question neuve. Les lignes antérieures gardent la chaîne vide, donc une
  // boîte déjà triée SE REJOUE une fois après cette migration — voulu, et facturé au plafond.
  await query(`ALTER TABLE message_tags ADD COLUMN IF NOT EXISTS taxonomy_version VARCHAR(12) NOT NULL DEFAULT ''`)
  // Retrait de la notion « entraînable » : la contrainte PUIS la colonne, dans cet ordre (une
  // CHECK qui nomme la colonne empêcherait son DROP). Les deux `IF EXISTS` rendent le passage
  // idempotent, donc une base déjà nettoyée redémarre sans rien faire, et une base antérieure
  // (lane, staging) migre seule au prochain démarrage sans migration écrite à la main.
  await query(`ALTER TABLE message_tags DROP CONSTRAINT IF EXISTS message_tags_training_sources`)
  await query(`ALTER TABLE message_tags DROP COLUMN IF EXISTS entrainement_autorise`)

  // L'ORIGINE de chaque ligne (décision 23, lot T-S). Sur une base antérieure, les lignes
  // existantes reçoivent l'auteur qu'on peut encore leur attribuer : l'utilisateur qui a validé
  // pour `humain` ; le moteur choisi par la boîte pour une source de moteur. Une boîte SANS
  // moteur au moment de la migration (mesuré le 29/09/2026 : les 3 boîtes de la lane, moteur du
  // gate T10b détaché) ne peut nommer personne : `auteur_id` reste vide et `auteur_nom` reprend
  // le modèle annoncé — dire « jev-1.13.0 » vaut mieux que prêter ces lignes à un moteur créé
  // depuis. `modele` passe NOT NULL (une colonne de clé primaire ne peut pas être NULL) : la
  // chaîne vide dit « aucun modèle » et la lecture la rend `null` comme avant.
  await query(`ALTER TABLE message_tags ADD COLUMN IF NOT EXISTS auteur_id TEXT NOT NULL DEFAULT ''`)
  await query(`ALTER TABLE message_tags ADD COLUMN IF NOT EXISTS auteur_nom TEXT NOT NULL DEFAULT ''`)
  await query(`UPDATE message_tags SET modele = '' WHERE modele IS NULL`)
  await query(`ALTER TABLE message_tags ALTER COLUMN modele SET DEFAULT '', ALTER COLUMN modele SET NOT NULL`)
  // Le rétro-remplissage ne tourne qu'UNE fois, au passage de l'ancienne clé à la nouvelle (lue
  // dans le catalogue plutôt que supposée). Après, `auteur_id = ''` est un état LÉGITIME (« on ne
  // sait pas qui ») : le rejouer à chaque démarrage prêterait ces lignes au moteur rattaché
  // DEPUIS, et entrerait en collision avec les lignes que ce moteur a écrites lui-même
  // (mesuré le 29/09/2026 : duplicate key sur message_tags_pkey au boot, après le retag du gate).
  // Les lignes existantes étaient uniques sous l'ancienne clé, donc le sont sous la nouvelle,
  // plus large : aucun dédoublonnage à faire avant.
  const [pk] = await query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'message_tags'::regclass AND contype = 'p'`
  )
  if (!pk?.def.includes('auteur_id')) {
    await query(`
      UPDATE message_tags t SET auteur_id = u.id::text, auteur_nom = u.name
        FROM users u
       WHERE t.auteur_id = '' AND t.source = '${HUMAN_SOURCE}' AND t.valide_par = u.id
    `)
    await query(`
      UPDATE message_tags t SET auteur_id = e.id::text, auteur_nom = e.name
        FROM mailbox_tagging m JOIN decision_engines e ON e.id = m.engine_id
       WHERE t.auteur_id = '' AND t.source <> '${HUMAN_SOURCE}' AND m.account_id = t.account_id AND e.kind = t.source
    `)
    await query(`UPDATE message_tags SET auteur_nom = COALESCE(NULLIF(modele, ''), source) WHERE auteur_id = '' AND auteur_nom = ''`)
    await query(`
      ALTER TABLE message_tags
        DROP CONSTRAINT IF EXISTS message_tags_pkey,
        ADD PRIMARY KEY (account_id, message_id, question, source, auteur_id, modele, question_version)
    `)
  }

  // Les VALEURS extraites d'un mail (lot T11, décision 19) : montant, échéance, n° de commande,
  // n° de suivi — mêmes colonnes de traçabilité et même clé que `message_tags` (l'étiquette
  // effective se calcule par le même fragment SQL). `question` est le nom du champ ; `valeur`
  // est TEXT (un montant, une date ISO, un numéro) ; `candidats` garde ce que les regex avaient
  // trouvé, pour que l'écran propose les mêmes choix qu'au moteur. Un IBAN n'y entre jamais en
  // clair : seulement ses 4 derniers caractères (`lib/tagging/fields.ts`).
  await query(`
    CREATE TABLE IF NOT EXISTS message_fields (
      id BIGSERIAL UNIQUE,
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      question VARCHAR(60) NOT NULL,
      valeur TEXT NOT NULL,
      candidats JSONB,
      source VARCHAR(20) NOT NULL CHECK (source IN (${sqlList(TAG_SOURCES)})),
      modele VARCHAR(100) NOT NULL DEFAULT '',
      cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valide_par UUID REFERENCES users(id) ON DELETE SET NULL,
      question_version VARCHAR(12) NOT NULL DEFAULT '',
      auteur_id TEXT NOT NULL DEFAULT '',
      auteur_nom TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (account_id, message_id, question, source, auteur_id, modele, question_version)
    )
  `)

  // Les QUESTIONS de tri d'un utilisateur (lot T-Q, décision 22) : la source unique de sa
  // taxonomie. `lib/tagging/questions.ts` ne garde que les défauts, copiés ici à la première
  // lecture (`lib/tagging/userQuestions.ts`). `criteria` porte les options telles que le code les
  // lit (`TagOption[]` : valeur, définition, frontière, exemples ; NULL pour un `noul`) ;
  // `list_badge` dit quand la pastille monte dans la liste (true, un niveau, ou NULL). `version`
  // est le compteur AFFICHÉ (+1 à chaque changement de consigne ou de critères) ; la version que
  // portent les étiquettes reste le hachage du corps envoyé au moteur (`questionVersion`).
  await query(`
    CREATE TABLE IF NOT EXISTS tag_questions (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id VARCHAR(40) NOT NULL,
      type VARCHAR(10) NOT NULL CHECK (type IN ('choice', 'score', 'noul')),
      instructions TEXT NOT NULL,
      criteria JSONB,
      list_badge JSONB,
      groupe VARCHAR(40) NOT NULL DEFAULT 'general',
      enabled BOOLEAN NOT NULL DEFAULT true,
      position INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, id)
    )
  `)
  // Une question par défaut corrigée dans `questions.ts` rejoint les jeux que l'utilisateur n'a
  // JAMAIS édités (`version = 1`) : sinon la correction ne vaudrait que pour un compte neuf.
  // Une question éditée garde sa consigne — c'est la sienne.
  await query(
    `UPDATE tag_questions t SET instructions = d.instructions, criteria = d.criteria, updated_at = NOW()
       FROM unnest($1::text[], $2::text[], $3::jsonb[]) AS d(id, instructions, criteria)
      WHERE t.id = d.id AND t.version = 1
        AND (t.instructions <> d.instructions OR t.criteria IS DISTINCT FROM d.criteria)`,
    [DEFAULT_QUESTIONS.map(q => q.id), DEFAULT_QUESTIONS.map(q => q.instructions),
      DEFAULT_QUESTIONS.map(q => (q.options ? JSON.stringify(q.options) : null))]
  )
  // Une question par défaut AJOUTÉE (lot T11b : cinq nouls de divulgation) rejoint les jeux
  // déjà insérés — sinon seuls les comptes neufs la recevraient. ponytail: une question par
  // défaut que l'utilisateur avait SUPPRIMÉE revient par le même chemin ; voie d'amélioration :
  // mémoriser les suppressions. Une question par défaut RETIRÉE quitte les jeux jamais édités.
  const d = defaultQuestionColumns()
  await query(
    `INSERT INTO tag_questions (user_id, id, type, instructions, criteria, list_badge, groupe, enabled, position, version)
     SELECT u.user_id, q.id, q.type, q.instructions, q.criteria, q.list_badge, q.groupe, true, q.position, 1
       FROM (SELECT DISTINCT user_id FROM tag_questions) u
      CROSS JOIN unnest($1::text[], $2::text[], $3::text[], $4::jsonb[], $5::jsonb[], $6::text[], $7::int[])
              AS q(id, type, instructions, criteria, list_badge, groupe, position)
     ON CONFLICT (user_id, id) DO NOTHING`,
    [d.ids, d.types, d.instructions, d.criteria, d.listBadges, d.groups, d.positions]
  )
  await query(`DELETE FROM tag_questions WHERE id = ANY($1::text[]) AND version = 1`, [RETIRED_DEFAULT_IDS])

  // Les règles d'étiquetage SANS moteur (lot T-Q2, décision 24.1) : mêmes `conditions` que
  // `email_rules`, évaluées par la même fonction ; `actions` = [{question, valeur}] ;
  // `authoritative` = la question tranchée n'est pas posée au moteur. `account_id` NULL = toutes
  // les boîtes de l'utilisateur.
  await query(`
    CREATE TABLE IF NOT EXISTS tag_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      priority INTEGER NOT NULL DEFAULT 0,
      condition_logic VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (condition_logic IN ('all', 'any')),
      conditions JSONB NOT NULL DEFAULT '[]',
      actions JSONB NOT NULL DEFAULT '[]',
      authoritative BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS tag_rules_user_idx ON tag_rules(user_id)`)

  // Les groupes de questions CONDITIONNELS (lot T-Q3, décision 24.2) : `id` est le slug que
  // porte `tag_questions.groupe` ; `conditions` = le déclencheur, même format que `tag_rules`
  // plus le champ `tag` (une étiquette déjà obtenue). Vide = tronc, posé à chaque mail. Un slug
  // sans ligne est du tronc aussi : les 49 questions d'origine n'ont donc aucune ligne ici.
  await query(`
    CREATE TABLE IF NOT EXISTS tag_question_groups (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id VARCHAR(40) NOT NULL,
      name VARCHAR(255) NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      condition_logic VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (condition_logic IN ('all', 'any')),
      conditions JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, id)
    )
  `)

  // Le groupe GED (lot G3, décision 6) : les quatre questions `ged` ne sont posées qu'à un
  // document porteur d'un texte OCR. Posé pour chaque utilisateur qui a déjà son jeu (le jeu
  // neuf le reçoit avec ses défauts, `userQuestions.ts`) ; un groupe modifié reste le sien.
  await query(
    `INSERT INTO tag_question_groups (user_id, id, name, condition_logic, conditions)
     SELECT u.user_id, $1, $2, $3, $4::jsonb FROM (SELECT DISTINCT user_id FROM tag_questions) u
     ON CONFLICT (user_id, id) DO NOTHING`,
    [GED_GROUP.id, GED_GROUP.name, GED_GROUP.conditionLogic, JSON.stringify(GED_GROUP.conditions)]
  )

  // La dernière position CONNUE d'un mail tagué, pour que le filtre par étiquette montre des
  // mails absents de la page chargée. `messages_cache` ne suffit pas : il ne garde qu'une
  // fenêtre, et un mail tagué il y a un mois en est sorti.
  await query(`
    CREATE TABLE IF NOT EXISTS tagged_messages (
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      folder TEXT,
      uid INTEGER,
      from_name TEXT,
      from_address TEXT,
      subject TEXT,
      date TIMESTAMPTZ,
      PRIMARY KEY (account_id, message_id)
    )
  `)

  // Le tri d'une boîte : quel moteur, quel plafond, où en est-on. Une ligne par boîte.
  // `locked_until` est le verrou qui empêche deux passages du planificateur de travailler
  // la même boîte (claim par `UPDATE … WHERE locked_until < NOW() RETURNING`).
  await query(`
    CREATE TABLE IF NOT EXISTS mailbox_tagging (
      account_id UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
      engine_id UUID REFERENCES decision_engines(id) ON DELETE SET NULL,
      budget_usd REAL NOT NULL DEFAULT ${TAGGING_BUDGET_USD_DEFAULT},
      spent_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      input_mails BIGINT NOT NULL DEFAULT 0,
      live BOOLEAN NOT NULL DEFAULT false,
      live_cursor JSONB,
      bulk_state VARCHAR(20) NOT NULL DEFAULT 'idle' CHECK (bulk_state IN (${sqlList(BULK_STATES)})),
      bulk_cursor JSONB,
      tagged INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      paused_reason VARCHAR(20) CHECK (paused_reason IS NULL OR paused_reason IN (${sqlList(PAUSE_REASONS)})),
      paused_detail TEXT,
      locked_until TIMESTAMPTZ,
      sample_size INTEGER,
      sample_seed BIGINT,
      sample_cursor JSONB,
      run_started_tag_id BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // Le mode « échantillon » (lot T10b) : `sample_size` NULL = tri complet, sinon le nombre de
  // mails tirés au hasard avant l'arrêt, `sample_seed` la graine qui rejoue LE MÊME tirage, et
  // `sample_cursor` le tirage LUI-MÊME (la liste des mails tirés) plus où on en est dedans —
  // enregistré parce qu'un tirage se fait sur l'état de la boîte à un instant donné : le rejouer
  // à chaque passage donnerait une liste différente dès qu'un mail arrive.
  await query(`ALTER TABLE mailbox_tagging ADD COLUMN IF NOT EXISTS sample_size INTEGER`)
  await query(`ALTER TABLE mailbox_tagging ADD COLUMN IF NOT EXISTS sample_seed BIGINT`)
  await query(`ALTER TABLE mailbox_tagging ADD COLUMN IF NOT EXISTS sample_cursor JSONB`)

  // Le nombre de mails DERRIÈRE `input_tokens` (lot T-Q2b). L'estimation divise les jetons cumulés
  // par un nombre de mails : `tagged` ne convient pas, il est remis à zéro à chaque tri alors que
  // `input_tokens` ne l'est jamais — après un échantillon d'1 mail, 13,6 M de jetons ÷ 1 donnait
  // 572,86 $ pour 1 000 mails au lieu de 0,30 $ (gate T-Q2, 01/10/2026). Ce compteur suit la même
  // vie que `input_tokens` : cumulé, jamais remis à zéro.
  await query(`ALTER TABLE mailbox_tagging ADD COLUMN IF NOT EXISTS input_mails BIGINT NOT NULL DEFAULT 0`)
  // Une boîte triée AVANT cette colonne a des jetons sans mails derrière : laissée à 0, elle
  // retombait bien sur la constante… jusqu'à son premier passage, où 13,6 M de jetons d'historique
  // divisés par les 2 mails de ce passage donnaient 4,9 M de jetons par mail (gate T-Q3, 01/10/2026).
  // Le dénominateur est donc rétro-rempli avec ce que l'historique sait : chaque tagage d'un mail
  // par un moteur sous une taxonomie, ce que `tagged` aurait compté. Une seule fois (`input_mails = 0`).
  // ponytail: un retagage sous la même version de question écrase sa ligne, l'historique sous-compte
  // donc un peu (1,5× la mesure T8 sur la boîte de référence, dans la marge [0,5×, 2×] du gate) ;
  // les passages suivants font converger la moyenne vers la mesure réelle.
  await query(`
    UPDATE mailbox_tagging m
       SET input_mails = (SELECT COUNT(DISTINCT (t.message_id, t.auteur_id, t.taxonomy_version)) FROM message_tags t
                           WHERE t.account_id = m.account_id AND t.source IN (${sqlList(ENGINES)}))
     WHERE m.input_mails = 0 AND m.input_tokens > 0
  `)

  // Le dernier `message_tags.id` qui existait quand le tri COURANT a été lancé (lot T10c). Il
  // sépare « déjà tagué avant ce tri » — un mail sauté pour de bon — de « tagué par ce tri
  // même », relu au passage suivant parce qu'un lot coupé au délai ne fait pas avancer son
  // curseur. Sans cette borne, le second cas était compté en « sautés » alors qu'il avait déjà
  // été compté en « tagués » : d'où `skipped=86` pour 995 mails tagués sur 1 000 tirés (gate
  // T10b, 28/09/2026). Une borne par IDENTIFIANT et non par date (`run_started_at`, retiré) :
  // l'horloge de Postgres sous Docker Desktop recule de 300 à 500 ms toutes les ~10 s (mesuré
  // le 29/09/2026 : 6 fois sur 400, un `NOW()` lu 150 ms APRÈS un autre lui était antérieur),
  // et un `cree_le` antérieur au lancement reclassait le premier lot du tri en « sautés ».
  // La séquence, elle, ne recule jamais.
  await query(`ALTER TABLE mailbox_tagging DROP COLUMN IF EXISTS run_started_at`)
  await query(`ALTER TABLE mailbox_tagging ADD COLUMN IF NOT EXISTS run_started_tag_id BIGINT`)

  // ── GED : une boîte dont chaque PDF reçu devient un document rangé dans des dossiers virtuels ──
  //
  // Décisions 3-5 (GOAL de la lane `courrier`). Les listes des CHECK viennent de `lib/ged/model.ts`
  // (même mécanique que le tri : reposées plus bas à chaque démarrage). Rien ici ne touche l'IMAP.

  // La boîte déclarée GED. Une ligne par boîte ; « À ranger » n'est pas une ligne mais une vue :
  // les documents sans dossier effectif.
  await query(`
    CREATE TABLE IF NOT EXISTS ged_mailboxes (
      account_id UUID PRIMARY KEY REFERENCES email_accounts(id) ON DELETE CASCADE,
      actif BOOLEAN NOT NULL DEFAULT true,
      cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // Le curseur de la chaîne de réception (lot G3) : `{ lastUid, uidValidity }` du dossier
  // surveillé. NULL = tout est à rattraper depuis le premier mail — l'OCR est local, donc gratuit.
  await query(`ALTER TABLE ged_mailboxes ADD COLUMN IF NOT EXISTS cursor JSONB`)

  // Un PDF = un document (décision 2) : la clé est la pièce jointe elle-même (mail + rang de la
  // partie), jamais l'UID IMAP seul, qui change à un déplacement. `page_texts` garde les pages
  // telles que `lib/ged/ocr.ts` les rend (index, texte, confiance, blanche) ; `ocr_text` est le
  // texte global, indexé en français pour la recherche (colonne générée : la base la tient à jour).
  await query(`
    CREATE TABLE IF NOT EXISTS ged_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      uid INTEGER NOT NULL,
      part_idx INTEGER NOT NULL,
      filename TEXT NOT NULL DEFAULT '',
      recu_le TIMESTAMPTZ,
      pages INTEGER NOT NULL DEFAULT 0,
      ocr_status VARCHAR(20) NOT NULL DEFAULT '${OCR_STATUS_PENDING}' CHECK (ocr_status IN (${sqlList(OCR_STATUSES)})),
      ocr_error TEXT,
      ocr_text TEXT NOT NULL DEFAULT '',
      page_texts JSONB,
      confiance REAL,
      texte_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('french', ocr_text)) STORED,
      cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (account_id, message_id, part_idx)
    )
  `)
  // L'enveloppe du mail porteur (lot G3) : ce que le trieur montre d'un document dans la liste
  // (`tagged_messages`), relu depuis la base sans rouvrir l'IMAP.
  await query(`ALTER TABLE ged_documents ADD COLUMN IF NOT EXISTS from_address TEXT NOT NULL DEFAULT ''`)
  await query(`ALTER TABLE ged_documents ADD COLUMN IF NOT EXISTS from_name TEXT NOT NULL DEFAULT ''`)
  await query(`ALTER TABLE ged_documents ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT ''`)
  await query(`CREATE INDEX IF NOT EXISTS ged_documents_account_idx ON ged_documents(account_id, recu_le DESC)`)
  await query(`CREATE INDEX IF NOT EXISTS ged_documents_tsv_idx ON ged_documents USING GIN (texte_tsv)`)

  // L'arbre des dossiers virtuels d'une boîte (décision 3) : libre, imbriqué, créé par un humain,
  // un agent ou automatiquement (`auto`, sous « Nouveaux émetteurs »). Deux frères ne portent pas
  // le même nom — à la racine aussi (`NULLS NOT DISTINCT`, Postgres 15+, la prod est en 16).
  await query(`
    CREATE TABLE IF NOT EXISTS ged_folders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      parent_id UUID REFERENCES ged_folders(id) ON DELETE CASCADE,
      nom VARCHAR(120) NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      auto BOOLEAN NOT NULL DEFAULT false,
      cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE NULLS NOT DISTINCT (account_id, parent_id, nom)
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS ged_folders_parent_idx ON ged_folders(account_id, parent_id, position)`)

  // Un rangement = une NOUVELLE ligne (décision 4, comme `message_tags`) : l'historique reste,
  // l'effectif se lit « humain d'abord, puis le plus récent ». `folder_id` NULL = « hors de tout
  // dossier » (une main qui défait un rangement). `auteur_nom` est un instantané, sans clé.
  await query(`
    CREATE TABLE IF NOT EXISTS ged_filings (
      id BIGSERIAL PRIMARY KEY,
      document_id UUID NOT NULL REFERENCES ged_documents(id) ON DELETE CASCADE,
      folder_id UUID REFERENCES ged_folders(id) ON DELETE CASCADE,
      source VARCHAR(20) NOT NULL CHECK (source IN (${sqlList(FILING_SOURCES)})),
      auteur_id TEXT NOT NULL DEFAULT '',
      auteur_nom TEXT NOT NULL DEFAULT '',
      confiance REAL,
      cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await query(`CREATE INDEX IF NOT EXISTS ged_filings_document_idx ON ged_filings(document_id, cree_le DESC)`)

  // Les motifs appris d'un rangement (décision 5) : un identifiant stable de l'émetteur → un
  // dossier. La même valeur PEUT pointer deux dossiers (c'est le cas « doute » qui laisse le
  // document à ranger) ; elle ne se répète pas dans le même dossier. Un IBAN n'y entre jamais en
  // clair (`iban4`, cf. `lib/tagging/fields.ts`). `touches` compte les documents rangés par le motif.
  await query(`
    CREATE TABLE IF NOT EXISTS ged_patterns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      folder_id UUID NOT NULL REFERENCES ged_folders(id) ON DELETE CASCADE,
      genre VARCHAR(20) NOT NULL CHECK (genre IN (${sqlList(PATTERN_KINDS)})),
      valeur TEXT NOT NULL,
      appris_de UUID REFERENCES ged_documents(id) ON DELETE SET NULL,
      auteur_id TEXT NOT NULL DEFAULT '',
      auteur_nom TEXT NOT NULL DEFAULT '',
      touches INTEGER NOT NULL DEFAULT 0,
      cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (folder_id, genre, valeur)
    )
  `)

  // Les CHECK ci-dessus ne sont posées qu'à la CRÉATION de la table : sur une base qui existe
  // déjà, élargir une liste dans le code ne changerait rien. On les repose donc à chaque
  // démarrage, pour que la base suive le code — c'est ce qui permet d'ajouter un type de moteur
  // (décision 13) sans écrire de migration à la main.
  for (const [table, name, expr] of [
    ['message_tags', 'message_tags_source_check', `source IN (${sqlList(TAG_SOURCES)})`],
    ['decision_engines', 'decision_engines_kind_check', `kind IN (${sqlList(ENGINES)})`],
    ['ged_documents', 'ged_documents_ocr_status_check', `ocr_status IN (${sqlList(OCR_STATUSES)})`],
    ['ged_filings', 'ged_filings_source_check', `source IN (${sqlList(FILING_SOURCES)})`],
    ['ged_patterns', 'ged_patterns_genre_check', `genre IN (${sqlList(PATTERN_KINDS)})`],
  ] as const) {
    await query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`)
    await query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr})`)
  }

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
