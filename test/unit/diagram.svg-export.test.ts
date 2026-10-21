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

describe('svgFromDiagram — column headers', () => {
  const withColumns = (): DiagramGraph => ({
    ...fixture(),
    columns: [
      { id: 'c1', elementId: 'pkg1', label: 'OA & <SA>', x: 0, y: -40, w: 360, h: 32, bottom: 300, fontSize: 18 },
      { id: 'c2', elementId: 'pkg2', label: 'SurveillanceDroneSwarm', x: 400, y: -40, w: 48, h: 32, bottom: 300, fontSize: 18 },
    ],
  });

  it('draws one band per column, under the edges and the boxes, with its label escaped', () => {
    const svg = svgFromDiagram(withColumns());
    expect(svg.match(/data-column-id="/g)!.length).toBe(2);
    expect(svg).toContain('data-elementid="pkg1"');
    expect(svg).toContain('>OA &amp; &lt;SA&gt;</text>');
    expect(svg.indexOf('data-layer="column-headers"')).toBeLessThan(svg.indexOf('data-layer="edges"'));
    expect(svg).not.toContain('OA & <SA>');
  });

  it('strokes only the bottom rule of a band, as the screen does', () => {
    const svg = svgFromDiagram(withColumns());
    const band = svg.match(/<g data-column-id="c1"[^>]*><rect [^>]*\/>/)![0];
    expect(band).not.toContain('stroke');
    // 18px label in a 360px column: the rule is 0.08em = 1.44px, inside the band's bottom edge (y -40 + 32).
    expect(svg).toMatch(/<line x1="0" y1="-8\.72" x2="360" y2="-8\.72" stroke="#2563eb" stroke-width="1\.44" \/>/);
  });

  it('widens the viewBox to the headers above the boxes', () => {
    // Boxes span y:[0,250]; the headers start at y:-40.
    expect(svgFromDiagram(withColumns())).toContain('viewBox="-24 -64 496 338"');
  });

  it('cuts a label that does not fit its column, and omits the text with labels off', () => {
    const svg = svgFromDiagram(withColumns());
    expect(svg).not.toContain('>SurveillanceDroneSwarm<');
    expect(svg).toMatch(/>S[A-Za-z]*…<\/text>/);
    const bare = svgFromDiagram(withColumns(), { labels: false });
    expect(bare).toContain('data-column-id="c1"');
    expect(bare).not.toContain('>OA &amp;');
  });

  it('adds nothing to a graph without columns', () => {
    const svg = svgFromDiagram(fixture());
    expect(svg).not.toContain('column-headers');
    expect(svg).not.toContain('data-column-id');
  });
});
