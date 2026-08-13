/** Five-field cron: minute hour day-of-month month day-of-week. */

interface CronField {
  /** Values this field matches, or null for "*" (every value). */
  values: Set<number> | null;
}

interface CronSpec {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const RANGES: Record<keyof CronSpec, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6]
};

const NAMED: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *'
};

function parseField(raw: string, [min, max]: [number, number]): CronField {
  if (raw === '*') return { values: null };

  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [spec, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step in "${raw}"`);

    let from = min;
    let to = max;
    if (spec !== '*') {
      const [lo, hi] = spec.split('-');
      from = Number(lo);
      to = hi === undefined ? (stepText ? max : from) : Number(hi);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
        throw new Error(`Invalid cron range "${part}" (expected ${min}-${max})`);
      }
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values };
}

export function parseCron(expression: string): CronSpec {
  const normalised = NAMED[expression.trim().toLowerCase()] ?? expression.trim();
  const fields = normalised.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression "${expression}": expected 5 fields, got ${fields.length}`);
  }
  return {
    minute: parseField(fields[0], RANGES.minute),
    hour: parseField(fields[1], RANGES.hour),
    dayOfMonth: parseField(fields[2], RANGES.dayOfMonth),
    month: parseField(fields[3], RANGES.month),
    dayOfWeek: parseField(fields[4], RANGES.dayOfWeek)
  };
}

const matches = (field: CronField, value: number): boolean => field.values === null || field.values.has(value);

function matchesAt(spec: CronSpec, date: Date): boolean {
  if (!matches(spec.minute, date.getUTCMinutes())) return false;
  if (!matches(spec.hour, date.getUTCHours())) return false;
  if (!matches(spec.month, date.getUTCMonth() + 1)) return false;

  // Standard cron quirk: when both day fields are restricted, either one matching is enough.
  const domRestricted = spec.dayOfMonth.values !== null;
  const dowRestricted = spec.dayOfWeek.values !== null;
  const domMatch = matches(spec.dayOfMonth, date.getUTCDate());
  const dowMatch = matches(spec.dayOfWeek, date.getUTCDay());

  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/**
 * The first minute strictly after `from` that the expression matches.
 *
 * Scans forward a minute at a time, bounded to four years so an unsatisfiable expression such as
 * "0 0 30 2 *" returns null rather than looping.
 */
export function nextRun(expression: string, from: Date = new Date()): Date | null {
  const spec = parseCron(expression);
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const limit = 4 * 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matchesAt(spec, cursor)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}
