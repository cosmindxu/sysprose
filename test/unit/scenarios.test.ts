import { describe, it, expect } from 'vitest';
import { diffScenarios } from '../../src/ui/panels/RegroupScenarios';
import type { RegroupConfig } from '@diagram/index';

const cfg = (
  membership: Record<string, string>,
  bundles: { id: string; label: string }[],
): RegroupConfig =>
  ({
    partKind: 'PartUsage',
    portLabels: {},
    membership,
    bundles: bundles.map((b) => ({ ...b, isNew: true })),
  }) as RegroupConfig;

describe('diffScenarios — what-if membership diff', () => {
  it('reports parts that moved between bundles (and un/newly-assigned)', () => {
    const a = cfg({ p1: 'b1', p2: 'b1' }, [{ id: 'b1', label: 'B1' }]);
    const b = cfg({ p1: 'b1', p2: 'b2', p3: 'b2' }, [
      { id: 'b1', label: 'B1' },
      { id: 'b2', label: 'B2' },
    ]);
    // p1 unchanged; p2 moved B1→B2; p3 newly assigned (—→B2).
    expect(diffScenarios(a, b, (id) => id)).toEqual([
      { partId: 'p2', from: 'B1', to: 'B2' },
      { partId: 'p3', from: '—', to: 'B2' },
    ]);
  });

  it('is empty for identical assignments (regardless of extra bundles)', () => {
    const a = cfg({ p1: 'b1' }, [{ id: 'b1', label: 'B1' }]);
    const b = cfg({ p1: 'b1' }, [
      { id: 'b1', label: 'B1' },
      { id: 'b2', label: 'Unused' },
    ]);
    expect(diffScenarios(a, b, (id) => id)).toEqual([]);
  });

  it('shows a removal as bundle→— ', () => {
    const a = cfg({ p1: 'b1' }, [{ id: 'b1', label: 'B1' }]);
    const b = cfg({}, [{ id: 'b1', label: 'B1' }]);
    expect(diffScenarios(a, b, (id) => id)).toEqual([{ partId: 'p1', from: 'B1', to: '—' }]);
  });
});
