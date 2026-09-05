#!/usr/bin/env tsx
/**
 * `sysprose` — report on a model from the command line.
 *
 * WHY. Every reporting function in this repo — the size and shape of a model,
 * which requirements are covered, what traces to what, which ports are wired,
 * what a change reaches, what nothing uses — is a pure, tested, exported
 * function, and until now every one of them was reachable only from the browser
 * or from a JavaScript console. `npm run check` could tell you a file was
 * VALID; nothing could tell you what was IN it. This is that half of the tool,
 * as one command with subcommands, each a thin shell over the exported function
 * that computes the answer, so a figure read in a terminal and the same figure
 * computed from that import cannot differ. Several of the app's views answer the
 * same QUESTION by drawing their own projection instead of calling the reporting
 * function (Allocation, Interconnection, Properties -> Used by), so those figures
 * are not promised to match — see the capability table in `README.md`.
 *
 *   npm run sysprose -- stats examples/uav-isr.sysml
 *   npm run sysprose -- requirements examples/uav-isr.sysml --json
 *   npm run sysprose -- where-used examples/uav-isr.sysml --element AirVehicle --depth 2
 *   cat model.sysml | npm run sysprose -- orphans -
 *
 * Exit codes are the contract, and they are `sysml-check`'s:
 *   0  the model loaded cleanly and the report is of all of it
 *   1  the model did NOT load cleanly — the report is of what parsed, and a
 *      `degraded` banner on stderr says so
 *   2  usage or I/O problem — nothing was reported
 *
 * Note what 1 does NOT mean here. These subcommands report; they do not judge.
 * `orphans` finding four unused definitions is an answer, not a failure, so it
 * exits 0 — the exit code is about whether the model under the report is the
 * whole model, which is the only thing an automation can act on generically.
 *
 * The report goes to stdout and everything about the FILE goes to stderr, for
 * every exit code: a file that parsed with warnings still had something wrong
 * with it, and a reader who is never told is a reader confidently analysing a
 * file the tool did not recognise.
 *
 * FAIL DIRECTION. Three refusals, each replacing an answer that would read as
 * true: a model that PARSED and produced no elements exits 2 rather than
 * reporting an empty success (a typo'd path and an empty model must not look
 * alike — a file that did not parse is exit 1, because it is broken rather
 * than empty); an element reference that matches several elements exits 2 with
 * the candidates rather than reporting on the first one; and an unexpected
 * internal failure exits 2 from the `main()` wrapper rather than falling
 * through to 0. `--from` / `--to` are refused the same way when they name a
 * metaclass the model has none of, because the alternative is an empty matrix
 * and exit 0.
 *
 * TWO LIBRARY FLAGS, because they are two knobs. `--no-library` skips BINDING:
 * it changes the model — library types report as unresolved — and it is the
 * same flag, with the same meaning, as `npm run check`'s. `--include-library`
 * changes REPORTING: the bundled library is bound and then listed as well as
 * the reader's own model. Only `elements` can honour the second one; the
 * analysis reports exclude the library by construction and each states its own
 * `libraryExcluded` figure, so the flag is rejected there rather than accepted
 * and quietly ignored.
 *
 * See docs/DIAGNOSTIC-CODES.md for what a diagnostic `code` means.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ElementRecord, Model } from '../src/core/index';
import {
  connectivityReport,
  impactClosure,
  isUserElement,
  modelMetrics,
  orphanReport,
  requirementSatisfaction,
  traceabilityMatrix,
  type ElementRef,
} from '../src/api/index';
import { resolveFullName } from '../src/semantics/index';
// Deep imports rather than `../src/diagram/index`: the diagram barrel pulls the
// layout engine in with it, and neither of these two builders needs it.
import { buildGrid } from '../src/diagram/grid';
import { buildRequirementsTable } from '../src/diagram/requirements-table';
import { loadModelText, type CheckReport } from '../src/text/load';
import { flagGiven, flagValue, isArgError, parseArgs, type ParsedArgs } from './lib/args';
import { runMain } from './lib/exit';
import {
  COMMANDS,
  TRACE_PRESETS,
  findCommand,
  flagsFor,
  renderCommandUsage,
  renderTopUsage,
  type CommandSpec,
} from './lib/sysprose-spec';

/**
 * A problem with what was ASKED, not with the model: exit 2, nothing reported.
 *
 * `showUsage` separates the two kinds. A malformed command line is answered
 * with the subcommand's help, because the reader needs the grammar; a
 * reference that resolves to nothing (or to six things) is answered with the
 * candidates, because the reader needs the model.
 */
