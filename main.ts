// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A text file's lines, its line break, and whether it ends with one (SPEC section 3). */
interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitLines(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinLines(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tierOf(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions where O occurs in lines at the given tier, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!tierOf(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier at which O occurs at least once (at or after `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** A line of N: its text, and the O index it is a context of, or -1. */
interface NewLine {
  text: string;
  ctx: number;
}

/**
 * Build the replacement lines for a match at `at` (SPEC section 5): a context line is
 * written as the file's own matched line; at tier 2 every other line is re-indented.
 */
function buildReplacement(fileLines: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  const f = tier === 2 && o.length > 0 ? leadWs(fileLines[at]!) : '';
  const p = tier === 2 && o.length > 0 ? leadWs(o[0]!) : '';
  return n.map((nl) => {
    if (nl.ctx >= 0) return fileLines[at + nl.ctx]!;
    if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) return f + nl.text.slice(p.length);
    return nl.text;
  });
}

/** One body line of a unified hunk or a V4A chunk: context, old or new. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/** A unified hunk (SPEC section 6). */
interface Hunk {
  /** Old start line, 1-based, from the header. */
  a: number;
  lines: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinal: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noFinalNew: boolean;
}

/** One unified section: one edit (SPEC section 6). */
interface Section {
  /** Null means `/dev/null` (no file). */
  oldPath: string | null;
  newPath: string | null;
  pathsFromHeader: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string | null {
  let s = p.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  if (s === '/dev/null') return null;
  return s;
}

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab. */
function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return stripAB(tab < 0 ? rest : rest.slice(0, tab));
}

function parseDiffGit(line: string, num: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${num}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new Exit2(`error: parse ${num}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3).trim();
  if (x === '' || y === '') throw new Exit2(`error: parse ${num}`);
  return [x, y];
}

/** Apply a section's hunks in order to a file's lines; throws Fail on a hunk failure. */
function applyHunks(cur: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const nn: NewLine[] = [];
    for (const l of h.lines) {
      if (l.kind === 'ctx') { nn.push({ text: l.text, ctx: o.length }); o.push(l.text); }
      else if (l.kind === 'old') o.push(l.text);
      else nn.push({ text: l.text, ctx: -1 });
    }
    if (o.length === 0) {
      const pos = Math.min(h.a + d, cur.lines.length);
      const atEnd = pos === cur.lines.length;
      const ins = nn.map((x) => x.text);
      cur.lines.splice(pos, 0, ...ins);
      if (atEnd) cur.final = !h.noFinal;
      d += nn.length;
      continue;
    }
    const found = findTier(cur.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const atEnd = best + o.length === cur.lines.length;
    const rep = buildReplacement(cur.lines, best, o, nn, found.tier);
    cur.lines.splice(best, o.length, ...rep);
    if (atEnd) cur.final = !h.noFinal;
    d += nn.length - o.length;
  }
  return cur;
}

function sectionEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = s.isCreate || oldP === null;
    const isDelete = !isCreate && (s.isDelete || newP === null);
    if (isCreate) {
      const np = newP as string;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const contentLines: string[] = [];
      let noFinalNew = false;
      for (const h of s.hunks) {
        for (const l of h.lines) if (l.kind === 'new') contentLines.push(l.text);
        if (h.lines.some((l) => l.kind === 'new')) noFinalNew = h.noFinalNew;
      }
      const content = contentLines.length === 0 ? '' : contentLines.join('\n') + (noFinalNew ? '' : '\n');
      tree.now.set(np, content);
      return;
    }
    if (isDelete) {
      const op = oldP as string;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== newP) {
      const op = oldP as string;
      const np = newP as string;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(splitLines(tree.get(op)!), s.hunks, strict, op);
      tree.now.set(np, joinLines(out));
      tree.now.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    const p = oldP as string;
    if (tree.get(p) === null) throw new Fail('missing', p);
    const out = applyHunks(splitLines(tree.get(p)!), s.hunks, strict, p);
    tree.now.set(p, joinLines(out));
  };
}

/** Read a unified diff patch (SPEC section 6) into one edit per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(l, i + 1);
      cur = { oldPath: x, newPath: y, pathsFromHeader: false, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1]!);
      if (cur === null || cur.hunks.length > 0) {
        cur = { oldPath: oldP, newPath: newP, pathsFromHeader: true, isCreate: false, isDelete: false, hunks: [] };
        sections.push(cur);
      } else {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.pathsFromHeader = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') { body.push(b); j++; continue; }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const hunkLines: BodyLine[] = [];
      let lastCtxNew = -1;
      let lastNew = -1;
      for (let k = 0; k < body.length; k++) {
        const b = body[k]!;
        if (b.startsWith(' ')) { hunkLines.push({ kind: 'ctx', text: b.slice(1) }); lastCtxNew = k; }
        else if (b.startsWith('-')) hunkLines.push({ kind: 'old', text: b.slice(1) });
        else if (b.startsWith('+')) { hunkLines.push({ kind: 'new', text: b.slice(1) }); lastCtxNew = k; lastNew = k; }
        else if (b === '') { hunkLines.push({ kind: 'ctx', text: '' }); lastCtxNew = k; }
      }
      const noFinal = lastCtxNew >= 0 && body[lastCtxNew + 1] !== undefined && body[lastCtxNew + 1]!.startsWith('\\');
      const noFinalNew = lastNew >= 0 && body[lastNew + 1] !== undefined && body[lastNew + 1]!.startsWith('\\');
      cur.hunks.push({ a, lines: hunkLines, noFinal, noFinalNew });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l === 'new file mode' || l.startsWith('new file mode ')) cur.isCreate = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.isDelete = true;
      else if (l.startsWith('rename from ') && !cur.pathsFromHeader) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ') && !cur.pathsFromHeader) cur.newPath = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitLines(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const nn: NewLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const rep = buildReplacement(f.lines, at, oldLines, nn, found.tier);
    f.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinLines(f));
  };
}

/** Read SEARCH/REPLACE blocks (SPEC section 7) into one edit per block. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    let s = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') { s = k; break; }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk (SPEC section 8). */
interface VChunk {
  /** Null when the chunk has no `@@` line, or its text is empty. */
  anchor: string | null;
  lines: BodyLine[];
  eof: boolean;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitLines(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let found: number | null = null;
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max && found === null; t++) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (tierOf(f.lines[k]!, ch.anchor, t)) { found = k; break; }
          }
        }
        if (found === null) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const o: string[] = [];
      const nn: NewLine[] = [];
      for (const l of ch.lines) {
        if (l.kind === 'ctx') { nn.push({ text: l.text, ctx: o.length }); o.push(l.text); }
        else if (l.kind === 'old') o.push(l.text);
        else nn.push({ text: l.text, ctx: -1 });
      }
      if (o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...nn.map((x) => x.text));
        cursor = at + nn.length;
        continue;
      }
      if (ch.eof) {
        const at = f.lines.length - o.length;
        if (at < cursor) throw new Fail('no-match', path);
        let tier = -1;
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max; t++) {
          let ok = true;
          for (let j = 0; j < o.length; j++) {
            if (!tierOf(f.lines[at + j]!, o[j]!, t)) { ok = false; break; }
          }
          if (ok) { tier = t; break; }
        }
        if (tier < 0) throw new Fail('no-match', path);
        const rep = buildReplacement(f.lines, at, o, nn, tier);
        f.lines.splice(at, o.length, ...rep);
        cursor = at + rep.length;
        continue;
      }
      const found = findTier(f.lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      const at = found.pos[0]!;
      const rep = buildReplacement(f.lines, at, o, nn, found.tier);
      f.lines.splice(at, o.length, ...rep);
      cursor = at + rep.length;
    }
    const out = joinLines(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Read a V4A patch (SPEC section 8) into one edit per section. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const content: string[] = [];
      let j = i + 1;
      while (j < last) {
        const b = lines[j]!;
        if (isSectionStart(b)) break;
        if (b === '') { content.push(''); j++; continue; }
        if (b.startsWith('+')) { content.push(b.slice(1)); j++; continue; }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push(((p, c) => (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, c.length === 0 ? '' : c.join('\n') + '\n');
      })(path, content));
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last) {
        const b = lines[j]!;
        if (isSectionStart(b)) break;
        if (blank(b)) { j++; continue; }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(((p) => (tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      let j = i + 1;
      while (j < last && blank(lines[j]!)) j++;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let started = false;
      while (j < last) {
        const b = lines[j]!;
        if (isSectionStart(b)) break;
        if (b.startsWith('@@')) {
          curChunk = { anchor: b.slice(2).trim(), lines: [], eof: false };
          chunks.push(curChunk);
          started = true;
          j++;
          continue;
        }
        if (b.trim() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${j + 1}`);
          curChunk.eof = true;
          curChunk = null;
          j++;
          continue;
        }
        if (b === '') {
          if (curChunk !== null) curChunk.lines.push({ kind: 'ctx', text: '' });
          j++;
          continue;
        }
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (curChunk === null) {
            if (started) throw new Exit2(`error: parse ${j + 1}`);
            curChunk = { anchor: null, lines: [], eof: false };
            chunks.push(curChunk);
            started = true;
          }
          if (b.startsWith(' ')) curChunk.lines.push({ kind: 'ctx', text: b.slice(1) });
          else if (b.startsWith('-')) curChunk.lines.push({ kind: 'old', text: b.slice(1) });
          else curChunk.lines.push({ kind: 'new', text: b.slice(1) });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1]!;
        while (tail.lines.length > 0) {
          const t = tail.lines[tail.lines.length - 1]!;
          if (t.kind === 'ctx' && t.text === '') tail.lines.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [o, n] of tree.moves) {
    const newNow = tree.now.get(n);
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && typeof newNow === 'string') {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    changed.push(p);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...changed, ...consumed]) {
      const now = tree.now.get(p);
      if (now === undefined) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
