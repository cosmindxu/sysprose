/**
 * OMG-API-shaped Query engine.
 *
 * Implements the SysML v2 API & Services "Query" semantics (see
 * docs/02-omg-standard-reference.md §5.5) as a pure, in-browser evaluator over a
 * {@link Model}. A Query is a plain-JSON object — a recursive constraint tree
 * plus an optional projection, scope and pagination window — so the very same
 * payload can be evaluated locally here and forwarded unchanged to a conformant
 * remote server.
 *
 * Faithfulness notes vs. the reference OpenAPI:
 *  - The reference PSM uses `PrimitiveConstraint{property,operator,value,inverse}`
 *    and `CompositeConstraint{operator:'and'|'or', constraint:[…]}`. We accept
 *    BOTH the OMG-canonical `CompositeConstraint{operator,constraint}` spelling
 *    and the plan §6 ergonomic `{kind:'and'|'or'|'not',operands}` spelling
 *    (normalised internally), over a richer operator set
 *    (`=,!=,<,>,<=,>=,in,contains,exists,matches`) on the same recursive tree.
 *  - Ordering (`orderBy`, stable) and both offset (`{offset,limit}`) and cursor
 *    (`{size,after}` → `nextCursor`) pagination follow the REST PSM's paging.
 *  - Property paths resolve against the synthetic OMG field names (`@id`,`@type`,
 *    `name`, `qualifiedName`, …) as well as `attrs.*` dot paths, matching how the
 *    wire JSON surfaces metaclass-specific fields as open `additionalProperties`.
 */

import type { ElementRecord, Model } from '@core/index';

/** The primitive (leaf) comparison operators. */
export type PrimitiveOperator =
  | '='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | 'in'
  | 'contains'
  | 'exists'
  | 'matches';

/** A leaf test on a single (possibly dotted) property of an element. */
export interface PrimitiveConstraint {
  property: string;
  operator: PrimitiveOperator;
   
  value?: any;
}

/**
 * A boolean combination of child constraints. Two spellings are accepted and
 * treated identically:
 *  - the ergonomic plan §6 form `{ kind, operands }`, and
 *  - the OMG-canonical PSM form `{ operator, constraint }`
 *    (`@type: 'CompositeConstraint'`).
 * Supply either pair; {@link asComposite} normalises both internally.
 */
export interface CompositeConstraint {
  /** Ergonomic spelling of the boolean operator. */
  kind?: 'and' | 'or' | 'not';
  /** Ergonomic spelling of the child constraints. */
  operands?: Constraint[];
  /** OMG-canonical spelling of the boolean operator. */
  operator?: 'and' | 'or' | 'not';
  /** OMG-canonical spelling of the child constraints. */
  constraint?: Constraint[];
}

/** Either a leaf or a composite node — the recursive constraint tree. */
export type Constraint = PrimitiveConstraint | CompositeConstraint;

/**
 * Pagination window over the matched result set. Two mutually-exclusive modes:
 *  - **offset paging** — `{ offset, limit }` (skip `offset`, take `limit`).
 *  - **cursor paging**  — `{ size, after }` where `after` is an opaque cursor
 *    (the id of the last element of the previous page); the window is the
 *    `size` elements that follow it. When more results remain, the
 *    {@link QueryResult} carries a `nextCursor`.
 * Cursor mode is selected whenever `size` or `after` is present.
 */
export interface QueryPage {
  offset?: number;
  limit?: number;
  size?: number;
  after?: string;
}

/** A single ordering criterion (stable sort). */
export interface OrderBy {
  property: string;
  direction?: 'asc' | 'desc';
}

/** A complete query: optional constraint tree, projection, scope and paging. */
export interface Query {
  constraint?: Constraint;
  /** Projection: property paths to return instead of whole element records. */
  select?: string[];
  /** Restrict evaluation to a subtree rooted at this element (inclusive). */
  scopeOwnerId?: string;
  /** Stable multi-key ordering applied before pagination. */
  orderBy?: OrderBy[];
  page?: QueryPage;
}