class UsageError extends Error {
  readonly showUsage: boolean;
  constructor(message: string, showUsage = false) {
    super(message);
    this.showUsage = showUsage;
  }
}

/** One subcommand's answer, in both renderings, from one computation. */
interface Report {
  /** The value published under the subcommand's payload key. */
  json: unknown;
  /** The human rendering, without a trailing newline. */
  text: string;
}

/* ────────────────────────────── small helpers ───────────────────────────── */

/** Best short label for an element reference. */
function label(ref: ElementRef): string {
  return ref.declaredName ?? (ref.qualifiedName || ref.id);
}

/** Qualified name, falling back to the id for an element that has none. */
function qname(model: Model, id: string): string {
  return model.qualifiedName(id) || id;
}

/** `  key   value` blocks, aligned on the longest key. */
function aligned(pairs: Array<[string, string | number]>, indent = '  '): string[] {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${indent}${k.padEnd(width)}   ${String(v)}`);
}

/** A bullet list, or a single line saying there is nothing in it. */
function listOrNone(heading: string, items: string[], none: string, indent = '  '): string[] {
  if (items.length === 0) return [`${indent}${none}`];
  return [`${indent}${heading}`, ...items.map((i) => `${indent}  ${i}`)];
}

/* ─────────────────────── element reference resolution ───────────────────── */

/**
 * Resolve what the reader typed after `--element` to one element.
 *
 * Three steps, narrowing: an exact id (what a previous `--json` run printed),
 * then the language's own name resolution (which is what makes a qualified name
 * work), then a unique suffix match on the qualified name (which is what makes
 * a bare `AirVehicle` work in a file that declares it inside a package).
 *
 * Only the last step needs filtering, and it needs it badly: `powerIn` matches
 * 10 elements in the shipped UAV example, 5 of which are the tool's own
 * usage-scoped copies. Offering all 10 asks the reader to choose between ids
 * that are not in their file. The first two steps are deliberately NOT
 * filtered — an exact id or a fully-resolved name is unambiguous, and asking
 * where a library type is used is a fair question.
 */
function resolveElementRef(model: Model, ref: string): ElementRecord {
  const byId = model.get(ref);
  if (byId) return byId;

  const byName = resolveFullName(model, ref, null);
  if (byName) return byName;

  const candidates = model.all().filter((el) => {
    if (!isUserElement(model, el)) return false;
    const qn = model.qualifiedName(el.id);
    return qn === ref || qn.endsWith(`::${ref}`) || el.declaredShortName === ref;
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new UsageError(
      `no element matches \`${ref}\` — pass an id or a qualified name, or run \`elements\` to see what is there`,
    );
  }
  throw new UsageError(
    [
      `\`${ref}\` is ambiguous — ${candidates.length} elements match:`,
      ...candidates.map((c) => `    ${qname(model, c.id)} [${c.eClass}]`),
      '  name one of them; a qualified name always resolves.',
    ].join('\n'),
  );
}

/* ─────────────────────────────── subcommands ────────────────────────────── */

function reportStats(model: Model, name: string): Report {
  const m = modelMetrics(model);
  const census = Object.entries(m.byMetaclass).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const text = [
    `${name}: ${m.totalElements} element(s) — ${m.nodeCount} node(s), ${m.relationshipCount} relationship(s), ` +
      `${m.rootCount} root(s), max depth ${m.maxDepth}`,
    ...aligned([['library elements', m.libraryElements]]),
    '  (the library is bound alongside the model and left out of every figure above)',
    '  by metaclass',
    ...aligned(
      census.map(([k, v]) => [k, v] as [string, number]),
      '    ',
    ),
  ].join('\n');
  return { json: m, text };
}

