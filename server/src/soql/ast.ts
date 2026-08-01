/** SOQL abstract syntax tree. Field paths are kept as segments so relationship traversal is explicit. */

export type AggregateFn = 'COUNT' | 'COUNT_DISTINCT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

export type SelectItem =
  | { kind: 'field'; path: string[]; alias?: string }
  | { kind: 'aggregate'; fn: AggregateFn; path: string[] | null; alias?: string }
  | { kind: 'subquery'; relationship: string; query: SoqlQuery };

export type LiteralValue =
  | { t: 'string'; v: string }
  | { t: 'number'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'date'; v: string }
  | { t: 'datetime'; v: string }
  /** TODAY, LAST_N_DAYS:30 … resolved to a range at compile time. */
  | { t: 'dateLiteral'; name: string; n?: number };

export type Condition =
  | { kind: 'and'; items: Condition[] }
  | { kind: 'or'; items: Condition[] }
  | { kind: 'not'; item: Condition }
  | { kind: 'cmp'; path: string[]; op: CompareOp; value: LiteralValue }
  /** HAVING COUNT(Id) > 1 — an aggregate on the left of the comparison. */
  | { kind: 'cmpAgg'; fn: AggregateFn; path: string[] | null; op: CompareOp; value: LiteralValue }
  | { kind: 'in'; path: string[]; not: boolean; values: LiteralValue[] }
  /** Semi-join: WHERE Id IN (SELECT ContactId FROM Membership__c) */
  | { kind: 'semiJoin'; path: string[]; not: boolean; query: SoqlQuery }
  | { kind: 'includes'; path: string[]; not: boolean; values: LiteralValue[] };

export type CompareOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'LIKE';

export interface OrderItem {
  path: string[];
  dir: 'ASC' | 'DESC';
  nulls: 'FIRST' | 'LAST' | null;
}

export interface SoqlQuery {
  select: SelectItem[];
  from: string;
  /** USING SCOPE mine | everything | delegated … */
  scope?: string;
  where?: Condition;
  groupBy?: string[][];
  having?: Condition;
  orderBy?: OrderItem[];
  limit?: number;
  offset?: number;
  forUpdate?: boolean;
  /** queryAll: include soft-deleted rows. */
  includeDeleted?: boolean;
}

export function isAggregateQuery(q: SoqlQuery): boolean {
  return !!q.groupBy?.length || q.select.some((s) => s.kind === 'aggregate');
}
