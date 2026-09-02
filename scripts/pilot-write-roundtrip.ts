/**
 * LIVE write round-trip against a real OMG SysML v2 pilot API server:
 * create a throwaway project → commit a Package (OMG Commit/DataVersion format)
 * → pull the element back → verify → DELETE the project (cleanup).
 * Read-only-safe except the one test project it creates and then deletes.
 */
import { PRODUCT_SLUG } from '../src/branding';

const BASE = process.env.SYSMLV2_PILOT_URL || 'http://sysml2.intercax.com:9000';
const TOKEN = process.env.SYSMLV2_PILOT_TOKEN;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 400)}`);
  return data;
}

let pid: string | undefined;
try {
  // 1) create a throwaway project
  const name = `${PRODUCT_SLUG}-interop-test-${Date.now()}`;
  const proj = await call('POST', '/projects', { '@type': 'Project', name });
  pid = proj['@id'];
  console.log(`created project "${name}"  id=${pid}`);
  const bid = proj.defaultBranch?.['@id'] ?? (await call('GET', `/projects/${pid}/branches`))[0]['@id'];
  console.log(`default branch: ${bid}`);

  // 2) commit a Package (OMG Commit -> change[] of DataVersion{identity,payload})
  const pkgId = crypto.randomUUID();
  const commitBody = {
    '@type': 'Commit',
    change: [
      {
        '@type': 'DataVersion',
        identity: { '@id': pkgId, '@type': 'DataIdentity' },
        payload: { '@id': pkgId, '@type': 'Package', declaredName: 'InteropTest' },
      },
    ],
  };
  const commit = await call('POST', `/projects/${pid}/commits?branchId=${bid}`, commitBody);
  const cid = commit['@id'];
  console.log(`committed Package (${pkgId}) -> commit ${cid}`);

  // 3) pull the elements back
  const body = await call('GET', `/projects/${pid}/commits/${cid}/elements`);
  const els: any[] = Array.isArray(body) ? body : body.elements ?? [];
  const found = els.find((e) => e['@type'] === 'Package' && e.declaredName === 'InteropTest');
  console.log(`pulled ${els.length} element(s); round-tripped Package present: ${!!found}` + (found ? `  @id=${found['@id']}` : ''));
  console.log(found && found['@id'] === pkgId ? 'ROUND-TRIP OK — id preserved' : 'ROUND-TRIP: package present' + (found ? ' (id differs)' : ' — NOT FOUND'));
} finally {
  // 4) cleanup — delete the throwaway project
  if (pid) {
    try { await call('DELETE', `/projects/${pid}`); console.log(`deleted test project ${pid}`); }
    catch (e) { console.log(`cleanup: could not delete ${pid}: ${(e as Error).message}`); }
  }
}
