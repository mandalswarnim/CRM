import { Errors } from '../util/errors.js';
import { tokenize, type Token } from '../soql/lexer.js';
import { parseSoql } from '../soql/parser.js';
import type { ReturningClause, SearchExpr, SearchGroup, SoslQuery } from './ast.js';

/**
 * Parse SOSL.
 *
 * `FIND {…}` is peeled off with a scan rather than the SOQL lexer, because the braces enclose a
 * free-text search expression with its own grammar (wildcards, phrases, escapes) that the SOQL
 * tokeniser has no reason to know about. Everything after it is ordinary SOQL-shaped syntax, so
 * the SOQL lexer handles it — and each RETURNING body is handed to `parseSoql` whole.
 */

const GROUPS: Record<string, SearchGroup> = {
  ALL: 'ALL',
  NAME: 'NAME',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  SIDEBAR: 'SIDEBAR'
};

/** Clause keywords that end the field list inside a RETURNING body. */
const BODY_CLAUSES = new Set(['WHERE', 'ORDER', 'LIMIT', 'OFFSET', 'USING', 'WITH']);

// ---------------------------------------------------------------- search term

/** A cursor over the raw text between the braces. */
class TermParser {
  private i = 0;
  constructor(private readonly src: string) {}

  parse(): SearchExpr {
    const expr = this.parseOr();
    this.skipSpace();
    if (this.i < this.src.length) {
      throw Errors.malformedSearch(`unexpected '${this.src[this.i]}' in search term at position ${this.i}`);
    }
    return expr;
  }

