const { test, expect } = require('@playwright/test');

async function writeAndLock(page) {
  await page.getByRole('button', {name: 'Start my first session'}).click();
  await page.getByLabel('Your observations').fill('Broad shapes, cool surfaces, a sense of space.');
  await page.getByRole('button', {name: 'Save observation', exact: true}).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name: 'Finish & lock notes'}).click();
  await expect(page.locator('#nextTitle')).toHaveText('Choose how you want to compare');
}

test('a beginner sees a clear start and follows the scored flow after a refresh', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#empty')).toContainText('hidden scene');
  await expect(page.locator('#humanMode')).toHaveAttribute('aria-pressed', 'true');
  await writeAndLock(page);
  await page.getByRole('button', {name: 'Compare 5 pictures'}).click();
  const comparisonUrl = await page.locator('#judgingLink a').getAttribute('href');
  await page.reload();
  await page.locator('#sessions button').first().click();
  await expect(page.locator('#nextTitle')).toContainText('rank all five');
  await expect(page.locator('#reveal')).toBeHidden();
  await expect(page.locator('#judgingLink a')).toHaveAttribute('href', comparisonUrl);
  const judge = await context.newPage();
  await judge.goto(comparisonUrl);
  await expect(judge.locator('#rankProgress')).toContainText('0 of 5');
  for (let i = 0; i < 5; i++) await judge.locator('#candidates select').nth(i).selectOption(String(i + 1));
  await expect(judge.locator('#rankProgress')).toContainText('5 of 5');
  await judge.getByRole('button', {name: 'Submit final ranking'}).click();
  await expect(judge.locator('#judgeOutcome')).toContainText('20%');
  await expect(judge.locator('#judgeOutcome')).toContainText('does not establish');
  await page.getByRole('button', {name: 'Check for submitted ranking'}).click();
  await expect(page.locator('#nextTitle')).toContainText('ranking is saved');
  await page.getByRole('button', {name: 'Show hidden scene'}).click();
  await expect(page.locator('#target')).toBeVisible();
  await expect(page.locator('#anotherSession')).toBeVisible();
});

test('reflection-only reveal explains consequences and cancel keeps the comparison available', async ({ page }) => {
  await page.goto('/');
  await writeAndLock(page);
  let message = '';
  page.once('dialog', async dialog => { message = dialog.message(); await dialog.dismiss(); });
  await page.getByRole('button', {name: 'Show hidden scene'}).click();
  await expect(page.getByRole('button', {name: 'Compare 5 pictures'})).toBeEnabled();
  expect(message).toContain('can’t enter blind judging');
  await expect(page.locator('#target')).toBeHidden();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name: 'Show hidden scene'}).click();
  await expect(page.locator('#target')).toContainText('reflection-only');
  await page.getByRole('button', {name: 'Dashboard', exact: true}).click();
  await expect(page.locator('#dashboardEmpty')).toBeVisible();
  await expect(page.locator('#trialHistory tbody tr')).toHaveCount(0);
});

test('unsaved observations survive guidance, mode changes and switching sessions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Start my first session'}).click();
  const firstCode = await page.locator('#code').textContent();
  await expect(page.locator('#finalize')).toBeDisabled();
  await expect(page.locator('#record')).toBeDisabled();
  await page.getByLabel('Your observations').fill('My unsaved observation');
  await expect(page.locator('#draftStatus')).toContainText('Not saved yet');
  await page.getByRole('button', {name: 'Help me notice more'}).click();
  await expect(page.getByLabel('Your observations')).toHaveValue('My unsaved observation');
  await page.getByRole('button', {name: 'AI experiments', exact: true}).click();
  await page.getByRole('button', {name: 'Human sessions', exact: true}).click();
  await expect(page.getByLabel('Your observations')).toHaveValue('My unsaved observation');
  await page.getByRole('button', {name: 'Start a session', exact: true}).click();
  await expect(page.getByLabel('Your observations')).toHaveValue('');
  await page.locator('#sessions button').filter({hasText: firstCode.split(' · ')[0].replace('SESSION ', '')}).click();
  await expect(page.getByLabel('Your observations')).toHaveValue('My unsaved observation');
  await page.getByRole('button', {name: 'Save observation', exact: true}).click();
  await expect(page.getByLabel('Your observations')).toHaveValue('');
  await expect(page.locator('#draftStatus')).toContainText('saved');
  await page.getByLabel('Your observations').fill('Another unsaved note');
  await page.getByRole('button', {name: 'Finish & lock notes'}).click();
  await expect(page.getByRole('alert')).toContainText('Save your observation');
  await expect(page.getByLabel('Your observations')).toHaveValue('Another unsaved note');
  await page.getByLabel('Your observations').fill('');
});

test('AI defaults work with advanced settings closed and missing model does not block human sessions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Let the AI try instead'}).click();
  await expect(page.locator('#advancedOptions')).not.toHaveAttribute('open');
  await expect(page.locator('#conditionHelp')).toContainText('without seeing it');
  await page.getByRole('button', {name: 'Run AI experiment'}).click();
  await expect(page.locator('#experimentResult h3')).toContainText('Ready to compare');
  await expect(page.locator('#experimentResult')).toContainText('not scored until');
  await page.route('**/api/settings', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({connected: false, models: [], selected_model: '', error: 'Unavailable'})}));
  await page.getByRole('button', {name: 'AI experiments', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Run AI experiment'})).toBeDisabled();
  await expect(page.locator('#experimentModel')).toContainText('Human sessions do not require AI');
  await page.getByRole('button', {name: 'Human sessions', exact: true}).click();
  await page.getByRole('button', {name: 'Start my first session'}).click();
  await expect(page.getByLabel('Your observations')).toBeVisible();
});

for (const width of [360, 390, 768, 1280]) {
  test(`beginner screens fit ${width}px and have usable navigation`, async ({ page }) => {
    await page.setViewportSize({width, height: 900});
    await page.goto('/');
    const checkWidth = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await checkWidth();
    await page.screenshot({path: `/tmp/remoteview-home-${width}.png`, fullPage: true});
    await page.getByRole('button', {name: 'Start my first session'}).click();
    await expect(page.locator('#phase')).toBeFocused();
    await checkWidth();
    await page.screenshot({path: `/tmp/remoteview-session-${width}.png`, fullPage: true});
    await page.getByRole('button', {name: 'AI experiments', exact: true}).click();
    await checkWidth();
    await page.screenshot({path: `/tmp/remoteview-ai-${width}.png`, fullPage: true});
    await page.getByRole('button', {name: 'Dashboard', exact: true}).click();
    await checkWidth();
  });
}
