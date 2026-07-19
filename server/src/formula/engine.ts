/**
 * Salesforce-compatible formula language: lexer, parser, evaluator.
 * One engine powers formula fields, validation rules, workflow criteria,
 * flow expressions, and default values.
 *
 * Values are tagged so date/number/text semantics match Salesforce
 * (e.g. date - date = days, date + number = date, & concatenates).
 */

export type FType = 'num' | 'text' | 'bool' | 'date' | 'datetime' | 'time' | 'null';

export interface FValue {
  t: FType;
  v: any; // num: number, text: string, bool: boolean, date: 'YYYY-MM-DD', datetime: Date, time: 'HH:mm:ss'
}

export const FNULL: FValue = { t: 'null', v: null };
export const fnum = (v: number): FValue => (Number.isFinite(v) ? { t: 'num', v } : FNULL);
export const ftext = (v: string): FValue => ({ t: 'text', v });
export const fbool = (v: boolean): FValue => ({ t: 'bool', v });
export const fdate = (v: string): FValue => ({ t: 'date', v });
export const fdatetime = (v: Date): FValue => ({ t: 'datetime', v });
export const ftime = (v: string): FValue => ({ t: 'time', v });

export class FormulaError extends Error {}

/* --------------------------------- lexer --------------------------------- */

type TokKind = 'num' | 'str' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';
interface Tok {
  kind: TokKind;
  text: string;
  pos: number;
}

const OPS = ['<>', '<=', '>=', '==', '!=', '&&', '||', '=', '<', '>', '&', '+', '-', '*', '/', '^', '!'];

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < src.length) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new FormulaError(`Unterminated string at ${i}`);
      toks.push({ kind: 'str', text: out, pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      // exponent
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (/[0-9]/.test(src[k] ?? '')) {
          k++;
          while (k < src.length && /[0-9]/.test(src[k])) k++;
          j = k;
        }
      }
      toks.push({ kind: 'num', text: src.slice(i, j).replaceAll('_', ''), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$.]/.test(src[j])) j++;
      // trailing dots are not part of the ident
      let text = src.slice(i, j);
      while (text.endsWith('.')) {
        text = text.slice(0, -1);
        j--;
      }
      toks.push({ kind: 'ident', text, pos: i });
      i = j;
      continue;
    }
    if (ch === '(') {
      toks.push({ kind: 'lparen', text: '(', pos: i });
      i++;
      continue;
    }
    if (ch === ')') {
      toks.push({ kind: 'rparen', text: ')', pos: i });
      i++;
      continue;
    }
    if (ch === ',') {
      toks.push({ kind: 'comma', text: ',', pos: i });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      toks.push({ kind: 'op', text: op, pos: i });
      i += op.length;
      continue;
    }
    throw new FormulaError(`Unexpected character '${ch}' at position ${i}`);
  }
  toks.push({ kind: 'eof', text: '', pos: src.length });
  return toks;
}

/* --------------------------------- parser -------------------------------- */

export type Ast =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'ref'; path: string }
  | { k: 'call'; name: string; args: Ast[] }
  | { k: 'bin'; op: string; l: Ast; r: Ast }
  | { k: 'un'; op: string; e: Ast };

class Parser {
  toks: Tok[];
  i = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  peek(): Tok {
    return this.toks[this.i];
  }
  next(): Tok {
    return this.toks[this.i++];
  }
  expect(kind: TokKind, text?: string): Tok {
    const t = this.next();
    if (t.kind !== kind || (text !== undefined && t.text !== text))
      throw new FormulaError(`Expected ${text ?? kind} at position ${t.pos}, got '${t.text || t.kind}'`);
    return t;
  }

  parse(): Ast {
    const e = this.or();
    if (this.peek().kind !== 'eof')
      throw new FormulaError(`Unexpected '${this.peek().text}' at position ${this.peek().pos}`);
    return e;
  }

