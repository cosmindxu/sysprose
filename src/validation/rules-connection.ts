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
import { connectorEndsOf } from '../semantics/connectors';
import { generalizationsOf } from '../semantics/inheritance';
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

interface PortFacets {
  el: ElementRecord;
  /** Declared on the end or inherited from its prototype; undefined if never declared. */
  direction?: string;
  /** Net conjugation: conjugating twice cancels. */
  conjugated: boolean;
  /** Every PortDefinition in the end's generalization closure. */
  defs: ElementRecord[];
}

/** What a connector end tells us once its prototype chain is followed. */
function portFacets(model: Model, id: ElementId): PortFacets | undefined {
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

      // (b) Type — both ends resolved, and no PortDefinition in common.
      if (a.defs.length > 0 && b.defs.length > 0) {
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
