"use strict";

// src/tags.ts
var TAG_RE = /@([A-Za-z0-9._-]+)(?:\(((?:\\.|[^)\\])*)\))?/g;
function parseTags(lineText) {
  const tags = [];
  TAG_RE.lastIndex = 0;
  let m;
  while (m = TAG_RE.exec(lineText)) {
    tags.push({
      name: m[1],
      value: m[2] === void 0 ? void 0 : unescapeValue(m[2]),
      start: m.index,
      end: m.index + m[0].length
    });
  }
  return tags;
}
function tagMap(lineText) {
  const map = /* @__PURE__ */ new Map();
  for (const t of parseTags(lineText)) {
    map.set(t.name, t.value ?? "");
  }
  return map;
}
function hasTag(lineText, name) {
  return parseTags(lineText).some((t) => t.name === name);
}
function pad(n) {
  return n < 10 ? "0" + n : String(n);
}
function todayStamp(includeTime, now = /* @__PURE__ */ new Date()) {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (!includeTime) {
    return date;
  }
  return `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
function unescapeValue(raw) {
  return raw.replace(/\\(.)/g, "$1");
}
function escapeValue(value) {
  return value.replace(/([()\\])/g, "\\$1");
}
function formatTag(name, value) {
  if (value === void 0 || value === "") {
    return `@${name}`;
  }
  return `@${name}(${escapeValue(value)})`;
}
function addTag(lineText, name, value) {
  if (parseTags(lineText).some((t) => t.name === name)) {
    return setTagValue(lineText, name, value);
  }
  const trailing = lineText.match(/\s*$/)?.[0] ?? "";
  const core = trailing ? lineText.slice(0, lineText.length - trailing.length) : lineText;
  const sep = core.length === 0 || /\s$/.test(core) ? "" : " ";
  return `${core}${sep}${formatTag(name, value)}${trailing}`;
}
function removeTag(lineText, name) {
  const indent = /^[\t ]*/.exec(lineText)?.[0] ?? "";
  const body = lineText.slice(indent.length).replace(new RegExp(`\\s*@${escapeRegExp(name)}(?:\\((?:\\\\.|[^)\\\\])*\\))?`, "g"), "").replace(/^ +| +$/g, "");
  return indent + body;
}
function removeAllTags(lineText) {
  const indent = /^[\t ]*/.exec(lineText)?.[0] ?? "";
  const body = lineText.slice(indent.length).replace(/\s*@[A-Za-z0-9._-]+(?:\((?:\\.|[^)\\])*\))?/g, "").replace(/^ +| +$/g, "");
  return indent + body;
}
function setTagValue(lineText, name, value) {
  const tags = parseTags(lineText);
  const existing = tags.find((t) => t.name === name);
  if (!existing) {
    return addTag(lineText, name, value);
  }
  const before = lineText.slice(0, existing.start);
  const after = lineText.slice(existing.end);
  return `${before}${formatTag(name, value)}${after}`;
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/model.ts
var LEADING_WS = /^[\t ]*/;
function lineKind(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "blank";
  }
  if (/^-\s+/.test(trimmed) || trimmed === "-") {
    return "task";
  }
  if (/:(\s+@[A-Za-z0-9._-]+(\([^)]*\))?)*\s*$/.test(text)) {
    return "project";
  }
  return "note";
}
function indentWidth(leading, tabSize) {
  let width = 0;
  for (const ch of leading) {
    if (ch === "	") {
      width += tabSize - width % tabSize;
    } else {
      width += 1;
    }
  }
  return width;
}
function displayTextFor(kind, text) {
  if (kind === "task") {
    return text.replace(/^-\s+/, "").replace(/^-$/, "");
  }
  if (kind === "project") {
    return text.replace(/:(\s*(@[A-Za-z0-9._-]+(\([^)]*\))?\s*)*)$/, "$1").trimEnd();
  }
  return text;
}
function buildOutline(lines2, tabSize) {
  const items = [];
  const roots = [];
  const stack = [];
  for (let i = 0; i < lines2.length; i++) {
    const raw = lines2[i];
    const kind = lineKind(raw);
    if (kind === "blank") {
      continue;
    }
    const leading = LEADING_WS.exec(raw)?.[0] ?? "";
    const indent = indentWidth(leading, tabSize);
    const text = raw.slice(leading.length);
    const item = {
      line: i,
      kind,
      indent,
      level: 0,
      raw,
      text,
      displayText: displayTextFor(kind, text),
      tags: tagMap(text),
      parent: null,
      children: [],
      subtreeEnd: i
    };
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    if (parent) {
      item.parent = parent;
      item.level = parent.level + 1;
      parent.children.push(item);
    } else {
      roots.push(item);
    }
    items.push(item);
    stack.push(item);
  }
  computeSubtreeEnds(items, lines2.length);
  return { items, roots, lineCount: lines2.length };
}
function computeSubtreeEnds(items, lineCount) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let end = lineCount - 1;
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].indent <= item.indent) {
        end = items[j].line - 1;
        break;
      }
    }
    item.subtreeEnd = Math.max(item.line, end);
  }
}
function itemAtLine(outline2, line) {
  let best;
  for (const item of outline2.items) {
    if (item.line <= line && line <= item.subtreeEnd) {
      if (!best || item.level > best.level) {
        best = item;
      }
    }
  }
  return best;
}

// src/dates.ts
var DAY = 864e5;
var WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday"
];
var WEEKDAY_ABBR = {
  sun: 0,
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  weds: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
  sat: 6
};
var UNIT_DAYS = {
  d: 1,
  day: 1,
  days: 1,
  w: 7,
  week: 7,
  weeks: 7
};
function midnight(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function weekdayIndex(word) {
  const w = word.toLowerCase();
  const full = WEEKDAYS.indexOf(w);
  if (full >= 0) {
    return full;
  }
  return w in WEEKDAY_ABBR ? WEEKDAY_ABBR[w] : void 0;
}
function parseDate(value, now = /* @__PURE__ */ new Date()) {
  const v = value.trim().toLowerCase();
  const base = midnight(now);
  if (v === "today" || v === "now") {
    return base;
  }
  if (v === "tomorrow") {
    return base + DAY;
  }
  if (v === "yesterday") {
    return base - DAY;
  }
  if (v === "next week") {
    return base + 7 * DAY;
  }
  if (v === "last week") {
    return base - 7 * DAY;
  }
  const iso2 = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (iso2) {
    const [, y, mo, d, h, mi, s] = iso2;
    return new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      h ? Number(h) : 0,
      mi ? Number(mi) : 0,
      s ? Number(s) : 0
    ).getTime();
  }
  const off = /^(?:in\s+)?([+-]?\d+)\s*(d|day|days|w|week|weeks)$/.exec(v);
  if (off) {
    return base + Number(off[1]) * UNIT_DAYS[off[2]] * DAY;
  }
  const wd = /^(next|last|this)?\s*([a-z]+)$/.exec(v);
  if (wd) {
    const idx = weekdayIndex(wd[2]);
    if (idx !== void 0) {
      return weekdayFrom(now, idx, wd[1] ?? "");
    }
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? NaN : parsed;
}
function weekdayFrom(now, target, qualifier) {
  const base = midnight(now);
  const cur = new Date(base).getDay();
  let delta = (target - cur + 7) % 7;
  if (qualifier === "last") {
    delta = delta === 0 ? -7 : delta - 7;
  } else if (qualifier === "this") {
    delta = delta > 3 ? delta - 7 : delta;
  } else {
    if (delta === 0) {
      delta = 7;
    }
  }
  return base + delta * DAY;
}
function resolveDateExpression(expr, now = /* @__PURE__ */ new Date()) {
  const ts = parseDate(expr, now);
  if (Number.isNaN(ts)) {
    return null;
  }
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function isPastDate(value, now = /* @__PURE__ */ new Date()) {
  const ts = parseDate(value, now);
  if (Number.isNaN(ts)) {
    return false;
  }
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return ts < todayMidnight;
}

// src/query/lexer.ts
var OP_CHARS = /* @__PURE__ */ new Set(["=", "!", "<", ">"]);
function lex(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;
  const push = (type, value, pos) => tokens.push({ type, value, pos });
  while (i < n) {
    const c = input[i];
    if (c === " " || c === "	" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/") {
      if (input[i + 1] === "/") {
        push("dslash", "//", i);
        i += 2;
      } else {
        push("slash", "/", i);
        i++;
      }
      continue;
    }
    if (c === "(") {
      push("lparen", "(", i);
      i++;
      continue;
    }
    if (c === ")") {
      push("rparen", ")", i);
      i++;
      continue;
    }
    if (c === ":" && input[i + 1] === ":") {
      push("coloncolon", "::", i);
      i += 2;
      continue;
    }
    if (c === "[") {
      const close = input.indexOf("]", i + 1);
      if (close === -1) {
        push("word", input.slice(i + 1), i);
        i = n;
      } else {
        push("mod", input.slice(i + 1, close), i);
        i = close + 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const start2 = i;
      const quote = c;
      i++;
      let value = "";
      while (i < n && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < n) {
          value += input[i + 1];
          i += 2;
        } else {
          value += input[i];
          i++;
        }
      }
      if (i >= n) {
        throw new Error(`Unterminated string starting at position ${start2}`);
      }
      i++;
      push("string", value, start2);
      continue;
    }
    if (OP_CHARS.has(c)) {
      const start2 = i;
      let op = c;
      i++;
      if (input[i] === "=") {
        op += "=";
        i++;
      }
      push("op", op, start2);
      continue;
    }
    if (c === "@") {
      const start2 = i;
      i++;
      let name = "";
      while (i < n && /[A-Za-z0-9._-]/.test(input[i])) {
        name += input[i];
        i++;
      }
      push("tag", name, start2);
      continue;
    }
    if (c === "&") {
      push("word", "and", i);
      i++;
      continue;
    }
    if (c === "|") {
      push("word", "or", i);
      i++;
      continue;
    }
    if (c === "!") {
      push("word", "not", i);
      i++;
      continue;
    }
    const start = i;
    let word = "";
    while (i < n && !isBreak(input[i])) {
      word += input[i];
      i++;
    }
    if (word.length === 0) {
      i++;
      continue;
    }
    push("word", word, start);
  }
  return tokens;
}
function isBreak(c) {
  return c === " " || c === "	" || c === "\n" || c === "\r" || c === "(" || c === ")" || c === "/" || c === "[" || c === "]" || c === '"' || c === "'" || c === "=" || c === "<" || c === ">" || c === "!" || c === "&" || c === "|";
}

// src/query/parser.ts
var RELATION_WORDS = /* @__PURE__ */ new Set(["contains", "beginswith", "endswith", "matches"]);
var TYPE_WORDS = /* @__PURE__ */ new Set(["project", "task", "note", "item"]);
var SET_OP_WORDS = /* @__PURE__ */ new Set(["union", "intersect", "except"]);
var SLICE_RE = /^(-?\d+|(-?\d+)?:(-?\d+)?)$/;
var AXIS_WORDS = /* @__PURE__ */ new Set([
  "child",
  "descendant",
  "descendant-or-self",
  "parent",
  "ancestor",
  "ancestor-or-self",
  "self",
  "following-sibling",
  "preceding-sibling"
]);
function parseQuery(input) {
  const tokens = lex(input);
  return new Parser(tokens).parseQuery();
}
var Parser = class {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }
  peek() {
    return this.tokens[this.i];
  }
  next() {
    return this.tokens[this.i++];
  }
  isWord(value) {
    const t = this.peek();
    return !!t && t.type === "word" && t.value.toLowerCase() === value;
  }
  parseQuery() {
    const query = this.parsePathExpr();
    if (this.peek()) {
      throw new Error(`Unexpected token "${this.peek().value}" in query`);
    }
    return query;
  }
  // Set operations have the lowest precedence and associate left.
  parsePathExpr() {
    let left = this.parsePathTerm();
    while (this.peekSetOp()) {
      const op = this.next().value.toLowerCase();
      const right = this.parsePathTerm();
      left = { t: op, a: left, b: right };
    }
    return left;
  }
  // A parenthesis may wrap a whole path expression (`(a//b union //c)`) or
  // merely group a predicate (`(a or b) and c`). Try the path-expression
  // reading first and backtrack when the paren turns out to be grouping.
  parsePathTerm() {
    if (this.peek()?.type === "lparen") {
      const save = this.i;
      this.next();
      try {
        const inner = this.parsePathExpr();
        const close = this.next();
        if (close?.type === "rparen" && this.atPathTermEnd()) {
          return inner;
        }
      } catch {
      }
      this.i = save;
    }
    return this.parsePath();
  }
  atPathTermEnd() {
    const t = this.peek();
    return !t || t.type === "rparen" || this.peekSetOp();
  }
  peekSetOp() {
    const t = this.peek();
    return !!t && t.type === "word" && SET_OP_WORDS.has(t.value.toLowerCase());
  }
  parsePath() {
    const steps = [];
    let firstSep = "descendant";
    if (this.peek()?.type === "dslash") {
      this.next();
      firstSep = "descendant";
    } else if (this.peek()?.type === "slash") {
      this.next();
      firstSep = "child";
    }
    steps.push(this.parseStep(firstSep));
    while (this.peek() && (this.peek().type === "slash" || this.peek().type === "dslash")) {
      const sepTok = this.next();
      const sep = sepTok.type === "dslash" ? "descendant" : "child";
      steps.push(this.parseStep(sep));
    }
    return { t: "path", steps };
  }
  parseStep(sep) {
    let axis;
    const t = this.peek();
    if (t && t.type === "word" && AXIS_WORDS.has(t.value.toLowerCase()) && this.tokens[this.i + 1]?.type === "coloncolon") {
      this.next();
      this.next();
      axis = t.value.toLowerCase();
    }
    const pred = this.parseOr();
    const slice = this.readSlice();
    return { sep, axis, pred, slice };
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.isWord("or")) {
      this.next();
      const right = this.parseAnd();
      left = { t: "or", a: left, b: right };
    }
    return left;
  }
  parseAnd() {
    let left = this.parseNot();
    while (true) {
      if (this.isWord("and")) {
        this.next();
        left = { t: "and", a: left, b: this.parseNot() };
        continue;
      }
      if (this.startsPrimary()) {
        left = { t: "and", a: left, b: this.parseNot() };
        continue;
      }
      break;
    }
    return left;
  }
  parseNot() {
    if (this.isWord("not")) {
      this.next();
      return { t: "not", a: this.parseNot() };
    }
    return this.parsePrimary();
  }
  startsPrimary() {
    const t = this.peek();
    if (!t) {
      return false;
    }
    if (t.type === "lparen" || t.type === "tag" || t.type === "string") {
      return true;
    }
    if (t.type === "word") {
      const w = t.value.toLowerCase();
      if (w === "and" || w === "or") {
        return false;
      }
      if (RELATION_WORDS.has(w) || SET_OP_WORDS.has(w)) {
        return false;
      }
      if (AXIS_WORDS.has(w) && this.tokens[this.i + 1]?.type === "coloncolon") {
        return false;
      }
      return true;
    }
    return false;
  }
  parsePrimary() {
    const t = this.next();
    if (!t) {
      throw new Error("Unexpected end of query");
    }
    if (t.type === "lparen") {
      const inner = this.parseOr();
      const close = this.next();
      if (!close || close.type !== "rparen") {
        throw new Error('Expected closing ")"');
      }
      return inner;
    }
    if (t.type === "tag") {
      const rel = this.tryReadRelation();
      if (rel) {
        return this.finishComparison(t.value, rel);
      }
      return { t: "has", attr: t.value };
    }
    if (t.type === "string") {
      return { t: "text", value: t.value };
    }
    if (t.type === "word") {
      const w = t.value.toLowerCase();
      if (w === "*") {
        return { t: "type", kind: "item" };
      }
      if (TYPE_WORDS.has(w)) {
        return { t: "type", kind: w };
      }
      const rel = this.tryReadRelation();
      if (rel) {
        return this.finishComparison(t.value, rel);
      }
      return { t: "text", value: t.value };
    }
    throw new Error(`Unexpected token "${t.value}" in query`);
  }
  // Modifiers may follow the relation (`<[d] tomorrow`, TaskPaper-style) or
  // trail the value (`<= today [d]`); accept both.
  finishComparison(attr, rel) {
    const before = this.readMods();
    const value = this.readValue();
    const after = this.readMods();
    return { t: "cmp", attr, rel, value, mods: before + after };
  }
  tryReadRelation() {
    const t = this.peek();
    if (!t) {
      return void 0;
    }
    if (t.type === "op") {
      this.next();
      return t.value;
    }
    if (t.type === "word" && RELATION_WORDS.has(t.value.toLowerCase())) {
      this.next();
      return t.value.toLowerCase();
    }
    return void 0;
  }
  readValue() {
    const t = this.next();
    if (!t) {
      throw new Error("Expected a value after relation");
    }
    if (t.type === "string" || t.type === "word") {
      return t.value;
    }
    if (t.type === "tag") {
      return t.value;
    }
    throw new Error(`Expected a value but found "${t.value}"`);
  }
  readMods() {
    const t = this.peek();
    if (t && t.type === "mod" && /^[A-Za-z]+$/.test(t.value)) {
      this.next();
      return t.value.toLowerCase();
    }
    return "";
  }
  readSlice() {
    const t = this.peek();
    if (!t || t.type !== "mod" || !SLICE_RE.test(t.value)) {
      return void 0;
    }
    this.next();
    if (!t.value.includes(":")) {
      return { index: parseInt(t.value, 10) };
    }
    const [startText, endText] = t.value.split(":");
    return {
      start: startText === "" ? void 0 : parseInt(startText, 10),
      end: endText === "" ? void 0 : parseInt(endText, 10)
    };
  }
};

