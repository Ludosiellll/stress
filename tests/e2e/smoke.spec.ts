import { expect, test } from '@playwright/test';

test('открывается главная страница с заголовком', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Тренажёр отбора' })).toBeVisible();
});