function reportElements(model: Model, name: string, includeLibrary: boolean): Report {
  const grid = buildGrid(model, { excludeLibrary: !includeLibrary });
  // `buildGrid`'s only filter is the library, and the app's Grid view wants it
  // that way. A command answering "what is IN it" must not stop there: 14 of
  // the 94 rows it returns for the shipped UAV example are the tool's own
  // usage-scoped connector endpoints (`impl-…` ids), so the listing claimed 29
  // PortUsages for a model that `stats` — and every other subcommand, which all
  // go through `isUserElement` — says has 15. Those rows are not in the
  // reader's file and cannot be edited there, so a listing that ADDS them is
  // not a listing of their model.
  const kept = grid.rows.filter((r) => {
    const el = model.get(r.id);
    if (!el) return false;
    return isUserElement(model, el) || (includeLibrary && el.attrs.isLibrary === true);
  });
  const implicitExcluded = grid.rows.length - kept.length;
  const rows = kept.map((r) => ({
    id: r.id,
    qualifiedName: qname(model, r.id),
    name: r.cells.name,
    metaclass: r.cells.metaclass,
    type: r.cells.type,
    multiplicity: r.cells.multiplicity,
    value: r.cells.value,
    redefines: r.cells.redefines,
    doc: r.cells.doc,
  }));
  // Padding is capped: one 90-character library name must not indent every
  // other line off the right of the terminal.
  const width = Math.min(60, Math.max(0, ...rows.map((r) => r.qualifiedName.length)));
  const text = [
    `${name}: ${rows.length} element(s)` + (includeLibrary ? ' (bundled library included)' : ''),
    '  relationships and documentation are reported through the elements they attach to',
    `  ${implicitExcluded} re-derived element(s) (usage-scoped connector endpoints) left out`,
    ...rows.map((r) => {
      const tail = [r.type ? `: ${r.type}` : '', r.value ? ` = ${r.value}` : ''].join('');
      return `  ${r.qualifiedName.padEnd(width)}  ${r.metaclass}${tail}`;
    }),
  ].join('\n');
  return { json: rows, text };
}

function reportRequirements(model: Model, name: string): Report {
  const sat = requirementSatisfaction(model);
  const table = buildRequirementsTable(model);
  const status = new Map(sat.requirements.map((r) => [r.requirement.id, r]));

  // The ratio and the list are built from ONE population: a row the ratio does
  // not count would be a line the reader adds up to a different number.
  const rows = table.rows
    .filter((r) => status.has(r.id))
    .map((r) => {
      const st = status.get(r.id)!;
      return {
        id: r.id,
        number: r.number,
        reqId: r.reqId,
        name: r.name || label(st.requirement),
        metaclass: r.eClass,
        text: r.text,
        satisfied: st.satisfied,
        satisfiedBy: st.satisfiers.map(label),
        verifiedBy: r.refs.verifiedBy.map((x) => x.label),
        refinedBy: r.refs.refinedBy.map((x) => x.label),
        tracedTo: r.refs.tracedTo.map((x) => x.label),
        derivedFrom: r.refs.derivedFrom.map((x) => x.label),
      };
    });
  const rowIds = new Set(rows.map((r) => r.id));
  for (const st of sat.requirements) {
    if (rowIds.has(st.requirement.id)) continue;
    rows.push({
      id: st.requirement.id,
      number: '',
      reqId: '',
      name: label(st.requirement),
      metaclass: st.requirement.eClass,
      text: '',
      satisfied: st.satisfied,
      satisfiedBy: st.satisfiers.map(label),
      verifiedBy: [],
      refinedBy: [],
      tracedTo: [],
      derivedFrom: [],
    });
  }

  const payload = {
    total: sat.total,
    satisfied: sat.satisfied,
    coverage: sat.coverage,
    libraryExcluded: sat.libraryExcluded,
    implicitExcluded: sat.implicitExcluded,
    nonNormativeExcluded: sat.nonNormativeExcluded,
    rows,
  };
  const pct = sat.total === 0 ? 0 : Math.round(sat.coverage * 100);
  const text = [
    `${name}: ${sat.satisfied} of ${sat.total} requirement(s) satisfied (${pct}%)`,
    ...(rows.length === 0 ? ['  no requirements in this model'] : []),
    ...rows.map((r) => {
      const mark = r.satisfied ? '[x]' : '[ ]';
      const id = r.reqId ? ` (${r.reqId})` : '';
      const by = r.satisfied ? `satisfied by ${r.satisfiedBy.join(', ')}` : 'nothing satisfies it';
      return `  ${mark} ${r.number ? `${r.number}  ` : ''}${r.name}${id} — ${by}`;
    }),
    `  ${sat.libraryExcluded} bundled library requirement(s) and ${sat.implicitExcluded} re-derived copy/copies are not counted`,
    // Only when there IS one. The exclusion line above is on every report
    // because the library is always there to exclude; a non-normative statement
    // is not, and a permanent `0 prose or prompt` line would teach every reader
    // of every model a vocabulary most of them never use. When one does appear,
    // the ratio moved and this says why.
    ...(sat.nonNormativeExcluded > 0
      ? [
          `  ${sat.nonNormativeExcluded} statement(s) tagged prose or prompt are not requirements and are not counted`,
        ]
      : []),
  ].join('\n');
  return { json: payload, text };
}