// src/query/evaluator.ts
function runQuery(input, outline2) {
  const query = parseQuery(input);
  return evaluate(query, outline2);
}
function evaluate(query, outline2) {
  switch (query.t) {
    case "path":
      return evaluatePath(query.steps, outline2);
    case "union": {
      const out2 = evaluate(query.a, outline2);
      for (const it of evaluate(query.b, outline2)) {
        out2.add(it);
      }
      return out2;
    }
    case "intersect": {
      const b = evaluate(query.b, outline2);
      return new Set([...evaluate(query.a, outline2)].filter((it) => b.has(it)));
    }
    case "except": {
      const b = evaluate(query.b, outline2);
      return new Set([...evaluate(query.a, outline2)].filter((it) => !b.has(it)));
    }
  }
}
function evaluatePath(steps, outline2) {
  if (steps.length === 0) {
    return /* @__PURE__ */ new Set();
  }
  const first = steps[0];
  let context = applySlice(
    firstCandidates(first, outline2).filter((it) => matchPred(first.pred, it)),
    first.slice
  );
  for (let s = 1; s < steps.length; s++) {
    const step = steps[s];
    const next = /* @__PURE__ */ new Set();
    for (const ctx of context) {
      const matched = [];
      for (const cand of axisNodes(effectiveAxis(step), ctx)) {
        if (matchPred(step.pred, cand)) {
          matched.push(cand);
        }
      }
      for (const it of applySlice(matched, step.slice)) {
        next.add(it);
      }
    }
    context = [...next];
  }
  return new Set(context);
}
function applySlice(items, slice) {
  if (!slice) {
    return items;
  }
  if (slice.index !== void 0) {
    const idx = slice.index < 0 ? items.length + slice.index : slice.index;
    return idx >= 0 && idx < items.length ? [items[idx]] : [];
  }
  return items.slice(slice.start ?? 0, slice.end);
}
function effectiveAxis(step) {
  if (step.axis) {
    return step.axis;
  }
  return step.sep === "child" ? "child" : "descendant-or-self";
}
function firstCandidates(step, outline2) {
  const axis = step.axis;
  if (axis === "child") {
    return outline2.roots;
  }
  if (axis && axis !== "descendant" && axis !== "descendant-or-self") {
    return outline2.items;
  }
  return step.sep === "child" ? outline2.roots : outline2.items;
}
function axisNodes(axis, item) {
  switch (axis) {
    case "self":
      return [item];
    case "child":
      return item.children;
    case "descendant":
      return descendants(item, false);
    case "descendant-or-self":
      return descendants(item, true);
    case "parent":
      return item.parent ? [item.parent] : [];
    case "ancestor":
      return ancestors(item, false);
    case "ancestor-or-self":
      return ancestors(item, true);
    case "following-sibling":
      return siblings(item, "after");
    case "preceding-sibling":
      return siblings(item, "before");
    default:
      return [];
  }
}
function descendants(item, includeSelf) {
  const out2 = [];
  if (includeSelf) {
    out2.push(item);
  }
  const walk = (node) => {
    for (const child of node.children) {
      out2.push(child);
      walk(child);
    }
  };
  walk(item);
  return out2;
}
function ancestors(item, includeSelf) {
  const out2 = [];
  if (includeSelf) {
    out2.push(item);
  }
  let cur = item.parent;
  while (cur) {
    out2.push(cur);
    cur = cur.parent;
  }
  return out2;
}
function siblings(item, which) {
  const list = item.parent ? item.parent.children : [];
  const idx = list.indexOf(item);
  if (idx < 0) {
    return [];
  }
  return which === "before" ? list.slice(0, idx) : list.slice(idx + 1);
}
function matchPred(pred, item) {
  switch (pred.t) {
    case "or":
      return matchPred(pred.a, item) || matchPred(pred.b, item);
    case "and":
      return matchPred(pred.a, item) && matchPred(pred.b, item);
    case "not":
      return !matchPred(pred.a, item);
    case "has":
      return hasAttr(item, pred.attr);
    case "type":
      return pred.kind === "item" || item.kind === pred.kind;
    case "text":
      return item.displayText.toLowerCase().includes(pred.value.toLowerCase());
    case "cmp":
      return compare(getAttr(item, pred.attr), pred.rel, pred.value, pred.mods);
  }
}
function hasAttr(item, attr) {
  const lower = attr.toLowerCase();
  if (lower === "text" || lower === "type" || lower === "line" || lower === "level" || lower === "id") {
    return true;
  }
  return item.tags.has(attr);
}
function getAttr(item, attr) {
  const lower = attr.toLowerCase();
  switch (lower) {
    case "text":
      return item.displayText;
    case "type":
      return item.kind;
    case "line":
      return String(item.line + 1);
    case "level":
      return String(item.level);
    case "id":
      return String(item.line);
    default:
      return item.tags.has(attr) ? item.tags.get(attr) : void 0;
  }
}
function compare(raw, rel, value, mods) {
  if (raw === void 0) {
    return false;
  }
  if (mods.includes("l")) {
    const rest = mods.replace(/l/g, "");
    return raw.split(",").some((part) => compare(part.trim(), rel, value, rest));
  }
  if (mods.includes("n")) {
    return compareNumeric(parseFloat(raw), rel, parseFloat(value));
  }
  if (mods.includes("d")) {
    return compareNumeric(parseDate(raw), rel, parseDate(value));
  }
  const caseSensitive = mods.includes("s");
  let a = raw;
  let b = value;
  if (!caseSensitive) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  switch (rel) {
    case "=":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case ">=":
      return a >= b;
    case "contains":
      return a.includes(b);
    case "beginswith":
      return a.startsWith(b);
    case "endswith":
      return a.endsWith(b);
    case "matches":
      try {
        return new RegExp(value, caseSensitive ? "" : "i").test(raw);
      } catch {
        return false;
      }
    default:
      return false;
  }
}
function compareNumeric(a, rel, b) {
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return false;
  }
  switch (rel) {
    case "=":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case ">=":
      return a >= b;
    case "contains":
    case "beginswith":
    case "endswith":
    case "matches":
      return a === b;
    default:
      return false;
  }
}