/** Result of evaluating a {@link Query} against a model commit. */
/**
 * A `select`-projected row: the requested property values only. This is a
 * JSON-OUT payload — it is NOT a live {@link ElementRecord} and is never fed
 * back into the model (finding M14).
 */
export type ProjectedRow = Record<string, unknown>;

export interface QueryResult {
  commitId: string;
  /** Matched elements; when `query.select` is given, {@link ProjectedRow}s. */
  elements: Array<ElementRecord | ProjectedRow>;
  total: number;
  /** Opaque cursor for the next page (present only when more results remain). */
  nextCursor?: string;
}

/* ───────────────────────────── Commit identity ──────────────────────────── */

/**
 * Derive a deterministic, monotonic commit id from a model. Intentionally avoids
 * Date.now/Math.random so reads are reproducible and snapshot-stable: the id is a
 * function of the element count plus an optional caller-supplied counter (the SDK
 * supplies its mutation counter; standalone reads use 0).
 */
export function modelCommitId(model: Model, counter = 0): string {
  return `commit-${model.size}-${counter}`;
}

/* ─────────────────────────── Property resolution ────────────────────────── */

/**
 * Normalise either composite spelling to `{ op, operands }`, or return `null`
 * when `c` is not a composite. The ergonomic (`kind`/`operands`) and OMG
 * (`operator`/`constraint`) spellings are recognised interchangeably; the
 * primitive operator set is disjoint from the boolean one, so a leaf is never
 * mistaken for a composite.
 */
function asComposite(c: Constraint): { op: 'and' | 'or' | 'not'; operands: Constraint[] } | null {
  const anyC = c as CompositeConstraint;
  const op = anyC.kind ?? anyC.operator;
  if (op === 'and' || op === 'or' || op === 'not') {
    const operands = anyC.operands ?? anyC.constraint;
    if (Array.isArray(operands)) return { op, operands };
  }
  return null;
}

/**
 * Resolve a property path on an element against the OMG/synthetic field set and
 * `attrs.*` dot paths. Recognised aliases:
 *  - `@id` | `id` | `identifier`            → element id
 *  - `@type` | `eClass` | `type`            → metaclass name
 *  - `name` | `declaredName`                → declared name
 *  - `shortName` | `declaredShortName`      → declared short name
 *  - `qualifiedName`                        → fully-qualified name
 *  - `ownerId` | `owner`                    → owner id
 *  - `source` / `target`                    → relationship endpoint arrays
 *  - `attrs.<k>.<k2>…`                      → nested attribute path
 *  - bare `<k>`                             → falls back to `attrs.<k>`
 */
export function getProperty(model: Model, el: ElementRecord, path: string): unknown {
  // Defensive: a malformed query constraint can supply a non-string `property`
  // (the API cast doesn't guarantee it); treat it as an unmatchable path rather
  // than crashing on `path.split` (finding H1).
  if (typeof path !== 'string') return undefined;
  switch (path) {
    case '@id':
    case 'id':
    case 'identifier':
      return el.id;
    case '@type':
    case 'eClass':
    case 'type':
      return el.eClass;
    case 'name':
    case 'declaredName':
      return el.declaredName;
    case 'shortName':
    case 'declaredShortName':
      return el.declaredShortName;
    case 'qualifiedName':
      return model.qualifiedName(el.id);
    case 'ownerId':
    case 'owner':
      return el.ownerId;
    case 'source':
      return el.source;
    case 'target':
      return el.target;
    default:
      break;
  }
  const parts = path.split('.');
   
  let cur: any;
  if (parts[0] === 'attrs') {
    cur = el.attrs;
    parts.shift();
  } else {
    cur = el as unknown as Record<string, unknown>;
  }
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  if (cur === undefined && el.attrs[path] !== undefined) return el.attrs[path];
  return cur;
}

