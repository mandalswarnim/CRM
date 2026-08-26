import { Errors } from '../util/errors.js';
import type { SearchExpr, SearchGroup } from './ast.js';

/**
 * Compile a parsed search expression to a Postgres `tsquery` string.
 *
 * The result is always passed to `to_tsquery('simple', $n)` as a **bind parameter**, never
 * interpolated into SQL. Every lexeme is single-quoted with internal quotes doubled, so a term
 * like `') OR 1=1 --` compiles to the harmless lexeme `''') or 1=1 --'`.
 */

/** Characters that are operators to tsquery and must not survive inside a lexeme. */
const TSQUERY_SPECIAL = /[&|!()<>:*'\\]/g;

function lexeme(word: string): string {
  // Strip tsquery's own operators from the word, then quote what is left. Stripping rather than
  // escaping keeps `AT&T` searchable as the two lexemes Postgres would index it as.
  const cleaned = word.replace(TSQUERY_SPECIAL, ' ').trim();
  if (!cleaned) throw Errors.malformedSearch(`'${word}' contains no searchable characters`);
  // A term the tokeniser would split (e.g. "oriental club") becomes an adjacency match, which is
  // what a user typing it as one term means.
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return parts.map((p) => `'${p.replace(/'/g, "''")}'`).join(' <-> ');
}

function compile(expr: SearchExpr): string {
  switch (expr.kind) {
    case 'and':
      return '(' + expr.items.map(compile).join(' & ') + ')';
    case 'or':
      return '(' + expr.items.map(compile).join(' | ') + ')';
    case 'not':
      return '!(' + compile(expr.item) + ')';
    case 'phrase':
      return '(' + expr.words.map(lexeme).join(' <-> ') + ')';
    case 'term': {
      const base = lexeme(expr.value);
      if (!expr.wildcard) return base;
      // Only the final lexeme takes the prefix marker.
      const idx = base.lastIndexOf(' <-> ');
      return idx < 0 ? `${base}:*` : `${base.slice(0, idx + 5)}${base.slice(idx + 5)}:*`;
    }
  }
}

export function toTsQuery(expr: SearchExpr): string {
  return compile(expr);
}

/**
 * The `ts_rank` weight mask for a search group, in Postgres's `{D,C,B,A}` order.
 *
 * Filtering on `ts_rank(mask, tsv, query) > 0` restricts a match to the requested kind of field:
 * `tsv @@ query` says the record matched somewhere, the mask says it matched *there*.
 */
export function weightMask(group: SearchGroup): string {
  switch (group) {
    case 'NAME':
    case 'SIDEBAR':
      return '{0,0,0,1}';
    case 'EMAIL':
      return '{0,1,0,0}';
    case 'PHONE':
      return '{1,0,0,0}';
    case 'ALL':
      return '{1,1,1,1}';
  }
}

/** Ranking weights: a hit on the name outranks one buried in a text area. */
export const RANK_WEIGHTS = '{0.2,0.4,0.4,1.0}';
