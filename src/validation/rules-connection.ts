/**
 * `connection-compatibility` — do the two ends of a connection agree?
 *
 * WHY. Only `port-direction` existed, and it checks that a direction is
 * DECLARED. `connect battery.powerOut to flightComputer.motorOut` (out→out) and
 * a PowerPort wired to a DataPort both passed silently. Confirmed by execution,
 * Fable advisory 2026-09-02.
 *
 * WHAT THE ENDS ARE. After the feature-chain pass, `source[0]`/`target[0]` of a
 * connector are the IMPLICIT per-usage port copies (`ensureImplicitFeature`),
 * which carry `direction` but neither the port type nor conjugation; those live
 * on the prototype and are reached through `generalizationsOf` (Redefinition →
 * prototype → FeatureTyping). Two consequences shape this rule:
 *  - findings are anchored on the CONNECTOR, never on an end — `validate()`
 *    drops any diagnostic anchored on an implicit element;
 *  - the type check compares PortDefinition CLOSURES and flags only when they
 *    are disjoint, so a specialised port def still matches its ancestor, and
 *    `T` ↔ `~T` (the canonical compatible pair, same FeatureTyping target) is
 *    never flagged.
 *
 * SEVERITY. Warning. SysML v2 does not forbid out→out at the language level —
 * a Connector relates features, and complementarity is what interfaces and
 * conjugated ports EXPRESS, as a modelling choice. Flagging it as an error
 * would make legal models fail `isValid()`. `--strict` promotes it.
 *
 * Lives in its own module so it can be tested and reviewed on its own; the
 * registry in `rules.ts` lists it.
 */

import type { ElementId, ElementRecord, Model } from '@core/index';
import { connectorEndsOf, payloadOf } from '../semantics/connectors';
import { generalizationsOf } from '../semantics/inheritance';
import {
  declaredDefinitions,
  effectiveDirection,
  endMismatches,
  payloadDefinition,
  portConjugated,
  portMismatches,
} from '../semantics/port-conformance';
import type { Diagnostic, ValidationRule } from './types';

const CONNECTOR_KINDS = new Set(['ConnectionUsage', 'InterfaceUsage', 'Connector']);

function qualifiedLabel(model: Model, el: ElementRecord): string {
  const parts: string[] = [];
  const visited = new Set<string>();
  let cur: ElementRecord | undefined = el;
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    parts.unshift(cur.declaredName ?? cur.declaredShortName ?? `«${cur.eClass}»`);
    cur = cur.ownerId !== null ? model.get(cur.ownerId) : undefined;
  }
  return parts.join('::');
}

/**
 * What a connector end tells us once its prototype chain is followed.
 *
 * Exported with {@link portFacets} because it is the ONE correct reading of a
 * port's direction in this tree, and a second reading is how two commands come
 * to disagree about what an `in` port is: `attrs.direction` alone misses the
 * direction a usage inherits from its prototype and misses conjugation
 * entirely, so `~PowerPort` reads as its own opposite. The signature census in
 * `src/api/analytics.ts` asks the same question for the opposite reason — it
 * counts imports and exports rather than judging a pair — and it asks it here.
 */
export interface PortFacets {
  el: ElementRecord;
  /** Declared on the end or inherited from its prototype; undefined if never declared. */
  direction?: string;
  /** Net conjugation: conjugating twice cancels. */
  conjugated: boolean;
  /** Every PortDefinition in the end's generalization closure. */
  defs: ElementRecord[];
}

/** The facets of the port `id` names, or `undefined` when it names no port. */
export function portFacets(model: Model, id: ElementId): PortFacets | undefined {
  const el = model.get(id);
  if (!el || el.eClass !== 'PortUsage') return undefined;
  let direction = typeof el.attrs.direction === 'string' ? el.attrs.direction : undefined;
  let conjugated = el.attrs.conjugated === true;
  const closure = generalizationsOf(model, id);
  for (const g of closure) {
    if (direction === undefined && typeof g.attrs.direction === 'string') direction = g.attrs.direction;
    if (g.attrs.conjugated === true) conjugated = !conjugated;
  }
  return { el, direction, conjugated, defs: closure.filter((g) => g.eClass === 'PortDefinition') };
}

