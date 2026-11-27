/**
 * Interface protocol compatibility of two connected parts' state machines (opt-in `check-behaviour --interfaces`).
 *
 * de Alfaro & Henzinger, "Interface Automata", ESEC/FSE 2001: two interface automata are COMPATIBLE when some
 * environment can drive their synchronous product so that neither side outputs an action the other cannot take
 * (an unspecified reception, their "illegal" state). SysML v2 Part 1 §7.12 (ports, interfaces, §7.12.1 port
 * conformance) gives the connection and the items its ports carry; §7.18.3 gives `accept X via p` (a trigger) and
 * `send X via p` (an action) for the two alphabets.
 *
 * THE READING. For a binary connection between two ports whose owners each hold exactly ONE flat state machine, the
 * items the connected ports carry are the shared alphabet. A transition triggered by `accept X via p` is an input of
 * that item; a transition whose effect action performs `send X via p` is an output of it. Both sides are composed
 * synchronously on the shared items: an output of one fires together with an input of the other, and every other
 * label (an event trigger no port item carries, an internal completion, an item of another port) interleaves, the
 * environment being taken as helpful (it offers any such event whenever asked). The product is walked exhaustively
 * under a bound. Reported: (a) an UNSPECIFIED RECEPTION: a reachable product state where one side can output item X
 * through the connection and the other has, in its current state, no transition accepting X; (b) a DEADLOCK: a
 * reachable product state, not final in both machines, with no enabled step. Each carries the product steps that
 * reach it. An unspecified reception is marked `forced` when the components alone drive the run into it (no
 * environment choice avoids it, the de Alfaro-Henzinger incompatibility) and otherwise it is reachable only when
 * the environment offers the events listed in the witness.
 *
 * WHAT STAYS UNSAID. Nothing is claimed for a pair when either machine has a construct this reading cannot attribute
 * with certainty: a send or accept whose port or item does not resolve to one directed feature of exactly one port,
 * a send inside an entry/do/exit action or an effect it cannot read, a transition that accepts a port item and also
 * sends, more than one send in an effect, a guard, a dwell, a nested or parallel state, an `inout` item, ports that do
 * not conform, more than one machine on a part. A walk cut by the bound is `undecided`, never compatible.
 * Untimed: asynchronous queues, more than two parts and assume-guarantee contracts are not read.
 */
import type { ElementId, ElementRecord, Model } from '@core/index';
import { effectiveFeatures, generalizationsOf } from '../inheritance';
import { connectorEndsOf, isConnector } from '../connectors';
import { directedFeaturesOf, declaredDefinitions, portMismatches } from '../port-conformance';
import {
  actionsNamed,
  directStates,
  entryStartUnreadOf,
  guardTextOf,
  initialStateOf,
  isFinalState,
  isHistoryComposite,
  isParallelState,
  machineRegion,
  timeTriggerLabel,
} from './config';
import { stateMachinesIn } from './explore';

/** The most product states one pair's walk visits before it answers `undecided`. */
export const MAX_INTERFACE_STATES = 100_000;

type Move =
  | { kind: 'internal' | 'env'; label: string; to: ElementId }
  | { kind: 'out' | 'in'; item: string; label: string; to: ElementId; triggered?: boolean };

interface Side {
  owner: ElementRecord;
  start: ElementId;
  moves: Map<ElementId, Move[]>;
  items: readonly string[];
}

/** One product step of a witness. */
export interface InterfaceStep {
  /** `-` for the opening, `A`/`B` for one side alone, `A!`/`B!` for an output taken together with the other's input. */
  who: '-' | 'A' | 'B' | 'A!' | 'B!';
  label: string;
  a: string;
  b: string;
}

export interface InterfaceFinding {
  kind: 'unspecified-reception' | 'deadlock';
  /** The item sent (unspecified reception only). */
  item?: string;
  /** The side that sent it (unspecified reception only). */
  sender?: 'A' | 'B';
  /** The components alone drive the run into it, whatever the environment does (it offers nothing). */
  forced?: boolean;
  witness: readonly InterfaceStep[];
}

