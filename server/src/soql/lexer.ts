import { Errors } from '../util/errors.js';

export type TokKind = 'ident' | 'number' | 'string' | 'op' | 'punct' | 'eof';

export interface Token {
  kind: TokKind;
  text: string;
  /** Upper-cased text, for keyword comparison without repeated allocation. */
  upper: string;
  pos: number;
}

const OPERATORS = ['!=', '<>', '<=', '>=', '=', '<', '>'];
const PUNCT = ['(', ')', ',', '.', ':'];

/**
 * Tokenise SOQL. Deliberately permissive about keywords — the parser decides what an identifier
 * means by position, so `Status`, `Group` and `Order` remain usable as field names.
 */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "'") {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          j += 2;
        } else {
          value += src[j];
          j++;
        }
      }
      if (j >= src.length) throw Errors.malformedQuery(`unterminated string literal at position ${i}`);
      out.push({ kind: 'string', text: value, upper: value.toUpperCase(), pos: i });
      i = j + 1;
      continue;
    }

    // A number, or a date/datetime literal such as 2026-07-29 or 2026-07-29T10:00:00Z.
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? '') && expectsValue(out))) {
      const m = /^-?\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?/.exec(src.slice(i));
      if (m && m[0].includes('-', 1)) {
        out.push({ kind: 'number', text: m[0], upper: m[0], pos: i });
        i += m[0].length;
        continue;
      }
      const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ kind: 'number', text: num[0], upper: num[0], pos: i });
      i += num[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ kind: 'ident', text: m[0], upper: m[0].toUpperCase(), pos: i });
      i += m[0].length;
      continue;
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ kind: 'op', text: op, upper: op, pos: i });
      i += op.length;
      continue;
    }

    if (PUNCT.includes(ch)) {
      out.push({ kind: 'punct', text: ch, upper: ch, pos: i });
      i++;
      continue;
    }

    throw Errors.malformedQuery(`unexpected character '${ch}' at position ${i}`);
  }

  out.push({ kind: 'eof', text: '', upper: '', pos: src.length });
  return out;
}

/** A leading '-' is part of a number only where a value can appear, not after an identifier. */
function expectsValue(out: Token[]): boolean {
  const last = out[out.length - 1];
  if (!last) return true;
  return last.kind === 'op' || (last.kind === 'punct' && last.text !== ')');
}
