#!/usr/bin/env tsx
/**
 * The four-surface probe behind the coverage universe's TXT rows.
 *
 * For each pinned probe model, print what each of the four decision surfaces
 * says about every row it files:
 *
 *   check    `checkConstraints` (the `sysml-check` reading, `src/semantics/evaluate-model.ts`)
 *   literal  `verifyModel --engine literal` (the point evaluation)
 *   numeric  `checkConstraintsNumeric` (the Solve reading)
 *   SMT      `verifyModel --engine smt`
 *
 * This is the evidence `scripts/todo-dashboard/coverage.py` cites: a TXT row is
 * `read` only where one of these rows names a feature the construct carries,
 * and `partial` where some shapes reach a row and others do not. The script
 * decides nothing and changes no engine — it is a reporter over the exported
 * functions, the same ones the app and the CLI call.
 *
 * usage: npx tsx scripts/todo-dashboard/probes/run.ts [--json] <file.sysml>…
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadModelText } from '../../../src/text/load';
import { checkConstraints } from '../../../src/semantics/evaluate-model';
import { checkConstraintsNumeric } from '../../../src/semantics/solver';
import { verifyModel } from '../../../src/api/verification';

interface Row {
  surface: 'check' | 'literal' | 'numeric' | 'smt';
  row: string;
  expression: string;
  outcome: string;
  sentence: string;
}

async function probe(file: string): Promise<{ file: string; rows: Row[]; notes: string[] }> {
  const text = readFileSync(resolve(file), 'utf8');
  const { model, report } = await loadModelText(text, { fileName: file });
  if (!model) {
    return { file, rows: [], notes: [`no model: ${report.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')}`] };
  }
  const rows: Row[] = [];
  for (const c of checkConstraints(model)) {
    const name = model.qualifiedName(c.id) || c.id;
    rows.push({ surface: 'check', row: name, expression: c.expression, outcome: c.result, sentence: c.message });
  }
  for (const c of checkConstraintsNumeric(model)) {
    const name = model.qualifiedName(c.id) || c.id;
    rows.push({ surface: 'numeric', row: name, expression: c.raw, outcome: c.result, sentence: '' });
  }
  for (const engine of ['literal', 'smt'] as const) {
    const report2 = await verifyModel(model, { engine, sourceText: text });
    for (const r of report2.results) {
      rows.push({
        surface: engine,
        row: r.clause.qualifiedName,
        expression: r.expression,
        outcome: r.claim + (r.code ? ` [${r.code}]` : ''),
        sentence: r.detail,
      });
    }
  }
  const notes = report.diagnostics.map((d) => `${d.code}: ${d.message}`);
  return { file, rows, notes };
}

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const files = argv.filter((a) => a !== '--json');
const out = [];
for (const f of files) out.push(await probe(f));
if (json) {
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
} else {
  for (const p of out) {
    process.stdout.write(`\n== ${p.file}\n`);
    if (p.notes.length) process.stdout.write(`  diagnostics: ${p.notes.join(' | ')}\n`);
    if (!p.rows.length) process.stdout.write('  (no row on any surface)\n');
    for (const r of p.rows) process.stdout.write(`  ${r.surface.padEnd(7)} ${r.outcome.padEnd(28)} ${r.row} — ${r.expression}${r.expression ? ' :: ' : ''}${r.sentence}\n`);
  }
}
