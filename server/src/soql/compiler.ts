import { tableFor } from '../metadata/registry.js';
import type { ChildRelationship, FieldMeta, ObjectMeta, OrgMeta } from '../metadata/types.js';
import { getField, getObject } from '../metadata/types.js';
import type { RequestContext } from '../runtime/context.js';
import { Errors } from '../util/errors.js';
import type { Condition, LiteralValue, SelectItem, SoqlQuery } from './ast.js';
import { isAggregateQuery } from './ast.js';
import { resolveDateLiteral } from './dates.js';
import { getSecurityPolicy, type SecurityPolicy } from './security.js';

/** Types compared case-insensitively, as SOQL does for text. */
const TEXTUAL = new Set(['Text', 'TextArea', 'LongTextArea', 'RichText', 'Picklist', 'MultiselectPicklist', 'Email', 'Phone', 'Url']);

/**
 * Types with no stored value: computed at read time, so not filterable or sortable.
 * Rollup summaries are not here — they are maintained in the JSONB body on every child write.
 */
const COMPUTED = new Set(['Formula']);

export interface OutputColumn {
  /** The key this value takes in the result record. */
  key: string;
  item: SelectItem;
  /** Field metadata for scalar selections; absent for aggregates over no field. */
  field?: FieldMeta;
  /** Relationship segments leading to the field, e.g. ['Account'] for Account.Name. */
  relationshipPath: string[];
  /** The object the field belongs to (for nesting and formula evaluation). */
  owner: ObjectMeta;
}

export interface CompiledSubquery {
  key: string;
  relationship: ChildRelationship;
  child: ObjectMeta;
  query: SoqlQuery;
}

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  columns: OutputColumn[];
  subqueries: CompiledSubquery[];
  isAggregate: boolean;
  root: ObjectMeta;
  /** Index into `columns` of the record Id, which subquery batching needs. */
  idColumn: number;
}

/**
 * Parent-relationship name for a lookup field: AccountId → Account, Member__c → Member__r.
 *
 * Deliberately derived from the API name rather than `relationshipName`, which holds the *child*
 * side of the relationship (Contact.AccountId names the child set `Contacts` on Account).
 */
export function parentRelationshipName(f: FieldMeta): string {
  if (f.apiName.endsWith('Id')) return f.apiName.slice(0, -2);
  if (f.apiName.endsWith('__c')) return f.apiName.replace(/__c$/, '__r');
  return f.apiName;
}

/**
 * A rollup stores whatever its operation produces: counts and sums are numeric, but MIN/MAX over a
 * date column stores a date. The declared return type decides the cast.
 */
function rollupCast(f: FieldMeta): string {
  const spec = f.rollup;
  if (!spec || spec.operation === 'COUNT' || spec.operation === 'SUM') return 'numeric';
  switch (f.formulaReturnType) {
    case 'Date':
      return 'date';
    case 'DateTime':
      return 'timestamptz';
    default:
      return 'numeric';
  }
}

interface Resolved {
  expr: string;
  field: FieldMeta;
  owner: ObjectMeta;
  alias: string;
  relationshipPath: string[];
}

class Compiler {
  readonly params: unknown[] = [];
  private joins: string[] = [];
  private aliasSeq = 0;
  private joinCache = new Map<string, { alias: string; obj: ObjectMeta }>();
  private rootAlias: string;

  constructor(
    private ctx: RequestContext,
    private org: OrgMeta,
    private root: ObjectMeta,
    private policy: SecurityPolicy,
    params: unknown[] = []
  ) {
    this.params = params;
    this.rootAlias = this.nextAlias();
  }

  get alias0(): string {
    return this.rootAlias;
  }

  private nextAlias(): string {
    return `t${this.aliasSeq++}`;
  }

  bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  joinSql(): string {
    return this.joins.join(' ');
  }

  /* ----------------------------- path resolution ---------------------------- */

