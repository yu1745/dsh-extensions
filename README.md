# DSH Extensions

一个 GitHub 分发的包，包含多个可独立启停的 DSH 插件。当前包含一期网页工具与额度功能，以及二期 CodeBuddy / Antigravity 模型接入，适配 **DSH 0.2.1-alpha.4 / Node.js 22+**。

| 插件 | 功能 |
| --- | --- |
| `yu-web-search` | Google Antigravity、OpenAI Codex、DeepSeek、MiniMax、ZAI 五后端，保留各自原生参数 |
| `yu-web-reader` | Playwright 渲染、ARIA 提取、动态加载判断、Cloudflare 处理、截图与 DSH 附件 |
| `yu-providers` | CodeBuddy、Antigravity 模型、浏览器登录与 DSH 凭据自动刷新 |
| `yu-quota` | 五源额度、余额与历史曲线；Codex 跨设备账本；本机和原生子代理费用；底栏会话计费 |
| `yu-codex-fast` | 会话级 `/fast`、`/ultrafast`、`/codex-speed`；子会话继承创建时快照 |

额度来源为 DeepSeek、GLM、MiniMax、OpenAI Codex、Antigravity。后台在 DSH 运行期间每分钟刷新，不依赖浏览器打开；同一个 DSH home 的多个进程共用轮询锁。

## 安装