export const connectionCompatibility: ValidationRule = {
  id: 'connection-compatibility',
  description: 'Connection ends are both `out` / both `in`, or carry unrelated port types.',
  severity: 'warning',
  run(model) {
    let n = 0;
    const mk = (message: string, elementId: string): Diagnostic => ({
      id: `connection-compatibility#${n++}`,
      ruleId: 'connection-compatibility',
      severity: 'warning',
      message,
      elementId,
    });
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (el.attrs.isLibrary === true) continue;
      if (!CONNECTOR_KINDS.has(el.eClass)) continue;
      const ends = connectorEndsOf(model, el.id);
      if (ends.length !== 2) continue; // `connector-endpoints` owns that case
      const a = portFacets(model, ends[0]);
      const b = portFacets(model, ends[1]);
      if (!a || !b) continue; // not port-to-port: no judgement
      const name = qualifiedLabel(model, el);

      // (a) Direction — only when BOTH are declared (a missing one is
      //     port-direction's finding), neither is inout, and conjugation is the
      //     same on both sides (conjugating one side flips its directions).
      if (
        a.direction !== undefined &&
        b.direction !== undefined &&
        a.direction !== 'inout' &&
        b.direction !== 'inout' &&
        a.direction === b.direction &&
        a.conjugated === b.conjugated
      ) {
        out.push(
          mk(
            `Connection "${name}" joins two \`${a.direction}\` ports (${qualifiedLabel(model, a.el)} and ${qualifiedLabel(model, b.el)}); one end is normally \`in\` and the other \`out\`.`,
            el.id,
          ),
        );
      }

      // (b) Conformance. Where either port has DIRECTED features, the
      //     question is §7.12.1's: every directed feature of each port needs a
      //     feature of a conforming definition with the conjugate direction on
      //     the other (structural, so two port definitions with matching
      //     features conform, and `T` to `T` with `out` features does not).
      //     Where neither has one, it stays nominal: a port definition in common.
      const mismatches = portMismatches(model, ends[0], ends[1]);
      if (mismatches !== undefined) {
        if (mismatches.length > 0) {
          const first = mismatches[0];
          const f = `\`${first.feature.direction} ${first.feature.name}${typeSuffix(model, first.feature.el.id)}\``;
          const where = qualifiedLabel(model, model.get(first.port) ?? first.feature.el);
          const otherPort = first.port === ends[0] ? b.el : a.el;
          const why =
            first.reason === 'direction' && first.other
              ? `${f} of ${where} meets \`${first.other.direction} ${first.other.name}\` on ${qualifiedLabel(model, otherPort)}, which is not its conjugate (in↔out, inout↔inout)`
              : `${f} of ${where} has no feature of a conforming definition on ${qualifiedLabel(model, otherPort)}`;
          const more = mismatches.length > 1 ? ` (${mismatches.length - 1} more unmatched feature${mismatches.length > 2 ? 's' : ''})` : '';
          out.push(mk(`Connection "${name}" joins ports that do not conform (SysML v2 §7.12.1): ${why}${more}.`, el.id));
        }
      } else if (a.defs.length > 0 && b.defs.length > 0) {
        const shared = a.defs.some((x) => b.defs.some((y) => y.id === x.id));
        if (!shared) {
          const nameOf = (defs: ElementRecord[]) => defs.map((d) => d.declaredName ?? `«${d.eClass}»`).join('/');
          out.push(
            mk(
              `Connection "${name}" joins ${qualifiedLabel(model, a.el)} : ${nameOf(a.defs)} to ${qualifiedLabel(model, b.el)} : ${nameOf(b.defs)}, which share no port definition.`,
              el.id,
            ),
          );
        }
      }
    }
    return out;
  },
};

/** ` : Def` for a feature with a declared definition, '' otherwise. */
function typeSuffix(model: Model, id: ElementId): string {
  const defs = declaredDefinitions(model, id);
  return defs.length > 0 ? ` : ${defs.map((d) => d.declaredName ?? `«${d.eClass}»`).join(', ')}` : '';
}

function defNames(defs: ElementRecord[], conjugated = false): string {
  return defs.map((d) => `${conjugated && d.eClass === 'PortDefinition' ? '~' : ''}${d.declaredName ?? `«${d.eClass}»`}`).join(', ');
}

/**
 * `interface-end-conformance` — does each related feature of a connection typed
 * by a connection or interface definition conform to the end it redefines?
 *
 * KerML §7.4.6.1: a connector end redefines the end of the association typing
 * the connector, and its links relate only things classified by that end's
 * type. A related port of another definition, or with the opposite
 * conjugation, does not conform. It is a warning, not an error: classifiers are
 * not disjoint, so the model is not contradictory, but the interface no longer
 * says what is exchanged across it. Ends pair by the end name written in the
 * connection (`connect sender ::> a.p to …`), else by position.
 */
export const interfaceEndConformance: ValidationRule = {
  id: 'interface-end-conformance',
  description: 'A connection end does not conform to the end of the connection or interface definition that types it.',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (el.attrs.isLibrary === true || !CONNECTOR_KINDS.has(el.eClass)) continue;
      for (const m of endMismatches(model, el.id)) {
        const rel = model.get(m.related);
        if (!rel) continue;
        const endText = `\`${m.end.declaredName ?? '«end»'} : ${defNames(m.required, portConjugated(model, m.end.id))}\``;
        const relText = `${qualifiedLabel(model, rel)} : ${defNames(m.actual, rel.eClass === 'PortUsage' && portConjugated(model, rel.id))}`;
        const why =
          m.reason === 'conjugation'
            ? `the end and the port it relates are conjugated differently, so the directions of the port's features are reversed with respect to the end (§7.12.3)`
            : `which ${defNames(m.actual)} does not specialise, so the connection can only link something that is both (KerML §7.4.6)`;
        out.push({
          id: `interface-end-conformance#${n++}`,
          ruleId: 'interface-end-conformance',
          severity: 'warning',
          message: `Connection "${qualifiedLabel(model, el)}" relates ${relText} through its end ${endText}${m.reason === 'conjugation' ? ': ' : ', '}${why}.`,
          elementId: el.id,
        });
      }
    }
    return out;
  },
};