  /**
   * Walk a dotted path, joining a parent table for each relationship segment.
   *
   * Field-level security is checked here, at compile time, so an unreadable field fails with
   * INVALID_FIELD before any SQL runs — indistinguishable from a field that does not exist,
   * which is what the Salesforce API does.
   */
  resolve(path: string[], opts: { forFilter?: boolean } = {}): Resolved {
    let obj = this.root;
    let alias = this.rootAlias;
    const relationshipPath: string[] = [];
    let cacheKey = obj.apiName;

    for (let i = 0; i < path.length - 1; i++) {
      const segment = path[i];
      const link = obj.fieldList.find(
        (f) =>
          (f.type === 'Lookup' || f.type === 'MasterDetail') &&
          parentRelationshipName(f).toLowerCase() === segment.toLowerCase()
      );
      if (!link) throw Errors.invalidField(path.slice(0, i + 1).join('.'), obj.apiName);
      if (!this.policy.canReadField(this.ctx, obj, link.apiName)) {
        throw Errors.invalidField(link.apiName, obj.apiName);
      }

      const targets = !link.referenceTo || link.referenceTo === '*' ? [] : link.referenceTo.split(',').map((t) => t.trim());
      if (targets.length !== 1) {
        throw Errors.malformedQuery(
          `relationship '${segment}' is polymorphic; specify the target object with TYPEOF (not yet supported)`
        );
      }
      const parent = getObject(this.org, targets[0]);
      if (!parent) throw Errors.invalidField(segment, obj.apiName);
      if (!this.policy.canReadObject(this.ctx, parent)) throw Errors.invalidType(parent.apiName);

      cacheKey += `.${link.apiName}`;
      const cached = this.joinCache.get(cacheKey);
      if (cached) {
        alias = cached.alias;
        obj = cached.obj;
      } else {
        const parentAlias = this.nextAlias();
        const fkExpr = this.columnExpr(alias, link);
        let on = `${parentAlias}.id = ${fkExpr}`;
        const share = this.policy.sharingPredicate(this.ctx, parent, parentAlias, this.params.length + 1);
        if (share) {
          this.params.push(...share.params);
          on += ` AND ${share.sql}`;
        }
        this.joins.push(`LEFT JOIN ${tableFor(parent.apiName)} ${parentAlias} ON ${on} AND ${parentAlias}.is_deleted = false`);
        this.joinCache.set(cacheKey, { alias: parentAlias, obj: parent });
        alias = parentAlias;
        obj = parent;
      }
      relationshipPath.push(segment);
    }

    const last = path[path.length - 1];
    const field = getField(obj, last);
    if (!field) throw Errors.invalidField(path.join('.'), obj.apiName);
    if (!this.policy.canReadField(this.ctx, obj, field.apiName)) {
      throw Errors.invalidField(field.apiName, obj.apiName);
    }
    if (opts.forFilter && COMPUTED.has(field.type)) {
      throw Errors.malformedQuery(
        `field '${field.apiName}' is a ${field.type} field and cannot be used in WHERE, ORDER BY or GROUP BY yet`
      );
    }

    return { expr: this.columnExpr(alias, field), field, owner: obj, alias, relationshipPath };
  }

  /** SQL expression yielding a field's value: a real column, or a cast JSONB extraction. */
  columnExpr(alias: string, f: FieldMeta): string {
    if (f.column) return `${alias}.${f.column}`;
    const raw = `(${alias}.fields->>'${f.apiName.replace(/'/g, "''")}')`;
    switch (f.type) {
      case 'Number':
      case 'Currency':
      case 'Percent':
        return `${raw}::numeric`;
      case 'Checkbox':
        return `${raw}::boolean`;
      case 'Date':
        return `${raw}::date`;
      case 'DateTime':
        return `${raw}::timestamptz`;
      case 'Time':
        return `${raw}::time`;
      case 'RollupSummary':
        return `${raw}::${rollupCast(f)}`;
      default:
        return raw;
    }
  }

  /* --------------------------------- values -------------------------------- */

  private literal(value: LiteralValue, field: FieldMeta): string {
    switch (value.t) {
      case 'string':
        return this.bind(value.v);
      case 'number':
        return this.bind(value.v);
      case 'bool':
        return this.bind(value.v);
      case 'date':
        return `${this.bind(value.v)}::date`;
      case 'datetime':
        return `${this.bind(value.v)}::timestamptz`;
      case 'null':
        return 'NULL';
      case 'dateLiteral':
        throw Errors.malformedQuery(`date literal ${value.name} is only valid in a comparison on a date field`);
    }
    throw Errors.malformedQuery(`unsupported literal for field ${field.apiName}`);
  }

