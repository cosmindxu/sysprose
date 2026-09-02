/**
 * Model-manipulation helpers shared by the user-oriented E2E specs.
 *
 * Everything here drives the app the way a person would — tree rows, the
 * "add child" picker, the inline rename box, the Properties form — and reads
 * the *result* back through the live `window.sysml` SDK so assertions are about
 * the model, not about DOM text. Complements `fixtures.ts` (bootstrap +
 * selection); nothing here is imported by the pre-existing specs.
 *
 * NOTE: every `page.evaluate` body is self-contained — it is serialized and run
 * inside the browser, so it cannot close over anything from this module.
 */

import { type Page, expect } from '@playwright/test';
import { selectElementById } from './fixtures';

/** SDK shape (subset) reached through `window.sysml` inside page.evaluate. */
interface HelperSdk {
  elementsOfType(eClass: string): { id: string; declaredName?: string }[];
  getElement(id: string): { declaredName?: string; attrs?: Record<string, unknown> } | undefined;
  children(id: string): { id: string }[];
  model: { all(): unknown[] };
}

/** Type-only helper: the browser-side global. */
type SysmlWindow = { sysml: HelperSdk };

/** Number of elements of a metaclass currently in the model. */
export function countOfType(page: Page, eClass: string): Promise<number> {
  return page.evaluate(
    (e) => (window as unknown as SysmlWindow).sysml.elementsOfType(e).length,
    eClass,
  );
}

/** Ids of every element of a metaclass, in model order. */
export function idsOfType(page: Page, eClass: string): Promise<string[]> {
  return page.evaluate(
    (e) => (window as unknown as SysmlWindow).sysml.elementsOfType(e).map((x) => x.id),
    eClass,
  );
}

/** Total element count (user model + library) — used for subtree size deltas. */
export function modelSize(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as SysmlWindow).sysml.model.all().length);
}

/** True when an element of the metaclass carries the declared name. */
export function hasNamed(page: Page, eClass: string, name: string): Promise<boolean> {
  return page.evaluate(
    ({ e, n }) =>
      (window as unknown as SysmlWindow).sysml
        .elementsOfType(e)
        .some((x) => x.declaredName === n),
    { e: eClass, n: name },
  );
}

/** The declared name of one element, or null when it has none / is gone. */
export function nameOf(page: Page, id: string): Promise<string | null> {
  return page.evaluate(
    (i) => (window as unknown as SysmlWindow).sysml.getElement(i)?.declaredName ?? null,
    id,
  );
}

/** One `attrs` entry of an element, or null. */
export function attrOf(page: Page, id: string, key: string): Promise<unknown> {
  return page.evaluate(
    ({ i, k }) => (window as unknown as SysmlWindow).sysml.getElement(i)?.attrs?.[k] ?? null,
    { i: id, k: key },
  );
}

/** True when the element still exists in the model. */
export function exists(page: Page, id: string): Promise<boolean> {
  return page.evaluate(
    (i) => !!(window as unknown as SysmlWindow).sysml.getElement(i),
    id,
  );
}

/**
 * Add a child of `eClass` under `ownerId` through the Explorer row's "+"
 * affordance and the metaclass picker, exactly as a user does. Returns the id
 * of the element that appeared (diffed against the pre-existing ids, so it is
 * correct even when several elements of that metaclass already exist).
 */
export async function addChild(page: Page, ownerId: string, eClass: string): Promise<string> {
  const before = await idsOfType(page, eClass);
  await selectElementById(page, ownerId);
  const row = page.locator(`[data-elementid="${ownerId}"]`).first();
  await row.getByTestId('tree-add').click();
  await page.locator('.tree-picker-select').selectOption(eClass);
  await expect.poll(() => countOfType(page, eClass)).toBe(before.length + 1);
  const after = await idsOfType(page, eClass);
  const created = after.find((id) => !before.includes(id));
  if (!created) throw new Error(`no new ${eClass} appeared under ${ownerId}`);
  return created;
}

/** Rename an element through the Explorer's inline rename box (dblclick → Enter). */
export async function renameInTree(page: Page, id: string, name: string): Promise<void> {
  await selectElementById(page, id);
  await page.locator(`[data-elementid="${id}"]`).first().dblclick();
  const input = page.getByTestId('tree-rename');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');
  await expect.poll(() => nameOf(page, id)).toBe(name);
}

/** Delete an element through the Explorer row's trash affordance. */
export async function deleteInTree(page: Page, id: string): Promise<void> {
  await selectElementById(page, id);
  await page.locator(`[data-elementid="${id}"]`).first().getByTestId('tree-delete').click();
  await expect.poll(() => exists(page, id)).toBe(false);
}

/** Select an element and type a value into the Properties "Value" field. */
export async function setPropValue(page: Page, id: string, value: string): Promise<void> {
  await selectElementById(page, id);
  const field = page.getByTestId('prop-value');
  await expect(field).toBeVisible();
  await field.fill(value);
  await expect.poll(() => attrOf(page, id, 'value')).toBe(value);
}

/** Select an element and rename it through the Properties "Name" field. */
export async function setPropName(page: Page, id: string, name: string): Promise<void> {
  await selectElementById(page, id);
  const field = page.getByTestId('prop-name');
  await expect(field).toBeVisible();
  await field.fill(name);
  await expect.poll(() => nameOf(page, id)).toBe(name);
}
