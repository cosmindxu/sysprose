/**
 * Systematic per-view palette coverage.
 *
 * For every view whose palette offers drawing tools, this exercises the two
 * fundamental authoring gestures end-to-end through the real UI:
 *
 *   1. NODE tool — arm the representative node tool (by `data-kind`), click the
 *      canvas, and assert a new element of that metaclass is created in the
 *      model *and* shows up as a selectable row in the Explorer tree.
 *   2. EDGE tool — arm the representative edge tool, then click two rendered
 *      nodes (click-to-connect) and assert a new relationship of that metaclass
 *      is created in the model.
 *
 * The diagram projection is unscoped (buildDiagram runs over the whole model),
 * so any node-kind element created via the node tool renders as a discrete node
 * in its view — which is what makes the edge gesture drivable for every view.
 *
 * Views covered: general, interconnection, action, state, requirement,
 * parametric, case (node + edge) and tree (node only). The geometry view is a
 * Three.js/WebGL renderer (no authoring palette) — covered by geometry3d.spec.ts.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, selectElementById, shot } from './fixtures';

interface SdkLite {
  elementsOfType: (t: string) => { id: string }[];
}

const idsOfType = (page: Page, eClass: string): Promise<string[]> =>
  page.evaluate(
    (e) => (window as unknown as { sysml: SdkLite }).sysml.elementsOfType(e).map((x) => x.id),
    eClass,
  );

const countOfType = (page: Page, eClass: string): Promise<number> =>
  page.evaluate(
    (e) => (window as unknown as { sysml: SdkLite }).sysml.elementsOfType(e).length,
    eClass,
  );

/** Arm a node tool and click the canvas → returns the id of the created element. */
async function armNodeAndPlace(page: Page, nodeKind: string): Promise<string> {
  const before = await idsOfType(page, nodeKind);
  const tool = page.locator(
    `[data-testid="palette-tool"][data-kind="${nodeKind}"][data-tooltype="node"]`,
  );
  await expect(tool).toBeVisible();
  await tool.click();
  // A node-tool click creates the element whether it lands on the pane
  // (onPaneClick) or an existing node (onNodeClick) — force past any overlap.
  await page.locator('.react-flow__pane').click({ force: true, position: { x: 24, y: 24 } });
  await expect.poll(() => countOfType(page, nodeKind)).toBe(before.length + 1);
  const after = await idsOfType(page, nodeKind);
  const created = after.find((id) => !before.includes(id));
  if (!created) throw new Error(`no new ${nodeKind} id found`);
  return created;
}

interface ViewCfg {
  view: string;
  nodeKind: string;
  edgeKind?: string;
  /**
   * Endpoints for the edge gesture. When set, connect these two named sample
   * elements (their frames are well-spaced and reliably clickable) instead of
   * freshly-created nodes — needed for the structural views whose usage nodes
   * carry compartments/handles that overlap the click target.
   */
  edgeEndpoints?: { eClass: string; a: string; b: string };
}

const VIEWS: ViewCfg[] = [
  {
    view: 'general',
    nodeKind: 'PartUsage',
    edgeKind: 'Specialization',
    edgeEndpoints: { eClass: 'PartDefinition', a: 'Vehicle', b: 'Engine' },
  },
  {
    view: 'interconnection',
    nodeKind: 'PartUsage',
    edgeKind: 'ConnectionUsage',
    edgeEndpoints: { eClass: 'PartDefinition', a: 'Vehicle', b: 'Engine' },
  },
  { view: 'action', nodeKind: 'ActionUsage', edgeKind: 'Succession' },
  { view: 'state', nodeKind: 'StateUsage', edgeKind: 'TransitionUsage' },
  { view: 'requirement', nodeKind: 'RequirementUsage', edgeKind: 'Satisfy' },
  { view: 'parametric', nodeKind: 'ConstraintUsage', edgeKind: 'BindingConnector' },
  { view: 'case', nodeKind: 'UseCaseUsage', edgeKind: 'IncludeUseCaseUsage' },
  { view: 'tree', nodeKind: 'Package' }, // node-only palette
  // NOTE: the 'geometry' view is now a lazily-loaded Three.js/WebGL renderer,
  // not a React Flow authoring canvas, so it has no palette drawing gesture to
  // exercise here — its rendering is covered by geometry3d.spec.ts.
];

for (const cfg of VIEWS) {
  const title = cfg.edgeKind
    ? `palette ${cfg.view}: node tool creates ${cfg.nodeKind}; edge tool connects with ${cfg.edgeKind}`
    : `palette ${cfg.view}: node tool creates ${cfg.nodeKind}`;

  test(title, async ({ page }) => {
    const errors = captureErrors(page);
    await gotoApp(page);

    await page.getByTestId(`tb-view-${cfg.view}`).click();
    await expect(page.getByTestId('diagram-canvas')).toBeVisible();
    await expect(page.getByTestId('palette')).toContainText(cfg.view);
    // Let the (async elkjs) layout settle before interacting.
    await page.waitForTimeout(400);

    /* ── NODE tool: create + assert in model and Explorer tree ── */
    const firstId = await armNodeAndPlace(page, cfg.nodeKind);
    // The created element is navigable in the Explorer (expands + selects it).
    await selectElementById(page, firstId);
    await expect(page.locator(`[data-elementid="${firstId}"].tree-node`)).toHaveClass(
      /is-selected/,
    );
    await shot(page, `pv-${cfg.view}-node`);

    /* ── EDGE tool: connect two rendered nodes ── */
    const edgeKind = cfg.edgeKind;
    if (edgeKind) {
      // Resolve the two endpoints: either well-known sample frames or two
      // freshly-created nodes of this view's kind.
      let srcId: string;
      let tgtId: string;
      if (cfg.edgeEndpoints) {
        srcId = await findElementId(page, cfg.edgeEndpoints.eClass, cfg.edgeEndpoints.a);
        tgtId = await findElementId(page, cfg.edgeEndpoints.eClass, cfg.edgeEndpoints.b);
      } else {
        srcId = firstId;
        tgtId = await armNodeAndPlace(page, cfg.nodeKind);
      }
      await page.waitForTimeout(400);

      const rfNode = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
      await expect(rfNode(srcId)).toBeVisible();
      await expect(rfNode(tgtId)).toBeVisible();

      const edgesBefore = await countOfType(page, edgeKind);
      await page
        .locator(`[data-testid="palette-tool"][data-kind="${edgeKind}"][data-tooltype="edge"]`)
        .click();
      const HEAD = { force: true, position: { x: 8, y: 6 } } as const;
      await rfNode(srcId).click(HEAD); // arm source
      await rfNode(tgtId).click(HEAD); // resolve target → connect()

      await expect.poll(() => countOfType(page, edgeKind)).toBe(edgesBefore + 1);

      // The new relationship is wired between the two chosen endpoints.
      const wired = await page.evaluate(
        ({ kind, src, tgt }) =>
          (
            window as unknown as {
              sysml: {
                elementsOfType: (t: string) => { source?: string[]; target?: string[] }[];
              };
            }
          ).sysml
            .elementsOfType(kind)
            .some((r) => (r.source ?? []).includes(src) && (r.target ?? []).includes(tgt)),
        { kind: edgeKind, src: srcId, tgt: tgtId },
      );
      expect(wired, `${edgeKind} wired ${srcId}→${tgtId}`).toBe(true);
      await shot(page, `pv-${cfg.view}-edge`);
    }

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });
}