  /* ------------------------------- conditions ------------------------------ */

  condition(cond: Condition): string {
    switch (cond.kind) {
      case 'and':
        return `(${cond.items.map((c) => this.condition(c)).join(' AND ')})`;
      case 'or':
        return `(${cond.items.map((c) => this.condition(c)).join(' OR ')})`;
      case 'not':
        return `NOT (${this.condition(cond.item)})`;
      case 'cmp':
        return this.comparison(cond);
      case 'cmpAgg':
        return this.aggregateComparison(cond);
      case 'in':
        return this.inList(cond);
      case 'includes':
        return this.includes(cond);
      case 'semiJoin':
        return this.semiJoin(cond);
    }
  }

  /** HAVING COUNT(Id) > 1: the aggregate is rebuilt here so it matches the SELECT expression. */
  private aggregateComparison(cond: Extract<Condition, { kind: 'cmpAgg' }>): string {
    let agg: string;
    if (!cond.path) {
      agg = 'count(*)';
    } else {
      const r = this.resolve(cond.path, { forFilter: true });
      agg = cond.fn === 'COUNT_DISTINCT' ? `count(DISTINCT ${r.expr})` : `${cond.fn.toLowerCase()}(${r.expr})`;
    }
    if (cond.value.t !== 'number') throw Errors.malformedQuery('an aggregate comparison requires a numeric value');
    return `${agg} ${cond.op === '!=' ? '<>' : cond.op} ${this.bind(cond.value.v)}`;
  }

  private comparison(cond: Extract<Condition, { kind: 'cmp' }>): string {
    const { expr, field } = this.resolve(cond.path, { forFilter: true });

    if (cond.value.t === 'null') {
      if (cond.op === '=') return `${expr} IS NULL`;
      if (cond.op === '!=') return `${expr} IS NOT NULL`;
      throw Errors.malformedQuery(`operator ${cond.op} cannot be used with null`);
    }

    if (cond.value.t === 'dateLiteral') {
      const range = resolveDateLiteral(cond.value.name, cond.value.n);
      const cast = field.type === 'Date' ? '::date' : '::timestamptz';
      // Bind lazily: each branch uses a different subset, and an unreferenced bind
      // leaves the parameter list longer than the statement expects.
      const start = () => `${this.bind(range.start)}${cast}`;
      const end = () => `${this.bind(range.end)}${cast}`;
      switch (cond.op) {
        case '=':
          return `(${expr} >= ${start()} AND ${expr} < ${end()})`;
        case '!=':
          return `(${expr} < ${start()} OR ${expr} >= ${end()} OR ${expr} IS NULL)`;
        case '<':
          return `${expr} < ${start()}`;
        case '<=':
          return `${expr} < ${end()}`;
        case '>':
          return `${expr} >= ${end()}`;
        case '>=':
          return `${expr} >= ${start()}`;
        default:
          throw Errors.malformedQuery(`operator ${cond.op} cannot be used with a date literal`);
      }
    }

    if (cond.op === 'LIKE') {
      if (cond.value.t !== 'string') throw Errors.malformedQuery('LIKE requires a string literal');
      return `${expr} ILIKE ${this.bind(cond.value.v)}`;
    }

    const bound = this.literal(cond.value, field);
    // SOQL text comparison ignores case; ids and numbers stay exact.
    if (TEXTUAL.has(field.type) && (cond.op === '=' || cond.op === '!=')) {
      return `lower(${expr}) ${cond.op === '=' ? '=' : '<>'} lower(${bound})`;
    }
    return `${expr} ${cond.op === '!=' ? '<>' : cond.op} ${bound}`;
  }

