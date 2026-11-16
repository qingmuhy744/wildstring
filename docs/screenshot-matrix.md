状态：进行中

# 截图矩阵（agent 统一入口）

`scripts/agent_shot.sh` 的唯一数据源。脚本按 `|` 解析下表，列名固定，加行即加覆盖；不要改列名，也不要在表格里写多行单元格。产物写到 `artifacts/shots/<platform>/`，每次运行先清空该目录（避免上一轮 Phone 的 PNG 混进 Pad 结果）。

- 文件名固定为 `<page>-<state>-<theme>-<width>.png`。
- `layer` 只有两档：`quick` 是自动化的确定性渲染，属于必过项，缺失时脚本退出非零；`manual` 由用户在交付前亲自看真机窗口，不算必过项，缺失只记入 `index.md` 的「not covered」。
- `how` 在 `quick` 行必须是可执行的触发点名：Playwright spec 文件 + 用例名、Android instrumented 测试类、XCTest 用例名。`manual` 行写清人工要做什么。
- 宽度 token：web 用 `1360`（Playwright desktop）与 `390`（手机宽度）；android 用 `phone`（1080×1920）与 `pad`（2560×1600）；macos 用 `wide`（1280×800）与 `narrow`（680×720）。
- 动画不靠截图验收。转场与落位继续由既有动效测试负责（Android `MotionAssertions` 等），这里只看静态布局。

## 矩阵