export type InterfacePairOutcome =
  | { kind: 'no-verdict'; connection: ElementId; reason: string }
  | { kind: 'undecided'; connection: ElementId; a: string; b: string; reason: string }
  /**
   * Compatible in the de Alfaro-Henzinger sense: some environment (one that withholds the events in the traces) avoids every
   * unspecified reception. `findings` lists what a helpful environment can still reach (unforced receptions, deadlocks).
   */
  | { kind: 'compatible'; connection: ElementId; a: string; b: string; states: number; items: readonly string[]; findings: readonly InterfaceFinding[] }
  /** Incompatible: an unspecified reception is forced, so no environment avoids it (de Alfaro-Henzinger 2001). */
  | { kind: 'incompatible'; connection: ElementId; a: string; b: string; states: number; findings: readonly InterfaceFinding[] };

const nameOf = (model: Model, id: ElementId): string => model.qualifiedName(id) || model.get(id)?.declaredName || id;

class NoVerdict extends Error {}
function refuse(why: string): never {
  throw new NoVerdict(why);
}

/** The port ids a port usage stands for: itself and every port it redefines or subsets. */
function portChain(model: Model, id: ElementId): Set<ElementId> {
  const out = new Set<ElementId>([id]);
  for (const g of generalizationsOf(model, id)) if (g.eClass === 'PortUsage') out.add(g.id);
  return out;
}

function samePort(model: Model, a: ElementRecord, b: ElementRecord): boolean {
  return a.id === b.id || portChain(model, a.id).has(b.id) || portChain(model, b.id).has(a.id);
}

/** The single machine root of `owner` (its own or one it inherits), or a reason there is none. */
function machineOf(model: Model, owner: ElementRecord): ElementId {
  const roots = new Set<ElementId>();
  for (const el of [owner, ...generalizationsOf(model, owner.id).filter((g) => g.attrs.isLibrary !== true)]) {
    for (const m of stateMachinesIn(model, el.id)) roots.add(m.id);
  }
  if (roots.size === 0) return refuse(`\`${nameOf(model, owner.id)}\` holds no state machine`);
  if (roots.size > 1) return refuse(`\`${nameOf(model, owner.id)}\` holds more than one state machine`);
  return [...roots][0];
}

/** The port of `owner` a `via` name stands for, among the owner's effective port features. */
function resolvePort(model: Model, owner: ElementRecord, via: string, what: string): ElementRecord {
  if (/[.:]/.test(via)) return refuse(`${what} names its port as \`${via}\`, a path this reading does not resolve`);
  const hits = effectiveFeatures(model, owner.id).filter((f) => f.eClass === 'PortUsage' && f.declaredName === via);
  const distinct: ElementRecord[] = [];
  for (const h of hits) if (!distinct.some((d) => samePort(model, d, h))) distinct.push(h);
  if (distinct.length !== 1) {
    return refuse(`${what} names port \`${via}\`, which is ${distinct.length === 0 ? 'no port' : 'more than one port'} of \`${nameOf(model, owner.id)}\``);
  }
  return distinct[0];
}

/** The one directed feature of `port` a payload name stands for (its name, else its type's name). */
function itemOf(model: Model, port: ElementRecord, payload: string, what: string) {
  const feats = directedFeaturesOf(model, port.id);
  const exact = feats.filter((f) => f.name === payload);
  const pick = exact.length > 0 ? exact : feats.filter((f) => declaredDefinitions(model, f.el.id).some((d) => d.declaredName === payload));
  if (pick.length !== 1) {
    return refuse(`${what} carries \`${payload}\`, which is ${pick.length === 0 ? 'no' : 'more than one'} directed item of port \`${port.declaredName}\``);
  }
  return pick[0];
}

