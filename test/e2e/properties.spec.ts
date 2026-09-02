/**
 * Scenario 3 — the Properties form edits the live model: rename a port, change
 * its direction, and set value + multiplicity, asserting each change is
 * reflected in the model (via the SDK) and in the Explorer tree.
 */

import { test, expect } from '@playwright/test';
import { gotoApp, findElementId, selectElementById, shot } from './fixtures';

/** Read an element attribute through the live SDK. */
function readAttr(page: import('@playwright/test').Page, id: string, key: string) {
  return page.evaluate(
    ({ id, key }) => {
      const api = (window as unknown as {
        sysml: { getElement: (i: string) => { attrs?: Record<string, unknown> } | undefined };
      }).sysml;
      return api.getElement(id)?.attrs?.[key] ?? null;
    },
    { id, key },
  );
}

test('properties edits name / direction / value / multiplicity of a port', async ({ page }) => {
  await gotoApp(page);

  // The sample has an input port "fuelIn" (a PortUsage) nested under "vehicle".
  const portId = await findElementId(page, 'PortUsage', 'fuelIn');
  await selectElementById(page, portId);

  // Properties shows this element.
  await expect(page.getByTestId('prop-name')).toHaveValue('fuelIn');
  await expect(page.getByTestId('prop-direction')).toBeVisible();
  await expect(page.getByTestId('prop-direction')).toHaveValue('in');

  await shot(page, '03a-port-selected');

  // ── Change the direction in → out ──
  await page.getByTestId('prop-direction').selectOption('out');
  await expect.poll(() => readAttr(page, portId, 'direction')).toBe('out');

  // ── Rename via prop-name; the Explorer row updates too ──
  await page.getByTestId('prop-name').fill('fuelInlet');
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as unknown as {
            sysml: { getElement: (i: string) => { declaredName?: string } | undefined };
          }).sysml.getElement(id)?.declaredName,
        portId,
      ),
    )
    .toBe('fuelInlet');
  await expect(page.locator(`[data-elementid="${portId}"]`).getByText('fuelInlet')).toBeVisible();

  // ── Set value + multiplicity (usage fields) ──
  await page.getByTestId('prop-value').fill('open');
  await expect.poll(() => readAttr(page, portId, 'value')).toBe('open');

  await page.getByTestId('prop-multiplicity').fill('0..1');
  await expect.poll(() => readAttr(page, portId, 'multiplicity')).toBe('0..1');

  await shot(page, '03b-port-edited');
});
