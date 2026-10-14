/**
 * The text of `reach` and `check-behaviour`, composed as typed lines.
 *
 * WHY THIS IS HERE AND NOT IN THE CLI. Both commands print a report whose every
 * line is a claim made under a bound, and the words of those claims are the
 * product: `dead withheld` instead of `0 dead`, `inconclusive:` in front of a
 * trap answer a gate refused, the profile printed beneath every verdict. A
 * second surface that composed its own copy of those sentences would drift from
 * the first, and the drift would be silent — each copy would read as honest. So
 * the composer lives beside the engine, and `scripts/sysprose.ts` and the page
 * both call it: what a terminal prints is `textOf(lines)`, and what the page
 * shows is the same lines, each carrying the element it is about and whether it
 * withholds an answer.
 *
 * BYTE-IDENTICAL BY CONTRACT. Every `text` is exactly the line the terminal
 * prints, indentation included, and joined by `\n` the lines are the CLI's text
 * block. The bodies below moved out of `scripts/sysprose.ts` verbatim; nothing
 * was reworded on the way.
 *
 * PURE. No DOM, no `node:`, no `src/api` import (the barrel re-exports this
 * module, not the other way round), no store.
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import {
  DEADLOCK_WITHHELD_SENTENCE,
  DEAD_TRANSITION_CODE,
  DEADLOCK_CODE,
  GUARD_UNDETERMINED_CODE,
  NONDETERMINISTIC_CHOICE_CODE,
  TRAP_REFUSAL_SENTENCE,
  UNREACHABLE_STATE_CODE,
  UNRECOVERABLE_MODE_CODE,
  stateMachinesIn,
  transitionLabel,
  type MachineReach,
  type ReachReport,
} from './explore';
import {
  SEMANTICS_ADMITS,
  WALK_ADMITS,
  coverRequiredRefusal,
  traceLine,
  type BehaviourReport,
  type PropertyVerdict,
} from './patterns';
import { profileLines } from './profile';
import { DWELL_SENTENCE, environmentSentence, environmentTriggers } from './publishable';

/* ───────────────────────────────── the lines ────────────────────────────── */

export type ReportLineKind =
  | 'head'
  | 'scope'
  | 'remit'
  | 'empty'
  | 'machine'
  | 'figures'
  | 'counts'
  | 'not-explored'
  | 'undecided'
  | 'unreachable'
  | 'dead'
  | 'no-way-out'
  | 'withheld'
  | 'trap'
  | 'trap-refused'
  | 'choice'
  | 'suppressed'
  | 'property'
  | 'from'
  | 'detail'
  | 'code'
  | 'every-run'
  | 'explored'
  | 'cover-required'
  | 'witness-head'
  | 'witness-step'
  | 'flag-note'
  | 'profile-head'
  | 'profile'
  | 'diagnostic';

/** One line of a report, with what a reader of the page needs to act on it. */
export interface ReportLine {
  readonly kind: ReportLineKind;
  /** Exactly what the terminal prints, indentation included. */
  readonly text: string;
  /** The `verification/*` code the line reports, when it reports one. */
  readonly code: string | null;
  readonly elementId: ElementId | null;
  /**
   * Does this line say an answer was NOT given? True for the lines that carry a
   * withheld, refused or undecided answer, and for none that carry a finding —
   * so a reader scanning for "what did this walk decline to say" finds them by
   * this flag and not by their wording.
   */
  readonly withholds: boolean;
  /** 0 = head or tail; i = the i-th machine (`reach`) or property (`check-behaviour`), 1-based. */
  readonly block: number;
  /** The witness step's index, on a `witness-step` line. */
  readonly step: number | null;
  /** {@link rowKeyOf} of the row, on a no-way-out, choice or undecided line; never printed. */
  readonly rowKey: string | null;
}

/** The text block of a report: the lines joined as the terminal prints them. */
export const textOf = (ls: readonly ReportLine[]): string => ls.map((l) => l.text).join('\n');

/**
 * The three kinds of `reach` row that claim a run gets somewhere or consults
 * something: a configuration with no way out, a choice, an undecided guard.
 * Each is existential, and each carries a {@link rowKeyOf}.
 */