/**
 * The row and column metaclasses a relationship family actually links.
 *
 * Read off the model rather than fixed per preset. `satisfy` joins a
 * `PartUsage` to a `RequirementDefinition` in the shipped UAV example and a
 * `PartUsage` to a `RequirementUsage` in a model that declares its requirements
 * as usages; a preset that hard-coded either pair would report an empty matrix
 * for the other shape, and an empty matrix is indistinguishable from "nothing
 * is traced". `--from` / `--to` override it for the axis a reader wants to see
 * whether anything reaches at all.
 */
function traceAxes(
  model: Model,
  relKinds: readonly string[],
): { fromKinds: string[]; toKinds: string[] } {
  const edges = model.all().filter((el) => relKinds.includes(el.eClass) && isUserElement(model, el));
  const kindsOn = (end: 'source' | 'target'): string[] => {
    const seen: string[] = [];
    for (const e of edges) {
      for (const id of e[end] ?? []) {
        const k = model.get(id)?.eClass;
        if (k && !seen.includes(k)) seen.push(k);
      }
    }
    return seen;
  };
  return { fromKinds: kindsOn('source'), toKinds: kindsOn('target') };
}

/**
 * The relationship family `--relation` names, or a refusal.
 *
 * Shared with {@link precheckArgs} so an unknown name is rejected before the
 * model is read rather than after a second of parsing and library binding.
 */
function traceRelation(args: ParsedArgs): { relation: string; relKinds: readonly string[] } {
  const relation = flagValue(args, 'relation') ?? 'satisfy';
  const relKinds = TRACE_PRESETS.get(relation);
  if (!relKinds) {
    throw new UsageError(
      `unknown --relation \`${relation}\` — one of ${[...TRACE_PRESETS.keys()].join(', ')}`,
      true,
    );
  }
  return { relation, relKinds };
}

