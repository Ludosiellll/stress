// Рисует app-icon.png (1024x1024): тёмный круг с красной точкой.
// Запуск: node scripts/make-icon.mjs && npx tauri icon app-icon.png
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <circle cx="512" cy="512" r="512" fill="#1b1d23"/>
  <circle cx="512" cy="512" r="170" fill="#e5383b"/>
</svg>`;

const out = fileURLToPath(new URL('../app-icon.png', import.meta.url));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg}</body></html>`,
  );
  await page.screenshot({ path: out, omitBackground: true });
} finally {
  await browser.close();
}
console.log(`Записан ${out}`);
