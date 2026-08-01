import type { FieldMeta, ObjectMeta } from '../metadata/types.js';
import { normalizeId } from '../util/ids.js';
import { Errors } from '../util/errors.js';

/** Field types the platform computes; never accepted from a caller. */
const DERIVED_TYPES = new Set(['Formula', 'RollupSummary', 'AutoNumber']);

/** System fields a caller may set; the rest are the pipeline's to write. */
const WRITABLE_SYSTEM_FIELDS = new Set(['OwnerId', 'RecordTypeId', 'CurrencyIsoCode']);

export function isWritable(f: FieldMeta): boolean {
  if (DERIVED_TYPES.has(f.type)) return false;
  if (f.isSystem) return WRITABLE_SYSTEM_FIELDS.has(f.apiName);
  return true;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?Z?$/;
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

function asString(field: string, v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw Errors.invalidValue(field, 'expected a string value');
}

function asNumber(field: string, v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw Errors.invalidValue(field, `invalid number value: ${String(v)}`);
  return n;
}

/**
 * Coerce and validate one caller-supplied value against its field definition.
 *
 * Returns the canonical storage form. Everything that can be checked without touching the database
 * happens here; lookup existence and uniqueness need queries and run later in the pipeline.
 */
export function coerceValue(obj: ObjectMeta, f: FieldMeta, raw: unknown): unknown {
  const field = f.apiName;
  if (raw === null || raw === undefined || raw === '') {
    if (f.type === 'Checkbox') return false;
    return null;
  }

  switch (f.type) {
    case 'Text':
    case 'TextArea':
    case 'LongTextArea':
    case 'RichText': {
      const s = asString(field, raw);
      const max = f.length ?? (f.type === 'Text' ? 255 : f.type === 'TextArea' ? 255 : 131072);
      if (s.length > max) throw Errors.stringTooLong(field, max);
      return s;
    }

    case 'Email': {
      const s = asString(field, raw).trim();
      if (!EMAIL.test(s)) throw Errors.invalidValue(field, `invalid email address: ${s}`);
      if (s.length > (f.length ?? 80)) throw Errors.stringTooLong(field, f.length ?? 80);
      return s;
    }

    case 'Phone': {
      const s = asString(field, raw).trim();
      if (s.length > (f.length ?? 40)) throw Errors.stringTooLong(field, f.length ?? 40);
      return s;
    }

    case 'Url': {
      const s = asString(field, raw).trim();
      const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
      try {
        // eslint-disable-next-line no-new
        new URL(candidate);
      } catch {
        throw Errors.invalidValue(field, `invalid URL: ${s}`);
      }
      if (candidate.length > (f.length ?? 255)) throw Errors.stringTooLong(field, f.length ?? 255);
      return candidate;
    }

    case 'Checkbox': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      throw Errors.invalidValue(field, `invalid boolean value: ${String(raw)}`);
    }

    case 'Number':
    case 'Currency':
    case 'Percent': {
      const n = asNumber(field, raw);
      const scale = f.scale ?? (f.type === 'Number' ? 0 : 2);
      const rounded = Number(n.toFixed(scale));
      if (f.precision != null) {
        const intDigits = Math.floor(Math.abs(rounded)).toString().replace('-', '').length;
        if (intDigits > f.precision - scale) {
          throw Errors.invalidValue(field, `value exceeds the field's precision (${f.precision},${scale})`);
        }
      }
      return rounded;
    }

    case 'Date': {
      if (raw instanceof Date) return raw.toISOString().slice(0, 10);
      const s = asString(field, raw).trim();
      if (ISO_DATE.test(s)) return s;
      const parsed = Date.parse(s);
      if (Number.isNaN(parsed)) throw Errors.invalidValue(field, `invalid date value: ${s}`);
      return new Date(parsed).toISOString().slice(0, 10);
    }

    case 'DateTime': {
      if (raw instanceof Date) return raw.toISOString();
      const s = asString(field, raw).trim();
      const parsed = Date.parse(ISO_DATE.test(s) ? `${s}T00:00:00Z` : s);
      if (Number.isNaN(parsed)) throw Errors.invalidValue(field, `invalid datetime value: ${s}`);
      return new Date(parsed).toISOString();
    }

    case 'Time': {
      const s = asString(field, raw).trim();
      if (!ISO_TIME.test(s)) throw Errors.invalidValue(field, `invalid time value: ${s}`);
      const [h, m, rest] = s.replace('Z', '').split(':');
      return `${h.padStart(2, '0')}:${m}:${(rest ?? '00').padStart(2, '0')}`.slice(0, 8);
    }

    case 'Picklist': {
      const s = asString(field, raw);
      if (f.restrictedPicklist && f.picklist && !f.picklist.some((p) => p.value === s && p.isActive)) {
        throw Errors.badPicklist(field, s);
      }
      return s;
    }

    case 'MultiselectPicklist': {
      const parts = (Array.isArray(raw) ? raw.map((x) => asString(field, x)) : asString(field, raw).split(';'))
        .map((p) => p.trim())
        .filter((p) => p !== '');
      if (f.restrictedPicklist && f.picklist) {
        for (const p of parts) {
          if (!f.picklist.some((v) => v.value === p && v.isActive)) throw Errors.badPicklist(field, p);
        }
      }
      return parts.join(';');
    }

    case 'Lookup':
    case 'MasterDetail': {
      const s = asString(field, raw).trim();
      const id = normalizeId(s);
      if (!id) throw Errors.malformedId(field, s);
      return id;
    }

    case 'Geolocation': {
      const v = typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
      const lat = asNumber(field, v?.latitude);
      const lon = asNumber(field, v?.longitude);
      if (lat < -90 || lat > 90) throw Errors.invalidValue(field, 'latitude must be between -90 and 90');
      if (lon < -180 || lon > 180) throw Errors.invalidValue(field, 'longitude must be between -180 and 180');
      return { latitude: lat, longitude: lon };
    }

    default:
      return raw;
  }
}

/** Objects whose Name is composed from FirstName/LastName rather than written directly. */
export function hasCompoundName(obj: ObjectMeta): boolean {
  return obj.fields.has('firstname') && obj.fields.has('lastname');
}

export function composeName(obj: ObjectMeta, fields: Record<string, unknown>): string | null {
  if (!hasCompoundName(obj)) return null;
  const first = (fields.FirstName as string | null) ?? '';
  const last = (fields.LastName as string | null) ?? '';
  return [first, last].filter((p) => p && String(p).trim() !== '').join(' ') || null;
}

/**
 * Expand an auto-number format: {0}/{000} become the padded sequence, {YYYY}/{YY}/{MM}/{DD} the
 * current date parts. A format with no sequence token gets the number appended.
 */
export function formatAutoNumber(format: string, seq: number, now = new Date()): string {
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  let sawSequence = false;
  const out = format.replace(/\{([^}]*)\}/g, (_m, token: string) => {
    switch (token) {
      case 'YYYY':
        return String(now.getUTCFullYear());
      case 'YY':
        return pad(now.getUTCFullYear() % 100, 2);
      case 'MM':
        return pad(now.getUTCMonth() + 1, 2);
      case 'DD':
        return pad(now.getUTCDate(), 2);
      default:
        if (/^0+$/.test(token)) {
          sawSequence = true;
          return pad(seq, token.length);
        }
        return token;
    }
  });
  return sawSequence ? out : out + seq;
}