function reportTrace(model: Model, name: string, args: ParsedArgs): Report {
  const { relation, relKinds } = traceRelation(args);
  const derived = traceAxes(model, relKinds);
  const from = flagValue(args, 'from');
  const to = flagValue(args, 'to');

  // An override naming a metaclass the model does not hold is refused, not
  // honoured. Honouring it produces an empty matrix and exit 0 — the exact
  // shape this command derives its axes to avoid, and indistinguishable from
  // the honest "nothing of this kind is traced" answer, so a typo (`PartUsages`
  // for `PartUsage`) would read as a finding about the model.
  const derivedAxes =
    derived.fromKinds.length === 0 || derived.toKinds.length === 0
      ? `this model has no ${relKinds.join('/')} relationship at all`
      : `${relation} here links ${derived.fromKinds.join(', ')} to ${derived.toKinds.join(', ')}`;
  for (const [flag, kind] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (kind !== undefined && model.ofKind(kind).length === 0) {
      throw new UsageError(
        `--${flag} names a metaclass this model has none of (\`${kind}\`) — ${derivedAxes}`,
        true,
      );
    }
  }

  const fromKinds = from ? [from] : derived.fromKinds;
  const toKinds = to ? [to] : derived.toKinds;

  const rows = new Map<string, ElementRef>();
  const columns = new Map<string, ElementRef>();
  const links = new Map<string, { from: string; to: string; relationshipId: string }>();
  for (const f of fromKinds) {
    for (const t of toKinds) {
      for (const rel of relKinds) {
        const m = traceabilityMatrix(model, f, t, rel);
        for (const r of m.rows) rows.set(r.id, r);
        for (const c of m.columns) columns.set(c.id, c);
        for (const l of m.links) links.set(`${l.relationshipId}|${l.from}|${l.to}`, l);
      }
    }
  }
  const rowList = [...rows.values()];
  const columnList = [...columns.values()];
  const linked = new Set([...links.values()].map((l) => `${l.from}|${l.to}`));

  // Counted over the UNION of the axis kinds, once per element: a candidate
  // that sits on both axes (a parts × parts view) is one element the reader
  // cannot see, and summing the parts of a merged matrix would report two
  // library parts in a model that has one.
  const candidates = new Map<string, ElementRecord>();
  for (const kind of new Set([...fromKinds, ...toKinds])) {
    for (const el of model.ofKind(kind)) candidates.set(el.id, el);
  }
  const pool = [...candidates.values()];
  const libraryExcluded = pool.filter((el) => el.attrs.isLibrary === true).length;
  const implicitExcluded = pool.filter(
    (el) => el.attrs.isLibrary !== true && !isUserElement(model, el),
  ).length;

  const unlinkedRows = rowList
    .filter((r) => !columnList.some((c) => linked.has(`${r.id}|${c.id}`)))
    .map(label);
  const unlinkedColumns = columnList
    .filter((c) => !rowList.some((r) => linked.has(`${r.id}|${c.id}`)))
    .map(label);

  const payload = {
    relation,
    relationshipKinds: [...relKinds],
    fromKinds,
    toKinds,
    rows: rowList,
    columns: columnList,
    cells: rowList.map((r) => columnList.map((c) => linked.has(`${r.id}|${c.id}`))),
    links: [...links.values()].map((l) => ({
      ...l,
      fromName: qname(model, l.from),
      toName: qname(model, l.to),
    })),
    unlinkedRows,
    unlinkedColumns,
    libraryExcluded,
    implicitExcluded,
  };

  const axes =
    fromKinds.length === 0 || toKinds.length === 0
      ? `no ${relKinds.join('/')} relationship in this model`
      : `${fromKinds.join(', ')} -> ${toKinds.join(', ')} via ${relKinds.join(', ')}`;
  const text = [
    `${name}: ${relation} — ${payload.links.length} link(s) across ${rowList.length} row(s) x ${columnList.length} column(s)`,
    `  axes: ${axes}`,
    ...listOrNone(
      'links',
      payload.links.map((l) => `${l.fromName} -> ${l.toName}`),
      'no links',
    ),
    ...(unlinkedColumns.length > 0
      ? [`  nothing links to: ${unlinkedColumns.join(', ')}`]
      : []),
    ...(unlinkedRows.length > 0 ? [`  links to nothing: ${unlinkedRows.join(', ')}`] : []),
    `  ${libraryExcluded} library and ${implicitExcluded} re-derived candidate(s) left out of the axes`,
  ].join('\n');
  return { json: payload, text };
}