// src/outlineOps.ts
function itemAt(lines2, line, tabSize) {
  const outline2 = buildOutline(lines2, tabSize);
  return { item: outline2.items.find((i) => i.line === line), roots: outline2.roots };
}
function siblingsOf(item, roots) {
  return item.parent ? item.parent.children : roots;
}
function moveItemUp(lines2, line, tabSize) {
  const { item, roots } = itemAt(lines2, line, tabSize);
  if (!item) {
    return null;
  }
  const siblings2 = siblingsOf(item, roots);
  const idx = siblings2.indexOf(item);
  if (idx <= 0) {
    return null;
  }
  const prev = siblings2[idx - 1];
  const block = lines2.slice(item.line, item.subtreeEnd + 1);
  const next = lines2.slice();
  next.splice(item.line, block.length);
  next.splice(prev.line, 0, ...block);
  return { lines: next, cursorLine: prev.line + (line - item.line) };
}
function moveItemDown(lines2, line, tabSize) {
  const { item, roots } = itemAt(lines2, line, tabSize);
  if (!item) {
    return null;
  }
  const siblings2 = siblingsOf(item, roots);
  const idx = siblings2.indexOf(item);
  if (idx < 0 || idx >= siblings2.length - 1) {
    return null;
  }
  const nextSib = siblings2[idx + 1];
  const block = lines2.slice(item.line, item.subtreeEnd + 1);
  const out2 = lines2.slice();
  out2.splice(item.line, block.length);
  const nextEndAfter = nextSib.subtreeEnd - block.length;
  out2.splice(nextEndAfter + 1, 0, ...block);
  return { lines: out2, cursorLine: nextEndAfter + 1 + (line - item.line) };
}
function indentItem(lines2, line, tabSize) {
  const { item } = itemAt(lines2, line, tabSize);
  if (!item) {
    return null;
  }
  const out2 = lines2.slice();
  for (let i = item.line; i <= item.subtreeEnd; i++) {
    if (out2[i].trim().length > 0) {
      out2[i] = "	" + out2[i];
    }
  }
  return { lines: out2, cursorLine: line };
}
var TRAILING_TAGS_RE = /((?:\s+@[A-Za-z0-9._-]+(?:\([^)]*\))?)*)\s*$/;
function setLineKind(lineText, kind) {
  const cur = lineKind(lineText);
  if (cur === "blank" || cur === kind) {
    return lineText;
  }
  const indent = /^[\t ]*/.exec(lineText)?.[0] ?? "";
  let body = lineText.slice(indent.length);
  if (cur === "task") {
    body = body.replace(/^-\s+/, "").replace(/^-$/, "");
  } else if (cur === "project") {
    body = body.replace(/:(\s*(@[A-Za-z0-9._-]+(\([^)]*\))?\s*)*)$/, "$1").trimEnd();
  }
  if (kind === "task") {
    return `${indent}- ${body}`;
  }
  if (kind === "project") {
    const m = TRAILING_TAGS_RE.exec(body);
    const cut = m ? m.index : body.length;
    if (body.slice(0, cut).endsWith(":")) {
      return indent + body;
    }
    return `${indent}${body.slice(0, cut)}:${body.slice(cut)}`;
  }
  return indent + body;
}
function groupItems(lines2, startLine, endLine, name, tabSize) {
  const outline2 = buildOutline(lines2, tabSize);
  const selected = outline2.items.filter((i) => i.line >= startLine && i.line <= endLine);
  if (selected.length === 0) {
    return null;
  }
  const start = selected[0].line;
  let end = endLine;
  let minIndent = Infinity;
  let lead = "";
  for (const it of selected) {
    end = Math.max(end, it.subtreeEnd);
    if (it.indent < minIndent) {
      minIndent = it.indent;
      lead = /^[\t ]*/.exec(it.raw)?.[0] ?? "";
    }
  }
  const out2 = lines2.slice();
  for (let i = start; i <= end; i++) {
    if (out2[i].trim().length > 0) {
      out2[i] = "	" + out2[i];
    }
  }
  out2.splice(start, 0, `${lead}${name}:`);
  return { lines: out2, cursorLine: start, cursorCol: lead.length + name.length };
}
function duplicateBranch(lines2, line, tabSize) {
  const { item } = itemAt(lines2, line, tabSize);
  if (!item) {
    return null;
  }
  const block = lines2.slice(item.line, item.subtreeEnd + 1);
  const out2 = lines2.slice();
  out2.splice(item.subtreeEnd + 1, 0, ...block);
  return { lines: out2, cursorLine: item.subtreeEnd + 1 + (line - item.line) };
}
function deleteBranch(lines2, startLine, endLine, tabSize) {
  const outline2 = buildOutline(lines2, tabSize);
  const selected = outline2.items.filter((i) => i.line >= startLine && i.line <= endLine);
  if (selected.length === 0) {
    return null;
  }
  const start = selected[0].line;
  let end = endLine;
  for (const it of selected) {
    end = Math.max(end, it.subtreeEnd);
  }
  const out2 = lines2.slice();
  out2.splice(start, end - start + 1);
  return { lines: out2, cursorLine: Math.max(0, Math.min(start, out2.length - 1)), cursorCol: 0 };
}
function moveBranchToProject(lines2, line, projectLine, tabSize) {
  const outline2 = buildOutline(lines2, tabSize);
  const item = outline2.items.find((i) => i.line === line) ?? itemAtLine(outline2, line);
  const project = outline2.items.find((i) => i.line === projectLine);
  if (!item || !project || project.kind !== "project") {
    return null;
  }
  if (project.line >= item.line && project.line <= item.subtreeEnd) {
    return null;
  }
  const byLine = new Map(
    outline2.items.filter((i) => i.line >= item.line && i.line <= item.subtreeEnd).map((i) => [i.line, i])
  );
  const block = [];
  for (let ln = item.line; ln <= item.subtreeEnd; ln++) {
    const it = byLine.get(ln);
    block.push(it ? "	".repeat(project.level + 1 + (it.level - item.level)) + it.text : lines2[ln]);
  }
  const out2 = lines2.slice();
  out2.splice(item.line, block.length);
  const insertAt = item.line <= project.subtreeEnd ? project.subtreeEnd + 1 - block.length : project.subtreeEnd + 1;
  out2.splice(insertAt, 0, ...block);
  return { lines: out2, cursorLine: insertAt };
}
function outdentItem(lines2, line, tabSize) {
  const { item } = itemAt(lines2, line, tabSize);
  if (!item) {
    return null;
  }
  const first = lines2[item.line];
  if (!first.startsWith("	") && !first.startsWith(" ")) {
    return null;
  }
  const out2 = lines2.slice();
  for (let i = item.line; i <= item.subtreeEnd; i++) {
    const l = out2[i];
    if (l.trim().length === 0) {
      continue;
    }
    if (l.startsWith("	")) {
      out2[i] = l.slice(1);
    } else {
      const spaces = /^ */.exec(l)?.[0].length ?? 0;
      out2[i] = l.slice(Math.min(spaces, tabSize));
    }
  }
  return { lines: out2, cursorLine: line };
}