  private skipSpace(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  /** Consume `word` if it appears next as a standalone keyword. */
  private eatKeyword(word: string): boolean {
    this.skipSpace();
    const slice = this.src.slice(this.i, this.i + word.length);
    if (slice.toUpperCase() !== word) return false;
    const after = this.src[this.i + word.length];
    if (after !== undefined && !/[\s("]/.test(after)) return false;
    this.i += word.length;
    return true;
  }

  private atEnd(): boolean {
    this.skipSpace();
    return this.i >= this.src.length;
  }

  private parseOr(): SearchExpr {
    const items = [this.parseAnd()];
    while (this.eatKeyword('OR')) items.push(this.parseAnd());
    return items.length === 1 ? items[0] : { kind: 'or', items };
  }

  /**
   * Juxtaposed terms are ANDed: `{oriental club}` finds records containing both words. Salesforce
   * documents the same default, and it is what anyone typing two words into a search box expects.
   */
  private parseAnd(): SearchExpr {
    const items = [this.parseNot()];
    for (;;) {
      if (this.eatKeyword('AND')) {
        items.push(this.parseNot());
        continue;
      }
      this.skipSpace();
      // Another primary sitting next to this one, and not the start of an OR/closing paren.
      if (this.atEnd() || this.src[this.i] === ')') break;
      const save = this.i;
      if (this.eatKeyword('OR')) {
        this.i = save;
        break;
      }
      items.push(this.parseNot());
    }
    return items.length === 1 ? items[0] : { kind: 'and', items };
  }

  private parseNot(): SearchExpr {
    if (this.eatKeyword('NOT')) return { kind: 'not', item: this.parseNot() };
    return this.parsePrimary();
  }

  private parsePrimary(): SearchExpr {
    this.skipSpace();
    if (this.i >= this.src.length) throw Errors.malformedSearch('search term ended unexpectedly');

    if (this.src[this.i] === '(') {
      this.i++;
      const inner = this.parseOr();
      this.skipSpace();
      if (this.src[this.i] !== ')') throw Errors.malformedSearch('unclosed ( in search term');
      this.i++;
      return inner;
    }

    if (this.src[this.i] === '"') return this.parsePhrase();
    return this.parseWord();
  }

  private parsePhrase(): SearchExpr {
    this.i++; // opening quote
    let text = '';
    while (this.i < this.src.length && this.src[this.i] !== '"') {
      if (this.src[this.i] === '\\' && this.i + 1 < this.src.length) {
        text += this.src[this.i + 1];
        this.i += 2;
        continue;
      }
      text += this.src[this.i++];
    }
    if (this.i >= this.src.length) throw Errors.malformedSearch('unterminated phrase in search term');
    this.i++; // closing quote
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) throw Errors.malformedSearch('empty phrase in search term');
    return { kind: 'phrase', words };
  }

  private parseWord(): SearchExpr {
    let text = '';
    let wildcard = false;

    while (this.i < this.src.length) {
      const ch = this.src[this.i];
      if (/\s/.test(ch) || ch === ')' || ch === '(') break;
      if (ch === '\\' && this.i + 1 < this.src.length) {
        text += this.src[this.i + 1];
        this.i += 2;
        continue;
      }
      if (ch === '?') {
        throw Errors.malformedSearch(
          "single-character wildcard '?' is not supported; use '*' for a trailing wildcard"
        );
      }
      if (ch === '*') {
        if (text === '') {
          throw Errors.malformedSearch('a search term may not begin with the wildcard *');
        }
        // A '*' anywhere but the end would be an infix wildcard, which the index cannot answer.
        if (this.i + 1 < this.src.length && !/[\s)]/.test(this.src[this.i + 1])) {
          throw Errors.malformedSearch('the wildcard * is only supported at the end of a term');
        }
        wildcard = true;
        this.i++;
        continue;
      }
      text += ch;
      this.i++;
    }

    if (!text) throw Errors.malformedSearch('empty search term');
    return { kind: 'term', value: text, wildcard };
  }
}

// ---------------------------------------------------------------------- SOSL

class SoslParser {
  private toks: Token[];
  private i = 0;

  /** `src` is everything after the FIND clause; token positions index into it. */
  constructor(private readonly src: string) {
    this.toks = tokenize(src);
  }

  private peek(ahead = 0): Token {
    return this.toks[Math.min(this.i + ahead, this.toks.length - 1)];
  }

  private atKeyword(word: string): boolean {
    const t = this.peek();
    return t.kind === 'ident' && t.upper === word;
  }

  private eatKeyword(word: string): boolean {
    if (!this.atKeyword(word)) return false;
    this.i++;
    return true;
  }

  private eatPunct(ch: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.text === ch) {
      this.i++;
      return true;
    }
    return false;
  }

  private fail(what: string): never {
    const t = this.peek();
    throw Errors.malformedSearch(`expected ${what} but found '${t.text || '<end>'}' at position ${t.pos}`);
  }

  parse(find: SearchExpr): SoslQuery {
    const query: SoslQuery = { find, group: 'ALL', returning: [], withClauses: [] };

    if (this.eatKeyword('IN')) query.group = this.parseGroup();
    if (this.eatKeyword('RETURNING')) query.returning = this.parseReturning();
    while (this.atKeyword('WITH')) query.withClauses.push(this.skipWithClause());
    if (this.eatKeyword('LIMIT')) query.limit = this.parseInt();

    // UPDATE TRACKING / UPDATE VIEWSTAT are accepted and ignored — they tune Salesforce's search
    // ranking, which has no analogue here.
    if (this.eatKeyword('UPDATE')) while (this.peek().kind !== 'eof') this.i++;

    if (this.peek().kind !== 'eof') this.fail('end of search');
    return query;
  }

  private parseGroup(): SearchGroup {
    const t = this.peek();
    const group = GROUPS[t.upper];
    if (!group) this.fail('ALL, NAME, EMAIL, PHONE or SIDEBAR');
    this.i++;
    if (!this.eatKeyword('FIELDS')) this.fail("'FIELDS'");
    return group;
  }

  private parseInt(): number {
    const t = this.peek();
    if (t.kind !== 'number' || !/^\d+$/.test(t.text)) this.fail('an integer');
    this.i++;
    return Number(t.text);
  }

  private parseReturning(): ReturningClause[] {
    const out: ReturningClause[] = [];
    do {
      out.push(this.parseReturningItem());
    } while (this.eatPunct(','));
    return out;
  }

  /**
   * `Account(Id, Name WHERE Industry = 'Hospitality' ORDER BY Name LIMIT 5)`.
   *
   * The body is reassembled into `SELECT … FROM Account …` and handed to the SOQL parser, so the
   * two grammars cannot drift. Slices are taken from the original source between token positions,
   * which keeps string literals and date literals byte-for-byte intact.
   */
  private parseReturningItem(): ReturningClause {
    const nameTok = this.peek();
    if (nameTok.kind !== 'ident') this.fail('an object name');
    this.i++;
    const objectApi = nameTok.text;

    if (!this.eatPunct('(')) {
      // `RETURNING Account` with no body: Salesforce returns Ids only.
      return { objectApi, query: parseSoql(`SELECT Id FROM ${objectApi}`) };
    }

    const fieldsStart = this.i;
    let clauseStart = -1;
    let depth = 1;
    let close = -1;

    for (let j = this.i; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.kind === 'eof') break;
      if (t.kind === 'punct' && t.text === '(') depth++;
      else if (t.kind === 'punct' && t.text === ')') {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      } else if (depth === 1 && t.kind === 'ident' && BODY_CLAUSES.has(t.upper) && clauseStart < 0) {
        clauseStart = j;
      }
    }
    if (close < 0) throw Errors.malformedSearch(`unclosed ( in RETURNING ${objectApi}`);

    const fieldsEnd = clauseStart >= 0 ? clauseStart : close;
    const fields = this.src.slice(this.toks[fieldsStart].pos, this.toks[fieldsEnd].pos).trim();
    const rest = clauseStart >= 0 ? this.src.slice(this.toks[clauseStart].pos, this.toks[close].pos).trim() : '';

    this.i = close + 1;

    const selectList = fields || 'Id';
    return { objectApi, query: parseSoql(`SELECT ${selectList} FROM ${objectApi} ${rest}`.trim()) };
  }