function reportConnectivity(model: Model, name: string): Report {
  const c = connectivityReport(model);
  const text = [
    `${name}: ${c.portCount} port(s), ${c.connectionCount} connection(s), ${c.connectedPortCount} connected, ` +
      `${c.unconnectedPorts.length} unconnected`,
    ...listOrNone(
      'connections',
      c.connections.map(
        (x) =>
          `${label(x.connection)}: ${x.sourcePorts.map((id) => qname(model, id)).join(', ')} -> ` +
          `${x.targetPorts.map((id) => qname(model, id)).join(', ')}`,
      ),
      'no connections',
    ),
    ...listOrNone(
      'unconnected ports',
      c.unconnectedPorts.map((p) => p.qualifiedName || p.id),
      'every declared port is wired',
    ),
    ...(c.unconnectedPortUsages.length > 0
      ? [
          '  unconnected port usages (a port is dangling per usage, not per declaration)',
          ...c.unconnectedPortUsages.map(
            (o) => `    ${o.part.qualifiedName || label(o.part)} :: ${label(o.port)}`,
          ),
        ]
      : []),
    `  ${c.implicitResolved} endpoint(s) lifted onto the port they redefine; ` +
      `${c.libraryExcluded} library and ${c.implicitExcluded} re-derived candidate(s) excluded`,
  ].join('\n');
  return { json: c, text };
}

/** The element `where-used` was asked about, or a refusal. Shared with the precheck. */
function whereUsedRef(args: ParsedArgs): string {
  const ref = flagValue(args, 'element');
  if (ref === undefined) {
    throw new UsageError('where-used needs --element <id|qualified name|unique name>', true);
  }
  return ref;
}

/** How many hops `where-used` was asked to walk, or a refusal. Shared with the precheck. */
function whereUsedDepth(args: ParsedArgs): number {
  const raw = flagValue(args, 'depth') ?? '1';
  const depth = Number(raw);
  if (!Number.isInteger(depth) || depth < 1) {
    throw new UsageError(`--depth must be a whole number of hops, 1 or more (got \`${raw}\`)`, true);
  }
  return depth;
}

function reportWhereUsed(model: Model, name: string, args: ParsedArgs): Report {
  const ref = whereUsedRef(args);
  const depth = whereUsedDepth(args);
  const el = resolveElementRef(model, ref);
  const report = impactClosure(model, el.id, depth);
  const payload = { ...report, requestedDepth: depth };
  const text = [
    `${name}: ${qname(model, el.id)} — ${report.impacted.length} element(s) impacted, ` +
      `${report.depth} hop(s) out of ${depth} asked for`,
    ...(report.impacted.length === 0
      ? ['  nothing references it']
      : report.impacted.map(
          (i) =>
            `  ${i.depth}  ${i.element.qualifiedName || i.element.id}` +
            `  via ${i.via} from ${label(i.from)}`,
        )),
    report.truncated
      ? `  truncated: one more hop has somewhere to go — raise --depth`
      : '  complete: nothing further to reach',
    `  ${report.libraryExcluded} library element(s) dropped from the walk; ` +
      `${report.implicitExcluded} re-derived element(s) crossed but not reported`,
  ].join('\n');
  return { json: payload, text };
}

function reportOrphans(model: Model, name: string): Report {
  const r = orphanReport(model);
  const text = [
    `${name}: ${r.orphans.length} of ${r.definitionsExamined} definition(s) unused`,
    ...(r.orphans.length === 0
      ? ['  every definition is used somewhere in this model']
      : r.orphans.map((o) => `  ${o.qualifiedName || label(o)} [${o.eClass}]`)),
    `  ${r.packagesSkipped} package(s) skipped as namespaces; ` +
      `${r.libraryExcluded} library and ${r.implicitExcluded} re-derived definition(s) excluded`,
    '  an unused definition is valid — this is an inventory, not a diagnostic',
  ].join('\n');
  return { json: r, text };
}

/* ──────────────────────────────── dispatch ──────────────────────────────── */

function buildReport(cmd: CommandSpec, model: Model, name: string, args: ParsedArgs): Report {
  switch (cmd.name) {
    case 'stats':
      return reportStats(model, name);
    case 'elements':
      return reportElements(model, name, flagGiven(args, 'include-library'));
    case 'requirements':
      return reportRequirements(model, name);
    case 'trace':
      return reportTrace(model, name, args);
    case 'connectivity':
      return reportConnectivity(model, name);
    case 'where-used':
      return reportWhereUsed(model, name, args);
    case 'orphans':
      return reportOrphans(model, name);
    default:
      // Unreachable while COMMANDS and this switch agree; exiting 2 rather than
      // reporting nothing is the honest answer if they ever do not.
      throw new UsageError(`\`${cmd.name}\` is declared but not implemented`);
  }
}

