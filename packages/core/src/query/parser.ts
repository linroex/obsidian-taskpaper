import { lex, Token } from './lexer';

export type Relation =
  | '='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | 'contains'
  | 'beginswith'
  | 'endswith'
  | 'matches';

export type Axis =
  | 'child'
  | 'descendant'
  | 'descendant-or-self'
  | 'parent'
  | 'ancestor'
  | 'ancestor-or-self'
  | 'self'
  | 'following-sibling'
  | 'preceding-sibling';

export type Predicate =
  | { t: 'or'; a: Predicate; b: Predicate }
  | { t: 'and'; a: Predicate; b: Predicate }
  | { t: 'not'; a: Predicate }
  | { t: 'has'; attr: string }
  | { t: 'cmp'; attr: string; rel: Relation; value: string; mods: string }
  | { t: 'type'; kind: 'project' | 'task' | 'note' | 'item' }
  | { t: 'text'; value: string };

/** Set operations combining two item-path expressions (lowest precedence). */
export type SetOp = 'union' | 'intersect' | 'except';

/** Trailing result slice on a step, JS Array.slice-style. */
export interface Slice {
  /** `[N]` — select the single Nth (0-based) match; negatives count from the end. */
  index?: number;
  /** `[start:end]` bounds; either side may be omitted. */
  start?: number;
  end?: number;
}

export interface Step {
  /** How candidates are drawn from each context node before filtering. */
  sep: 'child' | 'descendant';
  /** Explicit axis override (from `axis::`). */
  axis?: Axis;
  pred: Predicate;
  /** Optional `[N]` / `[start:end]` slice applied to this step's matches. */
  slice?: Slice;
}

export type Query =
  | { t: 'path'; steps: Step[] }
  | { t: SetOp; a: Query; b: Query };

const RELATION_WORDS = new Set(['contains', 'beginswith', 'endswith', 'matches']);
const TYPE_WORDS = new Set(['project', 'task', 'note', 'item']);
const SET_OP_WORDS = new Set(['union', 'intersect', 'except']);
// A `[...]` group is a slice when it holds only digits, `-` and `:` (relation
// modifiers are letters).
const SLICE_RE = /^(-?\d+|(-?\d+)?:(-?\d+)?)$/;
const AXIS_WORDS = new Set<string>([
  'child',
  'descendant',
  'descendant-or-self',
  'parent',
  'ancestor',
  'ancestor-or-self',
  'self',
  'following-sibling',
  'preceding-sibling',
]);