function readSide(model: Model, port: ElementRecord): Side {
  const owner = port.ownerId === null ? undefined : model.get(port.ownerId);
  if (owner === undefined) return refuse('a connected port has no owner');
  const machine = machineOf(model, owner);
  const label = `\`${nameOf(model, machine)}\``;
  const view = machineRegion(model, machine);
  if (view.refused !== undefined) return refuse(`${label}: ${view.refused.sentence}`);
  if (isParallelState(model, machine)) return refuse(`${label} is a parallel state`);
  const states = directStates(model, machine);
  for (const d of view.descendants) {
    if (d.id === machine) continue;
    if (d.eClass === 'SendActionUsage') return refuse(`${label} has a send in a state or its entry/do/exit action, which this reading does not attribute`);
    if (d.eClass === 'AcceptActionUsage') return refuse(`${label} has an accept action this reading does not read`);
    if (d.eClass === 'StateUsage' && !states.some((s) => s.id === d.id)) return refuse(`${label} has a nested state (\`${d.declaredName ?? d.id}\`)`);
  }
  for (const s of states) {
    if (isParallelState(model, s.id) || isHistoryComposite(model, s.id)) return refuse(`${label} has a parallel or history state`);
  }
  if (entryStartUnreadOf(model, view, states)) return refuse(`${label} opens in a state its entry action does not name plainly`);
  const start = initialStateOf(model, view, states);
  if (start === null) return refuse(`${label} has no opening state`);
  const stateIds = new Set(states.map((s) => s.id));
  const moves = new Map<ElementId, Move[]>(states.map((s) => [s.id, []]));
  for (const tr of view.transitions.filter((t) => t.eClass === 'TransitionUsage')) {
    const name = `transition \`${tr.declaredName ?? tr.id}\` of ${label}`;
    const from = tr.source?.[0];
    const to = tr.target?.[0];
    if (from === undefined || to === undefined || !stateIds.has(from) || !stateIds.has(to)) return refuse(`${name} does not join two direct states`);
    if (guardTextOf(tr) !== undefined) return refuse(`${name} has a guard, which this untimed, store-free reading does not decide`);
    if (timeTriggerLabel(tr) !== undefined) return refuse(`${name} is a dwell; this reading is untimed`);
    const trigger = typeof tr.attrs.trigger === 'string' && tr.attrs.trigger !== '' ? tr.attrs.trigger : undefined;
    const via = typeof tr.attrs.via === 'string' && tr.attrs.via !== '' ? tr.attrs.via : undefined;
    const sends = sendsOf(model, tr, name);
    let inItem: string | undefined;
    let inLabel = trigger ?? '';
    if (trigger !== undefined) {
      if (via !== undefined) {
        const p = resolvePort(model, owner, via, name);
        const f = itemOf(model, p, trigger, name);
        if (f.direction === 'inout') return refuse(`${name}: item \`${f.name}\` is inout`);
        if (f.direction !== 'in') return refuse(`${name} accepts \`${trigger}\` via \`${via}\`, where it is an out item`);
        if (samePort(model, p, port)) inItem = f.name;
        inLabel = `${trigger} via ${via}`;
      } else {
        const carried = effectiveFeatures(model, owner.id)
          .filter((p) => p.eClass === 'PortUsage')
          .some((p) => directedFeaturesOf(model, p.id).some((f) => f.name === trigger || declaredDefinitions(model, f.el.id).some((d) => d.declaredName === trigger)));
        if (carried) return refuse(`${name} accepts \`${trigger}\`, an item a port carries, without saying which port`);
      }
    }
    if (sends.length > 1) return refuse(`${name} sends more than once in its effect`);
    if (sends.length === 1) {
      const s = sends[0];
      const sv = typeof s.attrs.via === 'string' && s.attrs.via !== '' ? s.attrs.via : undefined;
      if (sv === undefined) return refuse(`${name} sends \`${s.declaredName}\` without a port`);
      const p = resolvePort(model, owner, sv, name);
      const f = itemOf(model, p, s.declaredName ?? '', name);
      if (f.direction === 'inout') return refuse(`${name}: item \`${f.name}\` is inout`);
      if (f.direction !== 'out') return refuse(`${name} sends \`${s.declaredName}\` via \`${sv}\`, where it is an in item`);
      if (inItem !== undefined) return refuse(`${name} accepts a connected item and sends in one transition`);
      const lab = `${trigger === undefined ? '' : `${inLabel} / `}send ${f.name} via ${sv}`;
      if (samePort(model, p, port)) moves.get(from)!.push({ kind: 'out', item: f.name, label: lab, to, triggered: trigger !== undefined });
      else moves.get(from)!.push({ kind: 'env', label: lab, to });
      continue;
    }
    if (inItem !== undefined) moves.get(from)!.push({ kind: 'in', item: inItem, label: `accept ${inLabel}`, to });
    else moves.get(from)!.push({ kind: trigger === undefined ? 'internal' : 'env', label: trigger === undefined ? 'completion' : inLabel, to });
  }
  const items = directedFeaturesOf(model, port.id).map((f) => {
    if (f.direction === 'inout') return refuse(`port \`${port.declaredName}\` carries inout item \`${f.name}\``);
    return f.name;
  });
  return { owner, start, moves, items };
}