  private inList(cond: Extract<Condition, { kind: 'in' }>): string {
    const { expr, field } = this.resolve(cond.path, { forFilter: true });
    if (!cond.values.length) return cond.not ? 'TRUE' : 'FALSE';

    const hasNull = cond.values.some((v) => v.t === 'null');
    const concrete = cond.values.filter((v) => v.t !== 'null');
    const parts: string[] = [];

    if (concrete.length) {
      const items = concrete.map((v) => this.literal(v, field));
      if (TEXTUAL.has(field.type)) {
        parts.push(`lower(${expr}) ${cond.not ? 'NOT IN' : 'IN'} (${items.map((i) => `lower(${i})`).join(', ')})`);
      } else {
        parts.push(`${expr} ${cond.not ? 'NOT IN' : 'IN'} (${items.join(', ')})`);
      }
    }
    if (hasNull) parts.push(`${expr} IS ${cond.not ? 'NOT ' : ''}NULL`);

    if (!parts.length) return cond.not ? 'TRUE' : 'FALSE';
    return `(${parts.join(cond.not ? ' AND ' : ' OR ')})`;
  }

  /** INCLUDES/EXCLUDES over a multi-select picklist stored as a ';'-joined string. */
  private includes(cond: Extract<Condition, { kind: 'includes' }>): string {
    const { expr, field } = this.resolve(cond.path, { forFilter: true });
    if (field.type !== 'MultiselectPicklist') {
      throw Errors.malformedQuery(`INCLUDES/EXCLUDES requires a multi-select picklist field, not ${field.apiName}`);
    }
    const wanted = cond.values.map((v) => (v.t === 'string' ? v.v : String((v as any).v)));
    const arr = `${this.bind(wanted)}::text[]`;
    const overlap = `string_to_array(coalesce(${expr}, ''), ';') && ${arr}`;
    return cond.not ? `NOT (${overlap})` : overlap;
  }

  /** WHERE Id IN (SELECT Contact__c FROM Membership__c …) */
  private semiJoin(cond: Extract<Condition, { kind: 'semiJoin' }>): string {
    const { expr } = this.resolve(cond.path, { forFilter: true });
    const inner = getObject(this.org, cond.query.from);
    if (!inner) throw Errors.invalidType(cond.query.from);
    if (!this.policy.canReadObject(this.ctx, inner)) throw Errors.invalidType(cond.query.from);
    if (cond.query.select.length !== 1 || cond.query.select[0].kind !== 'field') {
      throw Errors.malformedQuery('a semi-join subquery must select exactly one field');
    }

    const sub = new Compiler(this.ctx, this.org, inner, this.policy, this.params);
    const target = sub.resolve((cond.query.select[0] as { path: string[] }).path);
    const wheres = [`${sub.alias0}.is_deleted = false`];
    if (cond.query.where) wheres.push(sub.condition(cond.query.where));
    const share = this.policy.sharingPredicate(this.ctx, inner, sub.alias0, this.params.length + 1);
    if (share) {
      this.params.push(...share.params);
      wheres.push(share.sql);
    }

    const sql = `SELECT ${target.expr} FROM ${tableFor(inner.apiName)} ${sub.alias0} ${sub.joinSql()} WHERE ${wheres.join(' AND ')}`;
    return `${expr} ${cond.not ? 'NOT IN' : 'IN'} (${sql})`;
  }
}

/**
 * Compile a parsed query into SQL.
 *
 * Child subqueries are not inlined: they are returned for the executor to run batched against the
 * parent ids, which keeps the generated SQL flat and the row shaping honest.
 */
