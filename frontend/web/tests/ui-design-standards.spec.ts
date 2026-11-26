import { expect, test, type Locator, type Page } from '@playwright/test';
import { login, podcastCatalog } from './helpers';

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => {
    localStorage.setItem('wildstring-theme', value);
    window.dispatchEvent(new CustomEvent('wildstring:theme-changed', { detail: value }));
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function expectReadableText(label: Locator, minimumSize: number) {
  await expect(label).toBeVisible();
  const size = await label.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(size, `font size for ${await label.innerText()}`).toBeGreaterThanOrEqual(minimumSize);
}

async function expectBottomPlayButton(page: Page, isMobile: boolean) {
  const play = page.locator('.player .play-button');
  await expect(play).toHaveCSS('width', '38px');
  await expect(play).toHaveCSS('height', '38px');
  await expect(play.locator('.playback-glyph')).toHaveCSS('width', '24px');
  const colors = (hover: boolean) =>
    play.evaluate((button, hovered) => {
      const computed = getComputedStyle(button);
      const sample = document.createElement('span');
      sample.style.color = computed.getPropertyValue(hovered ? '--accent-hover' : '--accent');
      sample.style.backgroundColor = computed.getPropertyValue('--on-accent');
      button.append(sample);
      const expected = getComputedStyle(sample);
      const actual = { background: computed.backgroundColor, color: computed.color };
      const tokens = { background: expected.color, color: expected.backgroundColor };
      const hoveredNow = button.matches(':hover');
      sample.remove();
      return { actual, tokens, hoveredNow };
    }, hover);
  const normal = await colors(false);
  expect(normal.actual).toEqual(normal.tokens);
  if (!isMobile) {
    await play.hover();
    await expect
      .poll(async () => {
        const { actual, tokens, hoveredNow } = await colors(true);
        return { actual, tokens, hoveredNow };
      })
      .toMatchObject({ actual: (await colors(true)).tokens, hoveredNow: true });
    await page.mouse.move(1, 1);
  }
}

async function expectContrast(label: Locator) {
  await expect(label).toBeVisible();
  const ratio = await label.evaluate(async (element) => {
    function rgba(color: string) {
      const channels = color.match(/-?[\d.]+/g)!.map(Number);
      const scale = color.startsWith('color(srgb') ? 255 : 1;
      return [...channels.slice(0, 3).map((value) => value * scale), channels[3] ?? 1];
    }
    function over(color: number[], background: number[]) {
      return color.slice(0, 3).map((value, index) => {
        return value * color[3] + background[index] * (1 - color[3]);
      });
    }
    function luminance(rgb: number[]) {
      const linear = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }

    const surfaces: Element[] = [];
    for (let surface: Element | null = element; surface; surface = surface.parentElement) {
      surfaces.push(surface);
    }
    await Promise.allSettled(
      surfaces.flatMap((surface) =>
        surface
          .getAnimations()
          .filter(
            (animation) =>
              animation instanceof CSSTransition &&
              ['color', 'background-color'].includes(animation.transitionProperty),
          )
          .map((animation) => animation.finished),
      ),
    );

    // These checks use flat backgrounds, composited from the nearest opaque surface.
    const layers: number[][] = [];
    for (const surface of surfaces) {
      const style = getComputedStyle(surface);
      if (style.backgroundImage !== 'none') throw new Error('Expected a flat background');
      const color = rgba(style.backgroundColor);
      layers.unshift(color);
      if (color[3] === 1) break;
    }
    if (layers[0][3] !== 1) throw new Error('Expected an opaque background behind the label');
    const background = layers.reduce((behind, color) => over(color, behind));
    const ink = luminance(over(rgba(getComputedStyle(element).color), background));
    const surface = luminance(background);
    return (Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05);
  });
  expect(ratio, `contrast for ${await label.innerText()}`).toBeGreaterThanOrEqual(4.5);
}

test('曲库和播放栏显示可辨认的功能文字与当前曲目', async ({ page, isMobile }, info) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 900 });
  await login(page);
  const table = page.getByRole('table', { name: '歌曲列表' });
  const track = table.getByRole('row').nth(1);
  const title = track.locator('.track-title strong');
  await track.getByRole('button').first().click();
  await expect(track).toHaveClass(/\bcurrent\b/);
  await page.mouse.move(1, 1);

  const player = page.locator('.player');
  const selectedView = page.locator('.view-switch').getByRole('button', { name: '歌曲' });
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await expectBottomPlayButton(page, isMobile);
    await expectReadableText(table.getByRole('columnheader', { name: '歌曲 / 艺人' }), 11);
    await expectReadableText(player.locator('.timeline time').first(), 11);
    await expectReadableText(player.getByRole('button', { name: '播放队列' }).locator('small'), 11);
    await expectContrast(title);
    await expectContrast(track.locator('time'));
    await expect(selectedView).toHaveAttribute('aria-pressed', 'true');
    await selectedView.hover();
    await expectContrast(selectedView);
    await page.mouse.move(1, 1);
    if (isMobile) {
      await expectReadableText(selectedView, 12);
      await expectReadableText(page.getByRole('button', { name: /刷新曲库/ }), 12);
      await expectReadableText(page.getByRole('button', { name: '播放全部', exact: true }), 12);
    } else {
      await expectReadableText(page.locator('.sidebar-group-label').first(), 11);
      await expectReadableText(track.locator('.format'), 11);
      await expectContrast(track.locator('.album-column'));
    }
    await page.screenshot({ path: info.outputPath(`music-${theme}.png`), animations: 'disabled' });
  }
});

