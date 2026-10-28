const { test, expect } = require('@playwright/test');

test('human session preserves observations, guides, seals, blind judges, and reveals', async ({ page, context }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', {name: '+ New session'}).click();
  await page.getByLabel('Your impressions').fill('  cool\nrough and curved  ');
  await page.getByRole('button', {name: 'Record impression'}).click();
  await expect(page.locator('#transcript .user p')).toHaveText('  cool\nrough and curved  ');
  await page.getByRole('button', {name: 'Ask for guidance'}).click();
  await expect(page.locator('#transcript .assistant')).toContainText('What else, if anything, do you notice?');
  const request = page.waitForResponse(response => response.url().includes('/finalize') && response.status() === 200);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name: 'Finalize transcript'}).click();
  await request;
  await expect(page.getByLabel('Your impressions')).toBeHidden();
  await expect(page.locator('#seal')).toContainText('SHA-256');
  await page.getByRole('button', {name: 'Blind judge this session'}).click();
  const link = page.getByRole('link', {name: 'Open blind judging'});
  await expect(link).toBeVisible();
  await page.getByRole('button', {name: 'Reveal target'}).click();
  await expect(page.getByRole('alert')).toContainText('Submit the blind ranking');
  const judge = await context.newPage();
  await judge.goto(await link.getAttribute('href'));
  await expect(judge.locator('#judgeObservations')).toHaveText('  cool\nrough and curved  ');
  await expect(judge.locator('#candidates img')).toHaveCount(5);
  await expect(judge.getByText('Assigned target', {exact: true})).toHaveCount(0);
  expect(await judge.locator('#candidates img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  for (let i = 0; i < 5; i++) await judge.locator('#candidates select').nth(i).selectOption(String(i + 1));
  await judge.getByRole('button', {name: 'Submit final ranking'}).click();
  await expect(judge.locator('#judgeOutcome')).toContainText('Ranking sealed');
  await expect(judge.getByText('Assigned target', {exact: true})).toHaveCount(1);
  await page.getByRole('button', {name: 'Reveal target'}).click();
  await expect(page.locator('#target')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Download transcript'})).toBeVisible();
  await page.getByRole('button', {name: 'Dashboard', exact: true}).click();
  await expect(page.locator('#summary')).toContainText('20%');
  await expect(page.locator('#trialHistory tbody tr')).toHaveCount(1);
  await expect(page.locator('#comparisons')).toContainText('Human');
  expect(errors).toEqual([]);
});

test('AI conditions, model selection, judging validation, and dashboard charts', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', {name: 'Model settings'}).click();
  await page.getByLabel('Guidance model').selectOption('second-model');
  await page.getByRole('button', {name: 'Save model'}).click();
  await expect(page.getByLabel('Guidance model')).toHaveValue('second-model');
  await page.getByRole('button', {name: 'AI experiments', exact: true}).click();
  for (const condition of ['before', 'after', 'control']) {
    await page.getByLabel('Condition', {exact: true}).selectOption(condition);
    await page.getByRole('button', {name: 'Run AI experiment'}).click();
    await expect(page.locator('#experimentResult h3')).toHaveText(`${condition} · completed`);
  }
  await expect(page.locator('#experimentHistory button')).toHaveCount(3);
  const url = await page.locator('#experimentResult').getByRole('link').getAttribute('href');
  const judge = await page.context().newPage(); await judge.goto(url);
  for (let i = 0; i < 5; i++) await judge.locator('#candidates select').nth(i).selectOption('1');
  await judge.getByRole('button', {name: 'Submit final ranking'}).click();
  await expect(judge.getByRole('alert')).toContainText('exactly once');
  for (let i = 0; i < 5; i++) await judge.locator('#candidates select').nth(i).selectOption(String(i + 1));
  await judge.getByRole('button', {name: 'Submit final ranking'}).click();
  await expect(judge.locator('#judgeOutcome')).toContainText('Ranking sealed');
  await page.getByRole('button', {name: 'Dashboard', exact: true}).click();
  await expect(page.locator('#trialHistory tbody tr')).toHaveCount(1);
  await expect(page.locator('#comparisons')).toContainText('second-model');
  await expect(page.locator('#intervalNote')).toContainText('Wilson');
  await expect(page.locator('#accuracyChart')).toBeVisible();
  await expect(page.locator('#comparisonChart')).toBeVisible();
  await page.screenshot({path: test.info().outputPath('dashboard.png'), fullPage: true});
  expect(errors).toEqual([]);
});

test('loading indicator, disconnect message, and recovery preserve recorded observations', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', {name: '+ New session'}).click();
  await page.getByLabel('Your impressions').fill('Original observation');
  await page.getByRole('button', {name: 'Record impression'}).click();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/guidance', async route => { await gate; await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'Connection interrupted. Please retry.'})}); });
  await page.getByRole('button', {name: 'Ask for guidance'}).click();
  await expect(page.locator('#busy')).toContainText('Waiting for neutral Ollama guidance');
  await expect(page.getByRole('button', {name: 'Ask for guidance'})).toBeDisabled();
  release();
  await expect(page.getByRole('alert')).toContainText('Connection interrupted');
  await expect(page.locator('#transcript .user p')).toHaveText('Original observation');
  await page.unroute('**/guidance');
  await page.getByRole('button', {name: 'Ask for guidance'}).click();
  await expect(page.locator('#transcript .assistant')).toBeVisible();
});

test('mobile modes and empty dashboard render without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  await page.getByRole('button', {name: 'Dashboard', exact: true}).click();
  await expect(page.locator('#summary')).toContainText('Scored trials');
  await expect(page.locator('#intervalNote')).toContainText('no scored trials');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
