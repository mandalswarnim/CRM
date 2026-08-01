import { getDb, migrateSystem } from '../db/index.js';
import { createOrg } from '../db/provision.js';
import { config } from '../config.js';

/**
 * Provision a working org so there is something to log into.
 *
 * This is the platform bootstrap only — standard objects, profiles, an admin user. The club org,
 * with its members, bookings and rules as metadata, is seeded separately once the DML pipeline
 * and the club metadata exist.
 */
async function main(): Promise<void> {
  const db = await getDb();
  await migrateSystem(db);

  const existing = await db.query<{ id: string; name: string }>(`SELECT id, name FROM sys.orgs ORDER BY created_at`);
  if (existing.rows.length && !process.env.SEED_FORCE) {
    console.log(`[seed] ${existing.rows.length} org(s) already provisioned:`);
    for (const o of existing.rows) console.log(`       ${o.id}  ${o.name}`);
    console.log('[seed] nothing to do. Set SEED_FORCE=1 to provision another org.');
    await db.close();
    return;
  }

  const username = process.env.SEED_ADMIN_USERNAME ?? 'admin@orientalclub.org.uk';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'Meridian#2026';

  const org = await createOrg(db, {
    name: process.env.SEED_ORG_NAME ?? 'The Oriental Club',
    adminUsername: username,
    adminEmail: username,
    adminFirstName: 'Club',
    adminLastName: 'Administrator',
    adminPassword: password,
    defaultLocale: 'en_GB',
    defaultTimezone: 'Europe/London',
    corporateCurrency: 'GBP'
  });

  console.log('');
  console.log('  Org provisioned');
  console.log(`    id        ${org.orgId}`);
  console.log(`    schema    ${org.schema}`);
  console.log(`    database  ${db.kind === 'pglite' ? config.dataDir + '/pglite' : 'postgres'}`);
  console.log('');
  console.log('  Log in with');
  console.log(`    username  ${username}`);
  console.log(`    password  ${password}`);
  console.log('');
  console.log(`  Try it:  curl -s -X POST ${config.baseUrl}/api/auth/login \\`);
  console.log(`             -H 'Content-Type: application/json' \\`);
  console.log(`             -d '{"username":"${username}","password":"${password}"}'`);
  console.log('');

  await db.close();
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