export type RowKind = 'deadlock' | 'choice' | 'guard';

/**
 * A row's identity across a re-walk of the same machine: element ids are fresh
 * on every load, but the leaf, the state and the transition a row names are the
 * same within one model. `dl:<leaf>`, `nd:<state>|<event>`, `ug:<transition>`.
 */
export function rowKeyOf(kind: RowKind, id: ElementId, event?: string): string {
  switch (kind) {
    case 'deadlock':
      return `dl:${id}`;
    case 'choice':
      return `nd:${id}|${event ?? ''}`;
    case 'guard':
      return `ug:${id}`;
  }
}

interface LineExtras {
  code?: string | null;
  elementId?: ElementId | null;
  withholds?: boolean;
  step?: number | null;
  rowKey?: string | null;
}

/** A line builder for one block. */
function liner(block: number): (kind: ReportLineKind, text: string, o?: LineExtras) => ReportLine {
  return (kind, text, o = {}) => ({
    kind,
    text,
    code: o.code ?? null,
    elementId: o.elementId ?? null,
    withholds: o.withholds ?? false,
    block,
    step: o.step ?? null,
    rowKey: o.rowKey ?? null,
  });
}

/** Qualified name, falling back to the id for an element that has none. */
function qname(model: Model, id: string): string {
  return model.qualifiedName(id) || id;
}

/* ──────────────────────────────────── reach ──────────────────────────────── */