  or(): Ast {
    let l = this.and();
    while (this.peek().kind === 'op' && this.peek().text === '||') {
      this.next();
      l = { k: 'bin', op: '||', l, r: this.and() };
    }
    return l;
  }
  and(): Ast {
    let l = this.cmp();
    while (this.peek().kind === 'op' && this.peek().text === '&&') {
      this.next();
      l = { k: 'bin', op: '&&', l, r: this.cmp() };
    }
    return l;
  }
  cmp(): Ast {
    let l = this.concat();
    while (this.peek().kind === 'op' && ['=', '==', '<>', '!=', '<', '>', '<=', '>='].includes(this.peek().text)) {
      const op = this.next().text;
      l = { k: 'bin', op: op === '==' ? '=' : op === '!=' ? '<>' : op, l, r: this.concat() };
    }
    return l;
  }
  concat(): Ast {
    let l = this.add();
    while (this.peek().kind === 'op' && this.peek().text === '&') {
      this.next();
      l = { k: 'bin', op: '&', l, r: this.add() };
    }
    return l;
  }
  add(): Ast {
    let l = this.mul();
    while (this.peek().kind === 'op' && (this.peek().text === '+' || this.peek().text === '-')) {
      const op = this.next().text;
      l = { k: 'bin', op, l, r: this.mul() };
    }
    return l;
  }
  mul(): Ast {
    let l = this.unary();
    while (this.peek().kind === 'op' && (this.peek().text === '*' || this.peek().text === '/')) {
      const op = this.next().text;
      l = { k: 'bin', op, l, r: this.unary() };
    }
    return l;
  }
  unary(): Ast {
    const t = this.peek();
    if (t.kind === 'op' && (t.text === '-' || t.text === '!')) {
      this.next();
      return { k: 'un', op: t.text, e: this.unary() };
    }
    return this.power();
  }
  power(): Ast {
    const base = this.primary();
    if (this.peek().kind === 'op' && this.peek().text === '^') {
      this.next();
      return { k: 'bin', op: '^', l: base, r: this.unary() };
    }
    return base;
  }
  primary(): Ast {
    const t = this.next();
    if (t.kind === 'num') return { k: 'num', v: parseFloat(t.text) };
    if (t.kind === 'str') return { k: 'str', v: t.text };
    if (t.kind === 'lparen') {
      const e = this.or();
      this.expect('rparen');
      return e;
    }
    if (t.kind === 'ident') {
      const upper = t.text.toUpperCase();
      if (upper === 'TRUE') return { k: 'bool', v: true };
      if (upper === 'FALSE') return { k: 'bool', v: false };
      if (upper === 'NULL') return { k: 'null' };
      if (this.peek().kind === 'lparen') {
        this.next();
        const args: Ast[] = [];
        if (this.peek().kind !== 'rparen') {
          args.push(this.or());
          while (this.peek().kind === 'comma') {
            this.next();
            args.push(this.or());
          }
        }
        this.expect('rparen');
        return { k: 'call', name: upper, args };
      }
      return { k: 'ref', path: t.text };
    }
    throw new FormulaError(`Unexpected '${t.text || t.kind}' at position ${t.pos}`);
  }
}

const astCache = new Map<string, Ast>();

export function parseFormula(src: string): Ast {
  let ast = astCache.get(src);
  if (!ast) {
    ast = new Parser(lex(src)).parse();
    if (astCache.size > 5000) astCache.clear();
    astCache.set(src, ast);
  }
  return ast;
}

/** Collect field paths and $Global references used by a formula. */
export function extractRefs(ast: Ast, out = { fields: new Set<string>(), globals: new Set<string>() }) {
  switch (ast.k) {
    case 'ref':
      (ast.path.startsWith('$') ? out.globals : out.fields).add(ast.path);
      break;
    case 'call':
      // ISPICKVAL / ISCHANGED / PRIORVALUE take a field reference as first arg
      for (const a of ast.args) extractRefs(a, out);
      break;
    case 'bin':
      extractRefs(ast.l, out);
      extractRefs(ast.r, out);
      break;
    case 'un':
      extractRefs(ast.e, out);
      break;
  }
  return out;
}

/* ------------------------------- evaluation ------------------------------- */

