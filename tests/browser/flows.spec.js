const { test, expect } = require('@playwright/test');

test('human session preserves observations, guides, seals, blind judges, and reveals', async ({ page, context }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', {name: 'Start a session'}).click();
  await page.getByLabel('Your observations').fill('  cool\nrough and curved  ');
  await page.getByRole('button', {name: 'Save observation'}).click();
  await expect(page.locator('#transcript .user p')).toHaveText('  cool\nrough and curved  ');
  await page.getByRole('button', {name: 'Help me notice more'}).click();
  await expect(page.locator('#transcript .assistant')).toContainText('What else, if anything, do you notice?');
  const request = page.waitForResponse(response => response.url().includes('/finalize') && response.status() === 200);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name: 'Finish & lock notes'}).click();
  await request;
  await expect(page.getByLabel('Your observations')).toBeHidden();
  await page.getByText('Record details', {exact: true}).click();
  await expect(page.locator('#seal')).toContainText('SHA-256');
  await page.getByRole('button', {name: 'Compare 5 pictures'}).click();
  const link = page.getByRole('link', {name: 'Open blind judging'});
  await expect(link).toBeVisible();
  await expect(page.getByRole('button', {name: 'Show hidden scene'})).toBeHidden();
  const judge = await context.newPage();
  await judge.goto(await link.getAttribute('href'));
  await expect(judge.locator('#judgeObservations')).toHaveText('  cool\nrough and curved  ');
  await expect(judge.locator('#candidates img')).toHaveCount(5);
  await expect(judge.getByText('Assigned target', {exact: true})).toHaveCount(0);
  expect(await judge.locator('#candidates img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  for (let i = 0; i < 5; i++) await judge.locator('#candidates select').nth(i).selectOption(String(i + 1));
  await judge.getByRole('button', {name: 'Submit final ranking'}).click();
  await expect(judge.locator('#judgeOutcome')).toContainText('Ranking saved');
  await expect(judge.getByText('Assigned target', {exact: true})).toHaveCount(1);
  await page.getByRole('button', {name: 'Check for submitted ranking'}).click();
  await page.getByRole('button', {name: 'Show hidden scene'}).click();
  await expect(page.locator('#target')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Download notes'})).toBeVisible();
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
    await page.getByLabel('Trial type', {exact: true}).selectOption(condition);
    await page.getByRole('button', {name: 'Run AI experiment'}).click();
    await expect(page.locator('#experimentResult h3')).toContainText('Ready to compare');
  }
  await expect(page.locator('#experimentHistory button')).toHaveCount(3);
  const url = await page.locator('#experimentResult').getByRole('link').getAttribute('href');
  const judge = await page.context().newPage(); await judge.goto(url);
  for (let i = 0; i < 5; i++) await judge.locator('#candidates select').nth(i).selectOption('1');
  await judge.getByRole('button', {name: 'Submit final ranking'}).click();
  await expect(judge.getByRole('alert')).toContainText('exactly once');
  for (let i = 0; i < 5; i++) await judge.locator('#candidates select').nth(i).selectOption(String(i + 1));
  await judge.getByRole('button', {name: 'Submit final ranking'}).click();
  await expect(judge.locator('#judgeOutcome')).toContainText('Ranking saved');
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
  await page.getByRole('button', {name: 'Start a session'}).click();
  await page.getByLabel('Your observations').fill('Original observation');
  await page.getByRole('button', {name: 'Save observation'}).click();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/guidance', async route => { await gate; await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'Connection interrupted. Please retry.'})}); });
  await page.getByRole('button', {name: 'Help me notice more'}).click();
  await expect(page.locator('#busy')).toContainText('Getting an optional AI question');
  await expect(page.getByRole('button', {name: 'Help me notice more'})).toBeDisabled();
  release();
  await expect(page.getByRole('alert')).toContainText('Connection interrupted');
  await expect(page.locator('#transcript .user p')).toHaveText('Original observation');
  await page.unroute('**/guidance');
  await page.getByRole('button', {name: 'Help me notice more'}).click();
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

test('experimental instructions are editable, restored, and recorded with results', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'AI experiments', exact: true}).click();
  await page.getByText('Experimental Instructions', {exact: true}).click();
  await expect(page.getByLabel('System prompt')).toHaveValue(/spontaneous, speculative/);
  await page.getByLabel('User prompt').fill('Describe broad shapes and cool textures.');
  await page.getByText('Advanced settings · temperature & seed', {exact: true}).click();
  await page.getByLabel('Inference seed (optional)').fill('42');
  await page.getByRole('button', {name: 'Run AI experiment'}).click();
  await expect(page.locator('#experimentResult h3')).toHaveText('Scene chosen before writing · Ready to compare');
  await expect(page.locator('#experimentResult')).toContainText('Temperature: 0.7 · Inference seed: 42');
  await page.locator('#experimentResult summary').click();
  await expect(page.locator('#experimentResult pre')).toContainText('Describe broad shapes and cool textures.');
  await page.getByRole('button', {name: 'Restore default instructions'}).click();
  await expect(page.getByLabel('User prompt')).toHaveValue(/Generate five brief/);
  await page.getByLabel('Trial type', {exact: true}).selectOption('control');
  await expect(page.getByLabel('User prompt')).toHaveValue(/imagined scene/);
});


test('invalid AI response is shown and excluded from judging and scoring', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'AI experiments', exact: true}).click();
  await page.getByText('Experimental Instructions', {exact: true}).click();
  await page.getByLabel('User prompt').fill('Test refusal response');
  await page.getByRole('button', {name: 'Run AI experiment'}).click();
  await expect(page.locator('#experimentResult h3')).toHaveText('Scene chosen before writing · No usable observations');
  await expect(page.locator('#experimentResult')).toContainText('This trial is excluded from accuracy scoring.');
  await expect(page.locator('#experimentResult .entry')).toContainText("I'm sorry");
  await expect(page.locator('#experimentResult a')).toHaveCount(0);
  await page.getByRole('button', {name: 'Dashboard', exact: true}).click();
  await expect(page.locator('#summary')).toContainText('Invalid AI responses');
  await expect(page.locator('#trialHistory tbody tr')).toHaveCount(0);
});
