import type { Db, DbClient } from './index.js';
import { createTenantSchema, migrateSystem, withTenantClient } from './index.js';
import { generateId, KEY_PREFIXES, schemaNameForOrg } from '../util/ids.js';
import { STANDARD_OBJECTS } from '../metadata/standard/objects.js';
import { installObject } from '../metadata/installer.js';
import { invalidateOrgMeta } from '../metadata/registry.js';
import { tableFor } from '../metadata/registry.js';
import { hashPassword, randomToken, sha256 } from '../security/passwords.js';

export interface CreateOrgOptions {
  name: string;
  adminUsername: string;
  adminEmail: string;
  adminFirstName?: string;
  adminLastName: string;
  adminPassword: string;
  edition?: string;
  isSandbox?: boolean;
  sourceOrgId?: string;
  sandboxName?: string;
  defaultLocale?: string;
  defaultTimezone?: string;
  corporateCurrency?: string;
  /** Skip standard-object install (used by sandbox cloning which copies the schema). */
  skipStandardInstall?: boolean;
}

export interface ProvisionedOrg {
  orgId: string;
  schema: string;
  adminUserId: string;
  adminProfileId: string;
  standardProfileId: string;
  readOnlyProfileId: string;
}

export const ADMIN_PERMS = {
  apiEnabled: true,
  modifyAllData: true,
  viewAllData: true,
  manageSetup: true,
  manageUsers: true,
  runReports: true,
  exportReports: true,
  manageReports: true,
  importData: true,
  sendEmail: true,
  bulkApi: true,
  approvalAdmin: true
};

export const STANDARD_PERMS = {
  apiEnabled: true,
  modifyAllData: false,
  viewAllData: false,
  manageSetup: false,
  manageUsers: false,
  runReports: true,
  exportReports: true,
  manageReports: true,
  importData: false,
  sendEmail: true,
  bulkApi: false,
  approvalAdmin: false
};

/** Raw record insert used only during provisioning (before the DML pipeline can run). */
export async function rawInsert(
  c: DbClient,
  objectApi: string,
  id: string,
  name: string | null,
  fields: Record<string, any>,
  ownerId?: string | null
): Promise<void> {
  await c.query(
    `INSERT INTO ${tableFor(objectApi)} (id, name, owner_id, created_by_id, last_modified_by_id, fields, currency_iso_code)
     VALUES ($1,$2,$3,$4,$4,$5,'GBP')`,
    [id, name, ownerId ?? id, ownerId ?? id, JSON.stringify(fields)]
  );
}