test('播客状态与收音机显示可辨认的操作和时间', async ({ page, isMobile }, info) => {
  test.skip(process.env.WILDSTRING_TEST_PODCAST !== '1', 'Use make test-podcast-web.');
  if (isMobile) await page.setViewportSize({ width: 390, height: 900 });
  await login(page);
  await podcastCatalog(page);
  await expect(page.getByRole('heading', { name: '播客', exact: true })).toBeVisible();
  const card = page.locator('.podcast-card').filter({ hasText: '午后广播测试' });
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await expectReadableText(card.locator('.podcast-card-unplayed'), 12);
    await expectContrast(card.locator('.podcast-card-unplayed'));
    await page.screenshot({
      path: info.outputPath(`podcasts-${theme}.png`),
      animations: 'disabled',
    });
  }

  await card.click();
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await expectContrast(page.locator('.podcast-meta-author'));
    await expectContrast(page.locator('.unplayed-tag'));
    await expectContrast(page.locator('.ep-download-badge').first());
    await expectContrast(page.getByRole('button', { name: '全部', exact: true }));
    await page.screenshot({
      path: info.outputPath(`podcast-detail-${theme}.png`),
      animations: 'disabled',
    });
  }

  await page.locator('.episode-play-btn').first().click();
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await expectBottomPlayButton(page, isMobile);
    await page.screenshot({
      path: info.outputPath(`podcast-transport-${theme}.png`),
      animations: 'disabled',
    });
  }
  await page.getByRole('button', { name: '全屏播放', exact: true }).click();
  await expect(page.locator('.retro-radio')).toHaveAttribute('data-live', 'true');
  await page.getByRole('button', { name: '收音机暂停', exact: true }).click();
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await expectReadableText(page.getByText('已暂停', { exact: true }), 12);
    await expectReadableText(page.locator('.retro-time small'), 11);
    await expectReadableText(page.locator('.retro-volume .retro-caption').last(), 11);
    await expectReadableText(page.getByText('跳过已听完', { exact: true }), 12);
    await expectReadableText(page.locator('.newspaper-edition span').last(), 12);
    await expectReadableText(page.locator('.newspaper-byline span').first(), 12);
    await expectReadableText(page.getByText(/滚动阅读/), 12);
    await page.locator('.retro-radio').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`podcast-radio-${theme}.png`),
      animations: 'disabled',
    });
    if (isMobile) {
      await page.locator('.newspaper-footer').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`podcast-journal-${theme}.png`),
        animations: 'disabled',
      });
    }
  }
  if (!isMobile) {
    await page.setViewportSize({ width: 680, height: 450 });
    const stage = (await page.locator('.podcast-stage').boundingBox())!;
    const transport = (await page.locator('.fullscreen-controls').boundingBox())!;
    expect(stage.x).toBeCloseTo(transport.x);
    expect(stage.width).toBeCloseTo(transport.width);
  }
});