/** The sends of the action a transition's effect performs; refuses an effect whose sends it cannot read. */
function sendsOf(model: Model, tr: ElementRecord, name: string): ElementRecord[] {
  const effect = typeof tr.attrs.effect === 'string' ? tr.attrs.effect.trim() : undefined;
  if (effect === undefined) return [];
  if (typeof tr.attrs.effectType === 'string') {
    const defs = actionsNamed(model, tr, tr.attrs.effectType);
    if (defs.length !== 1 || model.descendants(defs[0].id).length > 0) return refuse(`${name} has an effect typed by an action this reading does not open`);
    return [];
  }
  if (tr.attrs.effectRef !== true) return [];
  const hits = actionsNamed(model, tr, effect);
  if (hits.length !== 1) return refuse(`${name} performs \`${effect}\`, which is ${hits.length === 0 ? 'no action' : 'more than one action'} this reading can resolve`);
  const x = hits[0];
  if (model.relationshipsFrom(x.id).some((r) => ['FeatureTyping', 'Subsetting', 'Redefinition', 'Subclassification'].includes(r.eClass))) {
    return refuse(`${name} performs \`${effect}\`, an action defined elsewhere, whose sends this reading does not follow`);
  }
  const out: ElementRecord[] = [];
  for (const d of model.descendants(x.id)) {
    if (d.eClass === 'SendActionUsage') out.push(d);
    else if (['AcceptActionUsage', 'PerformActionUsage', 'ActionUsage'].includes(d.eClass)) {
      return refuse(`${name} performs \`${effect}\`, which holds a further action this reading does not follow`);
    }
  }
  return out;
}

interface Node {
  a: ElementId;
  b: ElementId;
  parent: number;
  step: InterfaceStep;
  /** Steps the components take on their own (internal, output): no environment choice stops them. */
  uncontrolled: number[];
}

