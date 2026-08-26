/**
 * SOSL abstract syntax tree.
 *
 * The search expression inside `FIND {…}` is kept as a tree rather than a string so it can be
 * compiled to a Postgres `tsquery` with each lexeme quoted individually — the term never reaches
 * SQL as text, so a search for `') OR 1=1 --` is just a word.
 */

import type { SoqlQuery } from '../soql/ast.js';

/** `IN NAME FIELDS` and friends. Maps onto the weights the index writes. */
export type SearchGroup = 'ALL' | 'NAME' | 'EMAIL' | 'PHONE' | 'SIDEBAR';

export type SearchExpr =
  | { kind: 'and'; items: SearchExpr[] }
  | { kind: 'or'; items: SearchExpr[] }
  | { kind: 'not'; item: SearchExpr }
  /** A bare word. `wildcard` is set by a trailing `*`, which becomes a prefix match. */
  | { kind: 'term'; value: string; wildcard: boolean }
  /** A quoted "phrase search" — the words must be adjacent, in order. */
  | { kind: 'phrase'; words: string[] };

export interface ReturningClause {
  objectApi: string;
  /**
   * The RETURNING body, already parsed as an ordinary SOQL query against this object. SOSL's
   * `Account(Id, Name WHERE … ORDER BY … LIMIT n)` is SOQL with the clauses rearranged, so it is
   * handed to the SOQL parser verbatim rather than reimplemented here.
   */
  query: SoqlQuery;
}

export interface SoslQuery {
  find: SearchExpr;
  group: SearchGroup;
  /** Empty means "every searchable object", as Salesforce does when RETURNING is omitted. */
  returning: ReturningClause[];
  /** Overall cap across all objects. */
  limit?: number;
  /** WITH DIVISION / DATA CATEGORY etc. are accepted and ignored; recorded so callers can tell. */
  withClauses: string[];
}
