/**
 * Read-only cross-implementation interop check: pull a real project from the
 * live OMG SysML v2 pilot API server using our PilotApiClient, and reconstruct
 * it into our Model. No writes.
 */
import { PilotApiClient, elementsToModel } from '../src/interop/index';

const BASE = process.env.SYSMLV2_PILOT_URL || 'http://sysml2.intercax.com:9000';
const c = new PilotApiClient(BASE);

const projects = await c.listProjects();
console.log(`pilot @ ${BASE} — ${projects.length} projects`);

// Prefer a small, well-known starter model; fall back to the first project.
const proj =
  projects.find((p: any) => /Flashlight_StarterModel/i.test(p.name)) ??
  projects.find((p: any) => /Starter|Flashlight|Simple/i.test(p.name)) ??
  projects[0];
const pid = proj['@id'];
const bid = proj.defaultBranch?.['@id'];
console.log(`project: "${proj.name}"  id=${pid}  branch=${bid}`);

// Resolve the branch head commit (raw GET — the OMG Branch resource carries `head`).
const br: any = await fetch(`${BASE}/projects/${pid}/branches/${bid}`).then((r) => r.json());
const commitId = br?.head?.['@id'];
console.log(`head commit: ${commitId}`);

// Bounded pull (real projects bundle the whole library → thousands of elements;
// 300 is plenty to prove cross-implementation read interop over the public link).
const els = await c.getElements(pid, commitId, { size: 100, max: 300 });
const model = elementsToModel(els);
console.log(`PULLED ${els.length} elements (bounded) from the live pilot; reconstructed Model size=${model.size}`);

const counts: Record<string, number> = {};
for (const e of model.all()) counts[e.eClass] = (counts[e.eClass] ?? 0) + 1;
const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('metaclasses:', top.map(([k, v]) => `${k}:${v}`).join('  '));

// Sanity: no dangling relationship endpoints in the reconstructed model.
let dangling = 0;
for (const e of model.all()) {
  for (const ref of [...(e.source ?? []), ...(e.target ?? [])]) if (!model.has(ref)) dangling++;
}
console.log(`reconstructed integrity: ${dangling} dangling endpoints`);
