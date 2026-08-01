import { Errors } from '../util/errors.js';
import { tokenize, type Token } from './lexer.js';
import type {
  AggregateFn,
  CompareOp,
  Condition,
  LiteralValue,
  OrderItem,
  SelectItem,
  SoqlQuery
} from './ast.js';

const AGGREGATES = new Set(['COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX']);

const FIXED_DATE_LITERALS = new Set([
  'YESTERDAY', 'TODAY', 'TOMORROW',
  'LAST_WEEK', 'THIS_WEEK', 'NEXT_WEEK',
  'LAST_MONTH', 'THIS_MONTH', 'NEXT_MONTH',
  'LAST_QUARTER', 'THIS_QUARTER', 'NEXT_QUARTER',
  'LAST_YEAR', 'THIS_YEAR', 'NEXT_YEAR',
  'LAST_90_DAYS', 'NEXT_90_DAYS'
]);

const N_DATE_LITERALS = new Set([
  'LAST_N_DAYS', 'NEXT_N_DAYS',
  'LAST_N_WEEKS', 'NEXT_N_WEEKS',
  'LAST_N_MONTHS', 'NEXT_N_MONTHS',
  'LAST_N_QUARTERS', 'NEXT_N_QUARTERS',
  'LAST_N_YEARS', 'NEXT_N_YEARS'
]);

/** Recursive-descent SOQL parser. */
class Parser {
  private toks: Token[];
  private i = 0;

  constructor(src: string) {
    this.toks = tokenize(src);
  }

  private peek(ahead = 0): Token {
    return this.toks[Math.min(this.i + ahead, this.toks.length - 1)];
  }

  private next(): Token {
    return this.toks[this.i++];
  }

  private atKeyword(word: string): boolean {
    const t = this.peek();
    return t.kind === 'ident' && t.upper === word;
  }

  private eatKeyword(word: string): boolean {
    if (this.atKeyword(word)) {
      this.i++;
      return true;
    }
    return false;
  }

  private expectKeyword(word: string): void {
    if (!this.eatKeyword(word)) this.fail(`expected ${word}`);
  }

