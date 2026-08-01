import { config } from '../config.js';
import { Errors } from '../util/errors.js';

export type LimitKind = 'soqlQueries' | 'queryRows' | 'dmlStatements' | 'dmlRows' | 'cpuMs' | 'emails';

export interface LimitUsage {
  soqlQueries: number;
  queryRows: number;
  dmlStatements: number;
  dmlRows: number;
  cpuMs: number;
  emails: number;
}

/**
 * Per-transaction governor limits, carried through every engine call.
 *
 * Deliberately introduced before anything consumes it: threading a counter through thousands of
 * signatures after the fact is a rewrite, adding one now costs a parameter.
 */
export class LimitContext {
  readonly max: LimitUsage;
  private readonly used: LimitUsage = {
    soqlQueries: 0,
    queryRows: 0,
    dmlStatements: 0,
    dmlRows: 0,
    cpuMs: 0,
    emails: 0
  };
  private readonly startedAt = Date.now();

  constructor(overrides: Partial<LimitUsage> = {}) {
    this.max = { ...config.limits, ...overrides };
  }

  /** Record usage against a limit, throwing LIMIT_EXCEEDED if it would breach. */
  consume(kind: Exclude<LimitKind, 'cpuMs'>, n = 1): void {
    const next = this.used[kind] + n;
    if (next > this.max[kind]) {
      throw Errors.limitExceeded(`${kind} (max ${this.max[kind]})`);
    }
    this.used[kind] = next;
    this.checkCpu();
  }

  /** Wall-clock stands in for CPU time; checked opportunistically on every consume. */
  checkCpu(): void {
    const elapsed = Date.now() - this.startedAt;
    this.used.cpuMs = elapsed;
    if (elapsed > this.max.cpuMs) throw Errors.limitExceeded(`cpuMs (max ${this.max.cpuMs})`);
  }

  usage(): LimitUsage {
    return { ...this.used, cpuMs: Date.now() - this.startedAt };
  }

  remaining(kind: Exclude<LimitKind, 'cpuMs'>): number {
    return this.max[kind] - this.used[kind];
  }

  /** Salesforce /limits response shape for the per-transaction limits. */
  toLimitsBody(): Record<string, { Max: number; Remaining: number }> {
    const u = this.usage();
    const entry = (k: keyof LimitUsage) => ({ Max: this.max[k], Remaining: Math.max(0, this.max[k] - u[k]) });
    return {
      DailyApiRequests: { Max: config.dailyApiRequests, Remaining: config.dailyApiRequests },
      SoqlQueries: entry('soqlQueries'),
      QueryRows: entry('queryRows'),
      DmlStatements: entry('dmlStatements'),
      DmlRows: entry('dmlRows'),
      SingleEmail: entry('emails')
    };
  }
}
