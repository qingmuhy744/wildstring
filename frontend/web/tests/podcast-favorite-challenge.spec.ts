import { expect, test } from '@playwright/test';
import { login, podcastCatalog } from './helpers';

test.skip(process.env.WILDSTRING_TEST_PODCAST !== '1', 'Requires the isolated podcast fixture.');

test.describe('Milestone 2 Adversarial Challenge: Web Episode Favoriting & Synchronization', () => {
  test('1. Filter by "已收藏": 0 favorited vs some favorited vs dynamic unfavorite', async ({
    page,
  }) => {
    await login(page);
    await podcastCatalog(page);
    await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();

    // Switch to "全部单集" scope so all 7 episodes are visible
    await page.getByRole('button', { name: /全部单集/ }).click();

    const episodeRows = page.locator('.podcast-episode-row');
    await expect(episodeRows).toHaveCount(7);

    const filterAll = page.getByRole('button', { name: '全部', exact: true });
    const filterFavorited = page.getByRole('button', { name: '已收藏' });

    // Step 1: When no episodes are favorited, click "已收藏"
    await filterFavorited.click();
    await expect(filterFavorited).toHaveClass(/active/);
    await expect(episodeRows).toHaveCount(0);
    await expect(page.getByText('未找到匹配条件的单集，请调整搜索或筛选条件')).toBeVisible();

    // Clicking "已收藏" again toggles back to "all"
    await filterFavorited.click();
    await expect(filterFavorited).not.toHaveClass(/active/);
    await expect(filterAll).toHaveClass(/active/);
    await expect(episodeRows).toHaveCount(7);

    // Step 2: Favorite some episodes
    // Favorite Episode 1 via Dialog
    const ep1Title = '第 1 集：给午后的一封声音来信';
    const ep2Title = '第 2 集：给午后的一封声音来信';

    await page.getByRole('button', { name: ep1Title, exact: true }).click();
    const dialog1 = page.getByRole('dialog', { name: ep1Title });
    await expect(dialog1).toBeVisible();
    const favBtnInDialog1 = dialog1.locator('.episode-favorite-btn');
    await expect(favBtnInDialog1).toContainText('单集收藏');
    await favBtnInDialog1.click();
    await expect(favBtnInDialog1).toContainText('取消收藏');
    await expect(favBtnInDialog1).toHaveClass(/active/);
    await dialog1.getByRole('button', { name: '关闭详情' }).click();
    await expect(dialog1).toHaveCount(0);

    // Favorite Episode 2 via RowMenu
    const ep2Row = episodeRows.filter({ hasText: ep2Title });
    await ep2Row.locator('.row-menu-trigger').click();
    const rowMenuFavBtn = page.getByRole('menuitem', { name: '单集收藏' });
    await expect(rowMenuFavBtn).toBeVisible();
    await rowMenuFavBtn.click();
    await expect(page.getByText('已加入单集收藏')).toBeVisible();

    // Step 3: Filter by "已收藏" when some (2) episodes are favorited
    await filterFavorited.click();
    await expect(filterFavorited).toHaveClass(/active/);
    await expect(episodeRows).toHaveCount(2);
    await expect(episodeRows.filter({ hasText: ep1Title })).toHaveCount(1);
    await expect(episodeRows.filter({ hasText: ep2Title })).toHaveCount(1);

    // Step 4: Sorting within "已收藏"
    const sortBtn = page.locator('.podcast-sort-direction');
    const firstBefore = await episodeRows.first().locator('.episode-title').innerText();
    await sortBtn.click();
    const firstAfter = await episodeRows.first().locator('.episode-title').innerText();
    expect(firstAfter).not.toBe(firstBefore);

    // Step 5: Search within "已收藏"
    const searchInput = page.getByPlaceholder('搜索单集...');
    await searchInput.fill('第 1 集');
    await expect(episodeRows).toHaveCount(1);
    await expect(episodeRows.first()).toContainText(ep1Title);
    await searchInput.clear();
    await expect(episodeRows).toHaveCount(2);

    // Step 6: Dynamic removal while "已收藏" filter is active
    // Unfavorite Episode 1 via RowMenu
    const ep1RowInFav = episodeRows.filter({ hasText: ep1Title });
    await ep1RowInFav.locator('.row-menu-trigger').click();
    const ep1UnfavMenuItem = page.getByRole('menuitem', { name: '取消收藏' });
    await expect(ep1UnfavMenuItem).toBeVisible();
    await ep1UnfavMenuItem.click();
    await expect(page.getByText('已取消单集收藏')).toBeVisible();

    // Episode 1 must be immediately removed from the filtered list
    await expect(episodeRows).toHaveCount(1);
    await expect(episodeRows.filter({ hasText: ep1Title })).toHaveCount(0);
    await expect(episodeRows.filter({ hasText: ep2Title })).toHaveCount(1);

    // Unfavorite Episode 2 via Dialog while "已收藏" filter is active
    await episodeRows.filter({ hasText: ep2Title }).locator('.episode-title').click();
    const dialog2 = page.getByRole('dialog', { name: ep2Title });
    await expect(dialog2).toBeVisible();
    const favBtnInDialog2 = dialog2.locator('.episode-favorite-btn');
    await expect(favBtnInDialog2).toContainText('取消收藏');
    await favBtnInDialog2.click();
    await expect(favBtnInDialog2).toContainText('单集收藏');
    await dialog2.getByRole('button', { name: '关闭详情' }).click();

    // Now 0 episodes match "已收藏", should immediately show empty state
    await expect(episodeRows).toHaveCount(0);
    await expect(page.getByText('未找到匹配条件的单集，请调整搜索或筛选条件')).toBeVisible();

    // Switch back to "全部"
    await filterAll.click();
    await expect(episodeRows).toHaveCount(7);
  });

  test('2. Favorite toggle synchronization between PodcastEpisodeDialog and RowMenu', async ({
    page,
  }) => {
    await login(page);
    await podcastCatalog(page);
    await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();

    // Switch to "全部单集" scope
    await page.getByRole('button', { name: /全部单集/ }).click();

    const targetTitle = '第 3 集：给午后的一封声音来信';
    const targetRow = page.locator('.podcast-episode-row').filter({ hasText: targetTitle });

    // Step 1: Initial state in RowMenu is "单集收藏"
    await targetRow.locator('.row-menu-trigger').click();
    await expect(page.getByRole('menuitem', { name: '单集收藏' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Step 2: Open Dialog, toggle to favorited
    await targetRow.locator('.episode-title').click();
    const dialog = page.getByRole('dialog', { name: targetTitle });
    await expect(dialog).toBeVisible();

    const favBtn = dialog.locator('.episode-favorite-btn');
    await expect(favBtn).toContainText('单集收藏');
    await expect(favBtn).not.toHaveClass(/active/);

    await favBtn.click();
    await expect(favBtn).toContainText('取消收藏');
    await expect(favBtn).toHaveClass(/active/);
    await expect(page.getByText('已加入单集收藏')).toBeVisible();

    // Close Dialog
    await dialog.getByRole('button', { name: '关闭详情' }).click();
    await expect(dialog).toHaveCount(0);

    // Step 3: Check RowMenu in row — must be synchronized to "取消收藏"
    await targetRow.locator('.row-menu-trigger').click();
    const unfavMenuItem = page.getByRole('menuitem', { name: '取消收藏' });
    await expect(unfavMenuItem).toBeVisible();

    // Toggle back via RowMenu
    await unfavMenuItem.click();
    await expect(page.getByText('已取消单集收藏')).toBeVisible();

    // Step 4: Re-open Dialog — must be synchronized back to "单集收藏"
    await targetRow.locator('.episode-title').click();
    const reopenedDialog = page.getByRole('dialog', { name: targetTitle });
    await expect(reopenedDialog).toBeVisible();
    const reopenedFavBtn = reopenedDialog.locator('.episode-favorite-btn');
    await expect(reopenedFavBtn).toContainText('单集收藏');
    await expect(reopenedFavBtn).not.toHaveClass(/active/);

    // Step 5: Rapid toggle inside Dialog
    await reopenedFavBtn.click();
    await expect(reopenedFavBtn).toContainText('取消收藏');
    await expect(reopenedFavBtn).toHaveClass(/active/);

    await reopenedFavBtn.click();
    await expect(reopenedFavBtn).toContainText('单集收藏');
    await expect(reopenedFavBtn).not.toHaveClass(/active/);

    // Step 6: Responsive layout check on narrow viewports
    for (const width of [320, 393, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await reopenedDialog.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }

    await reopenedDialog.getByRole('button', { name: '关闭详情' }).click();
  });

  test('3. Stress-test: all episodes favorited and zero-episode podcast boundary', async ({
    page,
  }) => {
    // Intercept podcast detail endpoint to mock all episodes favorited
    await page.route('**/api/v1/podcasts/radio-test', async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      for (const ep of detail.episodes) {
        ep.favorite = true;
      }
      await route.fulfill({ response, json: detail });
    });

    await login(page);
    await podcastCatalog(page);
    await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
    await page.getByRole('button', { name: /全部单集/ }).click();

    const episodeRows = page.locator('.podcast-episode-row');
    await expect(episodeRows).toHaveCount(7);

    // When all are favorited, clicking "已收藏" should still show all 7 episodes
    const filterFavorited = page.getByRole('button', { name: '已收藏' });
    await filterFavorited.click();
    await expect(filterFavorited).toHaveClass(/active/);
    await expect(episodeRows).toHaveCount(7);

    // Verify boundary: unroute and route with 0 episodes
    await page.unroute('**/api/v1/podcasts/radio-test');
    await page.route('**/api/v1/podcasts/radio-test', async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      detail.episodes = [];
      await route.fulfill({ response, json: detail });
    });

    // Navigate back to catalog and re-enter podcast
    await page.getByRole('button', { name: /返回电台列表/ }).click();
    await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();

    // Verify zero-episode empty state
    await expect(page.getByText('暂无单集')).toBeVisible();
    await expect(episodeRows).toHaveCount(0);
  });

  test('4. Adversarial Network Failure: API 500 error prevents state desync', async ({ page }) => {
    await login(page);
    await podcastCatalog(page);
    await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
    await page.getByRole('button', { name: /全部单集/ }).click();

    const targetTitle = '第 4 集：给午后的一封声音来信';
    const targetRow = page.locator('.podcast-episode-row').filter({ hasText: targetTitle });

    // Mock failure for favorite endpoint
    await page.route('**/api/v1/podcasts/episodes/*/favorite', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Simulated backend failure' }),
      });
    });

    // Attempt favorite via Dialog
    await targetRow.locator('.episode-title').click();
    const dialog = page.getByRole('dialog', { name: targetTitle });
    await expect(dialog).toBeVisible();

    const favBtn = dialog.locator('.episode-favorite-btn');
    await expect(favBtn).toContainText('单集收藏');

    await favBtn.click();

    // Verify error toast
    await expect(page.getByText('暂时无法更新收藏状态，请重试')).toBeVisible();

    // State MUST NOT have flipped to "取消收藏" because backend failed
    await expect(favBtn).toContainText('单集收藏');
    await expect(favBtn).not.toHaveClass(/active/);

    await dialog.getByRole('button', { name: '关闭详情' }).click();

    // Check RowMenu — must also remain "单集收藏"
    await targetRow.locator('.row-menu-trigger').click();
    await expect(page.getByRole('menuitem', { name: '单集收藏' })).toBeVisible();
  });

  test('5. Multi-format property compatibility (favorite / favorited / loved)', async ({
    page,
  }) => {
    // Intercept podcast detail to test different property flags
    await page.route('**/api/v1/podcasts/radio-test', async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      // Episode 0 has favorite
      detail.episodes[0].favorite = true;
      // Episode 1 has favorited
      detail.episodes[1].favorited = true;
      // Episode 2 has loved
      detail.episodes[2].loved = true;
      // Rest are false
      for (let i = 3; i < detail.episodes.length; i++) {
        detail.episodes[i].favorite = false;
        detail.episodes[i].favorited = false;
        detail.episodes[i].loved = false;
      }
      await route.fulfill({ response, json: detail });
    });

    await login(page);
    await podcastCatalog(page);
    await page.locator('.podcast-card').filter({ hasText: '午后广播测试' }).click();
    await page.getByRole('button', { name: /全部单集/ }).click();

    const filterFavorited = page.getByRole('button', { name: '已收藏' });
    await filterFavorited.click();

    // All three property conventions must be recognized
    const episodeRows = page.locator('.podcast-episode-row');
    await expect(episodeRows).toHaveCount(3);
  });
});
