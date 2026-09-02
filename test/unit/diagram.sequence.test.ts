/**
 * Unit tests for the sequence-diagram builder & renderer.
 *
 * Covers {@link buildSequence} lifeline extraction (dedup + stable order),
 * ordered message derivation from transfer (SuccessionFlow) edges, the
 * fallback to plain Successions when no transfers exist, rootId scoping, and
 * the {@link SequenceView} SVG component (data-testid, lifelines, messages,
 * selection).
 */

import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';
import { Model, ModelFactory } from '@core/index';
import { buildSequence, SequenceView } from '@diagram/index';

/** A model whose actions exchange named SuccessionFlow messages a→b→c→a. */
function flowModel(): { m: Model; a: string; b: string; c: string } {
  const m = new Model();
  const f = new ModelFactory(m);
  const pkg = f.pkg('Interaction');
  const a = f.action('a', pkg.id);
  const b = f.action('b', pkg.id);
  const c = f.action('c', pkg.id);
  m.create('SuccessionFlow', { declaredName: 'req', ownerId: pkg.id, source: [a.id], target: [b.id] });
  m.create('SuccessionFlow', { declaredName: 'ack', ownerId: pkg.id, source: [b.id], target: [c.id] });
  m.create('SuccessionFlow', { declaredName: 'done', ownerId: pkg.id, source: [c.id], target: [a.id] });
  return { m, a: a.id, b: b.id, c: c.id };
}

describe('buildSequence — from transfer (SuccessionFlow) messages', () => {
  const { m, a, b, c } = flowModel();
  const seq = buildSequence(m);

  it('extracts lifelines in first-appearance order, deduplicated', () => {
    expect(seq.lifelines.map((l) => l.label)).toEqual(['a', 'b', 'c']);
    expect(seq.lifelines.map((l) => l.id)).toEqual([a, b, c]);
    expect(seq.lifelines[0].elementId).toBe(a);
  });

  it('produces one ordered message per flow with incrementing order', () => {
    expect(seq.messages).toHaveLength(3);
    const orders = seq.messages.map((msg) => msg.order);
    expect(orders).toEqual([...orders].sort((x, y) => x - y));
    expect(new Set(orders).size).toBe(3);
  });

  it('maps message endpoints to lifeline ids and labels from element name', () => {
    const first = seq.messages[0];
    expect(first.fromLifeline).toBe(a);
    expect(first.toLifeline).toBe(b);
    expect(first.label).toBe('req');
    expect(first.elementId).toBeTruthy();
    expect(seq.messages[1].label).toBe('ack');
    expect(seq.messages[2].fromLifeline).toBe(c);
    expect(seq.messages[2].toLifeline).toBe(a);
    // Every endpoint is a known lifeline.
    const known = new Set(seq.lifelines.map((l) => l.id));
    for (const msg of seq.messages) {
      expect(known.has(msg.fromLifeline)).toBe(true);
      expect(known.has(msg.toLifeline)).toBe(true);
    }
  });
});

describe('buildSequence — fallback to Successions & scoping', () => {
  it('derives messages from plain successions when no transfers exist', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const pkg = f.pkg('Flow');
    const x = f.action('x', pkg.id);
    const y = f.action('y', pkg.id);
    const z = f.action('z', pkg.id);
    f.succession(x.id, y.id, pkg.id);
    f.succession(y.id, z.id, pkg.id);
    const seq = buildSequence(m);
    expect(seq.lifelines.map((l) => l.label)).toEqual(['x', 'y', 'z']);
    expect(seq.messages).toHaveLength(2);
    expect(seq.messages[0].fromLifeline).toBe(x.id);
    expect(seq.messages[0].toLifeline).toBe(y.id);
    expect(seq.messages[1].order).toBeGreaterThan(seq.messages[0].order);
    // Unnamed successions carry no label.
    expect(seq.messages[0].label).toBeUndefined();
  });

  it('scopes to the rootId subtree, ignoring out-of-scope interactions', () => {
    const m = new Model();
    const f = new ModelFactory(m);
    const inPkg = f.pkg('In');
    const p = f.action('p', inPkg.id);
    const q = f.action('q', inPkg.id);
    m.create('SuccessionFlow', { declaredName: 'm1', ownerId: inPkg.id, source: [p.id], target: [q.id] });
    const outPkg = f.pkg('Out');
    const r = f.action('r', outPkg.id);
    const s = f.action('s', outPkg.id);
    m.create('SuccessionFlow', { declaredName: 'm2', ownerId: outPkg.id, source: [r.id], target: [s.id] });

    const scoped = buildSequence(m, inPkg.id);
    expect(scoped.lifelines.map((l) => l.label)).toEqual(['p', 'q']);
    expect(scoped.messages).toHaveLength(1);
    expect(scoped.messages[0].label).toBe('m1');
  });
});

describe('SequenceView — SVG rendering', () => {
  const { m, a } = flowModel();
  const seq = buildSequence(m);

  it('renders a rooted svg with a lifeline and message per element', () => {
    const { getByTestId, getAllByTestId } = render(React.createElement(SequenceView, { sequence: seq }));
    expect(getByTestId('sequence-view')).toBeInTheDocument();
    expect(getAllByTestId('sequence-lifeline')).toHaveLength(3);
    expect(getAllByTestId('sequence-message')).toHaveLength(3);
  });

  it('reports the lifeline element id when a header is clicked', () => {
    const onSelect = vi.fn();
    const { getAllByTestId } = render(React.createElement(SequenceView, { sequence: seq, onSelect }));
    const rect = getAllByTestId('sequence-lifeline')[0].querySelector('rect')!;
    fireEvent.click(rect);
    expect(onSelect).toHaveBeenCalledWith(a);
  });

  it('reports the message element id when a message is clicked', () => {
    const onSelect = vi.fn();
    const { getAllByTestId } = render(React.createElement(SequenceView, { sequence: seq, onSelect }));
    const msg = getAllByTestId('sequence-message')[0];
    fireEvent.click(msg);
    expect(onSelect).toHaveBeenCalledWith(msg.getAttribute('data-element-id'));
  });
});
