# RSS 添加与授权的本地验证

此模拟提供 RSS 2.0 XML 和独立的合成音频传输夹具，供真实 WildString 后端走 HTTP 获取、解析、入库和关注。
域名 `rss.wildstring.test` 由本地 Postman 代理接管，无需 DNS 或访问实际节目源；音乐、账号、数据库和后端均使用真实的临时测试实例。

从仓库根目录在两个终端启动：

```sh
postman simulation run contracts/checks/rss.sim.yaml --proxy --proxy-port 18812 --no-history --output ndjson
```

```sh
WILDSTRING_TEST_PODCAST=1 WILDSTRING_TEST_LIBRARIES=1 WILDSTRING_WEB_TEST_PORT=18813 \
HTTP_PROXY=http://127.0.0.1:18812 HTTPS_PROXY=http://127.0.0.1:18812 ALL_PROXY=http://127.0.0.1:18812 \
http_proxy=http://127.0.0.1:18812 https_proxy=http://127.0.0.1:18812 all_proxy=http://127.0.0.1:18812 \
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost make web-test-server
```

确认代理已启动、临时后端 `/health/ready` 为正常后运行：

```sh
postman collection run contracts/checks/catalog-access.postman_collection.json --no-report-events
```

脚本先核对 `radio-test` 的测试标题再继续。登录密码均为隔离测试夹具常量。不要将地址改为已有用户实例。
测试完分别在启动终端中结束进程，临时数据库自动移除。现有开发服务的 18780/18781 不受影响。

注意：代理环境变量的大小写均需设置，避免终端已有小写代理覆盖本轮值。代理会转发不匹配的域名；`catalog-access` 集合的音频策略为 `none`，不下载示例 enclosure；个人策略集合使用 `/policies.xml` 及同一模拟域名下的 `/audio/{2..6}.mp3`，验证共享传输字节。模拟不访问真实源站。模拟不热更新，编辑后需重启。不要重新生成 XML handler：生成器会给字符串包一层 XML element，与 RSS 根节点不符。

2026-10-26 本地验证：35 个请求、48 条断言全部通过；覆盖新用户默认授权、显式空授权、所有者目录浏览、普通用户越权拒绝、RSS 开关开启和关闭、真实 XML 解析、新增后个人关注、重复节目复用、畸形 XML 和私网 URL 拒绝。代理记录本轮后端只请求一次 `/feed.xml` 和一次 `/broken.xml`；重复添加没有再次获取 RSS。未发布到 Postman 云、未验证远程 CI 或真实源站。


2026-10-26 schema 40 补充验证：原目录集合 35 请求/48 断言继续通过。`podcast-personal-settings.postman_collection.json` 在独立 `Storage Resource Fixture` 后端运行，31 请求/45 断言通过；服务端真实获取并解析六集 RSS，两个账号分别配置最新 5/3 集，下载仅发生在 6/5/4/3/2。重复添加不额外获取 RSS，重复刷新两次不下载第 1 集。手动保存复用已有字节，关闭自己的自动策略不影响另一用户引用，已知 ID 与不匹配的账号标头均不能越权。该音频为合成传输字节，编码播放不在此模拟中验收。
