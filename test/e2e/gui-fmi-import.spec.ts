/**
 * FMI import (Phase 5): the "Import FMI" toolbar button turns an FMI 3.0
 * modelDescription.xml (from an external engine's FMU) into a SysML block whose
 * ports/attributes mirror the FMU variables.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp } from './fixtures';

const MODEL_DESCRIPTION = `<?xml version="1.0" encoding="UTF-8"?>
<fmiModelDescription fmiVersion="3.0" modelName="ExternalEngine" instantiationToken="{x}" generationTool="test">
  <CoSimulation modelIdentifier="ExternalEngine"/>
  <ModelVariables>
    <Float64 name="u" valueReference="0" causality="input" variability="continuous" start="0"/>
    <Float64 name="y" valueReference="1" causality="output" variability="continuous"/>
    <Float64 name="gain" valueReference="2" causality="parameter" variability="fixed" start="2.5"/>
  </ModelVariables>
  <ModelStructure>
    <Output valueReference="1"/>
  </ModelStructure>
</fmiModelDescription>
`;

test('toolbar: import an FMI modelDescription as a SysML block', async ({ page }) => {
  const errors = captureErrors(page);
  // Inject a deterministic File System Access picker returning the FMI XML, so
  // the test drives the real onImportFmi → importFmi path without an OS dialog.
  await page.addInitScript((xml) => {
    (window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = async () => [
      { getFile: async () => new File([xml], 'ExternalEngine.xml', { type: 'application/xml' }) },
    ];
  }, MODEL_DESCRIPTION);
  await gotoApp(page);

  await page.getByTestId('tb-import-fmi').click();

  // The imported block appears in the Explorer with its variables as ports/attrs.
  await expect(page.getByTestId('explorer').getByText('ExternalEngine')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const api = (window as unknown as {
          sysml: { elementsOfType: (t: string) => { declaredName?: string; attrs?: Record<string, unknown> }[] };
        }).sysml;
        const ports = api.elementsOfType('PortUsage');
        const u = ports.find((p) => p.declaredName === 'u');
        const y = ports.find((p) => p.declaredName === 'y');
        return u?.attrs?.direction === 'in' && y?.attrs?.direction === 'out';
      }),
    )
    .toBe(true);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