/** Check one connection, or say why it is not judged. */
export function checkInterfacePair(model: Model, connectionId: ElementId, opts: { maxStates?: number } = {}): InterfacePairOutcome {
  const max = opts.maxStates ?? MAX_INTERFACE_STATES;
  const ends = connectorEndsOf(model, connectionId);
  const stop = (reason: string): InterfacePairOutcome => ({ kind: 'no-verdict', connection: connectionId, reason });
  if (ends.length !== 2) return stop(`the connection has ${ends.length} ends; only a binary connection is read`);
  const pa = model.get(ends[0]);
  const pb = model.get(ends[1]);
  if (pa?.eClass !== 'PortUsage' || pb?.eClass !== 'PortUsage') return stop('its ends are not both ports');
  if (pa.ownerId === pb.ownerId) return stop('both ports belong to one part');
  const mm = portMismatches(model, pa.id, pb.id);
  if (mm === undefined) return stop('the ports carry no directed item');
  if (mm.length > 0) return stop('the ports do not conform (§7.12.1), so which item meets which is not read');
  let A: Side;
  let B: Side;
  try {
    A = readSide(model, pa);
    B = readSide(model, pb);
  } catch (e) {
    if (e instanceof NoVerdict) return stop(e.message);
    throw e;
  }
  const an = nameOf(model, A.owner.id);
  const bn = nameOf(model, B.owner.id);
  const sn = (id: ElementId): string => model.get(id)?.declaredName ?? id;

  const nodes: Node[] = [{ a: A.start, b: B.start, parent: -1, step: { who: '-', label: 'open', a: sn(A.start), b: sn(B.start) }, uncontrolled: [] }];
  const index = new Map<string, number>([[`${A.start}|${B.start}`, 0]]);
  const add = (a: ElementId, b: ElementId, parent: number, who: InterfaceStep['who'], label: string): number => {
    const k = `${a}|${b}`;
    const hit = index.get(k);
    if (hit !== undefined) return hit;
    nodes.push({ a, b, parent, step: { who, label, a: sn(a), b: sn(b) }, uncontrolled: [] });
    index.set(k, nodes.length - 1);
    return nodes.length - 1;
  };
  type Bad = { item: string; sender: 'A' | 'B'; label: string; target: ElementId; triggered: boolean };
  const illegal = new Map<number, Bad[]>();
  const noStep: number[] = [];
  for (let head = 0; head < nodes.length; head++) {
    if (nodes.length > max) return { kind: 'undecided', connection: connectionId, a: an, b: bn, reason: `the product walk passed ${max} states` };
    const n = nodes[head];
    let enabled = 0;
    const bad: Bad[] = [];
    const side = (me: Side, other: Side, mine: ElementId, theirs: ElementId, who: 'A' | 'B'): void => {
      const pair = (x: ElementId, y: ElementId): [ElementId, ElementId] => (who === 'A' ? [x, y] : [y, x]);
      const peer = who === 'A' ? 'B' : 'A';
      for (const m of me.moves.get(mine)!) {
        if (m.kind === 'in') continue; // an input fires only together with the other's output
        if (m.kind === 'out') {
          const takers = other.moves.get(theirs)!.filter((o) => o.kind === 'in' && o.item === m.item);
          if (takers.length === 0) {
            bad.push({ item: m.item, sender: who, label: `${who}: ${m.label}; ${peer}: no transition accepting ${m.item}`, target: m.to, triggered: m.triggered === true });
            continue;
          }
          for (const t of takers) {
            const [na, nb] = pair(m.to, t.to);
            n.uncontrolled.push(add(na, nb, head, who === 'A' ? 'A!' : 'B!', `${who}: ${m.label}; ${peer}: ${t.label}`));
            enabled++;
          }
          continue;
        }
        const [na, nb] = pair(m.to, theirs);
        const k = add(na, nb, head, who, `${who}: ${m.label}`);
        if (m.kind === 'internal') n.uncontrolled.push(k);
        enabled++;
      }
    };
    side(A, B, n.a, n.b, 'A');
    side(B, A, n.b, n.a, 'B');
    if (bad.length > 0) illegal.set(head, bad);
    if (enabled === 0 && bad.length === 0 && !(isFinalState(model, n.a) && isFinalState(model, n.b))) noStep.push(head);
  }

  const witness = (at: number): InterfaceStep[] => {
    const chain: InterfaceStep[] = [];
    for (let k = at; k >= 0; k = nodes[k].parent) chain.push(nodes[k].step);
    return chain.reverse();
  };
  // forced: reached from the opening through steps the components take on their own (output and internal), with
  // the environment offering nothing, so no environment choice avoids it (de Alfaro-Henzinger incompatibility).
  const forcedSet = new Set<number>([0]);
  for (const q = [0]; q.length > 0; ) for (const k of nodes[q.shift()!].uncontrolled) if (!forcedSet.has(k)) (forcedSet.add(k), q.push(k));
  const findings: InterfaceFinding[] = [];
  for (const [i, list] of illegal) {
    for (const b of list) findings.push({
        kind: 'unspecified-reception',
        item: b.item,
        sender: b.sender,
        forced: forcedSet.has(i) && !b.triggered,
        witness: [...witness(i), { who: b.sender, label: b.label, a: nodes[i].step.a, b: nodes[i].step.b }],
      });
  }
  for (const i of noStep) findings.push({ kind: 'deadlock', forced: forcedSet.has(i), witness: witness(i) });
  // Coordinator fence (wave 14): only a FORCED unspecified reception makes the pair incompatible (de Alfaro-Henzinger: two
  // interfaces are compatible when some environment avoids every illegal state; the environment controls its own events, so an
  // illegal state reached only through them is avoided by withholding them). A deadlock is reported, never a verdict.
  if (!findings.some((f) => f.kind === 'unspecified-reception' && f.forced === true)) {
    return { kind: 'compatible', connection: connectionId, a: an, b: bn, states: nodes.length, items: [...new Set([...A.items, ...B.items])], findings };
  }
  return { kind: 'incompatible', connection: connectionId, a: an, b: bn, states: nodes.length, findings };
}