/** One machine's block: the figures, then the rows that qualify them. */
export function reachMachineLines(m: MachineReach, block: number): ReportLine[] {
  const line = liner(block);
  const id = m.machine.id;
  const out: ReportLine[] = [
    line('machine', `  ${m.machine.qualifiedName} [${m.machine.eClass}]`, { elementId: id }),
    line(
      'figures',
      `    ${m.configs} configuration(s) explored, depth ${m.depth} — ${m.qualification}`,
      { elementId: id },
    ),
    line(
      'counts',
      // NOT `dead.length` when the list was withheld. The count is derived from a
      // list this report has just declined to publish, so `0 dead` on a
      // suppressed machine is the good-news reading of a short list — the exact
      // misreading the withholding exists to prevent — printed one line above the
      // sentence that says the list is withheld.
      `    ${m.states.reachable.length} of ${m.states.total} state(s) reachable; ` +
        `${m.transitions.fired} of ${m.transitions.total} transition(s) fired, ` +
        `${m.suppressed ? 'dead withheld' : `${m.transitions.dead.length} dead`}`,
      { elementId: id, withholds: m.suppressed },
    ),
  ];
  for (const u of m.unsupported) {
    out.push(
      line('not-explored', `    not explored: ${u.construct} — ${u.detail}`, {
        elementId: id,
        withholds: true,
      }),
    );
  }
  // Printed FIRST among the rows, because it is why the rows below it are
  // short. The unresolved names are named: an author who is told a guard could
  // not be evaluated and not which name was missing has to guess.
  for (const g of m.undeterminedGuards) {
    const names =
      g.unresolved.length > 0 ? `no value for ${g.unresolved.join(', ')}` : 'not readable as a value';
    out.push(
      line(
        'undecided',
        `    undecided    ${transitionLabel(g.transition)} — guard \`${g.guard}\`: ${names}`,
        {
          code: GUARD_UNDETERMINED_CODE,
          elementId: g.transition.id,
          withholds: true,
          rowKey: rowKeyOf('guard', g.transition.id),
        },
      ),
    );
  }
  for (const s of m.states.unreachable) {
    out.push(
      line('unreachable', `    unreachable  ${s.qualifiedName}`, {
        code: UNREACHABLE_STATE_CODE,
        elementId: s.id,
      }),
    );
  }
  for (const t of m.transitions.dead) {
    out.push(
      line('dead', `    dead         ${transitionLabel(t)}`, {
        code: DEAD_TRANSITION_CODE,
        elementId: t.id,
      }),
    );
  }
  for (const d of m.deadlocks) {
    out.push(
      line(
        'no-way-out',
        `    no way out   ${d.leaf.qualifiedName} — reached in ${d.steps} step(s), not marked final`,
        { code: DEADLOCK_CODE, elementId: d.leaf.id, rowKey: rowKeyOf('deadlock', d.leaf.id) },
      ),
    );
  }
  // A0's `otherwise` cell, printed. A row withheld because an undecided guard
  // is an edge out of the very configuration it is about leaves a LINE behind,
  // not a silence: the walk found the configuration and cannot say what a
  // reader would take the row to mean, and saying so is the difference between
  // a withheld claim and a claim nobody made.
  for (const d of m.deadlocksWithheld) {
    out.push(
      line('withheld', `    withheld     ${d.leaf.qualifiedName} — ${DEADLOCK_WITHHELD_SENTENCE}`, {
        elementId: d.leaf.id,
        withholds: true,
      }),
    );
  }
  // A set of configurations nothing leaves (register row A6). The list is
  // gated on `walkIsExact` and is EMPTY on every walk that gate refuses, so a
  // row here is a row over the relation the model states. The states are
  // declared names inside the braces — the finding beneath carries the
  // qualified one — and the opening is named because a trap is a claim about
  // where a run CAN get to, not only about where it cannot leave.
  for (const t of m.traps) {
    out.push(
      line(
        'trap',
        `    trap         {${t.states.map((s) => s.name).join(', ')}} — ${t.configs} configuration(s) ` +
          `nothing leaves; entered in ${t.steps} step(s) from ${t.entry[0].name}`,
        { code: UNRECOVERABLE_MODE_CODE, elementId: t.entry[0].id },
      ),
    );
  }
  // Where the gate refused a walk that FINISHED, the reason is printed here in
  // place of the list — the sentence opens with `inconclusive:` and is its own
  // row label — followed by the standing sentence for the mechanism. A
  // bound and an unsupported construct print nothing extra — the SUPPRESSED
  // and not-explored lines already say why every list is short. The no-trap
  // sentence is `--json` only and is NEVER a text row: a bare all-clear in a
  // report is the reading every gate in this lane exists to withhold.
  switch (m.trapCensus.refusedByGate) {
    case 'environment':
      // The standing sentence names the triggers THIS machine names, in the
      // order the bounds line above already printed them — never the plan's
      // example trigger: `reach` once said *consumes `abort`* of a file whose
      // only trigger is `unlatch`.
      out.push(
        line(
          'trap-refused',
          `    ${TRAP_REFUSAL_SENTENCE.environment}; ${environmentSentence(environmentTriggers(m.bounds.alphabet))}`,
          { elementId: id, withholds: true },
        ),
      );
      break;
    case 'time':
      out.push(
        line('trap-refused', `    ${TRAP_REFUSAL_SENTENCE.time}; ${DWELL_SENTENCE}`, {
          elementId: id,
          withholds: true,
        }),
      );
      break;
    case 'store':
      // The store's standing sentence is already inside the bounds line above
      // (`boundsSentence`), so nothing is appended here.
      out.push(
        line('trap-refused', `    ${TRAP_REFUSAL_SENTENCE.store}`, { elementId: id, withholds: true }),
      );
      break;
    case 'budget':
      out.push(
        line('trap-refused', `    ${TRAP_REFUSAL_SENTENCE.budget}`, { elementId: id, withholds: true }),
      );
      break;
    default:
      break;
  }
  for (const n of m.nondeterminism) {
    const on = n.event === '' ? 'as completion transitions (no trigger)' : `on \`${n.event}\``;
    out.push(
      line(
        'choice',
        `    choice       ${n.state.qualifiedName}: ${n.enabled.length} enabled ${on}; ` +
          `the simulator takes ${transitionLabel(n.taken)}, never ` +
          `${n.notTaken.map(transitionLabel).join(', ')}`,
        {
          code: NONDETERMINISTIC_CHOICE_CODE,
          elementId: n.state.id,
          rowKey: rowKeyOf('choice', n.state.id, n.event),
        },
      ),
    );
  }
  if (m.suppressed) {
    // Two different reasons for the same short lists, and a reader acts on them
    // differently: a bound is raised with `--max-configs`, an undecided guard is
    // fixed in the model. Printing the bound sentence over a walk that finished
    // would send them to the wrong one.
    // And it names the no-way-out list only where a row of it actually went:
    // after A0 that list is withheld per configuration, so on a machine whose
    // every deadlocked configuration was fully decided this line would
    // otherwise say a published row above it was not reported.
    out.push(
      line(
        'suppressed',
        m.undeterminedGuards.length > 0
          ? `    the unreachable and dead lists are WITHHELD${
              m.deadlocksWithheld.length === 0 ? '' : ', and the no-way-out rows marked `withheld` above'
            }: a guard this walk could not evaluate is not a guard that is false`
          : '    the unreachable and dead lists are SUPPRESSED: a walk that did not finish cannot say what it never reached',
        { elementId: id, withholds: true },
      ),
    );
  }
  return out;
}

