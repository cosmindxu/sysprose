/**
 * Branding drift guard.
 *
 * `src/branding.ts` is the single source of truth for the product name, but the
 * static assets (`index.html`, `public/manifest.webmanifest`, `package.json`)
 * cannot import TypeScript and so repeat those strings. This suite fails if any
 * of them drifts from the module, and if the trademark-sensitive product name
 * ever reacquires "SysML" (the tool is a candidate implementation, not a
 * certified one).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PRODUCT_NAME,
  PRODUCT_SHORT_NAME,
  PRODUCT_SLUG,
  PRODUCT_DESCRIPTION,
  GENERATOR_ID,
  ELEMENT_GRAPH_SCHEMA_ID,
  LEGACY_STORAGE_DB,
} from '../../src/branding';

/** Read a repo-root file (vitest runs with the project root as cwd). */
const root = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

describe('branding constants', () => {
  it('does not put a trademarked standard name in the product identity', () => {
    for (const s of [PRODUCT_NAME, PRODUCT_SHORT_NAME, PRODUCT_SLUG]) {
      expect(s.toLowerCase()).not.toContain('sysml');
    }
  });

  it('derives the machine-readable ids from the slug', () => {
    expect(GENERATOR_ID).toBe(PRODUCT_SLUG);
    expect(ELEMENT_GRAPH_SCHEMA_ID).toBe(`urn:${PRODUCT_SLUG}:element-graph`);
  });

  it('keeps the legacy browser-storage namespace so saved projects survive the rename', () => {
    expect(LEGACY_STORAGE_DB).toBe('sysmlv2-modeler');
  });
});

describe('static assets stay in step with src/branding.ts', () => {
  it('package.json name matches the slug', () => {
    expect(JSON.parse(root('package.json')).name).toBe(PRODUCT_SLUG);
  });

  it('the PWA manifest matches the product name', () => {
    const manifest = JSON.parse(root('public/manifest.webmanifest'));
    expect(manifest.name).toBe(PRODUCT_NAME);
    expect(manifest.short_name).toBe(PRODUCT_SHORT_NAME);
    expect(manifest.description).toBe(PRODUCT_DESCRIPTION);
  });

  it('index.html title and iOS web-app title match the product name', () => {
    const html = root('index.html');
    expect(html).toContain(`<title>${PRODUCT_NAME}</title>`);
    expect(html).toContain(`content="${PRODUCT_SHORT_NAME}"`);
  });
});
