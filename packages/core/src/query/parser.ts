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

export interface Step {
  /** How candidates are drawn from each context node before filtering. */
  sep: 'child' | 'descendant';
  /** Explicit axis override (from `axis::`). */
  axis?: Axis;
  pred: Predicate;
}

export interface Query {
  steps: Step[];
}

const RELATION_WORDS = new Set(['contains', 'beginswith', 'endswith', 'matches']);
const TYPE_WORDS = new Set(['project', 'task', 'note', 'item']);
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

    if (this.peek()) {
      throw new Error(`Unexpected token "${this.peek()!.value}" in query`);
    }
    return { steps };
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
    return { sep, axis, pred };
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
      if (RELATION_WORDS.has(w)) {
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
        const value = this.readValue();
        const mods = this.readMods();
        return { t: 'cmp', attr: t.value, rel, value, mods };
      }
      return { t: 'has', attr: t.value };
    }

    if (t.type === 'string') {
      return { t: 'text', value: t.value };
    }

    if (t.type === 'word') {
      const w = t.value.toLowerCase();
      if (TYPE_WORDS.has(w)) {
        return { t: 'type', kind: w as 'project' | 'task' | 'note' | 'item' };
      }
      // `attr relation value` where attr is a plain identifier (text, type, line, level...)
      const rel = this.tryReadRelation();
      if (rel) {
        const value = this.readValue();
        const mods = this.readMods();
        return { t: 'cmp', attr: t.value, rel, value, mods };
      }
      // Otherwise a bare text-search term.
      return { t: 'text', value: t.value };
    }

    throw new Error(`Unexpected token "${t.value}" in query`);
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
    if (t && t.type === 'mod') {
      this.next();
      return t.value.toLowerCase();
    }
    return '';
  }
}