/**
 * `flow-end-compatibility` — does a flow's payload conform to the features it
 * flows between, and does it flow from an output to an input?
 *
 * §7.16: a streaming flow takes its payload from an output feature of its
 * source and delivers it to an input feature of its target; §7.12.1: a
 * transfer between ports goes from `out` features to matching `in` features.
 * Directions are read through the conjugation of the ports the end is reached
 * through ({@link effectiveDirection}). A payload that does not resolve, or an
 * untyped end, gives no finding.
 */
export const flowEndCompatibility: ValidationRule = {
  id: 'flow-end-compatibility',
  description: 'A flow payload does not conform to its end features, or a flow runs from an input or into an output.',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    const mk = (message: string, elementId: ElementId): Diagnostic => ({
      id: `flow-end-compatibility#${n++}`,
      ruleId: 'flow-end-compatibility',
      severity: 'warning',
      message,
      elementId,
    });
    for (const el of model.all()) {
      if (el.attrs.isLibrary === true) continue;
      if (el.eClass !== 'Flow' && el.eClass !== 'FlowUsage' && el.eClass !== 'SuccessionFlowUsage') continue;
      const src = el.source?.[0];
      const tgt = el.target?.[0];
      const name = qualifiedLabel(model, el);
      const payload = payloadOf(el);
      const pdef = payload ? payloadDefinition(model, el.id, payload) : undefined;
      if (pdef) {
        for (const [end, role] of [
          [src, 'source'],
          [tgt, 'target'],
        ] as const) {
          if (end === undefined) continue;
          const defs = declaredDefinitions(model, end);
          if (defs.length === 0) continue;
          const conforms = defs.some(
            (d) =>
              d.id === pdef.id ||
              generalizationsOf(model, d.id).some((g) => g.id === pdef.id) ||
              generalizationsOf(model, pdef.id).some((g) => g.id === d.id),
          );
          if (!conforms) {
            const endEl = model.get(end);
            out.push(
              mk(
                `Flow "${name}" carries ${pdef.declaredName ?? payload} but its ${role} ${endEl ? qualifiedLabel(model, endEl) : end} is ${defNames(defs)}, and neither specialises the other (SysML v2 §7.16).`,
                el.id,
              ),
            );
          }
        }
      }
      const owned = (id: ElementId | undefined) => {
        const e = id ? model.get(id) : undefined;
        return e !== undefined && e.ownerId !== null && model.get(e.ownerId)?.eClass === 'PortUsage';
      };
      // Only an end reached through a port is judged: an action parameter's
      // direction is relative to the action, and a flow between actions at the
      // same level is out-to-in by the same reading, but a flow into a nested
      // action's parameter from its owner's parameter runs in-to-in legally.
      if (src !== undefined && owned(src) && effectiveDirection(model, src) === 'in') {
        out.push(mk(`Flow "${name}" takes its payload from ${qualifiedLabel(model, model.get(src)!)}, an \`in\` feature of its port; a flow's source is an output (§7.12.1, §7.16).`, el.id));
      }
      if (tgt !== undefined && owned(tgt) && effectiveDirection(model, tgt) === 'out') {
        out.push(mk(`Flow "${name}" delivers its payload to ${qualifiedLabel(model, model.get(tgt)!)}, an \`out\` feature of its port; a flow's target is an input (§7.12.1, §7.16).`, el.id));
      }
    }
    return out;
  },
};

/**
 * `port-typing` — §7.12.2: "A port usage must only be defined by port
 * definitions." A port typed by an item, part or attribute definition says what
 * passes but not as a port: it has no conjugate, and its features are the
 * item's, not directed features of a port. A warning while models that write
 * this form are brought to the spec's.
 */
export const portTyping: ValidationRule = {
  id: 'port-typing',
  description: 'A port usage is typed by a definition that is not a port definition.',
  severity: 'warning',
  run(model) {
    let n = 0;
    const out: Diagnostic[] = [];
    for (const el of model.all()) {
      if (el.attrs.isLibrary === true || el.attrs.implicit === true || el.eClass !== 'PortUsage') continue;
      const defs = declaredDefinitions(model, el.id).filter((d) => d.attrs.isLibrary !== true);
      const wrong = defs.filter((d) => d.eClass !== 'PortDefinition');
      if (wrong.length === 0) continue;
      out.push({
        id: `port-typing#${n++}`,
        ruleId: 'port-typing',
        severity: 'warning',
        message: `Port "${qualifiedLabel(model, el)}" is typed by ${wrong.map((d) => `${d.declaredName ?? '«def»'} (${d.eClass})`).join(', ')}; a port usage is defined only by port definitions (SysML v2 §7.12.2).`,
        elementId: el.id,
      });
    }
    return out;
  },
};
