/**
 * FMI export (Phase 4): the Export ▾ menu offers "FMU (.fmu)" and "FMI
 * description (.xml)" for the selected block (else the first part). This drives
 * the real download and inspects the produced FMU archive.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { captureErrors, gotoApp } from './fixtures';

test('toolbar: export a block as an FMI 3.0 FMU', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page); // the sample model has a Vehicle part → FMU export is enabled

  await page.getByTestId('tb-export').click();
  const fmuItem = page.getByTestId('tb-export-fmu');
  await expect(fmuItem).toBeVisible();
  await expect(page.getByTestId('tb-export-fmi-xml')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await fmuItem.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.fmu$/);

  // The archive is a real STORED zip (PK\x03\x04) carrying the model description.
  const path = await download.path();
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  const text = bytes.toString('latin1');
  expect(text).toContain('modelDescription.xml');
  expect(text).toContain('<fmiModelDescription fmiVersion="3.0"');
  expect(text).toContain('<CoSimulation modelIdentifier=');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('toolbar: export the FMI modelDescription.xml on its own', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-export').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('tb-export-fmi-xml').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('modelDescription.xml');
  const text = readFileSync(await download.path(), 'utf8');
  expect(text).toContain('<fmiModelDescription fmiVersion="3.0"');
  expect(text).toContain('<ModelVariables>');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