推荐从 [GitHub Releases](https://github.com/yu1745/dsh-extensions/releases) 安装预构建包：

```bash
dsh plugin --profile web add 'https://github.com/yu1745/dsh-extensions/releases/download/v0.2.0-alpha.4/yu1745-dsh-extensions-0.2.0-alpha.4.tgz'
```

或安装固定版本的 GitHub 源码：

```bash
dsh plugin --profile web add 'github:yu1745/dsh-extensions#v0.2.0-alpha.4'
```

源码安装需要运行 `prepare` 构建。若 pnpm 要求构建授权，在该 profile 的 `pnpm-workspace.yaml` 中合并：

```yaml
allowBuilds:
  '@yu1745/dsh-extensions': true
```

然后重新安装。`headless` profile 使用同一个包，将命令中的 `web` 改为 `headless`。Web 专用的三个预设 patch 在 headless 中会被跳过；`--dump-config` 可能显示对应的“entry not found”提示。包会启用 headless 的本地 credentials 和 authorization 服务，以便查询额度和使用已有 DSH 凭据。

首次使用网页读取前，安装 Playwright 浏览器：

```bash
npx playwright@1.61.0 install chromium chromium-headless-shell
```

Linux 默认使用带界面的浏览器以处理 WAF；没有可用显示器时需要 `Xvfb` 和 `xdpyinfo`。可以设置 `DSH_WEBREADER_HEADLESS=1` 使用无头模式，复杂 WAF 的通过率可能降低。也支持 `DSH_WEBREADER_CDP` 连接已有浏览器。

## 初次迁移 Pi 凭据

安装不会自动读取全部 Pi 密钥。需要从本机 Pi 迁移时，在 profile 的 `cordis.patch.yml` 中加入一次性导入配置：

```yaml
- id: yu-extensions
  name: '@yu1745/dsh-extensions'
  config:
    importPi: true
```

导入只补充 DSH 中缺失的 DeepSeek、GLM、MiniMax、TypeSafe、OpenRouter 密钥和 Codex grant，保留 Pi 原文件。搜索后端、额度历史和 Codex 首日校准设置也会复制。导入标记和数据保存在 `$DSH_HOME/extensions/yu1745/`，密钥由 DSH credentials 服务持有。

CodeBuddy 和 Antigravity 的 OAuth 由 `yu-providers` 管理，保存在 DSH credentials 的 `llm-pi-ai/codebuddy` 与 `llm-pi-ai/antigravity`，刷新由 DSH 的凭据锁串行化。模型、Antigravity 搜索和额度查询共用这份授权；运行时不再读取 Pi 的 token。

在 **额度与费用 → 服务登录** 中登录或重新授权。Antigravity 支持本机回调，也支持远程浏览器完成登录后粘贴完整回调 URL。CodeBuddy 支持浏览器授权或导入本机官方 CLI 的已有凭据。不要让 Pi 与 DSH 同时刷新同一份迁移授权；迁移时先备份并验证 DSH 写入，再移除 Pi 中对应条目。

CodeBuddy 从账号的 `/v3/config` 获取模型目录并缓存，发现失败时使用上次目录。**不提供 FP 开关，不替换系统提示词或工具定义，不发送模拟遥测**。请求保留服务端所需的认证和客户端协议头；DSH 的工具调用、推理档位、取消信号和会话标识直接传递。

## 使用

- 输入框的模型菜单按 **提供方 → 模型** 两级选择，点击提供方后在侧边弹出模型子菜单，父菜单保持位置和尺寸；推理档位也使用侧边子菜单。显示各提供方模型数量，支持搜索、方向键和 Enter；Escape 先关闭子菜单。

- 打开右侧栏，在“开始”页选择 **额度与费用**；已有对话的输入框下方也提供入口、当前提供方摘要和本会话计费，同时显示所有可用额度窗口（例如 `5h 剩余 80% · 周 剩余 60%`）。
- 面板中的搜索后端是新会话默认值；当前会话通过下方命令即时切换。Decision 服务和模型保存后需重新加载读取插件或重启 DSH。
- 输入 `/websearch-backend`，从指令菜单选中或按回车，会在输入框上方展开五个后端候选；支持搜索、方向键和回车选择，标记当前会话的后端。也可直接输入 `/websearch-backend zai`，无效参数会被拒绝。选择后在当前空闲会话立即生效，恢复会话后保留，不影响其他会话；工具参数和提示词随后端变化，提示缓存可能失效。
- 网页判断通过 PiAI 的通用 `Models.classify` 调用。默认 `typesafe / jev-latest`，也支持 `openai / gpt-6-luna` 和 OpenRouter `/api/alpha/decisions` 的任意可用模型 ID，例如 `microsoft/microsoft-decision-1`。
- OpenAI Decisions 需要 `OPENAI_API_KEY`，不能使用 Codex OAuth；另外两类使用 `TYPESAFE_API_KEY` 和 `OPENROUTER_API_KEY`。
- `/fast` 和 `/ultrafast` 分别请求 `priority` 和 `ultrafast` service tier。它们只影响当前会话以后的 Codex 请求；已创建的子会话保留各自快照，实际可用性由模型和账户决定。

在插件页分别停用 `yu-web-search` 或 `yu-web-reader` 时，恢复对应的 DSH 内置工具。标准、PTC 和 Creator 预设采用相同规则；最小预设保留原来的工具范围。组合胶水行 `yu-extensions` 和 `yu-web-tools` 随整个包启停。

## 费用与历史

Codex 卡片单独显示官方返回的剩余 credits（支持零余额和不限量状态）；接口未返回时显示“未提供”，不会从历史花费反推余额。

面板铺满可用宽度，额度卡片随宽度排列。历史支持 24 小时、7 天、30 天和全部范围；悬停或触摸查看时间与数值，点击图例显示或隐藏曲线，也可聚焦图表后用方向键、Home/End 查看数据。

DeepSeek 官方（`deepseek-official`，以及旧别名 `deepseek`）按[官方人民币分时价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)计费，使用精确人民币单价，**不做汇率换算**。其他提供方使用 PiAI 目录中的美元费率。同一会话混用多个提供方时，费用按币种分别累计，底栏与面板并排显示（例如 `¥0.42 + $0.03`）。

输入框下方的状态栏显示当前会话费用；存在原生子代理时标注“含子代理”。悬停会按 **缓存读 / 输入 / 输出**（有缓存写时另列）拆分价格，并显示子代理金额、请求数和未知价格请求；点击打开额度与费用面板。

| 模型 | 时段 | 缓存命中输入 / M | 未命中输入 / M | 输出 / M |
| --- | --- | ---: | ---: | ---: |
| Flash | 空闲 | ¥0.02 | ¥1 | ¥4 |
| Flash | 高峰 | ¥0.04 | ¥2 | ¥8 |
| Pro | 空闲 | ¥0.15 | ¥4.5 | ¥13.5 |
| Pro | 高峰 | ¥0.30 | ¥9 | ¥27 |

高峰为北京时间周一至周五 09:00–12:00、14:00–18:00；与美元估算一样，当前只按工作日/周末窗口区分，未单列中国法定节假日。价格快照日期为 2026-10-16。新请求按发生时的费率保存金额、币种和缓存读/输入/输出/缓存写分类小计；升级前的记录会按原请求用量和金额补算分类，原始账本不被改写。

其他已知模型使用 PiAI 目录中的美元费率，包括目录中已知的上下文阶梯价格；未知价格、缺失用量和没有匹配费率的 Codex 加速请求显示为未知。需要覆盖费率时，可在 `yu-quota` 的配置中提供 `rates.<provider>.<model>`，字段为每百万 token 的 `input/output/cacheRead/cacheWrite`；DeepSeek 官方覆盖值按人民币、其他提供方按美元解释。

Codex 跨设备账本使用官方 credits，沿用 Pi 的 `$0.04 / credit` 换算，美元金额明确标为估算；导入的首日手动校准也会显示标记。本机费用与跨设备账本不相加。子代理费用依据 DSH 原生父子会话关系汇总，不替换子代理插件、不解析 Pi 的子代理文本。

额度查询失败时保留上次成功数据并显示错误。历史保留 30 天、每账户至多 500 个变化点；数值变化或 4 小时心跳时记点。本机请求费用从安装后开始记录。

## 开发与卸载

```bash
npm ci --ignore-scripts
npm run check
npm pack
```

GitHub Actions 检查构建与测试；推送版本标签后生成预构建 `.tgz` 并附加到 GitHub Release。

```bash
dsh plugin --profile web remove @yu1745/dsh-extensions
```

停用或卸载整个 bundle 会恢复官方工具配置和 Codex 适配层方法。DSH 的原生子代理插件继续使用。
