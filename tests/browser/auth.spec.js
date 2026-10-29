const { test, expect } = require('@playwright/test');

test('password admission, logout, and re-login preserve private history', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:18766/');
  await expect(page.locator('#loginPanel')).toBeVisible();
  await expect(page.locator('#humanPanel')).toBeHidden();
  await page.getByLabel('Application password').fill('wrong-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('That password didn’t match');
  await expect(page.getByLabel('Application password')).toHaveValue('');
  await page.getByLabel('Application password').fill('browser-test-only-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.locator('#humanPanel')).toBeVisible();
  await page.getByRole('button', {name: 'Start a session'}).click();
  await page.getByLabel('Your observations').fill('Private original observation');
  await page.getByRole('button', {name: 'Save observation'}).click();
  await expect(page.locator('#transcript')).toContainText('Private original observation');
  await page.getByRole('button', {name: 'Sign out', exact: true}).click();
  await expect(page.locator('#loginPanel')).toBeVisible();
  await expect(page.locator('#transcript')).toBeEmpty();
  await page.getByLabel('Application password').fill('browser-test-only-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await page.locator('#sessions button').first().click();
  await expect(page.locator('#transcript')).toContainText('Private original observation');
  expect(errors).toEqual([]);
});

test('expired authentication hides and clears private workspace', async ({ page }) => {
  await page.goto('http://127.0.0.1:18766/');
  await page.getByLabel('Application password').fill('browser-test-only-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await page.getByRole('button', {name: 'Start a session'}).click();
  await page.getByLabel('Your observations').fill('Unsaved private note');
  await page.route('**/api/dashboard', route => route.fulfill({status: 401, contentType: 'application/json', body: '{"error":"Authentication required"}'}));
  await page.getByRole('button', {name: 'Dashboard', exact: true}).click();
  await expect(page.locator('#loginPanel')).toBeVisible();
  await expect(page.locator('#humanPanel')).toBeHidden();
  await expect(page.getByLabel('Your observations')).toHaveValue('');
});

test('another tab can rotate authentication without stranding POST requests', async ({ page, context }) => {
  await page.goto('http://127.0.0.1:18766/');
  await page.getByLabel('Application password').fill('browser-test-only-password');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await page.getByRole('button', {name: 'Start a session'}).click();
  const second = await context.newPage();
  await second.goto('http://127.0.0.1:18766/');
  await second.getByRole('button', {name: 'Sign out', exact: true}).click();
  await second.getByLabel('Application password').fill('browser-test-only-password');
  await second.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(second.locator('#humanPanel')).toBeVisible();
  await page.getByLabel('Your observations').fill('Observation after another tab signed in');
  await page.getByRole('button', {name: 'Save observation'}).click();
  await expect(page.locator('#transcript')).toContainText('Observation after another tab signed in');
  await expect(page.getByRole('alert')).toBeHidden();
});
