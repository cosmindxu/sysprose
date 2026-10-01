/**
 * Scenario — the three things the drone-swarm tutorials could not re-enter:
 * an interface between two ports, a `#Tag`, and a requirement's subject.
 *
 * The interface is drawn the way a person does it: the Interface tool, then
 * a click on a port handle of one part and on one of the other. The parts are
 * typed by a definition and own no ports of their own, so the handles are the
 * ports they have through their type, and the ends must come out as the
 * feature chains `m1.o` / `m2.i` — not the boxes.
 */
import { test, expect, type Page } from '@playwright/test';
import { captureErrors, treeName } from './fixtures';

const FIXTURE = `package R {
    metadata def Hazard;
    port def P;
    interface def I { end a : P; end b : ~P; }
    part def M { out port o : P; in port i : ~P; }
    part m1 : M;
    part m2 : M;
    requirement H {
        doc /* a hazard */
    }
}
`;

interface Sdk {
  byName(q: string): { id: string } | undefined;
}

async function open(page: Page): Promise<void> {
  await page.route('**/fixture.sysml', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: FIXTURE }));
  await page.goto('/?model=fixture.sysml', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as { sysml?: Sdk }).sysml?.byName('R::m1'));
}

const idOf = (page: Page, q: string): Promise<string> =>
  page.evaluate((qn) => (window as unknown as { sysml: Sdk }).sysml.byName(qn)!.id, q);

async function text(page: Page): Promise<string> {
  await page.getByTestId('tab-text').click();
  return page.getByTestId('text-editor').inputValue();
}

test('an interface is drawn port to port, on the ports the parts have through their type', async ({ page }) => {
  const errors = captureErrors(page);
  await open(page);
  await page.getByTestId('tb-view-interconnection').click();
  await page.waitForFunction(
    () => (window as unknown as { sysprose: { diagram: { busy(): boolean } } }).sysprose.diagram.busy() === false,
  );
  const [m1, m2, o, i] = await Promise.all(['R::m1', 'R::m2', 'R::M::o', 'R::M::i'].map((q) => idOf(page, q)));

  await page.locator('[data-testid="palette-tool"][data-kind="InterfaceUsage"]').click();
  await expect(page.getByTestId('canvas-tool-hint')).toContainText('port');
  await page.locator(`.react-flow__node[data-id="${m1}"] .react-flow__handle.source[data-handleid="${m1}/${o}"]`).click({ force: true });
  await page.locator(`.react-flow__node[data-id="${m2}"] .react-flow__handle.target[data-handleid="${m2}/${i}"]`).click({ force: true });

  await expect.poll(() => text(page)).toContain('interface connect m1.o to m2.i;');
  // One interface, and no box-to-box one beside it.
  expect((await text(page)).match(/connect /g)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('Properties writes a #Tag and a requirement subject into the text', async ({ page }) => {
  const errors = captureErrors(page);
  await open(page);
  const h = await idOf(page, 'R::H');
  await treeName(page.locator(`[data-elementid="${h}"]`).first()).click();

  await page.getByTestId('prop-tags').fill('#Hazard');
  await page.getByTestId('prop-tags').press('Enter');
  await page.getByTestId('prop-subject').fill('holder : M');
  await page.getByTestId('prop-subject').press('Enter');

  await expect.poll(() => text(page)).toContain('#Hazard requirement H {');
  expect(await text(page)).toContain('subject holder : M;');
  // The tag resolves to the model's own metadata def.
  await expect(page.getByTestId('prop-keyword-reading')).toHaveText('R::Hazard');
  expect(errors).toEqual([]);
});
