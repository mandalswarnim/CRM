-- ============================================================================
-- Meridian control-plane schema ("sys"): org directory, global login directory,
-- sessions/tokens (resolved before the tenant schema is known), API metering.
-- Idempotent — safe to run at every boot.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS sys;

CREATE TABLE IF NOT EXISTS sys.orgs (
  id                 char(18) PRIMARY KEY,
  name               text NOT NULL,
  schema_name        text NOT NULL UNIQUE,
  edition            text NOT NULL DEFAULT 'Enterprise',
  is_sandbox         boolean NOT NULL DEFAULT false,
  sandbox_name       text,
  source_org_id      char(18),
  instance_url       text,
  default_language   text NOT NULL DEFAULT 'en_US',
  default_locale     text NOT NULL DEFAULT 'en_GB',
  default_timezone   text NOT NULL DEFAULT 'Europe/London',
  corporate_currency text NOT NULL DEFAULT 'GBP',
  multi_currency     boolean NOT NULL DEFAULT true,
  features           jsonb NOT NULL DEFAULT '{}',
  dsn                text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Usernames are globally unique (like Salesforce) so login can route to the org.
CREATE TABLE IF NOT EXISTS sys.user_directory (
  username  text PRIMARY KEY,
  org_id    char(18) NOT NULL REFERENCES sys.orgs(id) ON DELETE CASCADE,
  user_id   char(18) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS user_directory_lower_idx ON sys.user_directory (lower(username));

-- UI + API sessions; token stored hashed. kind: ui | api | oauth | refresh
CREATE TABLE IF NOT EXISTS sys.sessions (
  token_hash    text PRIMARY KEY,
  org_id        char(18) NOT NULL REFERENCES sys.orgs(id) ON DELETE CASCADE,
  user_id       char(18) NOT NULL,
  kind          text NOT NULL DEFAULT 'ui',
  oauth_client  text,
  scopes        jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  ip            text,
  user_agent    text,
  refresh_of    text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sys.sessions (org_id, user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sys.sessions (expires_at);

-- OAuth authorization codes (short-lived).
CREATE TABLE IF NOT EXISTS sys.oauth_codes (
  code_hash     text PRIMARY KEY,
  org_id        char(18) NOT NULL,
  user_id       char(18) NOT NULL,
  client_id     text NOT NULL,
  redirect_uri  text NOT NULL,
  scopes        jsonb NOT NULL DEFAULT '[]',
  code_challenge text,
  expires_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS sys.api_usage (
  org_id    char(18) NOT NULL,
  day       date NOT NULL,
  requests  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day)
);

CREATE TABLE IF NOT EXISTS sys.migrations (
  id         text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