/**
 * Loose equality tolerant of number/string boundary mismatches (1500 == "1500").
 *
 * A number and a string that denote the same finite number are also equal, so
 * a query persisted as `{ value: '-2.50' }` while signed literals were stored
 * as strings keeps matching the number -2.5 the parser stores now. Two strings
 * are only ever equal verbatim: names such as `'1.0'` and `'01'` are distinct
 * identifiers, not numbers, and must not collapse onto `'1'`.
 */
function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (String(a) === String(b)) return true;
  if (typeof a !== 'number' && typeof b !== 'number') return false;
  const na = numericOf(a);
  const nb = numericOf(b);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

/** A decimal literal as the language writes it — no hex/binary/octal, no blanks. */
const DECIMAL_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * The number a query operand denotes, or NaN. Only numbers and decimal
 * literal strings qualify: `true` must not equal 1, `''` must not equal 0,
 * `'0x10'` is a name rather than 16, and arrays or objects never denote a
 * number even though `Number([5])` is 5.
 */
function numericOf(x: unknown): number {
  if (typeof x === 'number') return x;
  if (typeof x === 'string' && DECIMAL_RE.test(x)) return Number(x);
  return NaN;
}

/** Cache compiled patterns so a query over N elements compiles once, not N times. */
const regexCache = new Map<string, RegExp | null>();

/**
 * ReDoS-safe `matches`. The pattern comes from unauthenticated callers
 * (`POST /queries`, stored queries), so we reject patterns whose shape admits
 * catastrophic backtracking (nested/adjacent unbounded quantifiers) and bound
 * both the pattern and the tested string length. A rejected pattern never
 * matches rather than blocking the event loop.
 */
function safeRegexTest(pattern: string, input: string): boolean {
  if (pattern.length > 1000 || input.length > 100_000) return false;
  let re = regexCache.get(pattern);
  if (re === undefined) {
    re = isDangerousPattern(pattern) ? null : tryCompile(pattern);
    regexCache.set(pattern, re);
  }
  return re !== null && re.test(input);
}

/**
 * Reject the classic exponential-backtracking shape: an unbounded quantifier
 * (`+`, `*`, or `{n,}`) applied to a group or character class that itself
 * already contains an unbounded quantifier — e.g. `(a+)+`, `(a*)*`, `([a-z]+)*`.
 */
function isDangerousPattern(pattern: string): boolean {
  return /(\([^)]*[+*][^)]*\)|\[[^\]]*\]\+|\[[^\]]*\]\*)\s*[+*]|\)\s*[+*]\s*[+*]/.test(pattern);
}

function tryCompile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function evalPrimitive(model: Model, el: ElementRecord, c: PrimitiveConstraint): boolean {
  const actual = getProperty(model, el, c.property);
  switch (c.operator) {
    case 'exists': {
      const present = actual !== undefined && actual !== null;
      return c.value === false ? !present : present;
    }
    case '=':
      return looseEq(actual, c.value);
    case '!=':
      return !looseEq(actual, c.value);
    case '<':
      return actual != null && (actual as number | string) < c.value;
    case '>':
      return actual != null && (actual as number | string) > c.value;
    case '<=':
      return actual != null && (actual as number | string) <= c.value;
    case '>=':
      return actual != null && (actual as number | string) >= c.value;
    case 'matches':
      return typeof actual === 'string' && safeRegexTest(String(c.value), actual);
    case 'in':
      return Array.isArray(c.value) && c.value.some((v) => looseEq(v, actual));
    case 'contains': {
      if (Array.isArray(actual)) return actual.some((v) => looseEq(v, c.value));
      if (typeof actual === 'string') return actual.includes(String(c.value));
      return false;
    }
    default:
      return false;
  }
}

