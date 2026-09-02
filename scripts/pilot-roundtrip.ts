/**
 * pilot-roundtrip.ts — push/pull a model through the OMG SysML v2 API &
 * Services REST protocol and report element-set equivalence.
 *
 *   npm run interop        (or: npx tsx scripts/pilot-roundtrip.ts)
 *
 * Target selection:
 *  - If `SYSMLV2_PILOT_URL` is set, round-trips against that live OMG server
 *    (Bearer `SYSMLV2_PILOT_TOKEN` when provided).
 *  - Otherwise, boots our own `createServer()` on an ephemeral port and
 *    round-trips against it — a self-contained conformance smoke test.
 *
 * It pushes {@link buildSampleModel}, pulls it back, and prints element-set
 * equivalence (metaclass + qualified-name multiset, relationship endpoints)
 * plus any diff. Exit code is non-zero if the round-trip is not equivalent.
 */

import type { AddressInfo } from 'node:net';
import { buildSampleModel, Model } from '../src/core/index';
import { createServer } from '../src/server/app';
import { PilotApiClient } from '../src/interop/index';

/** A canonical, order-insensitive signature of a model's element set. */
interface ModelSignature {
  /** `metaclass\tqualifiedName` for every element (sorted). */
  elements: string[];
  /** `srcQN→tgtQN` for every relationship endpoint pair (sorted). */
  endpoints: string[];
}

function signature(model: Model): ModelSignature {
  const qn = (id: string): string => model.qualifiedName(id) || `«${model.get(id)?.eClass ?? '?'}»`;
  const elements = model
    .all()
    .map((el) => `${el.eClass}\t${qn(el.id)}`)
    .sort();
  const endpoints: string[] = [];
  for (const el of model.all()) {
    for (const s of el.source ?? []) {
      for (const t of el.target ?? []) endpoints.push(`${el.eClass}: ${qn(s)} → ${qn(t)}`);
    }
  }
  endpoints.sort();
  return { elements, endpoints };
}

function diff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const setB = new Map<string, number>();
  for (const x of b) setB.set(x, (setB.get(x) ?? 0) + 1);
  const setA = new Map<string, number>();
  for (const x of a) setA.set(x, (setA.get(x) ?? 0) + 1);
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const [x, n] of setA) if ((setB.get(x) ?? 0) < n) onlyA.push(x);
  for (const [x, n] of setB) if ((setA.get(x) ?? 0) < n) onlyB.push(x);
  return { onlyA: onlyA.sort(), onlyB: onlyB.sort() };
}

async function main(): Promise<number> {
  const source = buildSampleModel();
  const pilotUrl = process.env.SYSMLV2_PILOT_URL;

  let baseUrl: string;
  let token: string | undefined;
  let close: (() => void) | undefined;

  if (pilotUrl) {
    baseUrl = pilotUrl;
    token = process.env.SYSMLV2_PILOT_TOKEN;
    console.log(`Target: live OMG pilot server @ ${baseUrl}${token ? ' (with token)' : ''}`);
  } else {
    const server = createServer({ seed: false }).listen(0);
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}/api`;
    close = () => server.close();
    console.log(`Target: in-process createServer() @ ${baseUrl}`);
  }

  try {
    const client = new PilotApiClient(baseUrl, token ? { token } : {});

    const pushed = await client.pushModel(source, 'RoundtripSample');
    console.log(`Pushed ${source.size} elements → project=${pushed.projectId} branch=${pushed.branchId} commit=${pushed.commitId}`);

    const pulled = await client.pullModel(pushed.projectId, pushed.commitId);
    console.log(`Pulled ${pulled.size} elements from commit ${pushed.commitId}`);

    const sigA = signature(source);
    const sigB = signature(pulled);
    const elDiff = diff(sigA.elements, sigB.elements);
    const epDiff = diff(sigA.endpoints, sigB.endpoints);
    const equivalent =
      elDiff.onlyA.length === 0 &&
      elDiff.onlyB.length === 0 &&
      epDiff.onlyA.length === 0 &&
      epDiff.onlyB.length === 0;

    console.log('');
    console.log(`Element-set equivalence : ${equivalent ? 'EQUIVALENT (ok)' : 'DIFFERENT (mismatch)'}`);
    console.log(`  pushed elements : ${sigA.elements.length}   pulled elements : ${sigB.elements.length}`);
    console.log(`  pushed endpoints: ${sigA.endpoints.length}   pulled endpoints: ${sigB.endpoints.length}`);
    if (!equivalent) {
      if (elDiff.onlyA.length) console.log('  only in pushed (elements):', elDiff.onlyA);
      if (elDiff.onlyB.length) console.log('  only in pulled (elements):', elDiff.onlyB);
      if (epDiff.onlyA.length) console.log('  only in pushed (endpoints):', epDiff.onlyA);
      if (epDiff.onlyB.length) console.log('  only in pulled (endpoints):', epDiff.onlyB);
    }

    // Sanity: a query at the pulled commit returns matching elements.
    const q = await client.query(pushed.projectId, pushed.commitId, {
      constraint: { property: '@type', operator: '=', value: 'PartUsage' },
    });
    console.log(`  query(@type=PartUsage) → ${q.total} match(es)`);

    return equivalent ? 0 : 1;
  } finally {
    close?.();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Round-trip failed:', err);
    process.exit(1);
  });
