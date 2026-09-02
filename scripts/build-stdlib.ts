/**
 * build-stdlib.ts — reproducible converter from the OMG SysML v2 / KerML
 * machine-readable model library (XMI) into this modeler's serialized-model
 * JSON, bundled under `src/library/std/`.
 *
 *   npx tsx scripts/build-stdlib.ts <clonedRepoPath> <outDir>
 *
 * SOURCE. `<clonedRepoPath>` is a checkout of the EPL-2.0 licensed
 * `Systems-Modeling/SysML-v2-Release` repository. The authoritative
 * machine-readable form lives under `sysml.library.xmi/` (files `*.kermlx`,
 * `*.sysmlx`, `*.xmi` across "Kernel Libraries", "Systems Library" and
 * "Domain Libraries"). Every XMI file wraps its content in an anonymous root
 * `<sysml:Namespace>`; elements nest as
 *   ownedRelationship (a Membership/Relationship)
 *     └─ ownedRelatedElement (the actual Element)
 * Cross-file references appear as `href="relative/path#xmiId"` — because every
 * `xmi:id` is a globally-unique UUID, the fragment after `#` alone identifies
 * the target and no path resolution is needed.
 *
 * CONVERSION SCOPE. This produces the STRUCTURAL type library: every package,
 * definition, usage, feature, data type, classifier, behavior and function,
 * together with the specialization-family relationships that connect them
 * (Subclassification, Subsetting, Redefinition, FeatureTyping,
 * ReferenceSubsetting, Conjugation, Specialization). Containment is flattened
 * onto `ownerId`: the *owning* Memberships (OwningMembership, FeatureMembership,
 * …) are transparent wrappers, not emitted. The cross-namespace SCOPING
 * relationships ARE emitted, however, so name resolution can walk them for real:
 *   - `NamespaceImport`  — the `import ns::*` (and recursive `::**`) form; source
 *     is the importing namespace, target the imported namespace.
 *   - `MembershipImport` — the `import ns::member` form; target is resolved from
 *     the imported Membership down to the member Element it exposes.
 *   - alias `Membership`  — the `member as alias` form; emitted with
 *     `attrs.memberName`, source the owning namespace, target the aliased Element.
 * Documentation/Comment prose and the expression/literal/multiplicity
 * computation machinery (function/constraint BODIES) are intentionally NOT
 * emitted — they are semantics for a later increment, and omitting them keeps
 * this a compact library of *names and their type hierarchy*, which is exactly
 * what name/type resolution needs. Re-run with the corpus to regenerate.
 *
 * OUTPUT (in `<outDir>`, i.e. `src/library/std/`):
 *   - stdlib.json    — a SerializedModel valid for `Model.fromJSON`.
 *   - manifest.json  — { sourceRepo, commit, generatedFromCount, packages }.
 */

import { JSDOM } from 'jsdom';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/* ─────────────────────────── metaclass classification ──────────────────── */

const PREFIX = 'stdlib:';

/** Specialization-family relationships we emit as records (with source/target). */
const EMIT_REL = new Set<string>([
  'Subclassification',
  'Subsetting',
  'Redefinition',
  'FeatureTyping',
  'ReferenceSubsetting',
  'Conjugation',
  'Specialization',
]);

/** Endpoint role names per emitted relationship: [sourceRole, targetRole]. */
const REL_ENDPOINTS: Record<string, [src: string, tgt: string]> = {
  Subclassification: ['subclassifier', 'superclassifier'],
  Subsetting: ['subsettingFeature', 'subsettedFeature'],
  Redefinition: ['redefiningFeature', 'redefinedFeature'],
  FeatureTyping: ['typedFeature', 'type'],
  ReferenceSubsetting: ['referencingFeature', 'referencedFeature'],
  Conjugation: ['conjugatedType', 'originalType'],
  Specialization: ['specific', 'general'],
};

/**
 * Non-containment relationships that are transparent for ownership and NOT
 * emitted as records. (Owning `*Membership` types are also transparent — see
 * {@link classify} — but the scoping `NamespaceImport` / `MembershipImport`
 * relationships and alias `Membership`s ARE emitted.)
 */
