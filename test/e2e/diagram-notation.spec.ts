/**
 * Graphical NOTATION fidelity — what the boxes actually draw.
 *
 * The diagram suites so far assert that views *render* (nodes appear, no console
 * errors) and that edges connect the right elements. None of them looks at the
 * SysML notation carried on a node: the modifier adornments (`abstract`,
 * `variation`, `derived`, `readonly`), the derived `/name` transform, or the
 * attribute/port compartments and their port symbols. Since notation fidelity is
 * the tool's headline claim, "a box appeared" is far too weak a check — a box
 * that silently dropped every adornment would pass every existing test.
 *
 * The mapping under test is the documented one in `src/diagram/nodes.tsx`:
 * `adornmentsFor()` emits `«keyword»` first and then one badge per modifier flag,
 * `displayName()` prefixes a derived feature with `/`, and `portSymbolFor()`
 * resolves a port to `full`/`proxy` plus a conjugation flag.
 *
 * The GENERAL view is used throughout because that is the one whose builder fills
 * the attribute/port compartments (`buildGeneral` in `src/diagram/build.ts`);
 * interconnection promotes ports to nodes of their own instead.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, openTab, shot } from './fixtures';
import { setPropName } from './model-helpers';

/** Every modifier the textual grammar accepts, on elements that render as boxes. */
const NOTATION = `package Notation {
  abstract part def Chassis;
  variation part def Powertrain;
  part def Car {
    attribute mass;
    port fuelIn;
    derived part spare : Chassis;
    readonly part frame : Chassis;
  }
}
`;

async function loadText(page: Page, text: string): Promise<void> {
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await page.getByTestId('text-apply').click();
}

/** The rendered SysML box for an element id, in the active view. */
const boxOf = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"] [data-testid="sysml-node"]`);

/** The modifier badges on a box (the `«keyword»` is header text, never a badge). */
const badgesOf = (page: Page, id: string) =>
  boxOf(page, id).locator('[data-testid="node-adornment"]');

test('modifier keywords are drawn as SysML adornments on the box', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadText(page, NOTATION);

  await page.getByTestId('tb-view-general').click();
  await expect(page.locator('.react-flow__node').first()).toBeVisible();

  // ── `abstract part def` → the abstract flag + exactly one "abstract" badge ──
  const chassisId = await findElementId(page, 'PartDefinition', 'Chassis');
  const chassis = boxOf(page, chassisId);
  await expect(chassis).toBeVisible();
  await expect(chassis).toHaveAttribute('data-abstract', 'true');
  await expect(badgesOf(page, chassisId)).toHaveText(['abstract']);
  // The keyword guillemet is header text, not a badge.
  await expect(chassis).toContainText('«part def»');

  // ── `variation part def` → the variation flag, and NOT the abstract one ──
  const powertrainId = await findElementId(page, 'PartDefinition', 'Powertrain');
  const powertrain = boxOf(page, powertrainId);
  await expect(powertrain).toHaveAttribute('data-variation', 'true');
  await expect(badgesOf(page, powertrainId)).toHaveText(['variation']);
  await expect(powertrain).not.toHaveAttribute('data-abstract', 'true');

  // ── An unmodified definition carries no badge at all ──
  const carId = await findElementId(page, 'PartDefinition', 'Car');
  await expect(boxOf(page, carId)).toBeVisible();
  await expect(badgesOf(page, carId)).toHaveCount(0);
  await shot(page, 'notation-a-adornments');

  // ── `derived` → the badge AND the SysML `/name` transform on the box title ──
  const spareId = await findElementId(page, 'PartUsage', 'spare');
  await expect(badgesOf(page, spareId)).toHaveText(['derived']);
  await expect(boxOf(page, spareId)).toContainText('/spare');

  // ── `readonly` → the badge, rendered with its ■ mark ──
  const frameId = await findElementId(page, 'PartUsage', 'frame');
  await expect(badgesOf(page, frameId)).toHaveText(['■ readonly']);
  await expect(boxOf(page, frameId)).toContainText('frame');
  await shot(page, 'notation-b-derived-readonly');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('attributes and ports fill the box compartments, ports with their symbol', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await loadText(page, NOTATION);

  await page.getByTestId('tb-view-general').click();
  const carId = await findElementId(page, 'PartDefinition', 'Car');
  const car = boxOf(page, carId);
  await expect(car).toBeVisible();

  // The attribute compartment lists the owned attribute.
  await expect(car).toContainText('mass');

  // The port compartment lists the owned port with its SysML symbol. A plain
  // PortUsage resolves to the FULL port square (proxy ports are a distinct kind).
  const portRows = car.locator('[data-testid="port-row"]');
  await expect(portRows).toHaveCount(1);
  await expect(portRows.first()).toContainText('fuelIn');
  await expect(portRows.first()).toHaveAttribute('data-port-shape', 'full');
  await shot(page, 'notation-c-compartments');

  // ── A `~`-prefixed port name marks the port conjugated ──
  // (`portSymbolFor` reads the leading `~`; it is a MARKING on the same symbol,
  // so the shape must stay `full` rather than becoming some other kind.)
  const fuelInId = await findElementId(page, 'PortUsage', 'fuelIn');
  await setPropName(page, fuelInId, '~fuelIn');
  await expect.poll(() => portRows.first().textContent()).toContain('~fuelIn');
  await expect(portRows.first()).toHaveAttribute('data-port-shape', 'full');
  await shot(page, 'notation-d-conjugated');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