/**
 * Everything about the command line that can be judged without the model.
 *
 * Run before the file is read, because loading a model costs a second of
 * parsing and standard-library binding and a mistyped `--relation` should not
 * cost that. The checks themselves are not duplicated: these are the same
 * helpers the report functions call.
 */
function precheckArgs(cmd: CommandSpec, args: ParsedArgs): void {
  switch (cmd.name) {
    case 'trace':
      traceRelation(args);
      return;
    case 'where-used':
      whereUsedRef(args);
      whereUsedDepth(args);
      return;
    default:
      return;
  }
}

/** One diagnostic in the checker's own `file:line:col: severity code  message` form. */
function diagnosticLine(name: string, d: CheckReport['diagnostics'][number]): string {
  const at = d.range ? `${d.range.start.line}:${d.range.start.column}` : '-';
  return `${name}:${at}: ${d.severity} ${d.code ?? d.ruleId}  ${d.message}`;
}

/** How many diagnostics are printed before the rest are counted instead. */
const MAX_DIAGNOSTICS = 20;

/**
 * Put what the checker found about the FILE on stderr, whatever the exit code.
 *
 * Diagnostics used to be printed on two branches only — nothing loaded, and the
 * model loaded degraded — so a finding that left `report.ok` true never reached
 * the reader at all. `import/wrong-extension` is the live case: analysing
 * `model.txtt` reported a clean, confident set of figures and never said the
 * file was not recognised as textual notation, while `npm run check` on the
 * same file said so plainly. A report is of a file, and what is wrong with the
 * file belongs beside it.
 */
function writeDiagnostics(cmd: CommandSpec, name: string, report: CheckReport): void {
  if (report.diagnostics.length === 0) return;
  for (const d of report.diagnostics.slice(0, MAX_DIAGNOSTICS)) {
    process.stderr.write(`${diagnosticLine(name, d)}\n`);
  }
  const hidden = report.diagnostics.length - MAX_DIAGNOSTICS;
  if (hidden > 0) {
    process.stderr.write(`  … ${hidden} more — run \`npm run check\` for all of them\n`);
  }
  const { errors, warnings, infos } = report.summary;
  process.stderr.write(
    `sysprose ${cmd.name}: ${name} — ${errors} error(s), ${warnings} warning(s), ${infos} info(s)\n`,
  );
}