export interface InterfacesReport {
  pairs: readonly InterfacePairOutcome[];
}

/** Does the connection join a port of a part that holds machine `machineId`? */
function touches(model: Model, connectionId: ElementId, machineId: ElementId): boolean {
  for (const e of connectorEndsOf(model, connectionId)) {
    const owner = model.get(e)?.ownerId;
    const o = owner == null ? undefined : model.get(owner);
    if (o === undefined) continue;
    try {
      if (machineOf(model, o) === machineId) return true;
    } catch (err) {
      if (!(err instanceof NoVerdict)) throw err;
    }
  }
  return false;
}

/** Every connection whose ends are ports (those touching `machineId` when given), each judged or given its reason. */
export function interfacesReport(model: Model, opts: { maxStates?: number; machineId?: ElementId } = {}): InterfacesReport {
  const pairs: InterfacePairOutcome[] = [];
  for (const el of model.all()) {
    if (el.attrs.isLibrary === true || !isConnector(el)) continue;
    const ends = connectorEndsOf(model, el.id);
    if (ends.length < 2 || !ends.every((e) => model.get(e)?.eClass === 'PortUsage')) continue;
    if (opts.machineId !== undefined && !touches(model, el.id, opts.machineId)) continue;
    pairs.push(checkInterfacePair(model, el.id, opts));
  }
  return { pairs };
}

/** Plain-text lines of the report. */
export function interfacesLines(model: Model, r: InterfacesReport): string[] {
  const out: string[] = [];
  for (const p of r.pairs) {
    const c = nameOf(model, p.connection);
    if (p.kind === 'no-verdict') out.push(`${c}: no verdict, ${p.reason}`);
    else if (p.kind === 'undecided') out.push(`${c}: undecided for ${p.a} and ${p.b}, ${p.reason}`);
    else {
      if (p.kind === 'compatible') {
        out.push(
          `${c}: ${p.a} and ${p.b} are compatible over {${p.items.join(', ')}} (${p.states} product state(s): an environment exists that avoids every unspecified reception; ` +
            'synchronous rendezvous on the shared items, other labels from the environment, untimed)' +
            (p.findings.length > 0 ? `; ${p.findings.length} finding(s) a helpful environment can still reach:` : ', nothing reachable to report'),
        );
      } else {
        out.push(`${c}: ${p.a} and ${p.b} are NOT compatible: an unspecified reception is forced, no environment avoids it (${p.findings.length} finding(s) over ${p.states} product state(s))`);
      }
      for (const f of p.findings) {
        out.push(
          f.kind === 'unspecified-reception'
            ? `  unspecified reception: ${f.sender} can send ${f.item} where the other side has no transition accepting it${f.forced ? ' (forced: no environment choice avoids it)' : ' (reachable only when the environment offers the events in the trace)'}`
            : `  deadlock: no step is enabled and the machines are not both final${f.forced ? ' (reached with the environment offering nothing)' : ' (reachable when the environment offers the events in the trace)'}`,
        );
        for (const s of f.witness) out.push(`    ${s.who} ${s.label} -> (${s.a}, ${s.b})`);
      }
    }
  }
  if (out.length === 0) out.push('no port-to-port connection');
  return out;
}