| platform | page | state | themes | widths | layer | how | shows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| web | podcasts-show | normal | light,dark | 1360,390 | quick | frontend/web/tests/podcast-progress.spec.ts::续听界面桌面与手机浅深主题视觉证据 | 节目页，续听进行中的单集行与进度徽标 |
| web | podcasts-show | resume-notice | light,dark | 1360,390 | manual | 在节目页播放已完成单集，先等提示条出现再截图 | 节目页 snackbar「已听完」提示与行内徽标共存 |
| web | podcasts-show | all-completed | light,dark | 1360,390 | manual | podcast-player.spec.ts 已标完第 2 集，但只截项目默认宽度；需要手工在节目页把全部单集标为听完后截图 | 全部单集已听完时的节目页，无续听入口 |
| web | podcasts-show | loading | light,dark | 1360,390 | manual | 断开测试 API 或在 devtools 里延迟 `/api/v1/podcasts` 响应后截图 | 节目页骨架/加载态 |
| web | podcasts-show | empty | light,dark | 1360,390 | manual | 用无单集的节目 fixture 打开节目页 | 空单集列表与下一步操作 |
| web | podcasts-show | error | light,dark | 1360,390 | manual | 让 `/api/v1/podcasts` 返回 5xx 后打开节目页 | 平静的错误说明与重试 |
| web | resume-dialog | ask | light,dark | 1360,390 | quick | frontend/web/tests/podcast-progress.spec.ts::续听界面桌面与手机浅深主题视觉证据 | 「播客单集进度」询问弹窗 |
| web | podcasts-show | conflict | light,dark | 1360,390 | quick | frontend/web/tests/podcast-progress.spec.ts::续听界面桌面与手机浅深主题视觉证据 | 节目页冲突提示（用本机进度）与播放条 |
| web | settings | podcast-resume | light,dark | 1360,390 | quick | frontend/web/tests/podcast-progress.spec.ts::续听界面桌面与手机浅深主题视觉证据 | 个人设置里的播客单集接续选项 |
| web | settings | podcast-resume-error | light,dark | 1360,390 | quick | frontend/web/tests/podcast-progress.spec.ts::续听界面桌面与手机浅深主题视觉证据 | 个人设置保存失败时的错误提示 |
| android | podcasts-show | normal | light,dark | phone,pad | quick | PodcastResumeUiTest | 节目页，续听单集行 |
| android | podcasts-show | resume-notice | light,dark | phone,pad | quick | PodcastResumeUiTest | 节目页 snackbar 提示 |
| android | podcasts-show | all-completed | light,dark | phone,pad | manual | 模拟器上手动把全部单集标为听完后 `adb exec-out screencap -p > x.png` | 全部单集已听完的节目页 |
| android | player | conflict | light,dark | phone,pad | quick | PodcastResumeUiTest | 播放页冲突提示「使用本机进度」 |
| android | player | takeover | light,dark | phone,pad | quick | PodcastResumeUiTest | 点掉冲突提示后的播放页 |
| android | episode-menu | normal | light,dark | phone,pad | quick | PodcastResumeUiTest | 单集操作菜单（进行中单集） |
| android | episode-menu | completed | light,dark | phone,pad | quick | PodcastResumeUiTest | 单集操作菜单（已完成单集，出现「标为未听」） |
| android | ask-dialog | ask | light,dark | phone,pad | quick | PodcastResumeUiTest | 开始收听前的询问弹窗 |
| android | settings | podcast-resume | light,dark | phone,pad | quick | PodcastResumeUiTest | 播客设置页的续听方式 |
| macos | podcasts-show | narrow | light,dark | narrow | quick | MacAssistantTests.podcastsNarrowViewWithBufferingRowRendersInBothSchemes | 窄栏节目页与缓冲中的单集行 |
| macos | podcasts-show | normal | light,dark | wide | manual | 真机运行后打开节目页，交付前人工看一次 | 宽栏节目页 |
| macos | podcasts-show | all-completed | light,dark | wide,narrow | manual | 真机上把全部单集标为听完后人工截图 | 全部单集已听完的节目页 |
| macos | queue | open | light,dark | wide | quick | MacAssistantTests.queuePopupKeepsShellLayoutStableAndRendersFavoritesInBothSchemes | 队列浮层打开时的外壳布局 |
| macos | player | conflict | light,dark | wide | quick | MacAssistantTests.renderPodcastResumeSurfacesWithIsolatedSession | 播放器条上的续听冲突提示 |
| macos | resume-dialog | ask | light,dark | wide,narrow | manual | 真机配置为「询问」后点播单集，人工截图 | 续听询问弹窗 |
| macos | settings | podcast-resume | light,dark | wide | quick | MacAssistantTests.renderPodcastResumeSurfacesWithIsolatedSession | 设置页（含播客续听项） |
| ios | podcasts-show | normal | light,dark | phone,pad | manual | 模拟器人工打开节目页，`xcrun simctl io booted screenshot` | 节目页 |
| ios | podcasts-show | all-completed | light,dark | phone,pad | manual | 模拟器人工标完所有单集后截图 | 全部单集已听完的节目页 |
| ios | now-playing | playing | light,dark | phone,pad | manual | 模拟器人工播放后截图 | 正在播放 |
| ios | settings | podcast-resume | light,dark | phone,pad | manual | 模拟器人工打开设置后截图 | 设置页 |

## 现状与缺口

- web 与 android 的 `quick` 行全部由现有 spec / instrumented 测试的实际产物支撑，脚本只做复制与改名，不重跑页面流程；`manual` 行没有自动化触发，不编造覆盖。
- Android 的 `quick` 行只来自 `PodcastResumeUiTest`：它在测试内按 `screenWidthDp >= 600` 分 `phone`/`pad`，按主题循环输出 8 种状态，两种 AVD 都在 `hw.keyboard=yes` 下运行（脚本会校验，缺失即失败）。
- macOS 的 `quick` 行只复用既有 `WILDSTRING_SCREENSHOT_DIR` 输出；宽栏节目页、播放器条、续听弹窗与设置页目前没有快照用例，标 `manual`。新增快照测试属于后续范围，本轮不碰 `frontend/`。
- iOS 目前没有渲染到 PNG 的测试目标，全部 `manual`。`scripts/agent_shot.sh ios` 会明确报告「quick 层未实现」，并给出 `simctl` 人工命令，宿主为 CI 时如实记为缺口。
- 真机窗口层（窗口装饰、材质、焦点环、真实动画）不在本矩阵范围内，由用户在交付前按脚本 `--window` 打印的步骤人工签收。
