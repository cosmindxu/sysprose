/**
 * Unit tests for the pure SVG export ({@link svgFromDiagram} / {@link escapeXml}).
 *
 * These verify that a laid-out {@link DiagramGraph} renders to a standalone,
 * XML-escaped `<svg>` with each node in its correct SysML shape (use-case
 * ellipse, definition rounded-rect, decision diamond, state stadium, fork bar),
 * an edge connector between two nodes, a viewBox that encloses every node, and
 * node/edge counts matching the graph. Pure — no DOM, no React Flow.
 */

import { describe, expect, it } from 'vitest';
import { svgFromDiagram, escapeXml } from '@diagram/svg-export';
import type { DiagramGraph } from '@diagram/types';

/** A small mixed fixture exercising every shape family + escaping + edges. */
function fixture(): DiagramGraph {
  return {
    viewKind: 'general',
    nodes: [
      {
        id: 'uc',
        elementId: 'uc',
        kind: 'UseCaseUsage',
        label: 'Drive',
        data: { keyword: 'use case', name: 'Drive' },
        position: { x: 0, y: 0 },
        size: { w: 120, h: 60 },
      },
      {
        id: 'def',
        elementId: 'def',
        kind: 'PartDefinition',
        label: 'Vehicle & <Cargo>',
        data: { keyword: 'part def', name: 'Vehicle & <Cargo>' },
        position: { x: 200, y: 0 },
        size: { w: 160, h: 80 },
      },
      {
        id: 'dec',
        elementId: 'dec',
        kind: 'DecisionNode',
        label: '',
        data: {},
        position: { x: 200, y: 200 },
        size: { w: 26, h: 26 },
      },
      {
        id: 'st',
        elementId: 'st',
        kind: 'StateUsage',
        label: 'Idle',
        data: { keyword: 'state', name: 'Idle' },
        position: { x: 0, y: 200 },
        size: { w: 100, h: 50 },
      },
      {
        id: 'fork',
        elementId: 'fork',
        kind: 'ForkNode',
        label: '',
        data: {},
        position: { x: 400, y: 200 },
        size: { w: 48, h: 8 },
      },
    ],
    edges: [
      { id: 'e1', elementId: 'r1', source: 'uc', target: 'def', kind: 'dependency' },
      { id: 'e2', elementId: 'r2', source: 'def', target: 'dec', kind: 'satisfy' },
    ],
  };
}

describe('escapeXml', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXml('a & b < c > d " e \' f')).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &apos; f',
    );
  });
  it('leaves guillemets and ordinary text untouched', () => {
    expect(escapeXml('«part def» Vehicle')).toBe('«part def» Vehicle');
  });
});

describe('svgFromDiagram — structure', () => {
  it('emits a standalone <svg> with the SVG namespace', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('declares node/edge counts matching the graph', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg).toContain('data-node-count="5"');
    expect(svg).toContain('data-edge-count="2"');
    expect(svg).toContain('data-view="general"');
  });

  it('includes a viewBox enclosing every node (with padding)', () => {
    const svg = svgFromDiagram(fixture()); // default padding 24
    // Nodes span x:[0,448], y:[0,250]; padded by 24 on each side.
    expect(svg).toContain('viewBox="-24 -24 496 298"');
    expect(svg).toContain('width="496"');
    expect(svg).toContain('height="298"');
  });
});

describe('svgFromDiagram — node shapes', () => {
  it('draws a use case as an <ellipse>', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg).toContain('<ellipse');
    // Centre of the 120x60 use-case box at (0,0): (60, 30).
    expect(svg).toContain('cx="60"');
    expect(svg).toContain('ry="30"');
  });

  it('draws a definition as a rounded <rect>', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg).toContain('<rect');
    expect(svg).toContain('rx="4"');
    expect(svg).toContain('data-shape="roundrect"');
  });

  it('draws a decision node as a diamond <polygon> with four vertices', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg).toContain('<polygon');
    // Diamond of the 26x26 box at (200,200): centre (213,213).
    expect(svg).toContain('points="213,200 226,213 213,226 200,213"');
  });

  it('draws a state as a stadium (pill rect, rx = half the short side)', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg).toContain('data-shape="stadium"');
    // 100x50 state → rx = min(100,50)/2 = 25.
    expect(svg).toContain('rx="25"');
  });

  it('draws a fork as a filled bar', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg).toContain('data-shape="bar"');
    // The bar is drawn filled with the control ink.
    expect(svg).toContain('fill="#2d3748"');
  });
});

describe('svgFromDiagram — text + escaping', () => {
  it('renders the «keyword» and name inside a node', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg).toContain('«use case»');
    expect(svg).toContain('>Drive<');
  });

  it('XML-escapes a name containing & and <', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg).toContain('Vehicle &amp; &lt;Cargo&gt;');
    // The raw, unescaped form must never leak into the markup.
    expect(svg).not.toContain('<Cargo>');
    expect(svg).not.toContain('Vehicle & <Cargo>');
  });
});

describe('svgFromDiagram — edges', () => {
  it('draws one connector path per edge, between the two nodes', () => {
    const svg = svgFromDiagram(fixture());
    const paths = svg.match(/data-edge-id="/g) ?? [];
    expect(paths.length).toBe(2);
    expect(svg).toContain('data-edge-id="e1"');
    expect(svg).toContain('data-edge-id="e2"');
    // A straight move/line command connects the endpoints.
    expect(svg).toMatch(/d="M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+"/);
  });

  it('styles the dependency family dashed with an open arrowhead + «keyword» label', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg).toContain('stroke-dasharray="6 4"');
    expect(svg).toContain('marker-end="url(#sysml-open-arrow)"');
    // satisfy edge carries no explicit label → falls back to its «satisfy» keyword.
    expect(svg).toContain('«satisfy»');
  });

  it('includes the SysML marker <defs>', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg).toContain('<defs>');
    expect(svg).toContain('id="sysml-arrow"');
    expect(svg).toContain('id="sysml-open-arrow"');
  });
});

describe('svgFromDiagram — determinism + edge cases', () => {
  it('is deterministic (identical output for identical input)', () => {
    expect(svgFromDiagram(fixture())).toBe(svgFromDiagram(fixture()));
  });

  it('renders an empty graph as a valid <svg> with a unit viewBox', () => {
    const svg = svgFromDiagram({ nodes: [], edges: [], viewKind: 'general' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('data-node-count="0"');
    expect(svg).toContain('data-edge-count="0"');
    expect(svg).toContain('viewBox="');
  });
});