const TRANSPARENT_EXTRA = new Set<string>([
  'Annotation',
  'FeatureValue',
  'FeatureChaining',
  'FeatureInverting',
  'Disjoining',
  'Intersecting',
  'Unioning',
  'Differencing',
  'CrossSubsetting',
  'Dependency',
  'TransitionFeature',
  'PortConjugation',
]);

/** Node metaclasses NOT emitted: annotation prose + expression/literal bodies. */
const SKIP_NODE = new Set<string>([
  'Documentation',
  'Comment',
  'TextualRepresentation',
  'LiteralInteger',
  'LiteralReal',
  'LiteralRational',
  'LiteralBoolean',
  'LiteralString',
  'LiteralInfinity',
  'NullExpression',
  'OperatorExpression',
  'FeatureReferenceExpression',
  'FeatureChainExpression',
  'InvocationExpression',
  'IndexExpression',
  'ConstructorExpression',
  'MetadataAccessExpression',
  'Expression',
  'BooleanExpression',
  'Invariant',
  'MultiplicityRange',
  'Multiplicity',
]);

/** Scalar attributes copied onto `attrs` when present (besides `isLibrary`). */
const ATTR_WHITELIST = [
  'isAbstract',
  'isDerived',
  'isReadOnly',
  'isPortion',
  'isVariation',
  'isSufficient',
  'isStandard',
  'direction',
  'value',
] as const;

type Kind = 'NODE' | 'REL' | 'IMPORT' | 'ALIAS' | 'TRANSPARENT' | 'SKIP';

function classify(type: string): Kind {
  // Cross-namespace scoping relationships are emitted (source/target resolved).
  if (type === 'NamespaceImport' || type === 'MembershipImport') return 'IMPORT';
  // A plain `Membership` is the alias (`member as name`) form; emitted when it
  // actually carries a `memberName`. Every OTHER `*Membership` (OwningMembership,
  // FeatureMembership, …) is a transparent containment wrapper.
  if (type === 'Membership') return 'ALIAS';
  if (type.endsWith('Membership') || type.endsWith('Import')) return 'TRANSPARENT';
  if (EMIT_REL.has(type)) return 'REL';
  if (TRANSPARENT_EXTRA.has(type)) return 'TRANSPARENT';
  if (SKIP_NODE.has(type)) return 'SKIP';
  return 'NODE';
}

const isEmittedNodeType = (type: string): boolean => classify(type) === 'NODE';

/* ────────────────────────────── serialized shapes ──────────────────────── */

type AttrValue = string | number | boolean;

interface ElementRecord {
  id: string;
  eClass: string;
  declaredName?: string;
  declaredShortName?: string;
  ownerId: string | null;
  attrs: Record<string, AttrValue>;
  source?: string[];
  target?: string[];
}

/** A raw entry captured in the parse pass, before filtering/emission. */
interface Raw {
  xmiId: string;
  type: string;
  kind: Kind;
  declaredName?: string;
  declaredShortName?: string;
  ownerXmiId: string | null;
  attrs: Record<string, AttrValue>;
  /** For REL entries: unprefixed target/source xmi:ids. */
  sourceRefs?: string[];
  targetRefs?: string[];
  /** Emission order (file order, document order). */
  order: number;
}

/* ─────────────────────────────── XMI helpers ───────────────────────────── */

/** Local metaclass name from an `xsi:type` like "sysml:DataType" → "DataType". */
function localType(el: Element): string {
  const xsi = el.getAttribute('xsi:type');
  if (xsi) return xsi.includes(':') ? xsi.slice(xsi.lastIndexOf(':') + 1) : xsi;
  // The document root has no xsi:type; use its own (prefixed) tag name.
  const tag = el.tagName;
  return tag.includes(':') ? tag.slice(tag.lastIndexOf(':') + 1) : tag;
}

