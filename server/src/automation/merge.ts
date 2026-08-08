import type { ObjectMeta } from '../metadata/types.js';

export interface MergeSources {
  object: ObjectMeta;
  record: Record<string, any>;
  userName?: string;
  orgName?: string;
}

/**
 * Substitute {!Field}, {!Object.Field}, {!$User.Name} and {!$Organization.Name} in template text.
 *
 * An unresolved merge field renders empty rather than leaving the raw token in an email a member
 * would read.
 */
export function mergeFields(template: string, sources: MergeSources): string {
  return template.replace(/\{!\s*([^}]+?)\s*\}/g, (_whole, expr: string) => {
    const path = String(expr);

    if (path.startsWith('$User.')) return sources.userName ?? '';
    if (path.startsWith('$Organization.')) return sources.orgName ?? '';

    const segments = path.split('.');
    // "Contact.FirstName" on a Contact record means the record's own field.
    const local =
      segments.length > 1 && segments[0].toLowerCase() === sources.object.apiName.toLowerCase()
        ? segments.slice(1).join('.')
        : path;

    const value = sources.record[local];
    if (value === null || value === undefined) return '';
    return String(value);
  });
}