// src/analysis.ts
function projectStats(outline2) {
  const map = /* @__PURE__ */ new Map();
  for (const project of outline2.items) {
    if (project.kind !== "project") {
      continue;
    }
    let total = 0;
    let done = 0;
    const stack = [...project.children];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.kind === "task") {
        total++;
        if (node.tags.has("done")) {
          done++;
        }
      }
      stack.push(...node.children);
    }
    map.set(project, { remaining: total - done, total });
  }
  return map;
}
function documentCounts(outline2, now = /* @__PURE__ */ new Date()) {
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const counts = { remaining: 0, done: 0, today: 0, overdue: 0, dueToday: 0 };
  for (const item of outline2.items) {
    if (item.kind !== "task") {
      continue;
    }
    if (item.tags.has("done")) {
      counts.done++;
      continue;
    }
    counts.remaining++;
    if (item.tags.has("today")) {
      counts.today++;
    }
    const due = item.tags.get("due");
    if (due) {
      if (isPastDate(due, now)) {
        counts.overdue++;
      } else if (parseDate(due, now) === todayMidnight) {
        counts.dueToday++;
      }
    }
  }
  return counts;
}
function savedSearches(outline2) {
  const out2 = [];
  for (const item of outline2.items) {
    const query = item.tags.get("search");
    if (query === void 0 || query === "") {
      continue;
    }
    const name = item.displayText.replace(/\s*@[A-Za-z0-9._-]+(\([^)]*\))?/g, "").trim() || query;
    out2.push({ name, query, line: item.line });
  }
  return out2;
}