/** Parse a query string into a Query AST. Throws on malformed input. */
export function parseQuery(input: string): Query {
  const tokens = lex(input);
  return new Parser(tokens).parseQuery();
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }
  private next(): Token | undefined {
    return this.tokens[this.i++];
  }
  private isWord(value: string): boolean {
    const t = this.peek();
    return !!t && t.type === 'word' && t.value.toLowerCase() === value;
  }

  parseQuery(): Query {
    const query = this.parsePathExpr();
    if (this.peek()) {
      throw new Error(`Unexpected token "${this.peek()!.value}" in query`);
    }
    return query;
  }

  // Set operations have the lowest precedence and associate left.
  private parsePathExpr(): Query {
    let left = this.parsePathTerm();
    while (this.peekSetOp()) {
      const op = this.next()!.value.toLowerCase() as SetOp;
      const right = this.parsePathTerm();
      left = { t: op, a: left, b: right };
    }
    return left;
  }

  // A parenthesis may wrap a whole path expression (`(a//b union //c)`) or
  // merely group a predicate (`(a or b) and c`). Try the path-expression
  // reading first and backtrack when the paren turns out to be grouping.
  private parsePathTerm(): Query {
    if (this.peek()?.type === 'lparen') {
      const save = this.i;
      this.next();
      try {
        const inner = this.parsePathExpr();
        const close = this.next();
        if (close?.type === 'rparen' && this.atPathTermEnd()) {
          return inner;
        }
      } catch {
        // Fall through and re-parse as a predicate paren.
      }
      this.i = save;
    }
    return this.parsePath();
  }

  private atPathTermEnd(): boolean {
    const t = this.peek();
    return !t || t.type === 'rparen' || this.peekSetOp();
  }

  private peekSetOp(): boolean {
    const t = this.peek();
    return !!t && t.type === 'word' && SET_OP_WORDS.has(t.value.toLowerCase());
  }

  private parsePath(): Query {
    const steps: Step[] = [];

    // Leading separator determines whether we start from root children or all items.
    let firstSep: 'child' | 'descendant' = 'descendant';
    if (this.peek()?.type === 'dslash') {
      this.next();
      firstSep = 'descendant';
    } else if (this.peek()?.type === 'slash') {
      this.next();
      firstSep = 'child';
    }

    steps.push(this.parseStep(firstSep));

    while (this.peek() && (this.peek()!.type === 'slash' || this.peek()!.type === 'dslash')) {
      const sepTok = this.next()!;
      const sep = sepTok.type === 'dslash' ? 'descendant' : 'child';
      steps.push(this.parseStep(sep));
    }

    return { t: 'path', steps };
  }

  private parseStep(sep: 'child' | 'descendant'): Step {
    let axis: Axis | undefined;
    // axis:: prefix
    const t = this.peek();
    if (t && t.type === 'word' && AXIS_WORDS.has(t.value.toLowerCase()) && this.tokens[this.i + 1]?.type === 'coloncolon') {
      this.next(); // axis word
      this.next(); // ::
      axis = t.value.toLowerCase() as Axis;
    }
    const pred = this.parseOr();
    const slice = this.readSlice();
    return { sep, axis, pred, slice };
  }

  private parseOr(): Predicate {
    let left = this.parseAnd();
    while (this.isWord('or')) {
      this.next();
      const right = this.parseAnd();
      left = { t: 'or', a: left, b: right };
    }
    return left;
  }

  private parseAnd(): Predicate {
    let left = this.parseNot();
    while (true) {
      if (this.isWord('and')) {
        this.next();
        left = { t: 'and', a: left, b: this.parseNot() };
        continue;
      }
      // Juxtaposition implies AND when the next token starts a new primary.
      if (this.startsPrimary()) {
        left = { t: 'and', a: left, b: this.parseNot() };
        continue;
      }
      break;
    }
    return left;
  }

  private parseNot(): Predicate {
    if (this.isWord('not')) {
      this.next();
      return { t: 'not', a: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private startsPrimary(): boolean {
    const t = this.peek();
    if (!t) {
      return false;
    }
    if (t.type === 'lparen' || t.type === 'tag' || t.type === 'string') {
      return true;
    }
    if (t.type === 'word') {
      const w = t.value.toLowerCase();
      if (w === 'and' || w === 'or') {
        return false;
      }
      if (RELATION_WORDS.has(w) || SET_OP_WORDS.has(w)) {
        return false;
      }
      // An axis word directly followed by :: belongs to the next step, not this predicate.
      if (AXIS_WORDS.has(w) && this.tokens[this.i + 1]?.type === 'coloncolon') {
        return false;
      }
      return true;
    }
    return false;
  }

  private parsePrimary(): Predicate {
    const t = this.next();
    if (!t) {
      throw new Error('Unexpected end of query');
    }

    if (t.type === 'lparen') {
      const inner = this.parseOr();
      const close = this.next();
      if (!close || close.type !== 'rparen') {
        throw new Error('Expected closing ")"');
      }
      return inner;
    }

    if (t.type === 'tag') {
      const rel = this.tryReadRelation();
      if (rel) {
        return this.finishComparison(t.value, rel);
      }
      return { t: 'has', attr: t.value };
    }

    if (t.type === 'string') {
      return { t: 'text', value: t.value };
    }

    if (t.type === 'word') {
      const w = t.value.toLowerCase();
      // `*` is the universal predicate: any item.
      if (w === '*') {
        return { t: 'type', kind: 'item' };
      }
      if (TYPE_WORDS.has(w)) {
        return { t: 'type', kind: w as 'project' | 'task' | 'note' | 'item' };
      }
      // `attr relation value` where attr is a plain identifier (text, type, line, level...)
      const rel = this.tryReadRelation();
      if (rel) {
        return this.finishComparison(t.value, rel);
      }
      // Otherwise a bare text-search term.
      return { t: 'text', value: t.value };
    }

    throw new Error(`Unexpected token "${t.value}" in query`);
  }

  // Modifiers may follow the relation (`<[d] tomorrow`, TaskPaper-style) or
  // trail the value (`<= today [d]`); accept both.
  private finishComparison(attr: string, rel: Relation): Predicate {
    const before = this.readMods();
    const value = this.readValue();
    const after = this.readMods();
    return { t: 'cmp', attr, rel, value, mods: before + after };
  }

  private tryReadRelation(): Relation | undefined {
    const t = this.peek();
    if (!t) {
      return undefined;
    }
    if (t.type === 'op') {
      this.next();
      return t.value as Relation;
    }
    if (t.type === 'word' && RELATION_WORDS.has(t.value.toLowerCase())) {
      this.next();
      return t.value.toLowerCase() as Relation;
    }
    return undefined;
  }

  private readValue(): string {
    const t = this.next();
    if (!t) {
      throw new Error('Expected a value after relation');
    }
    if (t.type === 'string' || t.type === 'word') {
      return t.value;
    }
    if (t.type === 'tag') {
      return t.value;
    }
    throw new Error(`Expected a value but found "${t.value}"`);
  }

  private readMods(): string {
    const t = this.peek();
    // Letter groups only — digit/colon groups are slices and belong to the step.
    if (t && t.type === 'mod' && /^[A-Za-z]+$/.test(t.value)) {
      this.next();
      return t.value.toLowerCase();
    }
    return '';
  }

  private readSlice(): Slice | undefined {
    const t = this.peek();
    if (!t || t.type !== 'mod' || !SLICE_RE.test(t.value)) {
      return undefined;
    }
    this.next();
    if (!t.value.includes(':')) {
      return { index: parseInt(t.value, 10) };
    }
    const [startText, endText] = t.value.split(':');
    return {
      start: startText === '' ? undefined : parseInt(startText, 10),
      end: endText === '' ? undefined : parseInt(endText, 10),
    };
  }
}
