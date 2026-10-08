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
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DRIVE_HOSTS, DRIVE_SCOPE } from '../../src/persistence/drive';
import {
  PRODUCT_NAME,
  PRODUCT_SHORT_NAME,
  PRODUCT_SLUG,
  PRODUCT_VERSION,
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

  it('package.json version matches the version an evidence record names', () => {
    // An evidence record states the tool version it was produced by
    // (docs/04-formal-verification-plan.md §3.10). A constant that drifted from
    // the package would put a version nobody can check out into a record whose
    // whole purpose is to be checkable.
    expect(JSON.parse(root('package.json')).version).toBe(PRODUCT_VERSION);
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

/**
 * The Content-Security-Policy in `index.html` admits exactly the hosts the app
 * can contact.
 *
 * The policy is a static `<meta>`, so a Google host the Drive modules reach
 * without the policy naming it is a request the browser refuses in production
 * — while CI, which fakes Google with `page.route`, stays green. The revoke
 * endpoint is the case that motivated this: `google.accounts.oauth2.revoke`
 * POSTs to `oauth2.googleapis.com`, and a `connect-src` without it makes
 * "sign-out revokes" silently false. `src/persistence/drive/hosts.ts` lists the
 * hosts BY DIRECTIVE, and this holds the policy to that list in both
 * directions: every listed host is admitted where it is used, and each
 * directive admits nothing beyond what it admitted before Drive and its own
 * `DRIVE_HOSTS` entries.
 */
describe('the CSP admits exactly the hosts the app contacts', () => {
  /**
   * The policy as it stood before Google Drive, directive by directive. The
   * pin holds `index.html` to exactly this plus `DRIVE_HOSTS`, so any other
   * widening — a scheme source such as `https:`, a `*`, a host admitted under
   * another directive than the one it is used in, a new directive — fails here
   * and has to be made on purpose. `frame-src` is new with Drive; before it,
   * frames fell back to `default-src 'self'`, which its `'self'` keeps.
   */
  const PRE_DRIVE: Record<string, readonly string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'media-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", 'ws:', 'wss:', 'blob:', 'data:', 'https://raw.githubusercontent.com'],
    'frame-src': ["'self'"],
    'font-src': ["'self'", 'data:'],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };

  /** The directives in the order written, names lowercased as the browser reads them. */
  const directives = (): Array<[string, string[]]> => {
    const m = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(root('index.html'));
    expect(m, 'index.html no longer carries a CSP meta').not.toBeNull();
    return m![1]
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0] !== '')
      .map(([name, ...sources]) => [name.toLowerCase(), sources]);
  };

  /**
   * The policy the browser enforces. A repeated directive is ignored after its
   * first copy (CSP3, "parse a serialized CSP"), so the first copy is the one
   * read here — a later, complete copy must not hide an earlier, narrower one.
   */
  const policy = (): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const [name, sources] of directives()) if (!m.has(name)) m.set(name, sources);
    return m;
  };

  it('names each directive once, since the browser ignores every copy after the first', () => {
    const names = directives().map(([name]) => name);
    expect(names.filter((name, i) => names.indexOf(name) !== i), 'repeated directives').toEqual([]);
  });

  it('admits every DRIVE_HOSTS entry in the directive it is listed under', () => {
    const csp = policy();
    for (const [key, hosts] of Object.entries(DRIVE_HOSTS)) {
      const directive = `${key}-src`;
      expect(csp.has(directive), `the CSP has no ${directive}`).toBe(true);
      for (const host of hosts) {
        expect(csp.get(directive), `${directive} does not admit ${host}`).toContain(host);
      }
    }
  });

  it('admits the token, Drive and revoke endpoints in connect-src', () => {
    // Spelled out, beside the loop above: these are the hosts the auth, the
    // gateway and sign-out fetch from, and the revoke one is the easy one to lose.
    const connect = policy().get('connect-src') ?? [];
    for (const host of ['https://accounts.google.com/gsi/', 'https://www.googleapis.com', 'https://oauth2.googleapis.com']) {
      expect(DRIVE_HOSTS.connect as readonly string[], `hosts.ts lost ${host}`).toContain(host);
      expect(connect, `connect-src does not admit ${host}`).toContain(host);
    }
  });

  it("keeps frames to 'self' plus Google's sign-in and Picker frames", () => {
    const frame = policy().get('frame-src') ?? [];
    expect(frame).toContain("'self'");
    expect([...frame].sort()).toEqual(["'self'", ...DRIVE_HOSTS.frame].sort());
  });

  it('admits nothing beyond the pre-Drive policy and DRIVE_HOSTS, directive by directive', () => {
    const csp = policy();
    const driveHosts = DRIVE_HOSTS as Record<string, readonly string[]>;
    for (const key of Object.keys(driveHosts)) {
      expect(PRE_DRIVE, `DRIVE_HOSTS.${key} names a directive the pin does not know`).toHaveProperty(`${key}-src`);
    }
    expect([...csp.keys()].sort(), 'the directives').toEqual(Object.keys(PRE_DRIVE).sort());
    for (const [name, before] of Object.entries(PRE_DRIVE)) {
      // Covers the unsafe- keywords too: the two 'unsafe-inline' that predate
      // Drive (the theme preload's inline script, inline styles) and no other.
      const drive = driveHosts[name.replace(/-src$/, '')] ?? [];
      expect([...(csp.get(name) ?? [])].sort(), name).toEqual([...before, ...drive].sort());
    }
  });

  it('never spells a Google URL in the Drive sources outside hosts.ts', () => {
    // The scope identifier names a permission and is never fetched; every
    // other https URL a Drive module could reach must come from hosts.ts, or
    // the pin above would not see it.
    const dir = 'src/persistence/drive';
    const files = readdirSync(resolve(process.cwd(), dir)).filter((f) => f.endsWith('.ts') && f !== 'hosts.ts');
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      const urls = [...root(`${dir}/${file}`).matchAll(/https:\/\/[^\s'"`)]*/g)].map((m) => m[0]);
      expect(
        urls.filter((u) => u !== DRIVE_SCOPE),
        `${dir}/${file} spells a URL outside hosts.ts`,
      ).toEqual([]);
    }
  });
});
