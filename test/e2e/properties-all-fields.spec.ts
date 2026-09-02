/**
 * Properties-panel coverage — edits EVERY field the panel exposes and asserts
 * each change lands in the live model (via `window.sysml`) and, where visible,
 * in the Explorer tree:
 *
 *  identity  — prop-name, prop-shortName;
 *  usage     — prop-type, prop-value, prop-multiplicity;
 *  port      — prop-direction;
 *  requirement — prop-reqId, prop-text;
 *  transition  — prop-trigger, prop-guard, prop-effect;
 *  docs      — prop-doc (lazily creates a Documentation child);
 *  units     — a quantity-valued feature shows prop-dimension and converts via
 *              prop-unit-convert with prop-converted-value updating.
 */

import { test, expect, type Page } from '@playwright/test';
import { captureErrors, gotoApp, findElementId, selectElementById, shot } from './fixtures';

/** Read an element attribute through the live SDK. */
function readAttr(page: Page, id: string, key: string): Promise<unknown> {
  return page.evaluate(
    ({ id, key }) =>
      (window as unknown as {
        sysml: { getElement: (i: string) => { attrs?: Record<string, unknown> } | undefined };
      }).sysml.getElement(id)?.attrs?.[key] ?? null,
    { id, key },
  );
}

/** Read an element's declaredName / declaredShortName. */
function readField(page: Page, id: string, key: 'declaredName' | 'declaredShortName') {
  return page.evaluate(
    ({ id, key }) =>
      (window as unknown as {
        sysml: { getElement: (i: string) => Record<string, unknown> | undefined };
      }).sysml.getElement(id)?.[key] ?? null,
    { id, key },
  );
}

test('properties edits identity/usage/port/requirement/transition/doc/unit fields', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  /* ── identity + usage + doc on the `engine` PartUsage ── */
  const engineId = await findElementId(page, 'PartUsage', 'engine');
  await selectElementById(page, engineId);
  await expect(page.getByTestId('prop-name')).toHaveValue('engine');

  await page.getByTestId('prop-name').fill('engineCore');
  await expect.poll(() => readField(page, engineId, 'declaredName')).toBe('engineCore');
  await expect(
    page.locator(`[data-elementid="${engineId}"]`).getByText('engineCore'),
  ).toBeVisible();

  await page.getByTestId('prop-shortName').fill('EC');
  await expect.poll(() => readField(page, engineId, 'declaredShortName')).toBe('EC');

  await page.getByTestId('prop-type').fill('Engine');
  await expect.poll(() => readAttr(page, engineId, 'type')).toBe('Engine');

  await page.getByTestId('prop-multiplicity').fill('0..1');
  await expect.poll(() => readAttr(page, engineId, 'multiplicity')).toBe('0..1');

  await page.getByTestId('prop-doc').fill('The primary propulsion unit.');
  await expect
    .poll(() =>
      page.evaluate((owner) => {
        const api = (window as unknown as {
          sysml: {
            children: (i: string) => { id: string; eClass: string }[];
            getElement: (i: string) => { attrs?: Record<string, unknown> } | undefined;
          };
        }).sysml;
        const doc = api.children(owner).find((c) => c.eClass === 'Documentation' || c.eClass === 'Comment');
        return doc ? api.getElement(doc.id)?.attrs?.body ?? null : null;
      }, engineId),
    )
    .toBe('The primary propulsion unit.');
  await shot(page, 'props-a-usage');

  /* ── port direction on `fuelIn` (a PortUsage) ── */
  const portId = await findElementId(page, 'PortUsage', 'fuelIn');
  await selectElementById(page, portId);
  await expect(page.getByTestId('prop-direction')).toHaveValue('in');
  await page.getByTestId('prop-direction').selectOption('out');
  await expect.poll(() => readAttr(page, portId, 'direction')).toBe('out');

  /* ── requirement id + text on the `maxMass` RequirementUsage ── */
  const reqId = await findElementId(page, 'RequirementUsage', 'maxMass');
  await selectElementById(page, reqId);
  await page.getByTestId('prop-reqId').fill('REQ-42');
  await expect.poll(() => readAttr(page, reqId, 'reqId')).toBe('REQ-42');
  await page.getByTestId('prop-text').fill('Vehicle mass shall not exceed 2000 kg.');
  await expect.poll(() => readAttr(page, reqId, 'text')).toBe(
    'Vehicle mass shall not exceed 2000 kg.',
  );
  await shot(page, 'props-b-requirement');

  /* ── transition trigger/guard/effect on a freshly-created TransitionUsage ── */
  const rootRow = page.locator('[data-elementid]').filter({ hasText: 'VehicleModel' }).first();
  const trBefore = await page.evaluate(
    () =>
      (window as unknown as {
        sysml: { elementsOfType: (t: string) => { id: string }[] };
      }).sysml
        .elementsOfType('TransitionUsage')
        .map((x) => x.id),
  );
  await rootRow.click();
  await rootRow.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption('TransitionUsage');
  const transId = await page.evaluate((before: string[]) => {
    const ids = (window as unknown as {
      sysml: { elementsOfType: (t: string) => { id: string }[] };
    }).sysml
      .elementsOfType('TransitionUsage')
      .map((x) => x.id);
    return ids.find((id) => !before.includes(id))!;
  }, trBefore);

  await expect(page.getByTestId('prop-trigger')).toBeVisible();
  await page.getByTestId('prop-trigger').fill('ignitionOn');
  await expect.poll(() => readAttr(page, transId, 'trigger')).toBe('ignitionOn');
  await page.getByTestId('prop-guard').fill('fuel > 0');
  await expect.poll(() => readAttr(page, transId, 'guard')).toBe('fuel > 0');
  await page.getByTestId('prop-effect').fill('startEngine()');
  await expect.poll(() => readAttr(page, transId, 'effect')).toBe('startEngine()');
  await shot(page, 'props-c-transition');

  /* ── unit conversion on the `mass` AttributeUsage ── */
  const massId = await findElementId(page, 'AttributeUsage', 'mass');
  await selectElementById(page, massId);
  await page.getByTestId('prop-value').fill('1500 [kg]');
  await expect.poll(() => readAttr(page, massId, 'value')).toBe('1500 [kg]');

  // The quantity block now shows a dimension and a unit-convert control.
  await expect(page.getByTestId('prop-dimension')).toBeVisible();
  const dim = await page.getByTestId('prop-dimension').inputValue();
  expect(dim.length).toBeGreaterThan(0);
  await expect(page.getByTestId('prop-unit-convert')).toBeVisible();

  // Convert kilograms → tonnes: 1500 kg = 1.5 t.
  await page.getByTestId('prop-unit-convert').selectOption('t');
  await expect(page.getByTestId('prop-converted-value')).toHaveValue('1.5');
  await shot(page, 'props-d-units');

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toHaveLength(0);
});