// src/focus.ts
function targetAt(outline2, line) {
  return outline2.items.find((i) => i.line === line && i.kind === "project") ?? itemAtLine(outline2, line);
}
function focusVisibleLines(outline2, line) {
  const set = /* @__PURE__ */ new Set();
  const target = targetAt(outline2, line);
  if (!target) {
    return set;
  }
  for (let ln = target.line; ln <= target.subtreeEnd; ln++) {
    set.add(ln);
  }
  return set;
}
function projectsToFold(outline2, line) {
  const target = targetAt(outline2, line);
  if (!target) {
    return [];
  }
  const ancestors2 = /* @__PURE__ */ new Set();
  for (let a = target.parent; a; a = a.parent) {
    ancestors2.add(a);
  }
  const isDescendant = (it) => {
    for (let a = it.parent; a; a = a.parent) {
      if (a === target) {
        return true;
      }
    }
    return false;
  };
  return outline2.items.filter(
    (it) => it.kind === "project" && it !== target && !ancestors2.has(it) && !isDescendant(it) && it.subtreeEnd > it.line
  ).map((it) => it.line);
}
function focusOutTarget(outline2, line) {
  const target = targetAt(outline2, line);
  if (!target) {
    return null;
  }
  for (let a = target.parent; a; a = a.parent) {
    if (a.kind === "project") {
      return a.line;
    }
  }
  return null;
}
function toggleFocusTarget(currentLine, clickedLine) {
  return currentLine === clickedLine ? null : clickedLine;
}