export function compileQuery(
  ctx: RequestContext,
  org: OrgMeta,
  query: SoqlQuery,
  opts: { policy?: SecurityPolicy } = {}
): CompiledQuery {
  const policy = opts.policy ?? getSecurityPolicy();
  const root = getObject(org, query.from);
  if (!root) throw Errors.invalidType(query.from);
  if (!root.isQueryable) throw Errors.invalidType(query.from);
  if (!policy.canReadObject(ctx, root)) throw Errors.invalidType(query.from);

  const c = new Compiler(ctx, org, root, policy);
  const aggregate = isAggregateQuery(query);

  const columns: OutputColumn[] = [];
  const subqueries: CompiledSubquery[] = [];
  const selectSql: string[] = [];
  let aggIndex = 0;

  const pushColumn = (col: OutputColumn, sql: string) => {
    selectSql.push(`${sql} AS c${columns.length}`);
    columns.push(col);
  };

  for (const item of query.select) {
    if (item.kind === 'subquery') {
      const rel = root.childRelationships.find(
        (r) => (r.relationshipName ?? r.childObject).toLowerCase() === item.relationship.toLowerCase()
      );
      if (!rel) throw Errors.invalidField(item.relationship, root.apiName);
      const child = getObject(org, rel.childObject);
      if (!child) throw Errors.invalidType(rel.childObject);
      if (!policy.canReadObject(ctx, child)) throw Errors.invalidType(rel.childObject);
      subqueries.push({ key: rel.relationshipName ?? rel.childObject, relationship: rel, child, query: item.query });
      continue;
    }

    if (item.kind === 'aggregate') {
      const alias = item.alias ?? `expr${aggIndex++}`;
      let sql: string;
      let field: FieldMeta | undefined;
      if (!item.path) {
        sql = 'count(*)';
      } else {
        const r = c.resolve(item.path, { forFilter: true });
        field = r.field;
        sql =
          item.fn === 'COUNT_DISTINCT'
            ? `count(DISTINCT ${r.expr})`
            : `${item.fn.toLowerCase()}(${r.expr})`;
      }
      pushColumn({ key: alias, item, field, relationshipPath: [], owner: root }, sql);
      continue;
    }

    const r = c.resolve(item.path, { forFilter: false });
    const key = item.alias ?? item.path.join('.');
    if (COMPUTED.has(r.field.type)) {
      // Nothing stored to select; the shaper computes it. Select NULL to keep positions aligned.
      pushColumn({ key, item, field: r.field, relationshipPath: r.relationshipPath, owner: r.owner }, 'NULL');
    } else {
      pushColumn({ key, item, field: r.field, relationshipPath: r.relationshipPath, owner: r.owner }, r.expr);
    }
  }

  // Every non-aggregate query returns Id: the API always includes it, and subquery batching needs it.
  let idColumn = columns.findIndex((col) => col.field?.apiName === 'Id' && !col.relationshipPath.length);
  if (!aggregate && idColumn === -1) {
    const r = c.resolve(['Id']);
    pushColumn(
      { key: 'Id', item: { kind: 'field', path: ['Id'] }, field: r.field, relationshipPath: [], owner: root },
      r.expr
    );
    idColumn = columns.length - 1;
  }

  const wheres: string[] = [];
  if (!query.includeDeleted) wheres.push(`${c.alias0}.is_deleted = false`);
  if (query.scope === 'mine') wheres.push(`${c.alias0}.owner_id = ${c.bind(ctx.userId)}`);
  if (query.where) wheres.push(c.condition(query.where));

  const share = policy.sharingPredicate(ctx, root, c.alias0, c.params.length + 1);
  if (share) {
    c.params.push(...share.params);
    wheres.push(share.sql);
  }

  const groupBy = (query.groupBy ?? []).map((path) => c.resolve(path, { forFilter: true }).expr);
  const having = query.having ? c.condition(query.having) : null;

  const orderBy = (query.orderBy ?? []).map((o) => {
    const r = c.resolve(o.path, { forFilter: true });
    const nulls = o.nulls ? ` NULLS ${o.nulls}` : o.dir === 'ASC' ? ' NULLS LAST' : ' NULLS FIRST';
    return `${r.expr} ${o.dir}${nulls}`;
  });

  let sql = `SELECT ${selectSql.join(', ')} FROM ${tableFor(root.apiName)} ${c.alias0} ${c.joinSql()}`;
  if (wheres.length) sql += ` WHERE ${wheres.join(' AND ')}`;
  if (groupBy.length) sql += ` GROUP BY ${groupBy.join(', ')}`;
  if (having) sql += ` HAVING ${having}`;
  if (orderBy.length) sql += ` ORDER BY ${orderBy.join(', ')}`;
  if (query.limit != null) sql += ` LIMIT ${Number(query.limit)}`;
  if (query.offset != null) sql += ` OFFSET ${Number(query.offset)}`;
  if (query.forUpdate) sql += ' FOR UPDATE';

  return { sql, params: c.params, columns, subqueries, isAggregate: aggregate, root, idColumn };
}
