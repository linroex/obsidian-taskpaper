/** Token kinds for the TaskPaper item-path query language. */
export type TokenType =
  | 'tag' // @name
  | 'word' // bareword / keyword / axis / relation word
  | 'string' // "quoted" or 'quoted'
  | 'op' // = != < > <= >=
  | 'lparen'
  | 'rparen'
  | 'slash' // /
  | 'dslash' // //
  | 'coloncolon' // ::
  | 'mod'; // [i], [s], [n], [d] ...

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const OP_CHARS = new Set(['=', '!', '<', '>']);

/** Tokenize a query string. Throws on unterminated strings. */
export function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  const push = (type: TokenType, value: string, pos: number) => tokens.push({ type, value, pos });

  while (i < n) {
    const c = input[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    // Path separators.
    if (c === '/') {
      if (input[i + 1] === '/') {
        push('dslash', '//', i);
        i += 2;
      } else {
        push('slash', '/', i);
        i++;
      }
      continue;
    }

    if (c === '(') {
      push('lparen', '(', i);
      i++;
      continue;
    }
    if (c === ')') {
      push('rparen', ')', i);
      i++;
      continue;
    }

    if (c === ':' && input[i + 1] === ':') {
      push('coloncolon', '::', i);
      i += 2;
      continue;
    }

    // Modifier group: [isnd]
    if (c === '[') {
      const close = input.indexOf(']', i + 1);
      if (close === -1) {
        push('word', input.slice(i + 1), i);
        i = n;
      } else {
        push('mod', input.slice(i + 1, close), i);
        i = close + 1;
      }
      continue;
    }

    // Quoted strings.
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      let value = '';
      while (i < n && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < n) {
          value += input[i + 1];
          i += 2;
        } else {
          value += input[i];
          i++;
        }
      }
      if (i >= n) {
        throw new Error(`Unterminated string starting at position ${start}`);
      }
      i++; // closing quote
      push('string', value, start);
      continue;
    }

    // Operators. A lone `!` (not followed by `=`) is an alias for `not`;
    // only `!=` is a real operator.
    if (OP_CHARS.has(c)) {
      if (c === '!' && input[i + 1] !== '=') {
        push('word', 'not', i);
        i++;
        continue;
      }
      const start = i;
      let op = c;
      i++;
      if (input[i] === '=') {
        op += '=';
        i++;
      }
      push('op', op, start);
      continue;
    }

    if (c === '@') {
      const start = i;
      i++;
      let name = '';
      while (i < n && /[A-Za-z0-9._-]/.test(input[i])) {
        name += input[i];
        i++;
      }
      push('tag', name, start);
      continue;
    }

    if (c === '&') {
      push('word', 'and', i);
      i++;
      continue;
    }
    if (c === '|') {
      push('word', 'or', i);
      i++;
      continue;
    }

    // Bareword: run of non-special characters.
    const start = i;
    let word = '';
    while (i < n && !isBreak(input[i])) {
      word += input[i];
      i++;
    }
    if (word.length === 0) {
      // Unknown single char; skip to avoid infinite loop.
      i++;
      continue;
    }
    push('word', word, start);
  }

  return tokens;
}

function isBreak(c: string): boolean {
  return (
    c === ' ' ||
    c === '\t' ||
    c === '\n' ||
    c === '\r' ||
    c === '(' ||
    c === ')' ||
    c === '/' ||
    c === '[' ||
    c === ']' ||
    c === '"' ||
    c === "'" ||
    c === '=' ||
    c === '<' ||
    c === '>' ||
    c === '!' ||
    c === '&' ||
    c === '|'
  );
}

/** Quote a value as a query string literal, escaping backslashes and quotes. */
export function quoteQueryValue(value: string): string {
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}
