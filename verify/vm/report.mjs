// verify/vm/report.mjs -- write one scenario's verdict into docs/시험행렬.md.
//
// The release gate (`iris-release installer`) reads that table with the regex
// pinned in the file's own header comment, so this writer must produce rows
// the *same* regex accepts. That is why the row is rebuilt from parsed cells
// rather than patched in place with a loose replace: a stray `|` or a lost
// column would make the gate say "낡음" forever and nobody would know why.
//
//   node verify/vm/report.mjs --scenario S08 --result 통과 \
//       --zip _build/out/IRIS-Setup_v2.0.0_2026-09-15.zip \
//       --evidence "_agent\setup\diagnostics.json"
//
// `--zip` is turned into the 12-hex fingerprint the gate compares; `--print`
// shows the table's current state without writing.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const HEADER = '| # | 환경 | 잡는 것 | 어디서 | 결과 | zip 지문 | 날짜 | 근거(로그 경로) |';
export const ROW_RE = /^\|\s*(S\d{2})\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/;
export const RESULTS = Object.freeze(['미착수', '통과', '실패']);

export function matrixPath(repo = path.resolve(HERE, '..', '..')) {
  return path.join(repo, 'docs', '시험행렬.md');
}

function splitLines(text) {
  // Keep the file's own line ending -- rewriting LF as CRLF would show up as a
  // whole-file diff and (per R-022) quietly pollute the repo.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(/\r?\n/), eol };
}

/** parseMatrix(text) -> [{id, env, catches, where, result, fingerprint, date, evidence, line}] */
export function parseMatrix(text) {
  const { lines } = splitLines(text);
  const rows = [];
  lines.forEach((line, i) => {
    const m = ROW_RE.exec(line);
    if (!m) return;
    rows.push({
      id: m[1],
      env: m[2].trim(),
      catches: m[3].trim(),
      where: m[4].trim(),
      result: m[5].trim(),
      fingerprint: m[6].trim(),
      date: m[7].trim(),
      evidence: m[8].trim(),
      line: i,
    });
  });
  return rows;
}

export function formatRow(r) {
  const cells = [r.id, r.env, r.catches, r.where, r.result, r.fingerprint, r.date, r.evidence]
    // A `|` inside a cell would split the row and break the gate's regex.
    .map((c) => String(c ?? '').replace(/\|/g, '/').trim());
  return `| ${cells.join(' | ')} |`;
}

/**
 * setRow(text, {id, result, fingerprint, date, evidence, note}) -> new text.
 * Only the four result columns move; 환경·잡는 것·어디서 stay as written.
 * Throws if the row is missing or the result word is not one of the three the
 * parser allows -- silently writing an unparseable table is the one failure
 * mode this file exists to prevent.
 */
export function setRow(text, { id, result, fingerprint = '', date = '', evidence = '', note = '' }) {
  if (!RESULTS.includes(result)) {
    throw new Error(`결과 열에는 ${RESULTS.join(' · ')} 만 쓸 수 있습니다(받은 값: ${result})`);
  }
  if (fingerprint && !/^[0-9a-f]{12}$/.test(fingerprint)) {
    throw new Error(`zip 지문은 소문자 hex 12자여야 합니다(받은 값: ${fingerprint})`);
  }
  const { lines, eol } = splitLines(text);
  const idx = lines.findIndex((l) => ROW_RE.exec(l)?.[1] === id);
  if (idx === -1) throw new Error(`시험 행렬에 ${id} 행이 없습니다`);
  const m = ROW_RE.exec(lines[idx]);
  lines[idx] = formatRow({
    id,
    env: m[2].trim(),
    catches: m[3].trim(),
    where: m[4].trim(),
    result,
    fingerprint,
    date,
    evidence: note ? `${evidence} (${note})` : evidence,
  });
  return lines.join(eol);
}

/** updateRow(file, row) -> true when the file changed. */
export function updateRow(file, row) {
  const before = fs.readFileSync(file, 'utf8');
  const after = setRow(before, row);
  if (after === before) return false;
  // Byte-level write with the original line ending preserved (R-022).
  fs.writeFileSync(file, Buffer.from(after, 'utf8'));
  return true;
}

export function fingerprintOfZip(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
}

export function parseArgs(argv) {
  const o = { scenario: null, result: null, zip: null, fingerprint: '', date: new Date().toISOString().slice(0, 10), evidence: '', note: '', print: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scenario') o.scenario = String(argv[++i]).toUpperCase();
    else if (a === '--result') o.result = argv[++i];
    else if (a === '--zip') o.zip = path.resolve(argv[++i]);
    else if (a === '--fingerprint') o.fingerprint = String(argv[++i]).toLowerCase();
    else if (a === '--date') o.date = argv[++i];
    else if (a === '--evidence') o.evidence = argv[++i];
    else if (a === '--note') o.note = argv[++i];
    else if (a === '--file') o.file = path.resolve(argv[++i]);
    else if (a === '--print') o.print = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return o;
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const file = o.file ?? matrixPath();

  if (o.print || !o.scenario) {
    const rows = parseMatrix(fs.readFileSync(file, 'utf8'));
    console.log('  #    결과      zip 지문      날짜        근거');
    for (const r of rows) {
      console.log(`  ${r.id}  ${r.result.padEnd(8)}  ${(r.fingerprint || '-').padEnd(12)}  ${(r.date || '-').padEnd(10)}  ${r.evidence || '-'}`);
    }
    const gate = rows.filter((r) => r.id !== 'S12');
    const blocking = gate.filter((r) => r.result !== '통과');
    console.log(`\n게이트 대상 S01~S11: 통과 ${gate.length - blocking.length}/${gate.length}`
      + (blocking.length ? ` — 막는 행: ${blocking.map((r) => `${r.id}(${r.result})`).join(', ')}` : ''));
    if (!o.scenario) return;
  }

  const fingerprint = o.fingerprint || (o.zip ? fingerprintOfZip(o.zip) : '');
  const changed = updateRow(file, {
    id: o.scenario, result: o.result, fingerprint, date: o.date, evidence: o.evidence, note: o.note,
  });
  console.log(`${o.scenario} 행 ${changed ? '갱신' : '변화 없음'} — 결과 ${o.result} · 지문 ${fingerprint || '(없음)'} · ${o.date}`);
}

const isMain = process.argv[1] && process.argv[1].endsWith('report.mjs') && process.argv[1].includes('vm');
if (isMain) {
  try { main(); } catch (e) { console.error(`report.mjs: ${e.message}`); process.exitCode = 1; }
}
