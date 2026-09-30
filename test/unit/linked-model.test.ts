import { describe, it, expect, vi } from 'vitest';
import {
  fetchLinkedModel,
  linkedModelFromUrl,
  modelFileName,
  resolveHttpUrl,
} from '@ui/linked-model';
import { detectFormat } from '@persistence/index';

const PAGE = 'https://example.org/site/app/index.html?model=x';

/** A stand-in for `fetch` that answers every request with one Response. */
function answering(body: string, init: ResponseInit = {}): typeof fetch {
  return vi.fn(async () => new Response(body, init)) as unknown as typeof fetch;
}

describe('linkedModelFromUrl — ?model= and ?source=', () => {
  it('returns nulls when the page carries neither', () => {
    expect(linkedModelFromUrl('')).toEqual({ model: null, source: null });
    expect(linkedModelFromUrl('?room=r')).toEqual({ model: null, source: null });
  });

  it('reads both parameters, decoding them', () => {
    const q = `?model=${encodeURIComponent('model/A B.sysml')}&source=${encodeURIComponent('https://github.com/o/r/tree/main/x')}`;
    expect(linkedModelFromUrl(q)).toEqual({
      model: 'model/A B.sysml',
      source: 'https://github.com/o/r/tree/main/x',
    });
  });

  it('treats an empty value as absent', () => {
    expect(linkedModelFromUrl('?model=&source=')).toEqual({ model: null, source: null });
  });
});

describe('resolveHttpUrl — what a link may point at', () => {
  it('resolves a relative path against the page (the same-origin bundled case)', () => {
    expect(resolveHttpUrl('model/Swarm.sysml', PAGE)?.href).toBe(
      'https://example.org/site/app/model/Swarm.sysml',
    );
    expect(resolveHttpUrl('../m.sysml', PAGE)?.href).toBe('https://example.org/site/m.sysml');
  });

  it('keeps an absolute http(s) URL as it is', () => {
    const raw = 'https://raw.githubusercontent.com/o/r/main/examples/M.sysml';
    expect(resolveHttpUrl(raw, PAGE)?.href).toBe(raw);
    expect(resolveHttpUrl('http://localhost:4173/m.sysml', PAGE)?.protocol).toBe('http:');
  });

  it('refuses every other scheme', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/plain,package P;',
      'file:///etc/passwd',
      'blob:https://example.org/0',
      'ftp://example.org/m.sysml',
    ]) {
      expect(resolveHttpUrl(bad, PAGE), bad).toBeNull();
    }
  });
});

describe('fetchLinkedModel — limits and failures', () => {
  const url = new URL('https://example.org/m.sysml');

  it('returns the body of a 2xx response and asks the server to revalidate', async () => {
    const f = answering('package M;', { status: 200 });
    await expect(fetchLinkedModel(url, { fetchImpl: f })).resolves.toBe('package M;');
    expect(f).toHaveBeenCalledWith(url.href, expect.objectContaining({ cache: 'no-cache' }));
  });

  it('rejects a non-2xx status, naming it', async () => {
    const f = answering('nope', { status: 404, statusText: 'Not Found' });
    await expect(fetchLinkedModel(url, { fetchImpl: f })).rejects.toThrow('HTTP 404 Not Found');
  });

  it('rejects a declared Content-Length over the cap before reading the body', async () => {
    const f = answering('x', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } });
    await expect(fetchLinkedModel(url, { fetchImpl: f, maxBytes: 1024 * 1024 })).rejects.toThrow(
      /5\.0 MB, over the 1\.0 MB limit/,
    );
  });

  it('rejects a body over the cap when no length was declared', async () => {
    const f = answering('x'.repeat(2048), { status: 200 });
    await expect(fetchLinkedModel(url, { fetchImpl: f, maxBytes: 1024 })).rejects.toThrow(/over the/);
  });

  it('reports a network failure as such', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(fetchLinkedModel(url, { fetchImpl: f })).rejects.toThrow(
      'network error (Failed to fetch)',
    );
  });

  it('gives up after the timeout', async () => {
    const f = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    await expect(fetchLinkedModel(url, { fetchImpl: f, timeoutMs: 20 })).rejects.toThrow(
      'timed out after 0.02 s',
    );
  });
});

describe('modelFileName — naming the model in the banner', () => {
  it('uses the last path segment, decoded', () => {
    expect(modelFileName('https://x.org/a/b/Surveillance%20Swarm.sysml')).toBe('Surveillance Swarm.sysml');
  });
  it('falls back to the whole string when there is no usable segment', () => {
    expect(modelFileName('https://x.org/')).toBe('https://x.org/');
    expect(modelFileName('not a url')).toBe('not a url');
  });
});

describe('detectFormat — shared by Import and ?model=', () => {
  it('reads the extension first, then sniffs', () => {
    expect(detectFormat('/m/Swarm.sysml', '{')).toBe('sysml');
    expect(detectFormat('snap.json', '{"rootIds":[],"elements":[]}')).toBe('model-json');
    expect(detectFormat('graph.json', '{"@type":"Project"}')).toBe('api-json');
    expect(detectFormat('/raw/model', '  {"elements":[]}')).toBe('model-json');
    expect(detectFormat('/raw/model', 'package P;')).toBe('sysml');
  });
});
