import { Errors } from '../util/errors.js';

/**
 * Folding a resource into the allocation range.
 *
 * Postgres can enforce "no two overlapping bookings of the same thing" with
 * `EXCLUDE USING gist (resource_id WITH =, span WITH &&)` — but the `=` operator on a text column
 * needs the `btree_gist` extension, which **PGlite does not have**. Since every test runs against
 * PGlite, taking that route would leave the one guarantee that matters untested.
 *
 * So the resource is folded into the range instead. Each resource owns a contiguous, private
 * band of the number line:
 *
 *     span = [ordinal × STRIDE + startStep, ordinal × STRIDE + endStep)
 *
 * Two ranges from different resources can never overlap, because their bands do not. A single
 * `EXCLUDE USING gist (span WITH &&)` — no extension required — then means exactly
 * "no double booking", and behaves identically on the embedded driver and on real Postgres.
 */

/** Minutes are the unit; a day grain is just 1440 of them. */
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1440;

/**
 * The width of one resource's band, in minutes.
 *
 * 4×10⁹ minutes is roughly 7,600 years, so a step index can never escape its band. With int8's
 * ceiling that still leaves room for ~2.3×10⁹ resources in an org.
 */
export const STRIDE = 4_000_000_000n;

/** Steps must stay inside a band, which is what bounds the supported date range. */
const MAX_STEP = Number(STRIDE) - 1;

export type Grain = 'minute' | 'day';

/**
 * Convert an instant to its step index.
 *
 * A day grain floors to midnight UTC, so a stay from the 1st to the 5th occupies steps for the
 * nights of the 1st–4th and frees the 5th for the next guest — the `[)` half-open convention
 * doing the work that check-out times would otherwise need special-casing for.
 */
export function stepFor(at: Date, grain: Grain): number {
  const minutes = Math.floor(at.getTime() / MS_PER_MINUTE);
  const step = grain === 'day' ? Math.floor(minutes / MINUTES_PER_DAY) : minutes;
  if (!Number.isFinite(step)) throw Errors.invalidOperation(`'${at}' is not a bookable date`);
  if (step < 0) {
    throw Errors.invalidOperation('bookings before 1970 are outside the allocatable range');
  }
  if (step > MAX_STEP) {
    throw Errors.invalidOperation('that date is beyond the allocatable range');
  }
  return step;
}

/**
 * Every grain step a span touches — the rows a pool booking must decrement.
 *
 * The end is exclusive, so a stay ending exactly on a step boundary does not occupy that step:
 * checking out on the 5th leaves the night of the 5th free to sell.
 */
export function stepsBetween(starts: Date, ends: Date, grain: Grain): number[] {
  const from = stepFor(starts, grain);
  const endStep = stepFor(ends, grain);
  const last = Math.max(from, isBoundary(ends, grain) ? endStep - 1 : endStep);
  const out: number[] = [];
  for (let s = from; s <= last; s++) out.push(s);
  return out;
}

function isBoundary(at: Date, grain: Grain): boolean {
  const minutes = at.getTime() / MS_PER_MINUTE;
  if (!Number.isInteger(minutes)) return false;
  return grain === 'day' ? minutes % MINUTES_PER_DAY === 0 : true;
}

/**
 * The `int8range` literal for one allocation, as Postgres will store it.
 *
 * Half-open `[)` throughout: back-to-back bookings touch but never overlap, so the guest arriving
 * the morning someone else leaves is not turned away.
 */
export function encodeSpan(ordinal: bigint, starts: Date, ends: Date, grain: Grain): string {
  const base = ordinal * STRIDE;
  const from = base + BigInt(stepFor(starts, grain));
  let to = base + BigInt(stepFor(ends, grain));
  // A zero-width range would exclude nothing, so a same-step booking still claims its step.
  if (to <= from) to = from + 1n;
  return `[${from},${to})`;
}

/** Decode for tests and diagnostics: which resource band, and which steps. */
export function decodeSpan(span: string): { ordinal: bigint; from: number; to: number } {
  const m = /^\[(-?\d+),(-?\d+)\)$/.exec(span.trim());
  if (!m) throw Errors.invalidOperation(`'${span}' is not an encoded allocation span`);
  const from = BigInt(m[1]);
  const to = BigInt(m[2]);
  const ordinal = from / STRIDE;
  return { ordinal, from: Number(from - ordinal * STRIDE), to: Number(to - ordinal * STRIDE) };
}