/**
 * The whole `reach` text: the head, the machines, the profile, the diagnostics.
 *
 * `name` is the file name the head prints; `scopeName` is the qualified name of
 * the element the report was scoped to, when it was.
 */
export function reachLines(
  r: ReachReport,
  o: { name: string; scopeName?: string },
): ReportLine[] {
  const line = liner(0);
  return [
    line(
      'head',
      `${o.name}: ${r.totals.machines} state machine(s), ${r.totals.exhaustive} walked to exhaustion; ` +
        `${r.totals.configs} configuration(s) explored`,
    ),
    ...(o.scopeName !== undefined ? [line('scope', `  scoped to ${o.scopeName}`)] : []),
    // The sentence that keeps the command inside its remit: it decides the
    // finite abstraction it walked, and nothing beyond it.
    line(
      'remit',
      '  a bounded walk of what the interpreter would do — every figure below holds under the bounds printed beside it',
    ),
    // Said in words rather than left as a bare zero: a reader who asked for a
    // walk and got no rows needs to know the file has nothing to walk, not
    // wonder whether the command failed to find it.
    ...(r.machines.length === 0
      ? [
          line(
            'empty',
            '  this file declares no element that owns a transition, so there is no configuration graph to walk',
          ),
        ]
      : []),
    ...r.machines.flatMap((m, i) => reachMachineLines(m, i + 1)),
    line('profile-head', '  semantic profile (the reading every figure above holds under):'),
    ...profileLines('    ').map((t) => line('profile', t)),
    ...r.diagnostics.map((d) =>
      line('diagnostic', `  ${d.code}  ${d.message}`, { code: d.code, elementId: d.elementId ?? null }),
    ),
  ];
}

/* ───────────────────────────── the machine to walk ──────────────────────── */

/**
 * The sentence for a reference to BUNDLED LIBRARY content.
 *
 * The library's own requirements and machines are not the reader's, every
 * figure in these reports excludes them by construction, and scoping to one
 * would print an inventory of zero contracts that reads exactly like a model
 * with none.
 *
 * A caller makes this check BEFORE {@link noMachineRefusal} and
 * {@link behaviourMachineFor}, which do not look at `attrs.isLibrary`: handed a
 * library machine they return the machine, or the `holds no state machine`
 * text, where the terminal (`verificationScope`) says this.
 */
export const libraryElementRefusal = (ref: string): string =>
  `\`${ref}\` is a bundled standard-library element — this report is of your model, and every figure in it excludes the library`;

/**
 * The refusal for an element that holds no state machine, or `null` when it
 * holds one or more.
 *
 * A `REF` that holds none is refused BY NAME rather than answered with an empty
 * report: "0 machines, nothing to say" is indistinguishable from a model whose
 * machines this command failed to find, and the reader would have no way to
 * tell which they were looking at. `holder` is the machine that CONTAINS the
 * element when there is one: the commonest mistake is naming a state rather
 * than the machine it is in.
 */
export function noMachineRefusal(
  model: Model,
  scopeId: ElementId,
): { message: string; holder: ElementId | null } | null {
  if (stateMachinesIn(model, scopeId).length > 0) return null;
  return noMachine(model, scopeId);
}