  /** WITH DIVISION = 'x', WITH DATA CATEGORY … — consumed so they do not break the parse. */
  private skipWithClause(): string {
    const start = this.peek().pos;
    this.i++; // WITH
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.text === '(') depth++;
      if (t.kind === 'punct' && t.text === ')') depth--;
      if (depth === 0 && t.kind === 'ident' && (t.upper === 'RETURNING' || t.upper === 'LIMIT' || t.upper === 'WITH' || t.upper === 'UPDATE')) {
        break;
      }
      this.i++;
    }
    return this.src.slice(start, this.peek().pos).trim();
  }
}

/** Split `FIND {term}` (or `FIND 'term'`) from the rest of the statement. */
function splitFind(src: string): { term: string; rest: string } {
  const m = /^\s*FIND\s*/i.exec(src);
  if (!m) throw Errors.malformedSearch("a SOSL search must begin with FIND");

  let i = m[0].length;
  const open = src[i];
  if (open !== '{' && open !== "'") {
    throw Errors.malformedSearch('the search term must be wrapped in braces, as FIND {term}');
  }
  const close = open === '{' ? '}' : "'";

  let term = '';
  i++;
  while (i < src.length && src[i] !== close) {
    // Escapes are preserved for the term parser, which knows which characters are special to it.
    if (src[i] === '\\' && i + 1 < src.length) {
      term += src[i] + src[i + 1];
      i += 2;
      continue;
    }
    term += src[i++];
  }
  if (i >= src.length) throw Errors.malformedSearch(`unterminated search term: no closing ${close}`);
  return { term, rest: src.slice(i + 1) };
}

export function parseSosl(src: string): SoslQuery {
  const { term, rest } = splitFind(src);
  if (!term.trim()) throw Errors.malformedSearch('the search term is empty');
  const find = new TermParser(term).parse();
  return new SoslParser(rest).parse(find);
}

/** Parse just a search expression — the typeahead endpoint takes a bare term, not a statement. */
export function parseSearchTerm(term: string): SearchExpr {
  if (!term.trim()) throw Errors.malformedSearch('the search term is empty');
  return new TermParser(term).parse();
}