export async function createOrg(db: Db, opts: CreateOrgOptions): Promise<ProvisionedOrg> {
  await migrateSystem(db);
  const orgId = generateId(KEY_PREFIXES.Organization);
  const schema = schemaNameForOrg(orgId);

  await db.query(
    `INSERT INTO sys.orgs (id, name, schema_name, edition, is_sandbox, sandbox_name, source_org_id,
                           default_locale, default_timezone, corporate_currency, instance_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      orgId,
      opts.name,
      schema,
      opts.edition ?? 'Enterprise',
      opts.isSandbox ?? false,
      opts.sandboxName ?? null,
      opts.sourceOrgId ?? null,
      opts.defaultLocale ?? 'en_GB',
      opts.defaultTimezone ?? 'Europe/London',
      opts.corporateCurrency ?? 'GBP',
      process.env.BASE_URL ?? 'http://localhost:4000'
    ]
  );

  await createTenantSchema(db, schema);

  const result = await withTenantClient(db, schema, async (c) => {
    if (!opts.skipStandardInstall) {
      for (const spec of STANDARD_OBJECTS) {
        await installObject(c, spec);
      }
    }

    // Currencies
    const corp = opts.corporateCurrency ?? 'GBP';
    const currencyRows: Array<[string, number, boolean]> = [
      [corp, 1, true],
      ...(corp === 'GBP'
        ? ([['USD', 1.27, false], ['EUR', 1.17, false]] as Array<[string, number, boolean]>)
        : [])
    ];
    for (const [iso, rate, isCorp] of currencyRows) {
      await c.query(
        `INSERT INTO currency_type (iso_code, conversion_rate, is_corporate) VALUES ($1,$2,$3)
         ON CONFLICT (iso_code) DO NOTHING`,
        [iso, rate, isCorp]
      );
    }

    // Profiles
    const adminProfileId = generateId(KEY_PREFIXES.Profile);
    const standardProfileId = generateId(KEY_PREFIXES.Profile);
    const readOnlyProfileId = generateId(KEY_PREFIXES.Profile);
    await c.query(
      `INSERT INTO profile (id, name, description, is_custom, perms) VALUES
       ($1,'System Administrator','Full access to the org', false, $4),
       ($2,'Standard User','Create/edit CRM records', false, $5),
       ($3,'Read Only','View-only access', false, $6)`,
      [
        adminProfileId,
        standardProfileId,
        readOnlyProfileId,
        JSON.stringify(ADMIN_PERMS),
        JSON.stringify(STANDARD_PERMS),
        JSON.stringify({ ...STANDARD_PERMS, sendEmail: false, exportReports: false, manageReports: false })
      ]
    );

    // Object perms for non-admin profiles (admin implied by modifyAllData).
    if (!opts.skipStandardInstall) {
      for (const spec of STANDARD_OBJECTS) {
        const isUserObj = spec.apiName === 'User';
        await c.query(
          `INSERT INTO object_perm (id, parent_id, object_api, can_create, can_read, can_edit, can_delete)
           VALUES ($1,$2,$3,$4,true,$5,$6), ($7,$8,$9,false,true,false,false)`,
          [
            generateId('0PS'),
            standardProfileId,
            spec.apiName,
            !isUserObj,
            !isUserObj,
            !isUserObj,
            generateId('0PS'),
            readOnlyProfileId,
            spec.apiName
          ]
        );
      }
    }

    // Role hierarchy root
    const rootRoleId = generateId(KEY_PREFIXES.UserRole);
    await c.query(`INSERT INTO role (id, api_name, name, parent_id) VALUES ($1,'ClubDirector','Club Director',NULL)`, [rootRoleId]);

    // Admin user
    const adminUserId = generateId(KEY_PREFIXES.User);
    const fullName = [opts.adminFirstName, opts.adminLastName].filter(Boolean).join(' ');
    await rawInsert(c, 'User', adminUserId, fullName, {
      Username: opts.adminUsername,
      Email: opts.adminEmail,
      FirstName: opts.adminFirstName ?? null,
      LastName: opts.adminLastName,
      Alias: (opts.adminFirstName?.[0] ?? '') + opts.adminLastName.slice(0, 4),
      IsActive: true,
      ProfileId: adminProfileId,
      UserRoleId: rootRoleId,
      TimeZoneSidKey: opts.defaultTimezone ?? 'Europe/London',
      LocaleSidKey: opts.defaultLocale ?? 'en_GB',
      LanguageLocaleKey: 'en_US',
      DefaultCurrencyIsoCode: opts.corporateCurrency ?? 'GBP'
    });
    await c.query(`INSERT INTO auth_credential (user_id, password_hash) VALUES ($1,$2)`, [
      adminUserId,
      hashPassword(opts.adminPassword)
    ]);

    // Default connected app for API access (client secret printed once by seed tooling).
    const clientSecret = randomToken(24);
    await c.query(
      `INSERT INTO oauth_client (id, client_id, client_secret_hash, name, redirect_uris)
       VALUES ($1,'meridian-api',$2,'Meridian API Client', $3)`,
      [generateId(KEY_PREFIXES.OauthClient), sha256(clientSecret), JSON.stringify(['http://localhost:5173/oauth/callback'])]
    );
    await c.query(
      `INSERT INTO org_pref (key, value) VALUES ('bootstrapClientSecret', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(clientSecret)]
    );

    // Default apps
    if (!opts.skipStandardInstall) {
      await c.query(
        `INSERT INTO app_def (id, api_name, label, description, logo_letter, color, nav_items, is_default, is_custom) VALUES
         ($1,'Sales','Sales','Manage your sales process','S','#1B96FF',$3,true,false),
         ($2,'Service','Service','Support members and resolve cases','V','#9050E9',$4,false,false)`,
        [
          generateId(KEY_PREFIXES.AppDefinition),
          generateId(KEY_PREFIXES.AppDefinition),
          JSON.stringify([
            { type: 'page', target: 'home', label: 'Home' },
            { type: 'object', target: 'Lead' },
            { type: 'object', target: 'Account' },
            { type: 'object', target: 'Contact' },
            { type: 'object', target: 'Opportunity' },
            { type: 'object', target: 'Campaign' },
            { type: 'object', target: 'Task' },
            { type: 'page', target: 'reports', label: 'Reports' },
            { type: 'page', target: 'dashboards', label: 'Dashboards' }
          ]),
          JSON.stringify([
            { type: 'page', target: 'home', label: 'Home' },
            { type: 'object', target: 'Case' },
            { type: 'object', target: 'Account' },
            { type: 'object', target: 'Contact' },
            { type: 'object', target: 'Task' },
            { type: 'page', target: 'reports', label: 'Reports' },
            { type: 'page', target: 'dashboards', label: 'Dashboards' }
          ])
        ]
      );
    }

    // Recycled-bin purge + weekly export cron entries
    await c.query(
      `INSERT INTO cron_job (id, name, kind, cron_expr, payload, active) VALUES
       ($1,'Purge Recycle Bin','purgeRecycleBin','0 3 * * *','{"olderThanDays":15}',true),
       ($2,'Weekly Data Export','weeklyExport','0 4 * * 0','{}',true)`,
      [generateId(KEY_PREFIXES.CronJob), generateId(KEY_PREFIXES.CronJob)]
    );

    return { adminUserId, adminProfileId, standardProfileId, readOnlyProfileId };
  });

  await db.query(`INSERT INTO sys.user_directory (username, org_id, user_id) VALUES ($1,$2,$3)`, [
    opts.adminUsername,
    orgId,
    result.adminUserId
  ]);

  invalidateOrgMeta(orgId);
  return { orgId, schema, ...result };
}