// test/model.test.ts
var pass = 0;
var fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL: ${name}${extra ? "  -> " + extra : ""}`);
  }
}
var doc = `Inbox:
	- Try the extension @today
	- Read docs
Work:
	- Ship release @due(2026-07-01) @flag
		- Write changelog @done(2026-07-06)
		- Tag the build
	- Review PRs @today
Home:
	Errands:
		- Buy groceries @today
		- Pick up package @done(2026-07-07)
	- Water plants @done(2026-07-08)
`;
var lines = doc.split("\n");
var outline = buildOutline(lines, 4);
check("roots count", outline.roots.length === 3, `got ${outline.roots.length}`);
check("Inbox is project", outline.roots[0].kind === "project" && outline.roots[0].displayText === "Inbox");
var work = outline.roots[1];
check("Work has 2 children", work.children.length === 2, `got ${work.children.length}`);
var ship = work.children[0];
check("Ship has 2 subtasks", ship.children.length === 2, `got ${ship.children.length}`);
check("changelog is done task", ship.children[0].tags.has("done"));
var errands = outline.roots[2].children[0];
check("Errands nested project", errands.kind === "project" && errands.displayText === "Errands");
check("subtreeEnd of Ship covers subtasks", ship.subtreeEnd >= ship.children[1].line);
function q(query) {
  return [...runQuery(query, outline)].map((i) => i.displayText).sort();
}
check("@today matches 3", q("@today").length === 3, q("@today").join(" | "));
check("@done matches 3", q("@done").length === 3, q("@done").join(" | "));
check("not @done and task", q("not @done and task").every((t) => !t.includes("@done")));
check("text search groceries", q("groceries").length === 1, q("groceries").join(" | "));
check("type project count", q("project").length === 4, q("project").join(" | "));
check("boolean or", q("@flag or @today").length === 4, q("@flag or @today").join(" | "));
check("numeric compare absent ok", q("@priority > 0 [n]").length === 0);
check("path descendant", q('project "Work" // @today').length === 1, q('project "Work" // @today').join(" | "));
check("path child of Home", q('/ project "Home" / @done').length === 1, q('/ project "Home" / @done').join(" | "));
check("parens and not", q("task and not (@done or @today)").length >= 1);
check("beginswith", q('@text beginswith "Buy"').length === 1, q('@text beginswith "Buy"').join(" | "));
check("date compare due before today", q("@due <= today [d]").length === 1, q("@due <= today [d]").join(" | "));
var ty = /* @__PURE__ */ new Date();
var todayStr = `${ty.getFullYear()}-${String(ty.getMonth() + 1).padStart(2, "0")}-${String(ty.getDate()).padStart(2, "0")}`;
var dueToday = buildOutline([`Work:`, `	- ship @due(${todayStr})`], 4);
var qd = (query) => [...runQuery(query, dueToday)].length;
check("due today matches = today [d]", qd("@due = today [d]") === 1, String(qd("@due = today [d]")));
check("due today matches <= today [d]", qd("@due <= today [d]") === 1, String(qd("@due <= today [d]")));
var advDoc = [
  "Inbox:",
  "	- a1 @today",
  "	- a2 @due(2020-01-01)",
  "	- a3",
  "Work:",
  "	- done parent @done",
  "		- child of done",
  "			- grandchild of done",
  "	- open @priority(1,2)",
  "	- open2 @priority(3)",
  "	- open3 @today @done"
];
var adv = buildOutline(advDoc, 4);
var qa = (query) => [...runQuery(query, adv)].map((i) => i.displayText.replace(/\s*@\S+/g, "")).sort();
check("union with mod after relation", qa("@today union @due <[d] tomorrow").join(",") === "a1,a2,open3", qa("@today union @due <[d] tomorrow").join(","));
check(
  "except drops done subtrees",
  qa("not @done except @done//*").join(",") === "Inbox,Work,a1,a2,a3,open,open2",
  qa("not @done except @done//*").join(",")
);
check(
  "parenthesized path union then except",
  qa("(project Inbox//* union //@today) except //@done").join(",") === "Inbox,a1,a2,a3",
  qa("(project Inbox//* union //@today) except //@done").join(",")
);
check("intersect", qa("@today intersect @done").join(",") === "open3", qa("@today intersect @done").join(","));
check("set ops associate left", qa("@today union @due except @done").join(",") === "a1,a2", qa("@today union @due except @done").join(","));
check("predicate parens still group", qa("task and not (@done or @today)").join(",") === "a2,a3,child of done,grandchild of done,open,open2", qa("task and not (@done or @today)").join(","));
check("leading predicate paren backtracks", qa("(@today or @done) and task").join(",") === "a1,done parent,open3", qa("(@today or @done) and task").join(","));
check("slice first task", qa("task[0]").join(",") === "a1", qa("task[0]").join(","));
check("slice negative index", qa("task[-1]").join(",") === "open3", qa("task[-1]").join(","));
check("slice range", qa("task[0:2]").join(",") === "a1,a2", qa("task[0:2]").join(","));
check("slice open start", qa("task[:2]").join(",") === "a1,a2", qa("task[:2]").join(","));
check("slice open end", qa("task[6:]").join(",") === "open,open2,open3", qa("task[6:]").join(","));
check("slice negative range", qa("task[-2:]").join(",") === "open2,open3", qa("task[-2:]").join(","));
check("slice out of range empty", qa("task[99]").length === 0, qa("task[99]").join(","));
check(
  "per-context slice keeps one per project",
  qa("project *//task and not @done[0]").join(",") === "a1,child of done",
  qa("project *//task and not @done[0]").join(",")
);
check("per-context slice example from guide", qa("project *//not @done[0]").join(",") === "Inbox,Work", qa("project *//not @done[0]").join(","));
check("[l] contains element", qa("@priority contains[l] 1").join(",") === "open", qa("@priority contains[l] 1").join(","));
check("[l] equals element", qa("@priority =[l] 2").join(",") === "open", qa("@priority =[l] 2").join(","));
check("[ln] numeric per element", qa("@priority <[ln] 2").join(",") === "open", qa("@priority <[ln] 2").join(","));
check("[ln] matches whole list too", qa("@priority =[ln] 3").join(",") === "open2", qa("@priority =[ln] 3").join(","));
check("[l] no match", qa("@priority =[l] 9").length === 0, qa("@priority =[l] 9").join(","));
check("@id equality", qa("@id = 1").join(",") === "a1", qa("@id = 1").join(","));
check("@id numeric compare", qa("@id <[n] 3").join(",") === "Inbox,a1,a2", qa("@id <[n] 3").join(","));
check("@id present on all items", qa("@id").length === adv.items.length, String(qa("@id").length));
check("addTag done", addTag("- foo", "done", "2026-07-08") === "- foo @done(2026-07-08)");
check("addTag idempotent value replace", addTag("- foo @done(2026-01-01)", "done", "2026-07-08") === "- foo @done(2026-07-08)");
check("removeTag", removeTag("- foo @today @flag", "today") === "- foo @flag");
check("removeTag with value", removeTag("- foo @done(2026-07-08)", "done") === "- foo");
check(
  "removeTag preserves nested indentation",
  removeTag("		- Write changelog @done(2026-07-06)", "done") === "		- Write changelog",
  removeTag("		- Write changelog @done(2026-07-06)", "done")
);
check(
  "removeTag preserves intentional internal spaces",
  removeTag("	- foo   bar @today", "today") === "	- foo   bar",
  removeTag("	- foo   bar @today", "today")
);
check("hasTag", hasTag("- foo @today", "today") && !hasTag("- foo @today", "done"));
check("todayStamp format", /^\d{4}-\d{2}-\d{2}$/.test(todayStamp(false)));
check("escaped parens in value", (() => {
  const l = buildOutline(["- x @note(a \\) b)"], 4);
  return l.items[0].tags.get("note") === "a ) b";
})());
var spaceDoc = buildOutline(["Proj:", "    - child", "        - grand"], 4);
check("space indent nests", spaceDoc.roots[0].children[0].children.length === 1, "depth");
var tricky = buildOutline(["- not a project:"], 4);
check("dash-colon is task", tricky.items[0].kind === "task");
var ref = new Date(2026, 6, 9);
var iso = (e) => resolveDateExpression(e, ref);
check("nl today", iso("today") === "2026-07-09", String(iso("today")));
check("nl tomorrow", iso("tomorrow") === "2026-07-10");
check("nl +1 week", iso("+1 week") === "2026-07-16", String(iso("+1 week")));
check("nl 3 days", iso("3 days") === "2026-07-12", String(iso("3 days")));
check("nl next friday", iso("next friday") === "2026-07-10", String(iso("next friday")));
check("nl friday (bare = coming)", iso("friday") === "2026-07-10");
check("nl next thursday skips today", iso("next thursday") === "2026-07-16", String(iso("next thursday")));
check("nl last monday", iso("last monday") === "2026-07-06", String(iso("last monday")));
check("nl garbage -> null", iso("blorp") === null);
check("parseDate query use", !Number.isNaN(parseDate("next week", ref)));
var ol = ["A:", "	- one", "	- two", "		- two-child", "	- three"];
var down = moveItemDown(ol, 1, 4);
check("moveDown swaps sibling block", down !== null && down.lines[1] === "	- two" && down.lines[3] === "	- one", JSON.stringify(down?.lines));
var up = moveItemUp(ol, 4, 4);
check("moveUp swaps sibling block", up !== null && up.lines[1] === "	- one" && up.lines[2] === "	- three", JSON.stringify(up?.lines));
var ind = indentItem(ol, 2, 4);
check("indent adds tab to subtree", ind !== null && ind.lines[2] === "		- two" && ind.lines[3] === "			- two-child", JSON.stringify(ind?.lines));
var out = outdentItem(ol, 3, 4);
check("outdent removes one tab", out !== null && out.lines[3] === "	- two-child", JSON.stringify(out?.lines));
check("moveUp first child returns null", moveItemUp(ol, 1, 4) === null);
check("outdent at margin returns null", outdentItem(ol, 0, 4) === null);
check("task -> project", setLineKind("	- buy milk", "project") === "	buy milk:");
check("project -> task", setLineKind("	Errands:", "task") === "	- Errands");
check("note -> task", setLineKind("		some note", "task") === "		- some note");
check("task -> note", setLineKind("- buy milk", "note") === "buy milk");
check("project -> note", setLineKind("Errands:", "note") === "Errands");
check(
  "task -> project keeps trailing tags after colon",
  setLineKind("	- Ship @due(2026-07-20) @flag", "project") === "	Ship: @due(2026-07-20) @flag",
  setLineKind("	- Ship @due(2026-07-20) @flag", "project")
);
check(
  "project -> task keeps trailing tags",
  setLineKind("Work: @flag", "task") === "- Work @flag",
  setLineKind("Work: @flag", "task")
);
check("format is idempotent (task)", setLineKind("- x", "task") === "- x");
check("format is idempotent (project)", setLineKind("X:", "project") === "X:");
check("format blank untouched", setLineKind("   ", "task") === "   ");
var grp = groupItems(["A:", "	- one", "	- two", "		- two-child", "	- three"], 1, 2, "Sub", 4);
check(
  "group inserts project at min indent and indents subtrees",
  grp !== null && grp.lines.join("|") === "A:|	Sub:|		- one|		- two|			- two-child|	- three",
  JSON.stringify(grp?.lines)
);
check("group cursor on new project line before colon", grp !== null && grp.cursorLine === 1 && grp.cursorCol === 4);
check("group with no items returns null", groupItems(["", ""], 0, 1, "X", 4) === null);
var dup = duplicateBranch(["A:", "	- one", "		- one-child", "	- two"], 1, 4);
check(
  "duplicate copies whole branch after itself",
  dup !== null && dup.lines.join("|") === "A:|	- one|		- one-child|	- one|		- one-child|	- two",
  JSON.stringify(dup?.lines)
);
check("duplicate cursor on the copy", dup !== null && dup.cursorLine === 3);
var dupChild = duplicateBranch(["A:", "	- one", "		- one-child", "	- two"], 2, 4);
check(
  "duplicate from a child line copies just that item",
  dupChild !== null && dupChild.lines[3] === "		- one-child" && dupChild.cursorLine === 3,
  JSON.stringify(dupChild?.lines)
);
var del = deleteBranch(["A:", "	- one", "		- one-child", "	- two"], 1, 1, 4);
check(
  "delete removes item and its subtree",
  del !== null && del.lines.join("|") === "A:|	- two",
  JSON.stringify(del?.lines)
);
var delMulti = deleteBranch(["A:", "	- one", "		- one-child", "	- two", "B:"], 1, 3, 4);
check(
  "delete spans multi-line selection with subtrees",
  delMulti !== null && delMulti.lines.join("|") === "A:|B:",
  JSON.stringify(delMulti?.lines)
);
check("delete on blank-only selection returns null", deleteBranch(["A:", ""], 1, 1, 4) === null);
var mvDoc = ["One:", "	- a", "		- a-child", "Two:", "	- b"];
var mvFwd = moveBranchToProject(mvDoc, 1, 3, 4);
check(
  "move branch to a later project (end, re-indented)",
  mvFwd !== null && mvFwd.lines.join("|") === "One:|Two:|	- b|	- a|		- a-child",
  JSON.stringify(mvFwd?.lines)
);
check("move forward cursor on moved line", mvFwd !== null && mvFwd.cursorLine === 3);
var mvBack = moveBranchToProject(mvDoc, 4, 0, 4);
check(
  "move branch to an earlier project",
  mvBack !== null && mvBack.lines.join("|") === "One:|	- a|		- a-child|	- b|Two:",
  JSON.stringify(mvBack?.lines)
);
var mvDeep = moveBranchToProject(["One:", "	- a", "		- a-child", "Two:", "	- b"], 2, 0, 4);
check(
  "move a nested item up to its ancestor project re-indents as direct child",
  mvDeep !== null && mvDeep.lines.join("|") === "One:|	- a|	- a-child|Two:|	- b",
  JSON.stringify(mvDeep?.lines)
);
check("move into own subtree returns null", moveBranchToProject(["One:", "	Two:", "		- x"], 0, 1, 4) === null);
check("move to non-project returns null", moveBranchToProject(mvDoc, 4, 1, 4) === null);
check("removeAllTags strips every tag", removeAllTags("- foo @today @flag") === "- foo");
check(
  "removeAllTags handles values and keeps indent",
  removeAllTags("		- Ship @due(2026-07-20) @done(2026-07-06 10:00)") === "		- Ship",
  removeAllTags("		- Ship @due(2026-07-20) @done(2026-07-06 10:00)")
);
check("removeAllTags keeps project colon", removeAllTags("Work: @flag") === "Work:");
check("removeAllTags no-op without tags", removeAllTags("	- plain") === "	- plain");
var stats = projectStats(outline);
var workStat = [...stats.entries()].find(([p]) => p.displayText === "Work")?.[1];
check("projectStats Work remaining", !!workStat && workStat.total === 4 && workStat.remaining === 3, JSON.stringify(workStat));
var dc = documentCounts(outline);
check("documentCounts today=3", dc.today === 3, JSON.stringify(dc));
check("documentCounts done=3", dc.done === 3, JSON.stringify(dc));
var searchDoc = buildOutline(["Searches:", "	- Hot @search(@today and not @done)"], 4);
var ss = savedSearches(searchDoc);
check("savedSearches parses", ss.length === 1 && ss[0].name === "Hot" && ss[0].query === "@today and not @done", JSON.stringify(ss));
var focusDoc = buildOutline(["Inbox:", "	- a @today", "	- b", "Work:", "	- c", "		- c2"], 4);
var inboxLine = 0;
var workLine = 3;
check(
  "focusVisibleLines = subtree of Inbox",
  setEq(focusVisibleLines(focusDoc, inboxLine), /* @__PURE__ */ new Set([0, 1, 2])),
  [...focusVisibleLines(focusDoc, inboxLine)].join(",")
);
check(
  "focusVisibleLines = subtree of Work (incl nested)",
  setEq(focusVisibleLines(focusDoc, workLine), /* @__PURE__ */ new Set([3, 4, 5])),
  [...focusVisibleLines(focusDoc, workLine)].join(",")
);
check(
  "projectsToFold(Inbox) folds Work only",
  JSON.stringify(projectsToFold(focusDoc, inboxLine)) === JSON.stringify([workLine]),
  JSON.stringify(projectsToFold(focusDoc, inboxLine))
);
var errandsLine = errands.line;
check("focusOutTarget nested -> ancestor project", focusOutTarget(outline, errandsLine) === outline.roots[2].line, String(focusOutTarget(outline, errandsLine)));
check("focusOutTarget top-level -> null (clear focus)", focusOutTarget(outline, outline.roots[2].line) === null);
check("toggle same clears", toggleFocusTarget(3, 3) === null);
check("toggle different focuses", toggleFocusTarget(3, 0) === 0);
check("toggle from none focuses", toggleFocusTarget(null, 3) === 3);
function setEq(a, b) {
  if (a.size !== b.size) {
    return false;
  }
  for (const v of a) {
    if (!b.has(v)) {
      return false;
    }
  }
  return true;
}
console.log(`
${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