export interface EvalContext {
  /** Resolve a field path ("Amount", "Account.Name", "$User.Id") to a value. */
  get(path: string): FValue;
  /** Value of a field before the current save (validation/workflow context). */
  prior?(field: string): FValue;
  isNew?: boolean;
  /** Timezone-independent "today" (org timezone applied by caller). */
  today?(): string;
  now?(): Date;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function dateToDays(d: string): number {
  return Date.parse(d + 'T00:00:00Z') / 86400000;
}
function daysToDate(days: number): string {
  const d = new Date(Math.round(days) * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function isBlank(v: FValue): boolean {
  return v.t === 'null' || (v.t === 'text' && v.v === '');
}

export function truthy(v: FValue): boolean {
  if (v.t === 'bool') return v.v;
  if (v.t === 'null') return false;
  if (v.t === 'num') return v.v !== 0;
  if (v.t === 'text') return v.v !== '';
  return true;
}

function toNum(v: FValue): number | null {
  if (v.t === 'num') return v.v;
  if (v.t === 'null') return null;
  if (v.t === 'text') {
    const n = parseFloat(v.v);
    return Number.isFinite(n) ? n : null;
  }
  if (v.t === 'bool') return v.v ? 1 : 0;
  return null;
}

export function fToText(v: FValue): string {
  switch (v.t) {
    case 'null':
      return '';
    case 'text':
      return v.v;
    case 'num': {
      const s = String(v.v);
      return s.includes('e') ? v.v.toFixed(10).replace(/0+$/, '').replace(/\.$/, '') : s;
    }
    case 'bool':
      return v.v ? 'TRUE' : 'FALSE';
    case 'date':
      return v.v;
    case 'datetime': {
      const d = v.v as Date;
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
    }
    case 'time':
      return v.v;
  }
}

function cmpValues(l: FValue, r: FValue): number | null {
  if (l.t === 'null' || r.t === 'null') return null;
  if (l.t === 'num' || r.t === 'num') {
    const a = toNum(l);
    const b = toNum(r);
    if (a === null || b === null) return null;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (l.t === 'date' || r.t === 'date' || l.t === 'datetime' || r.t === 'datetime') {
    const a = l.t === 'date' ? dateToDays(l.v) * 86400000 : l.t === 'datetime' ? l.v.getTime() : Date.parse(fToText(l));
    const b = r.t === 'date' ? dateToDays(r.v) * 86400000 : r.t === 'datetime' ? r.v.getTime() : Date.parse(fToText(r));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const a = fToText(l);
  const b = fToText(r);
  return a === b ? 0 : a < b ? -1 : 1;
}

function equalValues(l: FValue, r: FValue): boolean {
  if (l.t === 'null' && r.t === 'null') return true;
  if (l.t === 'null' || r.t === 'null') return isBlank(l) && isBlank(r);
  if (l.t === 'bool' || r.t === 'bool') return truthy(l) === truthy(r);
  const c = cmpValues(l, r);
  return c === 0;
}

export function evaluate(ast: Ast, ctx: EvalContext): FValue {
  switch (ast.k) {
    case 'num':
      return fnum(ast.v);
    case 'str':
      return ftext(ast.v);
    case 'bool':
      return fbool(ast.v);
    case 'null':
      return FNULL;
    case 'ref':
      return ctx.get(ast.path);
    case 'un': {
      const e = evaluate(ast.e, ctx);
      if (ast.op === '-') {
        const n = toNum(e);
        return n === null ? FNULL : fnum(-n);
      }
      return fbool(!truthy(e));
    }
    case 'bin':
      return evalBin(ast, ctx);
    case 'call':
      return evalCall(ast.name, ast.args, ctx);
  }
}

function evalBin(ast: { op: string; l: Ast; r: Ast }, ctx: EvalContext): FValue {
  const { op } = ast;
  if (op === '&&') return fbool(truthy(evaluate(ast.l, ctx)) && truthy(evaluate(ast.r, ctx)));
  if (op === '||') return fbool(truthy(evaluate(ast.l, ctx)) || truthy(evaluate(ast.r, ctx)));

  const l = evaluate(ast.l, ctx);
  const r = evaluate(ast.r, ctx);

  switch (op) {
    case '&':
      return ftext(fToText(l) + fToText(r));
    case '=':
      return fbool(equalValues(l, r));
    case '<>':
      return fbool(!equalValues(l, r));
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const c = cmpValues(l, r);
      if (c === null) return fbool(false);
      return fbool(op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0);
    }
    case '+': {
      if (l.t === 'date' || r.t === 'date') {
        const d = l.t === 'date' ? l : r;
        const n = toNum(l.t === 'date' ? r : l);
        if (n === null) return FNULL;
        return fdate(daysToDate(dateToDays(d.v) + n));
      }
      if (l.t === 'datetime' || r.t === 'datetime') {
        const d = l.t === 'datetime' ? l : r;
        const n = toNum(l.t === 'datetime' ? r : l);
        if (n === null) return FNULL;
        return fdatetime(new Date(d.v.getTime() + n * 86400000));
      }
      if (l.t === 'text' || r.t === 'text') return ftext(fToText(l) + fToText(r));
      const a = toNum(l);
      const b = toNum(r);
      return a === null || b === null ? FNULL : fnum(a + b);
    }
    case '-': {
      if (l.t === 'date' && r.t === 'date') return fnum(dateToDays(l.v) - dateToDays(r.v));
      if (l.t === 'datetime' && r.t === 'datetime') return fnum((l.v.getTime() - r.v.getTime()) / 86400000);
      if (l.t === 'date') {
        const n = toNum(r);
        return n === null ? FNULL : fdate(daysToDate(dateToDays(l.v) - n));
      }
      if (l.t === 'datetime') {
        const n = toNum(r);
        return n === null ? FNULL : fdatetime(new Date(l.v.getTime() - n * 86400000));
      }
      const a = toNum(l);
      const b = toNum(r);
      return a === null || b === null ? FNULL : fnum(a - b);
    }
    case '*': {
      const a = toNum(l);
      const b = toNum(r);
      return a === null || b === null ? FNULL : fnum(a * b);
    }
    case '/': {
      const a = toNum(l);
      const b = toNum(r);
      if (a === null || b === null || b === 0) return FNULL;
      return fnum(a / b);
    }
    case '^': {
      const a = toNum(l);
      const b = toNum(r);
      return a === null || b === null ? FNULL : fnum(Math.pow(a, b));
    }
  }
  throw new FormulaError(`Unknown operator ${op}`);
}

function argRefName(a: Ast): string {
  if (a.k === 'ref') return a.path;
  if (a.k === 'str') return a.v;
  throw new FormulaError('Expected a field reference');
}

function evalCall(name: string, args: Ast[], ctx: EvalContext): FValue {
  const ev = (i: number) => (args[i] ? evaluate(args[i], ctx) : FNULL);
  const num = (i: number) => toNum(ev(i));
  const txt = (i: number) => fToText(ev(i));

  switch (name) {
    /* ------------------------------ logic ------------------------------ */
    case 'IF':
      return truthy(ev(0)) ? ev(1) : args[2] ? ev(2) : FNULL;
    case 'AND':
      for (let i = 0; i < args.length; i++) if (!truthy(ev(i))) return fbool(false);
      return fbool(true);
    case 'OR':
      for (let i = 0; i < args.length; i++) if (truthy(ev(i))) return fbool(true);
      return fbool(false);
    case 'NOT':
      return fbool(!truthy(ev(0)));
    case 'CASE': {
      const subject = ev(0);
      let i = 1;
      for (; i + 1 < args.length; i += 2) {
        if (equalValues(subject, ev(i))) return ev(i + 1);
      }
      return i < args.length ? ev(i) : FNULL;
    }
    case 'ISBLANK':
    case 'ISNULL':
      return fbool(isBlank(ev(0)));
    case 'BLANKVALUE':
    case 'NULLVALUE': {
      const v = ev(0);
      return isBlank(v) ? ev(1) : v;
    }
    case 'ISNUMBER': {
      const v = ev(0);
      if (v.t === 'num') return fbool(true);
      if (v.t !== 'text' || v.v.trim() === '') return fbool(false);
      return fbool(Number.isFinite(parseFloat(v.v)) && /^-?[\d.,]+([eE][-+]?\d+)?$/.test(v.v.trim()));
    }
    case 'ISPICKVAL':
      return fbool(fToText(ev(0)) === txt(1));
    case 'TEXT':
      return ftext(fToText(ev(0)));
    case 'VALUE': {
      const n = parseFloat(txt(0));
      return Number.isFinite(n) ? fnum(n) : FNULL;
    }
    case 'ISNEW':
      return fbool(!!ctx.isNew);
    case 'ISCHANGED': {
      if (!ctx.prior) return fbool(false);
      const field = argRefName(args[0]);
      if (ctx.isNew) return fbool(false);
      return fbool(!equalValues(ctx.get(field), ctx.prior(field)));
    }
    case 'PRIORVALUE': {
      const field = argRefName(args[0]);
      if (!ctx.prior || ctx.isNew) return ctx.get(field);
      return ctx.prior(field);
    }

    /* ------------------------------- text ------------------------------ */
    case 'LEN':
      return fnum(txt(0).length);
    case 'LEFT':
      return ftext(txt(0).slice(0, Math.max(0, num(1) ?? 0)));
    case 'RIGHT': {
      const n = Math.max(0, num(1) ?? 0);
      const s = txt(0);
      return ftext(n === 0 ? '' : s.slice(-n));
    }
    case 'MID': {
      const s = txt(0);
      const start = Math.max(1, num(1) ?? 1);
      return ftext(s.substr(start - 1, Math.max(0, num(2) ?? 0)));
    }
    case 'SUBSTITUTE':
      return ftext(txt(0).split(txt(1)).join(txt(2)));
    case 'TRIM':
      return ftext(txt(0).trim());
    case 'UPPER':
      return ftext(txt(0).toUpperCase());
    case 'LOWER':
      return ftext(txt(0).toLowerCase());
    case 'CONTAINS':
      return fbool(txt(0).includes(txt(1)));
    case 'BEGINS':
      return fbool(txt(0).startsWith(txt(1)));
    case 'FIND': {
      const idx = txt(1).indexOf(txt(0), Math.max(0, (num(2) ?? 1) - 1));
      return fnum(idx + 1);
    }
    case 'LPAD': {
      const s = txt(0);
      const width = num(1) ?? 0;
      const padStr = args[2] ? txt(2) : ' ';
      if (s.length >= width) return ftext(s.slice(0, width));
      let out = s;
      while (out.length < width) out = padStr + out;
      return ftext(out.slice(-width));
    }
    case 'RPAD': {
      const s = txt(0);
      const width = num(1) ?? 0;
      const padStr = args[2] ? txt(2) : ' ';
      if (s.length >= width) return ftext(s.slice(0, width));
      let out = s;
      while (out.length < width) out = out + padStr;
      return ftext(out.slice(0, width));
    }
    case 'BR':
      return ftext('\n');
    case 'HYPERLINK':
      return ftext(args[1] ? txt(1) : txt(0));
    case 'CASESAFEID': {
      const v = txt(0);
      return ftext(v.length === 15 ? v : v);
    }
    case 'REGEX': {
      try {
        return fbool(new RegExp(`^(?:${txt(1)})$`, 's').test(txt(0)));
      } catch {
        throw new FormulaError('Invalid REGEX pattern');
      }
    }

    /* ------------------------------- math ------------------------------ */
    case 'ABS': {
      const n = num(0);
      return n === null ? FNULL : fnum(Math.abs(n));
    }
    case 'ROUND': {
      const n = num(0);
      const digits = num(1) ?? 0;
      if (n === null) return FNULL;
      const f = Math.pow(10, digits);
      // Salesforce rounds half away from zero
      return fnum(Math.sign(n) * Math.round(Math.abs(n) * f) / f);
    }
    case 'FLOOR': {
      const n = num(0);
      return n === null ? FNULL : fnum(Math.sign(n) * Math.floor(Math.abs(n)));
    }
    case 'CEILING': {
      const n = num(0);
      return n === null ? FNULL : fnum(Math.sign(n) * Math.ceil(Math.abs(n)));
    }
    case 'MFLOOR': {
      const n = num(0);
      return n === null ? FNULL : fnum(Math.floor(n));
    }
    case 'MCEILING': {
      const n = num(0);
      return n === null ? FNULL : fnum(Math.ceil(n));
    }
    case 'SQRT': {
      const n = num(0);
      return n === null || n < 0 ? FNULL : fnum(Math.sqrt(n));
    }
    case 'EXP': {
      const n = num(0);
      return n === null ? FNULL : fnum(Math.exp(n));
    }
    case 'LN': {
      const n = num(0);
      return n === null || n <= 0 ? FNULL : fnum(Math.log(n));
    }
    case 'LOG': {
      const n = num(0);
      return n === null || n <= 0 ? FNULL : fnum(Math.log10(n));
    }
    case 'MOD': {
      const a = num(0);
      const b = num(1);
      if (a === null || b === null || b === 0) return FNULL;
      return fnum(a - b * Math.floor(a / b));
    }
    case 'MAX': {
      let best: number | null = null;
      for (let i = 0; i < args.length; i++) {
        const n = num(i);
        if (n !== null && (best === null || n > best)) best = n;
      }
      return best === null ? FNULL : fnum(best);
    }
    case 'MIN': {
      let best: number | null = null;
      for (let i = 0; i < args.length; i++) {
        const n = num(i);
        if (n !== null && (best === null || n < best)) best = n;
      }
      return best === null ? FNULL : fnum(best);
    }

    /* ---------------------------- date & time --------------------------- */
    case 'TODAY':
      return fdate(ctx.today ? ctx.today() : new Date().toISOString().slice(0, 10));
    case 'NOW':
      return fdatetime(ctx.now ? ctx.now() : new Date());
    case 'TIMENOW': {
      const d = ctx.now ? ctx.now() : new Date();
      return ftime(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`);
    }
    case 'DATE': {
      const y = num(0);
      const m = num(1);
      const d = num(2);
      if (y === null || m === null || d === null) return FNULL;
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (Number.isNaN(dt.getTime())) return FNULL;
      return fdate(`${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`);
    }
    case 'DATEVALUE': {
      const v = ev(0);
      if (v.t === 'date') return v;
      if (v.t === 'datetime') return fdate(fToText(v).slice(0, 10));
      const s = fToText(v);
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return fdate(`${m[1]}-${m[2]}-${m[3]}`);
      const uk = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (uk) return fdate(`${uk[3]}-${pad(+uk[2])}-${pad(+uk[1])}`);
      return FNULL;
    }
    case 'DATETIMEVALUE': {
      const v = ev(0);
      if (v.t === 'datetime') return v;
      if (v.t === 'date') return fdatetime(new Date(v.v + 'T00:00:00Z'));
      const ms = Date.parse(fToText(v).replace(' ', 'T'));
      return Number.isNaN(ms) ? FNULL : fdatetime(new Date(ms));
    }
    case 'TIMEVALUE': {
      const s = txt(0);
      const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      return m ? ftime(`${pad(+m[1])}:${m[2]}:${m[3] ?? '00'}`) : FNULL;
    }
    case 'YEAR':
    case 'MONTH':
    case 'DAY':
    case 'WEEKDAY':
    case 'DAYOFYEAR': {
      const v = ev(0);
      const ds = v.t === 'date' ? v.v : v.t === 'datetime' ? fToText(v).slice(0, 10) : null;
      if (!ds) return FNULL;
      const d = new Date(ds + 'T00:00:00Z');
      if (name === 'YEAR') return fnum(d.getUTCFullYear());
      if (name === 'MONTH') return fnum(d.getUTCMonth() + 1);
      if (name === 'DAY') return fnum(d.getUTCDate());
      if (name === 'WEEKDAY') return fnum(d.getUTCDay() + 1); // 1 = Sunday
      const start = Date.UTC(d.getUTCFullYear(), 0, 0);
      return fnum(Math.round((d.getTime() - start) / 86400000));
    }
    case 'HOUR':
    case 'MINUTE':
    case 'SECOND': {
      const v = ev(0);
      if (v.t === 'datetime') {
        const d = v.v as Date;
        return fnum(name === 'HOUR' ? d.getUTCHours() : name === 'MINUTE' ? d.getUTCMinutes() : d.getUTCSeconds());
      }
      if (v.t === 'time') {
        const [h, mi, s] = v.v.split(':').map((x: string) => parseInt(x, 10));
        return fnum(name === 'HOUR' ? h : name === 'MINUTE' ? mi : (s ?? 0));
      }
      return FNULL;
    }
    case 'ADDMONTHS': {
      const v = ev(0);
      const n = num(1);
      if (v.t !== 'date' || n === null) return FNULL;
      const d = new Date(v.v + 'T00:00:00Z');
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + n);
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, lastDay));
      return fdate(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
    }

    default:
      throw new FormulaError(`Unknown function ${name}()`);
  }
}

/* ------------------------------ public helpers ---------------------------- */

/** Convert a stored JS value + declared field type into an FValue. */
export function toFValue(value: any, fieldType?: string): FValue {
  if (value === null || value === undefined || value === '') {
    return fieldType === 'Checkbox' ? fbool(false) : FNULL;
  }
  switch (fieldType) {
    case 'Number':
    case 'Currency':
    case 'Percent':
    case 'RollupSummary':
      return typeof value === 'number' ? fnum(value) : fnum(parseFloat(String(value)));
    case 'Checkbox':
      return fbool(value === true || value === 'true');
    case 'Date':
      return fdate(String(value).slice(0, 10));
    case 'DateTime':
      return fdatetime(value instanceof Date ? value : new Date(value));
    case 'Time':
      return ftime(String(value));
    default:
      if (typeof value === 'number') return fnum(value);
      if (typeof value === 'boolean') return fbool(value);
      if (value instanceof Date) return fdatetime(value);
      return ftext(String(value));
  }
}

/** Convert an FValue back to a storable/JSON value. */
export function fromFValue(v: FValue): any {
  switch (v.t) {
    case 'null':
      return null;
    case 'datetime':
      return (v.v as Date).toISOString();
    default:
      return v.v;
  }
}

/** Parse + evaluate in one call. */
export function runFormula(src: string, ctx: EvalContext): FValue {
  return evaluate(parseFormula(src), ctx);
}