/** Evaluate a constraint (leaf or composite) against a single element. */
export function matchesConstraint(model: Model, el: ElementRecord, c: Constraint): boolean {
  const comp = asComposite(c);
  if (comp) {
    switch (comp.op) {
      case 'and':
        return comp.operands.every((o) => matchesConstraint(model, el, o));
      case 'or':
        return comp.operands.some((o) => matchesConstraint(model, el, o));
      case 'not':
        // NOR semantics: excluded if it matches ANY operand (plain negation for one).
        return !comp.operands.some((o) => matchesConstraint(model, el, o));
      default:
        return false;
    }
  }
  return evalPrimitive(model, el, c as PrimitiveConstraint);
}

/* ─────────────────────────────── Evaluation ─────────────────────────────── */

/** Project an element down to the selected property paths (OMG `select`). */
function project(model: Model, el: ElementRecord, select: string[]): ProjectedRow {
  const row: ProjectedRow = {};
  for (const p of select) row[p] = getProperty(model, el, p);
  return row;
}

/**
 * Evaluate a {@link Query} against a model, returning matched elements (optionally
 * projected) with the total match count (before pagination) and the commit id.
 */
export function evaluateQuery(model: Model, query: Query = {}): QueryResult {
  let pool: ElementRecord[];
  if (query.scopeOwnerId) {
    const scope = model.get(query.scopeOwnerId);
    pool = scope ? [scope, ...model.descendants(query.scopeOwnerId)] : [];
  } else {
    pool = model.all();
  }

  const matched = query.constraint
    ? pool.filter((el) => matchesConstraint(model, el, query.constraint!))
    : pool;

  // Stable multi-key ordering (index tie-break guarantees stability).
  const sorted =
    query.orderBy && query.orderBy.length > 0
      ? stableSort(model, matched, query.orderBy)
      : matched;
  const total = sorted.length;

  // Pagination — cursor mode when `size`/`after` present, else offset mode.
  const page = query.page ?? {};
  let windowed: ElementRecord[];
  let windowStart: number;
  if (page.size !== undefined || page.after !== undefined) {
    windowStart = 0;
    if (page.after !== undefined) {
      const idx = sorted.findIndex((el) => el.id === page.after);
      windowStart = idx >= 0 ? idx + 1 : sorted.length;
    }
    const size = page.size != null ? Math.max(0, page.size) : sorted.length;
    windowed = sorted.slice(windowStart, windowStart + size);
  } else {
    windowStart = Math.max(0, page.offset ?? 0);
    const limit = page.limit;
    windowed =
      limit != null
        ? sorted.slice(windowStart, windowStart + Math.max(0, limit))
        : sorted.slice(windowStart);
  }

  // A next cursor is emitted whenever the window does not reach the last row.
  // The window's last index in `sorted` is known from windowStart — no O(n)
  // indexOf scan needed.
  let nextCursor: string | undefined;
  const last = windowed[windowed.length - 1];
  if (last) {
    const lastIndex = windowStart + windowed.length - 1;
    if (lastIndex < total - 1) nextCursor = last.id;
  }

  const elements =
    query.select && query.select.length > 0
      ? windowed.map((el) => project(model, el, query.select!))
      : windowed;

  const result: QueryResult = { commitId: modelCommitId(model), elements, total };
  if (nextCursor !== undefined) result.nextCursor = nextCursor;
  return result;
}

/** Compare two property values: numbers numerically, else lexically; null/undefined last. */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Stable sort of `els` by the ordered `criteria` (ascending unless `desc`). */
function stableSort(model: Model, els: ElementRecord[], criteria: OrderBy[]): ElementRecord[] {
  return els
    .map((el, i) => ({ el, i }))
    .sort((a, b) => {
      for (const o of criteria) {
        let c = compareValues(getProperty(model, a.el, o.property), getProperty(model, b.el, o.property));
        if (o.direction === 'desc') c = -c;
        if (c !== 0) return c;
      }
      return a.i - b.i;
    })
    .map((x) => x.el);
}
