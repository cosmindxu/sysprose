import { test, expect, type Page } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';

/**
 * One facet of a requirement, read back out of the LIVE model rather than out of
 * the cell that wrote it — the nine stored facets live on an owned
 * `RequirementMetadata` carrier the write creates on demand.
 */
function readFacet(page: Page, reqId: string, key: string): Promise<unknown> {
  return page.evaluate(
    ({ reqId, key }) => {
      const api = (window as unknown as {
        sysml: {
          children: (i: string) => { id: string; eClass: string; declaredName?: string }[];
          getElement: (i: string) => { attrs?: Record<string, unknown> } | undefined;
        };
      }).sysml;
      const carrier = api
        .children(reqId)
        .find((c) => c.eClass === 'MetadataUsage' && c.declaredName === 'RequirementMetadata');
      if (!carrier) return null;
      const cell = api
        .children(carrier.id)
        .find((c) => c.eClass === 'AttributeUsage' && c.declaredName === key);
      return cell ? (api.getElement(cell.id)?.attrs?.value ?? null) : null;
    },
    { reqId, key },
  );
}

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

/**
 * The facet columns of the same grid: the Kind cell and the ten controls beside
 * it, driven in a real browser and read back through the live model.
 *
 * The Properties panel's equivalents are covered by
 * `properties-all-fields.spec.ts`; this pins that the SECOND editor of the same
 * data writes the same places — a cell wired to the wrong column key, or to the
 * wrong store command, passes every builder test and fails here.
 */
test('requirements table: the facet columns write through to the model', async ({ page }) => {
  const errors = captureErrors(page);
  await gotoApp(page);
  await page.getByTestId('tb-view-requirements').click();
  const table = page.getByTestId('requirements-table');
  await expect(table).toBeVisible();

  const row = table.getByTestId('req-row').first();
  const reqId = (await row.getAttribute('data-element-id'))!;

  // A closed-list facet: the drop-down offers exactly what the write accepts.
  const status = row.locator('[data-testid="req-attr-select"][data-col-key="status"]');
  await expect(status).toBeEnabled();
  await status.selectOption('done');
  await expect.poll(() => readFacet(page, reqId, 'status')).toBe('"done"');

  // A free-text facet: click the cell, type, commit on blur.
  await row.locator('[data-testid="req-attr-cell"][data-col-key="owner"] .req-attr-text').click();
  const owner = row.locator('[data-testid="req-attr-input"][data-col-key="owner"]');
  await expect(owner).toBeVisible();
  await owner.fill('ada');
  await owner.blur();
  await expect.poll(() => readFacet(page, reqId, 'owner')).toBe('"ada"');

  // The Kind cell shows what is WRITTEN: a sample requirement carries no
  // keyword, so it sits on the blank entry, whose label says what it reads as.
  const kind = row.locator('[data-testid="req-attr-select"][data-col-key="statementKind"]');
  await expect(kind).toHaveValue('');
  await expect(kind.locator('option[value=""]')).toHaveText('(untagged — reads as requirement)');
  await kind.selectOption({ value: 'prose' });
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as unknown as {
            sysml: { getElement: (i: string) => { attrs?: Record<string, unknown> } | undefined };
          }).sysml.getElement(id)?.attrs?.metadata ?? null,
        reqId,
      ),
    )
    .toEqual(['prose']);
  // Tagged prose, the row STAYS in the grid — it is only out of the coverage
  // ratio, not out of the editor — and its Kind cell now says so.
  await expect(table.locator(`[data-testid="req-row"][data-element-id="${reqId}"]`)).toHaveCount(1);
  await expect(kind).toHaveValue('prose');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
