import { expect, test } from '@playwright/test';
import { login } from './helpers';
import { errorCodeMessage } from '../src/api';

test('手机端长标题不撑宽屏幕', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 892 });
  await login(page);

  const titleStyle = await page
    .locator('.track-title strong')
    .first()
    .evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        display: computed.display,
        minWidth: computed.minWidth,
        overflow: computed.overflow,
        textOverflow: computed.textOverflow,
        whiteSpace: computed.whiteSpace,
      };
    });

  expect(titleStyle.display).toBe('block');
  expect(titleStyle.minWidth).toBe('0px');
  expect(titleStyle.overflow).toBe('hidden');
  expect(titleStyle.textOverflow).toBe('ellipsis');

  await page.evaluate(() => {
    const title = document.querySelector('.track-title strong');
    if (title) {
      title.textContent =
        '这是一个超级超级超级超级超级超级超级超级超级超级超级超级超级长的音乐标题用于测试移动端排版撑宽问题';
    }
  });

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(412);
});

test('前端 API 错误码映射与网络异常处理', () => {
  expect(errorCodeMessage('invalid_podcast_feed_url')).toBe('播客 RSS 源地址无效或不可访问。');
  expect(errorCodeMessage('invalid_podcast_audio_url')).toBe('播客音频地址无效或不可访问。');
  expect(errorCodeMessage('podcast_feed_too_large')).toBe('播客 RSS 源文件过大。');
  expect(errorCodeMessage('podcast_audio_too_large')).toBe('播客音频文件过大。');
  expect(errorCodeMessage('invalid_podcast_network_policy')).toBe('播客网络策略设置无效。');
  expect(errorCodeMessage('some_random_code_not_in_dict')).toBe('操作未完成，请重试。');
});
