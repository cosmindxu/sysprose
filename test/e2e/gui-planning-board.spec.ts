/**
 * Planning board — the CONTENT of the waves, not just the config knobs.
 *
 * `planning.spec.ts` asserts that the board renders and that changing capacity /
 * grouping / ordering re-plans it. It never opens a group to look at what is
 * inside, and it never clicks an item. So the board's whole reason for existing
 * — telling you which model elements landed in which wave, and letting you jump
 * to one — was unverified: a board that grouped everything into the wrong wave,
 * or whose chips selected nothing, would still have passed.
 */

import { test, expect } from '@playwright/test';
import { captureErrors, gotoApp, shot } from './fixtures';
import { nameOf } from './model-helpers';

test('opening a group lists its members, and clicking one selects that element', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-planning').click();
  await expect(page.getByTestId('planning-view')).toBeVisible();

  const groups = page.getByTestId('plan-group');
  await expect.poll(() => groups.count()).toBeGreaterThan(0);
  await expect(page.getByTestId('plan-wave').first()).toBeVisible();

  // ── Expand the first group (its twisty; clicking the card only selects it) ──
  const group = groups.first();
  await expect(group.locator('.plan-twisty')).toHaveText('▸');
  await group.locator('.plan-twisty').click();
  await expect(group.locator('.plan-twisty')).toHaveText('▾');
  const members = page.getByTestId('plan-member');
  await expect.poll(() => members.count()).toBeGreaterThan(0);
  await shot(page, 'planning-a-expanded');

  // ── Clicking a member selects that very element in the rest of the app ──
  const member = members.first();
  const memberId = await member.getAttribute('data-element-id');
  expect(memberId).toBeTruthy();
  await member.click();

  await expect(member).toHaveClass(/is-selected/);
  const expected = (await nameOf(page, memberId!)) ?? '';
  if (expected) await expect(page.getByTestId('prop-name')).toHaveValue(expected);
  await expect(page.locator(`[data-elementid="${memberId}"].tree-node`)).toHaveClass(/is-selected/);
  await shot(page, 'planning-b-member-selected');

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('items with no grouping association are surfaced as ungrouped chips, not dropped', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await gotoApp(page);

  await page.getByTestId('tb-view-planning').click();
  await expect(page.getByTestId('planning-view')).toBeVisible();

  // Group by something the sample model does NOT associate its parts with, so
  // every candidate item falls out of the waves. The board must SAY so rather
  // than quietly planning a subset — silent omission is the failure mode here.
  const grouping = page.getByTestId('plan-grouping');
  const options = await grouping.locator('option').evaluateAll((os) =>
    os.map((o) => (o as HTMLOptionElement).value),
  );
  expect(options.length).toBeGreaterThan(1);

  for (const value of options) {
    await grouping.selectOption(value);
    const ungrouped = page.getByTestId('plan-ungrouped');
    if ((await ungrouped.count()) === 0) continue;

    // The pool names how many items it holds, and each is a clickable chip.
    await expect(ungrouped).toContainText('ungrouped item');
    const chips = page.getByTestId('plan-chip');
    await expect.poll(() => chips.count()).toBeGreaterThan(0);

    const chipId = await chips.first().getAttribute('data-element-id');
    expect(chipId).toBeTruthy();
    await chips.first().click();
    await expect(chips.first()).toHaveClass(/is-selected/);
    await expect(page.locator(`[data-elementid="${chipId}"].tree-node`)).toHaveClass(
      /is-selected/,
    );
    await shot(page, 'planning-c-ungrouped');

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    return;
  }

  throw new Error('no grouping choice left any item ungrouped — cannot exercise the pool');
});