  private eatPunct(ch: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.text === ch) {
      this.i++;
      return true;
    }
    return false;
  }

  private expectPunct(ch: string): void {
    if (!this.eatPunct(ch)) this.fail(`expected '${ch}'`);
  }

  private fail(what: string): never {
    const t = this.peek();
    throw Errors.malformedQuery(`${what} at position ${t.pos}${t.text ? ` but found '${t.text}'` : ''}`);
  }

  /* ------------------------------- statement ------------------------------ */

  parseQuery(): SoqlQuery {
    this.expectKeyword('SELECT');
    const select = this.parseSelectList();
    this.expectKeyword('FROM');
    const from = this.parseIdent('object name');

    const query: SoqlQuery = { select, from };

    if (this.eatKeyword('USING')) {
      this.expectKeyword('SCOPE');
      query.scope = this.parseIdent('scope').toLowerCase();
    }
    if (this.eatKeyword('WHERE')) query.where = this.parseCondition();
    if (this.eatKeyword('WITH')) {
      // WITH SECURITY_ENFORCED and friends: security is always enforced here, so accept and skip.
      this.parseIdent('with clause');
    }
    if (this.eatKeyword('GROUP')) {
      this.expectKeyword('BY');
      query.groupBy = [this.parsePath()];
      while (this.eatPunct(',')) query.groupBy.push(this.parsePath());
      if (this.eatKeyword('HAVING')) query.having = this.parseCondition();
    }
    if (this.eatKeyword('ORDER')) {
      this.expectKeyword('BY');
      query.orderBy = [this.parseOrderItem()];
      while (this.eatPunct(',')) query.orderBy.push(this.parseOrderItem());
    }
    if (this.eatKeyword('LIMIT')) query.limit = this.parseInt('LIMIT');
    if (this.eatKeyword('OFFSET')) query.offset = this.parseInt('OFFSET');
    if (this.eatKeyword('FOR')) {
      if (this.eatKeyword('UPDATE')) query.forUpdate = true;
      else this.expectKeyword('VIEW'); // FOR VIEW / FOR REFERENCE: accepted, no side effect
    }

    if (this.peek().kind !== 'eof') this.fail('unexpected trailing input');
    return query;
  }

  private parseSelectList(): SelectItem[] {
    const items: SelectItem[] = [this.parseSelectItem()];
    while (this.eatPunct(',')) items.push(this.parseSelectItem());
    return items;
  }

  private parseSelectItem(): SelectItem {
    if (this.eatPunct('(')) {
      const query = this.parseQuery0();
      this.expectPunct(')');
      return { kind: 'subquery', relationship: query.from, query };
    }

    const t = this.peek();
    if (t.kind === 'ident' && AGGREGATES.has(t.upper) && this.peek(1).kind === 'punct' && this.peek(1).text === '(') {
      const fn = this.next().upper as AggregateFn;
      this.expectPunct('(');
      const path = this.eatPunct(')') ? null : this.parsePath();
      if (path) this.expectPunct(')');
      const alias = this.parseAlias();
      return { kind: 'aggregate', fn, path, alias };
    }

    const path = this.parsePath();
    const alias = this.parseAlias();
    return { kind: 'field', path, alias };
  }

  /** A nested query inside parentheses; the outer parseQuery consumes the closing paren. */
  private parseQuery0(): SoqlQuery {
    const save = this.i;
    try {
      const q = this.parseSubSelect();
      return q;
    } catch (e) {
      this.i = save;
      throw e;
    }
  }

  private parseSubSelect(): SoqlQuery {
    this.expectKeyword('SELECT');
    const select = this.parseSelectList();
    this.expectKeyword('FROM');
    const from = this.parseIdent('relationship name');
    const query: SoqlQuery = { select, from };
    if (this.eatKeyword('USING')) {
      this.expectKeyword('SCOPE');
      query.scope = this.parseIdent('scope').toLowerCase();
    }
    if (this.eatKeyword('WHERE')) query.where = this.parseCondition();
    if (this.eatKeyword('ORDER')) {
      this.expectKeyword('BY');
      query.orderBy = [this.parseOrderItem()];
      while (this.eatPunct(',')) query.orderBy.push(this.parseOrderItem());
    }
    if (this.eatKeyword('LIMIT')) query.limit = this.parseInt('LIMIT');
    if (this.eatKeyword('OFFSET')) query.offset = this.parseInt('OFFSET');
    return query;
  }

  private parseAlias(): string | undefined {
    const t = this.peek();
    if (t.kind !== 'ident') return undefined;
    // Only treat it as an alias when it cannot begin the next clause.
    const RESERVED = ['FROM', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'HAVING', 'USING', 'FOR', 'WITH', 'AND', 'OR', 'NOT'];
    if (RESERVED.includes(t.upper)) return undefined;
    this.i++;
    return t.text;
  }

  private parseIdent(what: string): string {
    const t = this.peek();
    if (t.kind !== 'ident') this.fail(`expected ${what}`);
    this.i++;
    return t.text;
  }

  private parseInt(what: string): number {
    const t = this.peek();
    if (t.kind !== 'number' || !/^\d+$/.test(t.text)) this.fail(`expected an integer after ${what}`);
    this.i++;
    return Number(t.text);
  }

  private parsePath(): string[] {
    const path = [this.parseIdent('field name')];
    while (this.eatPunct('.')) path.push(this.parseIdent('field name'));
    if (path.length > 6) {
      throw Errors.malformedQuery('relationship traversal is limited to 5 levels');
    }
    return path;
  }

  private parseOrderItem(): OrderItem {
    const path = this.parsePath();
    let dir: 'ASC' | 'DESC' = 'ASC';
    if (this.eatKeyword('ASC')) dir = 'ASC';
    else if (this.eatKeyword('DESC')) dir = 'DESC';
    let nulls: 'FIRST' | 'LAST' | null = null;
    if (this.eatKeyword('NULLS')) {
      if (this.eatKeyword('FIRST')) nulls = 'FIRST';
      else if (this.eatKeyword('LAST')) nulls = 'LAST';
      else this.fail('expected FIRST or LAST');
    }
    return { path, dir, nulls };
  }

  /* ------------------------------- conditions ----------------------------- */

  private parseCondition(): Condition {
    return this.parseOr();
  }

  private parseOr(): Condition {
    const items = [this.parseAnd()];
    while (this.eatKeyword('OR')) items.push(this.parseAnd());
    return items.length === 1 ? items[0] : { kind: 'or', items };
  }

  private parseAnd(): Condition {
    const items = [this.parseUnary()];
    while (this.eatKeyword('AND')) items.push(this.parseUnary());
    return items.length === 1 ? items[0] : { kind: 'and', items };
  }

  private parseUnary(): Condition {
    if (this.eatKeyword('NOT')) return { kind: 'not', item: this.parseUnary() };
    if (this.eatPunct('(')) {
      const inner = this.parseCondition();
      this.expectPunct(')');
      return inner;
    }
    return this.parseComparison();
  }

  private parseComparison(): Condition {
    // HAVING clauses compare an aggregate rather than a field.
    const head = this.peek();
    if (head.kind === 'ident' && AGGREGATES.has(head.upper) && this.peek(1).kind === 'punct' && this.peek(1).text === '(') {
      this.i++;
      this.expectPunct('(');
      const path = this.eatPunct(')') ? null : this.parsePath();
      if (path) this.expectPunct(')');
      const t = this.peek();
      if (t.kind !== 'op') this.fail('expected a comparison operator');
      this.i++;
      const op = (t.text === '<>' ? '!=' : t.text) as CompareOp;
      return { kind: 'cmpAgg', fn: head.upper as AggregateFn, path, op, value: this.parseValue() };
    }

    const path = this.parsePath();

    if (this.eatKeyword('NOT')) {
      if (this.eatKeyword('IN')) return this.parseIn(path, true);
      this.fail('expected IN after NOT');
    }
    if (this.eatKeyword('IN')) return this.parseIn(path, false);
    if (this.eatKeyword('INCLUDES')) return { kind: 'includes', path, not: false, values: this.parseValueList() };
    if (this.eatKeyword('EXCLUDES')) return { kind: 'includes', path, not: true, values: this.parseValueList() };
    if (this.eatKeyword('LIKE')) return { kind: 'cmp', path, op: 'LIKE', value: this.parseValue() };

    const t = this.peek();
    if (t.kind !== 'op') this.fail('expected a comparison operator');
    this.i++;
    const op = (t.text === '<>' ? '!=' : t.text) as CompareOp;
    return { kind: 'cmp', path, op, value: this.parseValue() };
  }

  private parseIn(path: string[], not: boolean): Condition {
    this.expectPunct('(');
    if (this.atKeyword('SELECT')) {
      const query = this.parseSubSelect();
      this.expectPunct(')');
      return { kind: 'semiJoin', path, not, query };
    }
    const values: LiteralValue[] = [];
    if (!this.eatPunct(')')) {
      values.push(this.parseValue());
      while (this.eatPunct(',')) values.push(this.parseValue());
      this.expectPunct(')');
    }
    return { kind: 'in', path, not, values };
  }

  private parseValueList(): LiteralValue[] {
    this.expectPunct('(');
    const values = [this.parseValue()];
    while (this.eatPunct(',')) values.push(this.parseValue());
    this.expectPunct(')');
    return values;
  }

  private parseValue(): LiteralValue {
    const t = this.next();

    if (t.kind === 'string') return { t: 'string', v: t.text };

    if (t.kind === 'number') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(t.text)) return { t: 'date', v: t.text };
      if (/^\d{4}-\d{2}-\d{2}T/.test(t.text)) return { t: 'datetime', v: t.text };
      return { t: 'number', v: Number(t.text) };
    }

    if (t.kind === 'ident') {
      if (t.upper === 'NULL') return { t: 'null' };
      if (t.upper === 'TRUE') return { t: 'bool', v: true };
      if (t.upper === 'FALSE') return { t: 'bool', v: false };
      if (FIXED_DATE_LITERALS.has(t.upper)) return { t: 'dateLiteral', name: t.upper };
      if (N_DATE_LITERALS.has(t.upper)) {
        if (!this.eatPunct(':')) this.fail(`expected ':n' after ${t.upper}`);
        const n = this.parseInt(t.upper);
        return { t: 'dateLiteral', name: t.upper, n };
      }
      throw Errors.malformedQuery(`unexpected value '${t.text}' at position ${t.pos}`);
    }

    throw Errors.malformedQuery(`unexpected token '${t.text}' at position ${t.pos}`);
  }
}

export function parseSoql(src: string): SoqlQuery {
  if (!src || !src.trim()) throw Errors.malformedQuery('query text is empty');
  return new Parser(src).parseQuery();
}