/** Nearest ancestor `ownedRelatedElement` whose metaclass is an emitted node. */
function ownerNodeId(el: Element): string | null {
  let anc: Element | null = el.parentElement;
  while (anc) {
    if (anc.localName === 'ownedRelatedElement' && anc.hasAttribute('xmi:id')) {
      if (isEmittedNodeType(localType(anc))) return anc.getAttribute('xmi:id');
      // Skipped node (e.g. an expression body): its content belongs higher up.
    }
    anc = anc.parentElement;
  }
  return null; // reached the (dropped) root Namespace ⇒ this element is a root.
}

/** Resolve an endpoint role to unprefixed xmi:ids (local attr OR href/idref child). */
function resolveEndpoint(el: Element, role: string): string[] {
  const ids: string[] = [];
  const attr = el.getAttribute(role);
  if (attr) for (const t of attr.trim().split(/\s+/)) if (t) ids.push(t);
  for (const child of Array.from(el.children)) {
    if (child.localName !== role) continue;
    const href = child.getAttribute('href');
    if (href) {
      const hash = href.lastIndexOf('#');
      if (hash >= 0) ids.push(href.slice(hash + 1));
      continue;
    }
    const idref = child.getAttribute('xmi:idref');
    if (idref) ids.push(idref);
  }
  return ids;
}

function collectAttrs(el: Element): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = { isLibrary: true };
  for (const name of ATTR_WHITELIST) {
    const v = el.getAttribute(name);
    if (v === null) continue;
    attrs[name] = v === 'true' ? true : v === 'false' ? false : v;
  }
  return attrs;
}

/**
 * Attributes emitted onto an `Import` record: always `isLibrary`, plus the
 * import's `visibility` (governs re-export across the import boundary) and, for a
 * recursive `import ns::**`, `isRecursive` (KerML `isRecursive`; the older
 * `importAll` spelling is accepted defensively).
 */
function collectImportAttrs(el: Element): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = { isLibrary: true };
  const vis = el.getAttribute('visibility');
  if (vis) attrs.visibility = vis;
  const rec = el.getAttribute('isRecursive') ?? el.getAttribute('importAll');
  if (rec === 'true') attrs.isRecursive = true;
  return attrs;
}

/**
 * The member Element an owning/aliasing Membership exposes: its owned element
 * (the `ownedRelatedElement` child, for owning memberships) or, failing that, the
 * `memberElement` reference (attribute or `href`/`idref` child, for a plain alias
 * `Membership`). Returns the unprefixed xmi:id, or `undefined`. Used to build the
 * membership→member map that lets a `MembershipImport` (which references a
 * Membership) point at the actual Element the resolver needs.
 */
function memberElementOf(el: Element): string | undefined {
  for (const child of Array.from(el.children)) {
    if (child.localName === 'ownedRelatedElement' && child.hasAttribute('xmi:id')) {
      return child.getAttribute('xmi:id') ?? undefined;
    }
  }
  const refs = resolveEndpoint(el, 'memberElement');
  return refs[0];
}

/* ─────────────────────────────── file walking ──────────────────────────── */

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(kermlx|sysmlx|xmi)$/i.test(entry.name)) out.push(full);
    }
  }
  return out.sort();
}

/* ───────────────────────────────── main ────────────────────────────────── */

