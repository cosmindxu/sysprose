import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * Requirements-table editor (the 'requirements' view). Drives the DOORS-NG-style
 * table end-to-end: switch to the view, add a requirement, edit its ID/Name/Text
 * cells, add a "Satisfied By" link via the picker, click the resulting chip to
 * select the target element, and remove the link — asserting zero console/page
 * errors throughout.
 */
test('requirements table: add/edit requirement, link + unlink a satisfier', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  // Switch to the Requirements view; the table renders, the graph canvas is gone.
  await page.getByTestId('tb-view-requirements').click();
  const table = page.getByTestId('requirements-table');
  await expect(table).toBeVisible();
  await expect(page.getByTestId('diagram-canvas')).toHaveCount(0);

  // The built-in sample carries at least one requirement.
  const rowsBefore = await table.getByTestId('req-row').count();
  expect(rowsBefore).toBeGreaterThanOrEqual(1);

  // Add a top-level requirement → a new row appears and its Name cell opens for edit.
  await page.getByTestId('req-add-row').click();
  await expect(table.getByTestId('req-row')).toHaveCount(rowsBefore + 1);
  const input = table.getByTestId('req-cell-input');
  await expect(input).toBeVisible();
  await input.fill('Braking distance');
  await input.press('Enter');
  await expect(table.getByText('Braking distance')).toBeVisible();

  // Edit the ID cell of the new row (click its "(id)" placeholder text).
  const newRow = table.getByTestId('req-row').filter({ hasText: 'Braking distance' });
  await newRow.getByText('(id)').click();
  const idInput = table.getByTestId('req-cell-input');
  await expect(idInput).toBeVisible();
  await idInput.fill('R-BRK');
  await idInput.press('Enter');
  await expect(newRow.getByText('R-BRK')).toBeVisible();

  // Add a "Satisfied By" link on the NEW (empty) requirement row via the picker.
  await newRow.getByTestId('req-ref-add').first().click();
  const picker = page.getByTestId('req-ref-picker');
  await expect(picker).toBeVisible();
  // Pick the first real candidate (the disabled placeholder is excluded).
  const optionValues = await picker.locator('option').evaluateAll((os) =>
    (os as HTMLOptionElement[]).filter((o) => !o.disabled).map((o) => o.value),
  );
  expect(optionValues.length).toBeGreaterThan(0);
  await picker.selectOption(optionValues[0]);

  // Exactly one chip appears on this row; clicking it selects the target (no error).
  const chip = newRow.getByTestId('req-ref-chip');
  await expect(chip).toHaveCount(1);
  await chip.click();

  await shot(page, '40-requirements-table');

  // Remove the link via the chip ✕ (revealed on hover) → chip disappears.
  await chip.hover();
  await chip.getByTestId('req-ref-remove').click();
  await expect(newRow.getByTestId('req-ref-chip')).toHaveCount(0);

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
