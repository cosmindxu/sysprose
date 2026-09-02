/**
 * Unit tests for the enriched SysML symbol set exposed by the renderer maps:
 * edge markers/line-styles (edgeStyleFor + MARKER) and node shapes/variants
 * (controlShapeFor + nodeVariantFor). These are pure resolvers so the symbol
 * set is verifiable without a React Flow render context.
 */

import { describe, expect, it } from 'vitest';
import { edgeStyleFor, MARKER, edgeTypes } from '@diagram/edges';
import { controlShapeFor, nodeVariantFor, nodeTypes, portOffsetPercent } from '@diagram/nodes';

describe('edge symbol set — markers & line styles by kind', () => {
  it('composition/aggregation carry a diamond at the source (whole) end', () => {
    expect(edgeStyleFor('composite').markerStart).toBe(MARKER.composite);
    expect(edgeStyleFor('composition').markerStart).toBe(MARKER.composite);
    expect(edgeStyleFor('reference').markerStart).toBe(MARKER.reference);
  });

  it('specialization family uses a hollow triangle at the target (general) end', () => {
    for (const k of ['specialize', 'subclassification', 'subsetting', 'redefinition']) {
      const s = edgeStyleFor(k);
      expect(s.markerEnd).toBe(MARKER.specialize);
      expect(s.dashed).toBeFalsy();
    }
    // Feature typing: hollow triangle but a dashed line (SysML notation).
    const typed = edgeStyleFor('typed-by');
    expect(typed.markerEnd).toBe(MARKER.specialize);
    expect(typed.dashed).toBe(true);
  });

  it('the dependency family is dashed + open arrow with a «keyword» label', () => {
    const cases: Array<[string, string]> = [
      ['satisfy', 'satisfy'],
      ['allocate', 'allocate'],
      ['derive', 'derive'],
      ['refine', 'refine'],
      ['trace', 'trace'],
      ['dependency', 'dependency'],
    ];
    for (const [kind, keyword] of cases) {
      const s = edgeStyleFor(kind);
      expect(s.dashed).toBe(true);
      expect(s.markerEnd).toBe(MARKER.open);
      expect(s.keyword).toBe(keyword);
    }
  });

  it('succession/transition/flow/bind/containment are solid arrows', () => {
    for (const k of ['succession', 'transition', 'flow', 'bind', 'containment']) {
      const s = edgeStyleFor(k);
      expect(s.markerEnd).toBe(MARKER.arrow);
      expect(s.dashed).toBeFalsy();
    }
  });

  it('still exposes the data-driven sysml edge type', () => {
    expect(edgeTypes.sysml).toBeTypeOf('function');
  });
});

describe('node symbol set — control shapes & box variants', () => {
  it('maps control-node metaclasses to their flow symbols', () => {
    expect(controlShapeFor('ForkNode')).toBe('bar');
    expect(controlShapeFor('JoinNode')).toBe('bar');
    expect(controlShapeFor('DecisionNode')).toBe('diamond');
    expect(controlShapeFor('MergeNode')).toBe('diamond');
    expect(controlShapeFor('InitialNode')).toBe('initial');
    expect(controlShapeFor('DoneNode')).toBe('final');
    expect(controlShapeFor('ActionUsage')).toBe('node');
  });

  it('distinguishes constraint and requirement boxes', () => {
    expect(nodeVariantFor('ConstraintUsage')).toBe('constraint');
    expect(nodeVariantFor('ConstraintDefinition')).toBe('constraint');
    expect(nodeVariantFor('CalculationUsage')).toBe('constraint');
    expect(nodeVariantFor('RequirementUsage')).toBe('requirement');
    expect(nodeVariantFor('RequirementDefinition')).toBe('requirement');
    expect(nodeVariantFor('PartUsage')).toBe('default');
    // A node flagged as a constraint parameter host via data.
    expect(nodeVariantFor('PartUsage', { isConstraint: true })).toBe('constraint');
  });

  it('still exposes the sysml + control node types', () => {
    // React.memo-wrapped (H5): memo returns an exotic component object, not a
    // bare function.
    expect(nodeTypes.sysml).toBeTruthy();
    expect(nodeTypes.control).toBeTruthy();
  });
});

describe('boundary-port handle distribution', () => {
  /**
   * Regression guard: ports on the same side used to render at one point, so
   * three inputs landed on the same pixel and their connectors fanned into it.
   * Confirmed by a Fable advisor, 2026-09-02 — the layout engine distributed
   * them correctly and only the rendering collapsed them.
   */
  it('spreads N ports evenly along a side, never stacking them', () => {
    const three = [0, 1, 2].map((i) => portOffsetPercent(i, 3));
    expect(three).toEqual(['25%', '50%', '75%']);
    expect(new Set(three).size, 'no two ports may share a position').toBe(3);
  });

  it('centres a lone port', () => {
    expect(portOffsetPercent(0, 1)).toBe('50%');
  });

  it('stays inside the node edge for any count', () => {
    for (const n of [1, 2, 5, 12]) {
      for (let i = 0; i < n; i++) {
        const pct = Number.parseFloat(portOffsetPercent(i, n));
        expect(pct).toBeGreaterThan(0);
        expect(pct).toBeLessThan(100);
      }
    }
  });

  it('degrades safely on nonsense input rather than producing NaN%', () => {
    expect(portOffsetPercent(0, 0)).toBe('50%');
    expect(portOffsetPercent(-1, 3)).toBe('25%');
    expect(portOffsetPercent(99, 3)).toBe('75%');
  });
});
