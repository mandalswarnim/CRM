import { createEphemeralDb, withTenantClient, type Db } from '../src/db/index.js';
import { createOrg, type ProvisionedOrg } from '../src/db/provision.js';
import { loadOrgMeta } from '../src/metadata/registry.js';
import type { OrgMeta } from '../src/metadata/types.js';

export interface TestOrg extends ProvisionedOrg {
  db: Db;
  meta: () => Promise<OrgMeta>;
  tenant: <T>(fn: (c: import('../src/db/index.js').DbClient) => Promise<T>) => Promise<T>;
}

let shared: TestOrg | null = null;

/** Provision one org per test process (PGlite in-memory) and reuse it. */
export async function testOrg(): Promise<TestOrg> {
  if (shared) return shared;
  const db = await createEphemeralDb();
  const org = await createOrg(db, {
    name: 'The Larkspur Club',
    adminUsername: 'admin@larkspur.club',
    adminEmail: 'admin@larkspur.club',
    adminFirstName: 'Ada',
    adminLastName: 'Pemberton',
    adminPassword: 'Larkspur#1905'
  });
  shared = {
    ...org,
    db,
    meta: () => loadOrgMeta(db, org.orgId, org.schema),
    tenant: (fn) => withTenantClient(db, org.schema, fn)
  };
  return shared;
}