/** Report a usage refusal on stderr and hand back its exit code. */
function writeUsageError(cmd: CommandSpec, err: UsageError): number {
  process.stderr.write(
    `sysprose ${cmd.name}: ${err.message}\n${err.showUsage ? `\n${renderCommandUsage(cmd)}\n` : ''}`,
  );
  return 2;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    process.stderr.write(`sysprose: no subcommand\n\n${renderTopUsage()}\n`);
    return 2;
  }
  if (argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(`${renderTopUsage()}\n`);
    return 0;
  }
  if (argv[0].startsWith('-') && argv[0] !== '-') {
    process.stderr.write(`sysprose: unknown option: ${argv[0]}\n\n${renderTopUsage()}\n`);
    return 2;
  }

  const cmd = findCommand(argv[0]);
  if (!cmd) {
    process.stderr.write(
      `sysprose: unknown subcommand: ${argv[0]} — one of ${COMMANDS.map((c) => c.name).join(', ')}\n\n${renderTopUsage()}\n`,
    );
    return 2;
  }

  const parsed = parseArgs(argv.slice(1), flagsFor(cmd));
  if (isArgError(parsed)) {
    process.stderr.write(`sysprose ${cmd.name}: ${parsed.error}\n\n${renderCommandUsage(cmd)}\n`);
    return 2;
  }
  // Help is read off the PARSED flags rather than scanned for in the raw argv,
  // so it obeys the grammar the rest of the command line obeys: after `--` a
  // `-h` is a positional, and `--element --help` is a missing value. A raw scan
  // answered both with the help text and exit 0 — a malformed command line
  // reported as a success, which is what the missing-value check exists to stop.
  if (flagGiven(parsed, 'help')) {
    process.stdout.write(`${renderCommandUsage(cmd)}\n`);
    return 0;
  }
  if (parsed.positionals.length === 0) {
    process.stderr.write(`sysprose ${cmd.name}: no input file\n\n${renderCommandUsage(cmd)}\n`);
    return 2;
  }
  if (parsed.positionals.length > 1) {
    // One model per run, deliberately: files are separate namespaces here (see
    // `npm run check`), so two files are two models and one report over both
    // would be a number that is true of neither.
    process.stderr.write(
      `sysprose ${cmd.name}: expected one file, got ${parsed.positionals.length}\n\n${renderCommandUsage(cmd)}\n`,
    );
    return 2;
  }

  try {
    precheckArgs(cmd, parsed);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    return writeUsageError(cmd, err);
  }

  const file = parsed.positionals[0];
  const name = file === '-' ? '<stdin>' : file;
  let text: string;
  try {
    text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(
      `sysprose ${cmd.name}: cannot read ${name}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const { model, report } = await loadModelText(text, {
    library: flagGiven(parsed, 'no-library') ? 'none' : 'full',
    // Piped input has no file name, so it is labelled rather than named — the
    // extension test is about a file the reader could rename.
    ...(file === '-' ? { displayName: '<stdin>' } : { fileName: file }),
  });

  writeDiagnostics(cmd, name, report);

  if (!model) {
    process.stderr.write(`sysprose ${cmd.name}: nothing loaded from ${name} — no report\n`);
    return 2;
  }
  const degraded = !report.ok;
  if (!degraded && model.all().filter((el) => isUserElement(model, el)).length === 0) {
    // "0 elements, everything is fine" is the answer a mistyped path deserves
    // least: it is indistinguishable from a real report on a real model.
    //
    // Only for a file that PARSED, though. A file that failed to parse and
    // salvaged nothing is a broken file, not an empty one, and reporting it as
    // "no elements" threw away every diagnostic that said why — the reader was
    // told their model was empty when it was unreadable. That case is the
    // degraded exit below, with the findings above it.
    process.stderr.write(
      `sysprose ${cmd.name}: no elements in ${name} — nothing to report\n`,
    );
    return 2;
  }

  let built: Report;
  try {
    built = buildReport(cmd, model, name, parsed);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    return writeUsageError(cmd, err);
  }

  const body = flagGiven(parsed, 'json')
    ? JSON.stringify(
        {
          ok: report.ok,
          file: name,
          ...(degraded
            ? {
                degraded: {
                  errors: report.summary.errors,
                  warnings: report.summary.warnings,
                  diagnostics: report.diagnostics,
                },
              }
            : {}),
          [cmd.payloadKey]: built.json,
        },
        null,
        2,
      )
    : built.text;

  const out = flagValue(parsed, 'out');
  if (out !== undefined) {
    try {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${body}\n`);
    } catch (err) {
      // A path that cannot be written is a problem with what was asked, and it
      // reads as one. Letting it reach the top-level handler reported `internal
      // error` with a stack trace, which tells the reader the tool is broken
      // when their `--out` argument names a directory.
      process.stderr.write(
        `sysprose ${cmd.name}: cannot write ${out}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 2;
    }
    process.stdout.write(`Wrote ${out}\n`);
  } else {
    process.stdout.write(`${body}\n`);
  }

  if (degraded) {
    // The banner is on stderr and the report is on stdout, so a pipeline gets
    // the report and a person gets the warning that it is of a part. The
    // findings themselves are already above it, printed for every exit code.
    process.stderr.write(
      `sysprose ${cmd.name}: degraded — ${name} did not load cleanly ` +
        `(${report.summary.errors} error(s), ${report.summary.warnings} warning(s)); ` +
        `reporting on what parsed\n`,
    );
    return 1;
  }
  return 0;
}

runMain('sysprose', main);