function noMachine(model: Model, scopeId: ElementId): { message: string; holder: ElementId | null } {
  const holder = stateMachinesIn(model).find((m) =>
    model.descendants(m.id).some((d) => d.id === scopeId),
  );
  return {
    message:
      `\`${qname(model, scopeId)}\` holds no state machine` +
      (holder ? ` — it is inside \`${qname(model, holder.id)}\`, which is one` : ''),
    holder: holder ? holder.id : null,
  };
}

export type MachineFor =
  | { ok: true; machine: ElementRecord }
  | { ok: false; message: string; holder: ElementId | null; candidates: ElementId[] };

/**
 * `--element REF`, which `check-behaviour` cannot do without.
 *
 * `reach` defaults to every machine in the file and this one has no default at
 * all, and the difference is not an oversight: `reach` REPORTS on machines, so
 * "all of them" is a coherent answer, while a property is a CLAIM about one
 * machine. A run that checked every property in the file against every machine
 * in it would answer a question nobody asked and would report failures against
 * machines the property was never about.
 */
export const ELEMENT_REQUIRED_LEAD =
  '--element REF is required: it names the state machine the property is about. ';
export const NO_DEFAULT_MACHINE =
  'There is no default — a property is a claim about one machine, and checking every ' +
  'property in the file against every machine in it would report failures against machines ' +
  'the property was never about.';

/** The machine to check, refused BY NAME when the reference holds none or several. */
export function behaviourMachineFor(model: Model, scopeId: ElementId): MachineFor {
  const machines = stateMachinesIn(model, scopeId);
  if (machines.length === 0) {
    return { ok: false, ...noMachine(model, scopeId), candidates: [] };
  }
  if (machines.length > 1) {
    // Refused rather than answered over all of them, for `ELEMENT_REQUIRED_LEAD`'s
    // reason: a verdict is about one machine, and a `REF` that holds several is
    // a reference the reader has to narrow.
    return {
      ok: false,
      message: [
        `\`${qname(model, scopeId)}\` holds ${machines.length} state machines:`,
        ...machines.map((m) => `    ${qname(model, m.id)} [${m.eClass}]`),
        '  name one of them — a property is a claim about one machine.',
      ].join('\n'),
      holder: null,
      candidates: machines.map((m) => m.id),
    };
  }
  return { ok: true, machine: machines[0] };
}

/* ──────────────────────────────── check-behaviour ───────────────────────── */

/** One property's block: the verdict, then the trace that stands behind it. */
export function propertyVerdictLines(
  v: PropertyVerdict,
  coverRequired: boolean,
  block: number,
): ReportLine[] {
  const line = liner(block);
  // `inconclusive` and `vacuous` are the two words that say nothing was decided.
  const undecided = v.claim === 'inconclusive' || v.claim === 'vacuous';
  const from = v.property.source === 'flag' ? '--pattern' : `@PropertyPattern on ${v.property.carrier}`;
  const out: ReportLine[] = [
    line('property', `  ${v.claim.toUpperCase().padEnd(12)} ${v.sentence}`, {
      code: v.code,
      withholds: undecided,
    }),
    line('from', `    from ${from}`),
    line('detail', `    ${v.detail}`, { withholds: undecided }),
  ];
  if (v.code !== null) out.push(line('code', `    ${v.code}`, { code: v.code }));
  // Some run or every run? One line, on a `fail` row only, with the value word
  // first — `guaranteed`, `potential`, `not decided` — and the simulator
  // sentence folded into the same line where the walk recorded a choice.
  if (v.modality !== null) {
    out.push(
      line('every-run', `    every run? ${v.modality.sentence}`, {
        withholds: v.modality.value === 'not-decided',
      }),
    );
  }
  if (v.claim !== 'inconclusive' || v.configs > 0) {
    // A `recovery` row never ran the product search: its count is the
    // machine's configurations, and "product state(s)" would label it as a
    // number nothing computed.
    const unit = v.patternClass === 'branching' ? 'configuration(s)' : 'product state(s)';
    out.push(line('explored', `    ${v.configs} ${unit} explored — ${v.qualification}`));
  }
  // CORRECTION 23's disclosure. A cover withheld under an undecided guard is
  // not `not covered` and the flag has no 1 to spend on it, so the row says
  // so on EVERY such cover — the census may be 0 (the undecided edge leads
  // somewhere the walk reached anyway) and the flag declined on that row all
  // the same — quoting the census as a fraction rather than leaving a reader
  // to wonder why the flag did nothing, or telling them "every" about states
  // nothing counted.
  if (coverRequired && v.cover !== undefined && v.code === GUARD_UNDETERMINED_CODE) {
    out.push(line('cover-required', `    ${coverRequiredRefusal(v.cover)}`, { withholds: true }));
  }
  if (v.witness.length > 0) {
    // ONE STRING, TWO READERS: the header repeats the warrant `checkProperty`
    // composed into the detail, so a `covered` row re-worded to the walk's
    // warrant cannot print a header claiming the semantics'.
    out.push(
      line('witness-head', `    witness — ${v.detail.includes(WALK_ADMITS) ? WALK_ADMITS : SEMANTICS_ADMITS}:`),
    );
    for (const step of v.witness) {
      out.push(
        line('witness-step', `      ${traceLine(step)}`, {
          elementId: step.leaf?.id ?? null,
          step: step.index,
        }),
      );
    }
  }
  return out;
}

