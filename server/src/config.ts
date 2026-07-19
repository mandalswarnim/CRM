import path from 'node:path';

/** Central runtime configuration, sourced from environment variables. */
export const config = {
  port: Number(process.env.PORT ?? 4000),
  /** postgres:// DSN. When unset, an embedded PGlite database is used (zero-infrastructure mode). */
  databaseUrl: process.env.DATABASE_URL ?? '',
  /** Directory for embedded database, file store, outbound .eml files. */
  dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
  /** Secret for signing nothing sensitive by default (tokens are opaque + hashed), used for cookies. */
  secret: process.env.APP_SECRET ?? 'meridian-dev-secret-change-me',
  baseUrl: process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`,
  apiVersions: ['59.0', '60.0', '61.0'],
  defaultApiVersion: '61.0',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  /** SMTP transport: "file" writes .eml under DATA_DIR/outbox; or "smtp" with SMTP_URL. */
  emailTransport: process.env.EMAIL_TRANSPORT ?? 'file',
  smtpUrl: process.env.SMTP_URL ?? '',
  /** Pool sizing for the pg driver. */
  pgPoolSize: Number(process.env.PG_POOL_SIZE ?? 16),
  /** Governor limits (per synchronous transaction). */
  limits: {
    soqlQueries: 100,
    queryRows: 50000,
    dmlStatements: 150,
    dmlRows: 10000,
    cpuMs: 10000,
    emails: 10
  },
  dailyApiRequests: Number(process.env.DAILY_API_REQUESTS ?? 100000)
};
