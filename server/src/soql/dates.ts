/** Salesforce date literals resolved to a half-open [start, end) range in the org timezone. */

export interface DateRange {
  start: string;
  end: string;
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + n);
  return out;
}

/** Week starts on Sunday, matching Salesforce's default. */
function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  return addDays(s, -s.getUTCDay());
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function startOfQuarter(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
}

function startOfYear(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

const iso = (d: Date) => d.toISOString();

export function resolveDateLiteral(name: string, n: number | undefined, now = new Date()): DateRange {
  const today = startOfDay(now);

  switch (name) {
    case 'YESTERDAY':
      return { start: iso(addDays(today, -1)), end: iso(today) };
    case 'TODAY':
      return { start: iso(today), end: iso(addDays(today, 1)) };
    case 'TOMORROW':
      return { start: iso(addDays(today, 1)), end: iso(addDays(today, 2)) };

    case 'THIS_WEEK':
      return { start: iso(startOfWeek(today)), end: iso(addDays(startOfWeek(today), 7)) };
    case 'LAST_WEEK':
      return { start: iso(addDays(startOfWeek(today), -7)), end: iso(startOfWeek(today)) };
    case 'NEXT_WEEK':
      return { start: iso(addDays(startOfWeek(today), 7)), end: iso(addDays(startOfWeek(today), 14)) };

    case 'THIS_MONTH':
      return { start: iso(startOfMonth(today)), end: iso(addMonths(startOfMonth(today), 1)) };
    case 'LAST_MONTH':
      return { start: iso(addMonths(startOfMonth(today), -1)), end: iso(startOfMonth(today)) };
    case 'NEXT_MONTH':
      return { start: iso(addMonths(startOfMonth(today), 1)), end: iso(addMonths(startOfMonth(today), 2)) };

    case 'THIS_QUARTER':
      return { start: iso(startOfQuarter(today)), end: iso(addMonths(startOfQuarter(today), 3)) };
    case 'LAST_QUARTER':
      return { start: iso(addMonths(startOfQuarter(today), -3)), end: iso(startOfQuarter(today)) };
    case 'NEXT_QUARTER':
      return { start: iso(addMonths(startOfQuarter(today), 3)), end: iso(addMonths(startOfQuarter(today), 6)) };

    case 'THIS_YEAR':
      return { start: iso(startOfYear(today)), end: iso(addMonths(startOfYear(today), 12)) };
    case 'LAST_YEAR':
      return { start: iso(addMonths(startOfYear(today), -12)), end: iso(startOfYear(today)) };
    case 'NEXT_YEAR':
      return { start: iso(addMonths(startOfYear(today), 12)), end: iso(addMonths(startOfYear(today), 24)) };

    // LAST_N windows end at the end of today; NEXT_N windows start at the beginning of today.
    case 'LAST_90_DAYS':
      return { start: iso(addDays(today, -90)), end: iso(addDays(today, 1)) };
    case 'NEXT_90_DAYS':
      return { start: iso(today), end: iso(addDays(today, 91)) };

    case 'LAST_N_DAYS':
      return { start: iso(addDays(today, -(n ?? 0))), end: iso(addDays(today, 1)) };
    case 'NEXT_N_DAYS':
      return { start: iso(today), end: iso(addDays(today, (n ?? 0) + 1)) };
    case 'LAST_N_WEEKS':
      return { start: iso(addDays(startOfWeek(today), -7 * (n ?? 0))), end: iso(startOfWeek(today)) };
    case 'NEXT_N_WEEKS':
      return { start: iso(addDays(startOfWeek(today), 7)), end: iso(addDays(startOfWeek(today), 7 * ((n ?? 0) + 1))) };
    case 'LAST_N_MONTHS':
      return { start: iso(addMonths(startOfMonth(today), -(n ?? 0))), end: iso(startOfMonth(today)) };
    case 'NEXT_N_MONTHS':
      return { start: iso(addMonths(startOfMonth(today), 1)), end: iso(addMonths(startOfMonth(today), (n ?? 0) + 1)) };
    case 'LAST_N_QUARTERS':
      return { start: iso(addMonths(startOfQuarter(today), -3 * (n ?? 0))), end: iso(startOfQuarter(today)) };
    case 'NEXT_N_QUARTERS':
      return { start: iso(addMonths(startOfQuarter(today), 3)), end: iso(addMonths(startOfQuarter(today), 3 * ((n ?? 0) + 1))) };
    case 'LAST_N_YEARS':
      return { start: iso(addMonths(startOfYear(today), -12 * (n ?? 0))), end: iso(startOfYear(today)) };
    case 'NEXT_N_YEARS':
      return { start: iso(addMonths(startOfYear(today), 12)), end: iso(addMonths(startOfYear(today), 12 * ((n ?? 0) + 1))) };

    default:
      throw new Error(`Unknown date literal ${name}`);
  }
}
