import { describe, it, expect } from 'vitest';
import {
  runFormula,
  toFValue,
  fromFValue,
  extractRefs,
  parseFormula,
  FNULL,
  fnum,
  ftext,
  fbool,
  fdate,
  type EvalContext,
  type FValue
} from '../src/formula/engine.js';

function ctx(record: Record<string, FValue>, old?: Record<string, FValue>, isNew = false): EvalContext {
  return {
    get: (p) => record[p] ?? FNULL,
    prior: old ? (f) => old[f] ?? FNULL : undefined,
    isNew,
    today: () => '2026-07-19',
    now: () => new Date('2026-07-19T12:00:00Z')
  };
}

const run = (src: string, rec: Record<string, FValue> = {}) => fromFValue(runFormula(src, ctx(rec)));

describe('formula engine', () => {
  it('arithmetic and precedence', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('2 ^ 3 ^ 2')).toBe(512); // right associative
    expect(run('10 / 4')).toBe(2.5);
    expect(run('-3 + 5')).toBe(2);
    expect(run('MOD(10, 3)')).toBe(1);
    expect(run('MOD(-1, 3)')).toBe(2); // Salesforce MOD follows floor semantics
  });

  it('text functions and concatenation', () => {
    expect(run('"Lark" & "spur"')).toBe('Larkspur');
    expect(run('UPPER(LEFT("mayfair", 3))')).toBe('MAY');
    expect(run('MID("membership", 4, 3)')).toBe('ber');
    expect(run('SUBSTITUTE("a-b-c", "-", "+")')).toBe('a+b+c');
    expect(run('LPAD("7", 3, "0")')).toBe('007');
    expect(run('FIND("spur", "Larkspur")')).toBe(5);
    expect(run('CONTAINS("Private Members Club", "Members")')).toBe(true);
    expect(run('BEGINS("W1J 8AJ", "W1")')).toBe(true);
    expect(run('REGEX("SW1A 1AA", "[A-Z]{1,2}\\\\d[A-Z\\\\d]? ?\\\\d[A-Z]{2}")')).toBe(true);
  });

  it('logic, IF, CASE, blank handling', () => {
    expect(run('IF(5 > 3, "yes", "no")')).toBe('yes');
    expect(run('AND(true, 1 < 2, "x" = "x")')).toBe(true);
    expect(run('OR(false, ISBLANK(""))')).toBe(true);
    expect(run('NOT(false)')).toBe(true);
    expect(run('CASE("Gold", "Silver", 1, "Gold", 2, 0)')).toBe(2);
    expect(run('BLANKVALUE(Nickname, "Member")', { Nickname: FNULL })).toBe('Member');
    expect(run('ISNUMBER("12.5")')).toBe(true);
    expect(run('ISNUMBER("W1J")')).toBe(false);
    expect(run('VALUE("250") * 2')).toBe(500);
  });

  it('equality follows Salesforce semantics (= is comparison, null equals blank text)', () => {
    expect(run('"a" = "a"')).toBe(true);
    expect(run('1 = 1.0')).toBe(true);
    expect(run('NULL = ""')).toBe(true);
    expect(run('1 <> 2')).toBe(true);
  });

  it('date arithmetic', () => {
    expect(run('TODAY()')).toBe('2026-07-19');
    expect(run('TODAY() + 7')).toBe('2026-07-26');
    expect(run('DATE(2026, 12, 25) - TODAY()')).toBe(159);
    expect(run('YEAR(TODAY())')).toBe(2026);
    expect(run('MONTH(DATE(2026,2,14))')).toBe(2);
    expect(run('WEEKDAY(DATE(2026,7,19))')).toBe(1); // Sunday
    expect(run('ADDMONTHS(DATE(2026,1,31), 1)')).toBe('2026-02-28');
    expect(run('DATEVALUE("19/07/2026")')).toBe('2026-07-19'); // UK format
    expect(run('TEXT(DATE(2026,3,5))')).toBe('2026-03-05');
  });

  it('rounding matches Salesforce (half away from zero)', () => {
    expect(run('ROUND(2.5, 0)')).toBe(3);
    expect(run('ROUND(-2.5, 0)')).toBe(-3);
    expect(run('ROUND(1.245, 2)')).toBe(1.25);
    expect(run('FLOOR(-2.5)')).toBe(-2); // toward zero
    expect(run('MFLOOR(-2.5)')).toBe(-3); // true floor
    expect(run('CEILING(2.1)')).toBe(3);
  });

  it('record field references, ISPICKVAL, ISCHANGED, PRIORVALUE', () => {
    const record = { Status__c: ftext('Active'), Amount: fnum(1200), 'Tier__r.Name': ftext('Gold') };
    expect(fromFValue(runFormula('ISPICKVAL(Status__c, "Active")', ctx(record)))).toBe(true);
    expect(fromFValue(runFormula('Amount * 0.2', ctx(record)))).toBe(240);
    expect(fromFValue(runFormula('Tier__r.Name & " member"', ctx(record)))).toBe('Gold member');

    const changed = runFormula(
      'ISCHANGED(Status__c)',
      ctx({ Status__c: ftext('Lapsed') }, { Status__c: ftext('Active') })
    );
    expect(fromFValue(changed)).toBe(true);
    const prior = runFormula(
      'PRIORVALUE(Status__c)',
      ctx({ Status__c: ftext('Lapsed') }, { Status__c: ftext('Active') })
    );
    expect(fromFValue(prior)).toBe('Active');
    expect(fromFValue(runFormula('ISNEW()', ctx({}, undefined, true)))).toBe(true);
  });

  it('validation-rule style formulas', () => {
    // Guest limit: block save when guests exceed 3 for non-Gold members
    const formula = 'AND(Guests__c > 3, NOT(ISPICKVAL(Tier__c, "Gold")))';
    expect(fromFValue(runFormula(formula, ctx({ Guests__c: fnum(5), Tier__c: ftext('Silver') })))).toBe(true);
    expect(fromFValue(runFormula(formula, ctx({ Guests__c: fnum(5), Tier__c: ftext('Gold') })))).toBe(false);
    expect(fromFValue(runFormula(formula, ctx({ Guests__c: fnum(2), Tier__c: ftext('Silver') })))).toBe(false);
  });

  it('extractRefs finds field and global dependencies', () => {
    const refs = extractRefs(parseFormula('IF(Amount > 0, Account.Name, $User.Alias) & Status__c'));
    expect([...refs.fields].sort()).toEqual(['Account.Name', 'Amount', 'Status__c']);
    expect([...refs.globals]).toEqual(['$User.Alias']);
  });

  it('toFValue respects declared types', () => {
    expect(toFValue('42.5', 'Currency')).toEqual(fnum(42.5));
    expect(toFValue(null, 'Checkbox')).toEqual(fbool(false));
    expect(toFValue('2026-07-19', 'Date')).toEqual(fdate('2026-07-19'));
    expect(fromFValue(toFValue('true', 'Checkbox'))).toBe(true);
  });

  it('division by zero and null propagation yield null, not crashes', () => {
    expect(run('1 / 0')).toBeNull();
    expect(run('Amount + 5', { Amount: FNULL })).toBeNull();
    expect(run('SQRT(-1)')).toBeNull();
  });

  it('rejects malformed formulas with useful errors', () => {
    expect(() => run('IF(1 > 2')).toThrow(/Expected/);
    expect(() => run('FROBNICATE(1)')).toThrow(/Unknown function/);
    expect(() => run('1 +* 2')).toThrow();
  });
});