function main(): void {
  const [repoArg, outArg] = process.argv.slice(2);
  if (!repoArg || !outArg) {
    console.error('usage: npx tsx scripts/build-stdlib.ts <clonedRepoPath> <outDir>');
    process.exit(1);
  }
  const repo = path.resolve(repoArg);
  const outDir = path.resolve(outArg);
  const xmiRoot = path.join(repo, 'sysml.library.xmi');
  if (!fs.existsSync(xmiRoot)) {
    console.error(`XMI library not found: ${xmiRoot}`);
    process.exit(1);
  }

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim();
  } catch {
    /* not a git checkout — leave 'unknown' */
  }

  const files = walkFiles(xmiRoot);
  const raws: Raw[] = [];
  const globalIds = new Set<string>(); // every xmi:id seen (any metaclass)
  // Maps every Membership's xmi:id → the xmi:id of the Element it exposes. Needed
  // because a `MembershipImport` references a Membership (which we flatten away),
  // but the resolver needs the member Element the import brings into scope.
  const membershipToMember = new Map<string, string>();
  let order = 0;
  let rawElementCount = 0;

  for (const file of files) {
    const xml = fs.readFileSync(file, 'utf8');
    const dom = new JSDOM(xml, { contentType: 'text/xml' });
    const doc = dom.window.document;
    const all = doc.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const xmiId = el.getAttribute('xmi:id');
      if (!xmiId) continue; // endpoint-ref child (<superclassifier href=…/>) — not an element
      rawElementCount++;
      globalIds.add(xmiId);

      const type = localType(el);
      const kind = classify(type);

      // Record what every Membership exposes (owning + alias) before any early
      // return, so MembershipImport targets can be dereferenced across files.
      if (type.endsWith('Membership')) {
        const member = memberElementOf(el);
        if (member) membershipToMember.set(xmiId, member);
      }

      if (kind === 'TRANSPARENT') continue; // wrapper: contributes only ownership
      // A plain `Membership` without a `memberName` is a non-alias wrapper (e.g. a
      // FeatureValue/return membership): transparent, nothing to expose by name.
      if (kind === 'ALIAS' && !el.getAttribute('memberName')) continue;

      const raw: Raw = {
        xmiId,
        type,
        kind,
        ownerXmiId: ownerNodeId(el),
        attrs: {},
        order: order++,
      };

      if (kind === 'REL') {
        const [srcRole, tgtRole] = REL_ENDPOINTS[type];
        let src = resolveEndpoint(el, srcRole);
        if (src.length === 0 && raw.ownerXmiId) src = [raw.ownerXmiId]; // specific = owner
        raw.sourceRefs = src;
        raw.targetRefs = resolveEndpoint(el, tgtRole);
      } else if (kind === 'IMPORT') {
        // Source is the importing namespace (the owning node). Target is the
        // imported namespace (NamespaceImport) or imported Membership
        // (MembershipImport) — resolved to a member Element in the emit pass.
        raw.sourceRefs = raw.ownerXmiId ? [raw.ownerXmiId] : [];
        const role = type === 'NamespaceImport' ? 'importedNamespace' : 'importedMembership';
        raw.targetRefs = resolveEndpoint(el, role);
        raw.attrs = collectImportAttrs(el);
      } else if (kind === 'ALIAS') {
        // `member as name`: expose the referenced element under `memberName`.
        raw.sourceRefs = raw.ownerXmiId ? [raw.ownerXmiId] : [];
        raw.targetRefs = resolveEndpoint(el, 'memberElement');
        raw.attrs = { isLibrary: true, memberName: el.getAttribute('memberName')! };
        const vis = el.getAttribute('visibility');
        if (vis) raw.attrs.visibility = vis;
      } else if (kind === 'NODE') {
        const dn = el.getAttribute('declaredName');
        const sn = el.getAttribute('declaredShortName');
        if (dn) raw.declaredName = dn;
        if (sn) raw.declaredShortName = sn;
        raw.attrs = collectAttrs(el);
      }
      raws.push(raw);
    }
  }

  // Which xmi:ids will be emitted as nodes (needed to keep relationships valid).
  const emittedNodeIds = new Set<string>();
  for (const r of raws) if (r.kind === 'NODE' && !SKIP_NODE.has(r.type)) emittedNodeIds.add(r.xmiId);

  const ns = (id: string) => PREFIX + id;
  const elements: ElementRecord[] = [];
  const rootIds: string[] = [];
  const packageNames = new Set<string>();

  for (const r of raws.sort((a, b) => a.order - b.order)) {
    if (r.kind === 'NODE') {
      if (SKIP_NODE.has(r.type)) continue;
      const rec: ElementRecord = {
        id: ns(r.xmiId),
        eClass: r.type,
        ownerId: r.ownerXmiId ? ns(r.ownerXmiId) : null,
        attrs: r.attrs,
      };
      if (r.declaredName !== undefined) rec.declaredName = r.declaredName;
      if (r.declaredShortName !== undefined) rec.declaredShortName = r.declaredShortName;
      elements.push(rec);
      if (rec.ownerId === null) rootIds.push(rec.id);
      if ((r.type === 'LibraryPackage' || r.type === 'Package') && r.declaredName) {
        packageNames.add(r.declaredName);
      }
    } else if (r.kind === 'REL') {
      const source = (r.sourceRefs ?? []).filter((id) => emittedNodeIds.has(id));
      const target = (r.targetRefs ?? []).filter((id) => emittedNodeIds.has(id));
      if (source.length === 0 || target.length === 0) continue; // dangling ⇒ drop
      elements.push({
        id: ns(r.xmiId),
        eClass: r.type,
        ownerId: ns(source[0]),
        attrs: { isLibrary: true },
        source: source.map(ns),
        target: target.map(ns),
      });
    } else if (r.kind === 'IMPORT') {
      const source = (r.sourceRefs ?? []).filter((id) => emittedNodeIds.has(id));
      if (source.length === 0) continue; // importing namespace not emitted ⇒ drop
      let targetId = (r.targetRefs ?? [])[0];
      if (!targetId) continue;
      // A MembershipImport references a Membership; dereference it to the member
      // Element the resolver actually exposes.
      if (r.type === 'MembershipImport') targetId = membershipToMember.get(targetId) ?? targetId;
      if (!emittedNodeIds.has(targetId)) continue; // dangling target ⇒ drop
      elements.push({
        id: ns(r.xmiId),
        eClass: r.type,
        ownerId: ns(source[0]),
        attrs: r.attrs,
        source: source.map(ns),
        target: [ns(targetId)],
      });
    } else if (r.kind === 'ALIAS') {
      const source = (r.sourceRefs ?? []).filter((id) => emittedNodeIds.has(id));
      const target = (r.targetRefs ?? []).filter((id) => emittedNodeIds.has(id));
      if (source.length === 0 || target.length === 0) continue; // dangling ⇒ drop
      elements.push({
        id: ns(r.xmiId),
        eClass: 'Membership',
        ownerId: ns(source[0]),
        attrs: r.attrs,
        source: source.map(ns),
        target: target.map(ns),
      });
    }
  }

  const stdlib = {
    formatVersion: '0.1.0',
    generator: 'build-stdlib.ts',
    elements,
    rootIds,
  };
  const manifest = {
    sourceRepo: 'https://github.com/Systems-Modeling/SysML-v2-Release',
    commit,
    generatedFromCount: rawElementCount,
    emittedElementCount: elements.length,
    packages: [...packageNames].sort(),
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'stdlib.json'), JSON.stringify(stdlib));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Report to stdout.
  const bytes = (p: string) => fs.statSync(path.join(outDir, p)).size;
  console.log(`source repo   : ${manifest.sourceRepo}`);
  console.log(`source commit : ${commit}`);
  console.log(`XMI files     : ${files.length}`);
  console.log(`raw elements  : ${rawElementCount}`);
  const count = (cls: string) => elements.filter((e) => e.eClass === cls).length;
  console.log(`emitted       : ${elements.length} (nodes+relationships)`);
  console.log(`  nodes       : ${elements.filter((e) => !e.source).length}`);
  console.log(`  relationships: ${elements.filter((e) => e.source).length}`);
  console.log(`  NamespaceImport : ${count('NamespaceImport')}`);
  console.log(`  MembershipImport: ${count('MembershipImport')}`);
  console.log(`  alias Membership: ${count('Membership')}`);
  console.log(`roots         : ${rootIds.length}`);
  console.log(`packages      : ${manifest.packages.length}`);
  console.log(`stdlib.json   : ${(bytes('stdlib.json') / 1_048_576).toFixed(2)} MiB`);
  console.log(`manifest.json : ${bytes('manifest.json')} B`);
}

main();
