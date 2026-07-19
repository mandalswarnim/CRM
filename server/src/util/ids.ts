import crypto from 'node:crypto';

/**
 * Salesforce-style record IDs: 15-character case-sensitive base-62 with a 3-character
 * key prefix identifying the object, plus the standard 3-character checksum suffix that
 * makes the case-insensitive 18-character form.
 */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CHECK_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/** Well-known key prefixes for standard objects (matching Salesforce where one exists). */
export const KEY_PREFIXES: Record<string, string> = {
  Organization: '00D',
  User: '005',
  Account: '001',
  Contact: '003',
  Lead: '00Q',
  Opportunity: '006',
  OpportunityLineItem: '00k',
  Product2: '01t',
  Pricebook2: '01s',
  PricebookEntry: '01u',
  Case: '500',
  CaseComment: '00a',
  Campaign: '701',
  CampaignMember: '00v',
  Task: '00T',
  Event: '00U',
  EmailMessage: '02s',
  ContentDocument: '069',
  ContentVersion: '068',
  ContentDocumentLink: '06A',
  FeedItem: '0D5',
  FeedComment: '0D7',
  Profile: '00e',
  PermissionSet: '0PS',
  PermissionSetAssignment: '0Pa',
  UserRole: '00E',
  Group: '00G',
  Report: '00O',
  Dashboard: '01Z',
  ListView: '00B',
  RecordType: '012',
  EmailTemplate: '00X',
  Flow: '300',
  WorkflowRule: '01Q',
  ApprovalProcess: '04a',
  ProcessInstanceWorkitem: '04i',
  PushTopic: '0IF',
  AppDefinition: '02u',
  Layout: '00h',
  ValidationRule: '03d',
  CustomObjectDef: '01I',
  CustomFieldDef: '00N',
  SharingRule: '02c',
  Package: '033',
  ChangeSet: '04s',
  CronJob: '08e',
  OauthClient: '0CI'
};

export function generateId(keyPrefix: string): string {
  if (!/^[0-9a-zA-Z]{3}$/.test(keyPrefix)) throw new Error(`Bad key prefix: ${keyPrefix}`);
  let suffix = '';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) suffix += BASE62[bytes[i] % 62];
  return to18(keyPrefix + suffix);
}

/** Compute the 18-character form from a 15-character id (standard Salesforce algorithm). */
export function to18(id15: string): string {
  if (id15.length === 18) return id15;
  if (id15.length !== 15) throw new Error(`Bad id length: ${id15}`);
  let out = id15;
  for (let block = 0; block < 3; block++) {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const ch = id15[block * 5 + i];
      if (ch >= 'A' && ch <= 'Z') value |= 1 << i;
    }
    out += CHECK_CHARS[value];
  }
  return out;
}

/** Normalise a 15- or 18-char id to the 18-char canonical form; returns null if invalid. */
export function normalizeId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (typeof id !== 'string') return null;
  if (id.length === 15) return to18(id);
  if (id.length === 18) return to18(id.slice(0, 15));
  return null;
}

export function keyPrefixOf(id: string): string {
  return id.slice(0, 3);
}

/** Allocate the next custom-object key prefix: a00, a01 … a0z, a10 … */
export function nextCustomPrefix(existing: string[]): string {
  const taken = new Set(existing);
  for (let i = 0; i < 62 * 62; i++) {
    const p = 'a' + BASE62[Math.floor(i / 62)] + BASE62[i % 62];
    if (!taken.has(p)) return p;
  }
  throw new Error('Exhausted custom key prefixes');
}

/** Schema name for an org id (lower-cased, base62 15-char ids are case sensitive so encode). */
export function schemaNameForOrg(orgId18: string): string {
  // Case-sensitivity would be lost in identifiers; hex-encode the 15-char id to stay unique.
  return 'org_' + Buffer.from(orgId18.slice(0, 15), 'utf8').toString('hex');
}