/**
 * The whole `check-behaviour` text: the head, the remit, the properties, the
 * profile, the flag notes and the diagnostics.
 *
 * `name` is the file name the head prints; `machineName` is the qualified name
 * of the machine the run was scoped to.
 */
export function behaviourLines(
  r: BehaviourReport,
  o: { name: string; machineName: string },
): ReportLine[] {
  const line = liner(0);
  return [
    line(
      'head',
      `${o.name}: ${o.machineName} — ${r.properties.length} propert${r.properties.length === 1 ? 'y' : 'ies'}: ` +
        `${r.counts.passed} pass, ${r.counts.failed} fail, ${r.counts.vacuous} vacuous, ` +
        // APPENDED after the four, never reordered: the campaign pins the
        // four-bucket prefix as a substring on every transcript.
        `${r.counts.inconclusive} inconclusive, ${r.counts.covered} covered, ${r.counts.notCovered} not covered`,
    ),
    // The two sentences that keep the command inside its remit: what a pass is
    // a claim about, and what this engine does not decide at all. It reaches
    // six words and no others — and the three louder ones a reader might
    // expect are not among them, which is said by their absence and by the
    // claims guard rather than by naming them here.
    line(
      'remit',
      '  a pass is a claim about every configuration this walk reached, under the bounds printed beside it, and about nothing outside them; a covered is a claim that ONE run this walk saw reaches the situation named, and not covered that none it saw whole does: pass, fail, vacuous, inconclusive, covered, not covered are the six words this command reaches',
    ),
    line(
      'remit',
      '  liveness (`existence`, `response`) is NOT decided here: a bad-prefix search finds no bad prefix for either, so both report inconclusive',
    ),
    ...(r.properties.length === 0
      ? [
          line(
            'empty',
            '  this machine states no property and none was given: nothing was decided, which is exit 2 — a run that checked nothing has not passed',
          ),
          line(
            'empty',
            '  write one with `--pattern "pattern=absence, scope=globally, p=state failsafe"`, or carry it in the model as `@SysproseVerification::PropertyPattern { attribute pattern = "absence"; … }`',
          ),
        ]
      : []),
    ...r.properties.flatMap((v, i) => propertyVerdictLines(v, r.coverRequired, i + 1)),
    line('profile-head', '  semantic profile (the reading every verdict above holds under):'),
    ...profileLines('    ').map((t) => line('profile', t)),
    ...(r.strictVacuity
      ? [
          line(
            'flag-note',
            '  --strict-vacuity: every vacuous row above is also an error below; the exit code is the same with the flag and without it',
          ),
        ]
      : []),
    ...(r.coverRequired
      ? [
          line(
            'flag-note',
            '  --cover-required: every not-covered row above is also an error below and spends the 1; the claim word is the same with the flag and without it',
          ),
        ]
      : []),
    ...r.diagnostics.map((d) =>
      line('diagnostic', `  ${d.severity} ${d.code}  ${d.message}`, {
        code: d.code,
        elementId: d.elementId ?? null,
      }),
    ),
  ];
}
