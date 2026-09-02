/**
 * Awkward names must survive every hop.
 *
 * Every round-trip test in the suite uses tidy ASCII identifiers — `Vehicle`,
 * `Gearbox`, `mass`. The formats a model passes through are not all equally
 * forgiving: the textual notation has to quote what is not a bare identifier,
 * JSON has to escape, and the DOM has to render rather than interpret. A name
 * with a space, a quote, a unicode character or something that looks like markup
 * is where those three disagree, and the disagreement shows up as a silently
 * renamed — or silently executed — element.
 *
 * The names below are chosen for that: a space (needs quoting in notation), a
 * double quote (needs escaping inside the quoting), a non-ASCII word, and an
 * HTML-ish string that must come back as TEXT, never as markup.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, findElementId, gotoApp, openTab, shot } from './fixtures';
import { addChild, hasNamed, nameOf, renameInTree } from './model-helpers';

const AWKWARD = [
  'Brake Assembly', //          a space — must be quoted in the notation
  'Sensor "A"', //              an embedded double quote
  'Régulateur_vitesse', //      non-ASCII
  '<script>x</script>', //      must render as text, never as markup
] as const;

test('names with spaces, quotes, unicode and markup survive text regeneration', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // ── Author one part definition per awkward name, through the GUI ──
  const rootId = await findElementId(page, 'Package', 'VehicleModel');
  const ids: string[] = [];
  for (const name of AWKWARD) {
    const id = await addChild(page, rootId, 'PartDefinition');
    await renameInTree(page, id, name);
    ids.push(id);
  }
  await shot(page, 'identity-a-authored');

  // The Explorer shows the markup name as literal text — if it had been parsed
  // as HTML there would be no text node carrying the angle brackets.
  await expect(
    page.getByTestId('explorer').getByText('<script>x</script>', { exact: true }),
  ).toBeVisible();
  // …and no script element was ever injected into the document.
  expect(
    await page.evaluate(() => document.querySelectorAll('script[data-injected]').length),
  ).toBe(0);

  // ── The serializer must quote them, and the parser must read them back ──
  await openTab(page, 'tab-text');
  const editor = page.getByTestId('text-editor');
  const serialized = await editor.inputValue();
  for (const name of AWKWARD) {
    expect(serialized, `"${name}" should appear in the notation`).toContain(name);
  }

  // Round-trip the notation through the parser: text → model → text.
  await page.getByTestId('text-apply').click();
  for (const name of AWKWARD) {
    await expect
      .poll(() => hasNamed(page, 'PartDefinition', name), { timeout: 20_000 })
      .toBe(true);
  }
  await shot(page, 'identity-b-reparsed');

  // Re-serializing the reparsed model produces the same names again — a quoting
  // bug typically survives one hop and corrupts on the second.
  const reserialized = await editor.inputValue();
  for (const name of AWKWARD) {
    expect(reserialized, `"${name}" should survive a second serialization`).toContain(name);
  }

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('a GUI-authored model survives an export → import round-trip intact', async ({ page }) => {
  const errors = captureErrors(page);
  await page.addInitScript(() => {
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });
  await gotoApp(page);

  // ── Author a small model of mixed metaclasses through the Explorer ──
  const rootId = await findElementId(page, 'Package', 'VehicleModel');
  const authored: Array<{ eClass: string; name: string }> = [
    { eClass: 'PartDefinition', name: 'RoundTripPart' },
    { eClass: 'AttributeUsage', name: 'roundTripAttr' },
    { eClass: 'PortUsage', name: 'roundTripPort' },
    { eClass: 'RequirementUsage', name: 'roundTripReq' },
    { eClass: 'ActionDefinition', name: 'RoundTripAction' },
  ];
  for (const { eClass, name } of authored) {
    const id = await addChild(page, rootId, eClass);
    await renameInTree(page, id, name);
  }

  // ── Export the native model JSON ──
  const download = page.waitForEvent('download');
  await page.getByTestId('tb-export').click();
  await page.getByTestId('tb-export-json').click();
  const path = (await (await download).path())!;
  await shot(page, 'identity-c-exported');

  // ── Wipe the workspace, then import the file back ──
  await page.getByTestId('tb-new').click();
  for (const { eClass, name } of authored) {
    expect(await hasNamed(page, eClass, name), `${name} should be gone after New`).toBe(false);
  }

  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('tb-import').click();
  (await chooser).setFiles(path);

  // ── Every authored element is back, with its metaclass AND its name ──
  for (const { eClass, name } of authored) {
    await expect
      .poll(() => hasNamed(page, eClass, name), { timeout: 20_000 })
      .toBe(true);
  }
  // The sample the authoring hung off came back too — the import is the whole
  // model, not just the elements the test happened to name.
  await expect.poll(() => hasNamed(page, 'PartDefinition', 'Vehicle')).toBe(true);
  const reRootId = await findElementId(page, 'Package', 'VehicleModel');
  expect(await nameOf(page, reRootId)).toBe('VehicleModel');
  await shot(page, 'identity-d-imported');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
