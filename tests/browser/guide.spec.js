const { test, expect } = require('@playwright/test');

test('guide links, contents and keyboard navigation work without changing lab state', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Start a session'}).click();
  await page.getByLabel('Your observations').fill('An unsaved observation');
  const opened = context.waitForEvent('page');
  await page.getByRole('link', {name: /Beginner’s guide/}).click();
  const guide = await opened;
  await guide.waitForLoadState();
  await expect(guide).toHaveTitle('Beginner’s guide · RemoteView AI Lab');
  await expect(page.getByLabel('Your observations')).toHaveValue('An unsaved observation');
  for (const link of await guide.locator('.guide-toc a').all()) {
    const href = await link.getAttribute('href');
    await link.click();
    await expect(guide.locator(href)).toBeInViewport();
  }
  await guide.goto('/guide');
  await guide.keyboard.press('Tab');
  await expect(guide.getByRole('link', {name: 'Skip to guide'})).toBeFocused();
  await guide.keyboard.press('Enter');
  await expect(guide.locator('#guide-content')).toBeInViewport();
  await expect(guide.locator('#results')).toContainText('20%');
  await expect(guide.locator('#results')).toContainText('AI consciousness');
  await guide.getByText('Is an invalid response the same as a miss?').click();
  await expect(guide.locator('#faq details').nth(1)).toHaveAttribute('open', '');
});

for (const width of [360, 390, 768, 1280]) {
  test(`guide is readable at ${width}px with no scripts or horizontal overflow`, async ({ browser }) => {
    const context = await browser.newContext({javaScriptEnabled: false, viewport: {width, height: 844}});
    const page = await context.newPage();
    await page.goto('/guide');
    await expect(page.getByRole('heading', {name: 'Your first human session'})).toBeVisible();
    const overflow = await page.locator('html').evaluate(el => el.scrollWidth > el.clientWidth);
    expect(overflow).toBe(false);
    await expect(page.locator('.guide-toc a')).toHaveCount(10);
    await page.screenshot({path: `/tmp/remoteview-guide-${width}.png`});
    await context.close();
  });
}

test('guide is available at sign-in while private APIs stay protected', async ({ page }) => {
  await page.goto('http://127.0.0.1:18766/guide');
  await expect(page.getByRole('heading', {name: 'Run one AI trial'})).toBeVisible();
  const response = await page.request.get('http://127.0.0.1:18766/api/sessions');
  expect(response.status()).toBe(401);
});
