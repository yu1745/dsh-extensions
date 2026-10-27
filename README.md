# DSH Extensions

一个 GitHub 分发的包，包含多个可独立启停的 DSH 插件。当前包含一期网页工具与额度功能，以及二期 CodeBuddy / Antigravity 模型接入，适配 **DSH 0.2.1-alpha.4 / Node.js 22+**。

| 插件 | 功能 |
| --- | --- |
| `yu-web-search` | Google Antigravity、OpenAI Codex、DeepSeek、MiniMax、ZAI 五后端，保留各自原生参数 |
| `yu-web-reader` | Playwright 渲染、ARIA 提取、动态加载判断、Cloudflare 处理、截图与 DSH 附件 |
| `yu-providers` | CodeBuddy、Antigravity 模型、浏览器登录与 DSH 凭据自动刷新 |
| `yu-quota` | 五源额度、余额与历史曲线；Codex 跨设备账本；本机和原生子代理费用；底栏会话计费 |
| `yu-codex-fast` | 会话级 `/fast`、`/ultrafast`、`/codex-speed`；子会话继承创建时快照 |
| `yu-model-fallback` | 独立设置页配置单模型优先级；额度耗尽顺位回退，恢复后优先回到手动首选模型 |
| `yu-openai-windows` | OpenAI 模型使用 notes/history 滚窗，不发摘要或远程压缩请求；其他模型沿用 DSH 基础 compact |
| `yu-no-workspace` | 全局新对话默认使用独立目录，形式上显示“不在工作区工作”；每次创建真实子目录与注册工作区 |

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

CodeBuddy 从账号的 `/v3/config` 获取模型目录并缓存，发现失败时使用上次目录。**不提供 FP 开关，不替换工具定义，不发送模拟遥测**。请求保留服务端所需的认证和客户端协议头；DSH 的工具调用、推理档位、取消信号和会话标识直接传递。

只要 `yu-providers` 处于激活状态，插件会在每次组装提示词时把产品名 `DeepSeek Harness` 改写成 `DSH`，覆盖系统提示词、运行上下文快照和插值变量；停用插件即恢复原文，会话日志记录的是改写后的提示词。CodeBuddy 的渠道校验（`HTTP 400 / code 11128`，Illegal API invocation from an unapproved channel）把该名字判为非官方客户端，名字是唯一触发点：整段提示词改名后同一请求直接返回 200，与模型、提示词长度、句式、工具定义均无关。改写不涉及请求头、遥测，也不改变工具定义。

## 使用

- 输入框的模型菜单按 **提供方 → 模型** 两级选择，点击提供方后在侧边弹出模型子菜单，父菜单保持位置和尺寸；推理档位也使用侧边子菜单。显示各提供方模型数量，支持搜索、方向键和 Enter；Escape 先关闭子菜单。

- 打开右侧栏，在“开始”页选择 **额度与费用**；已有对话的输入框下方也提供入口、当前提供方摘要和本会话计费，同时显示所有可用额度窗口（例如 `5h 剩余 80% · 周 剩余 60%`）。
- 面板中的搜索后端是新会话默认值；当前会话通过下方命令即时切换。Decision 服务和模型保存后需重新加载读取插件或重启 DSH。
- 输入 `/websearch-backend`，从指令菜单选中或按回车，会在输入框上方展开五个后端候选；支持搜索、方向键和回车选择，标记当前会话的后端。也可直接输入 `/websearch-backend zai`，无效参数会被拒绝。选择后在当前空闲会话立即生效，恢复会话后保留，不影响其他会话；工具参数和提示词随后端变化，提示缓存可能失效。
- 网页判断通过 PiAI 的通用 `Models.classify` 调用。默认 `typesafe / jev-latest`，也支持 `openai / gpt-6-luna` 和 OpenRouter `/api/alpha/decisions` 的任意可用模型 ID，例如 `microsoft/microsoft-decision-1`。
- OpenAI Decisions 需要 `OPENAI_API_KEY`，不能使用 Codex OAuth；另外两类使用 `TYPESAFE_API_KEY` 和 `OPENROUTER_API_KEY`。
- `/fast` 和 `/ultrafast` 分别请求 `priority` 和 `ultrafast` service tier。它们只影响当前会话以后的 Codex 请求；已创建的子会话保留各自快照，实际可用性由模型和账户决定。
- 每轮工作结束后，在操作行上方追加一行灰色的用时（例如 `Worked for 1m 20s`），取本轮开始与结束事件的时间差。仅在本轮正常完成时显示，中断、失败、超时和取消不显示。格式与 Codex CLI 一致：不补零（`1m 1s`）、不足 1 秒显示 `<1s`。

在插件页分别停用 `yu-web-search` 或 `yu-web-reader` 时，恢复对应的 DSH 内置工具。标准、PTC 和 Creator 预设采用相同规则；最小预设保留原来的工具范围。组合胶水行 `yu-extensions` 和 `yu-web-tools` 随整个包启停。

## OpenAI 滚动上下文窗口

第一参考是 [Codex CLI 的 notes/history 实现](https://github.com/openai/codex/tree/aeb6b22c8bda5f4d4b6ab80ebd3ccdb3f47fb3ab/codex-rs/ext/history-notes) 与 token-budget 换窗流程，而不是 Pi 插件。标准、PTC、Creator 预设及 headless 的 compaction 服务使用相同的路由分派：只对 `openai` / `openai-codex` 提供方下的 OpenAI 模型启用；DeepSeek、Anthropic、Antigravity 等仍直接调用 DSH 原始 `BasicCompactionEngine`，不增加窗口工具或提示词。最小预设原本没有 compaction，保持不变。

- 模型获得 `notes_*`、`history_*`、`get_context_remaining` 和 `new_context`。DSH 使用平面工具名适配 schema，官方 alpha HTTP 路径不变；这是兼容别名，并不冒充服务端保留的 `notes`/`history` namespace。
- 接近阈值时提醒模型保存 checkpoint。当前窗口必须先成功收到写入响应，再完整读回同一笔记；新用户消息或普通工作工具结果会使旧 checkpoint 失效。局部行读取不解锁换窗。模型负责核对加密结果的实际含义，客户端不解密，也不能把 HTTP 200 单独当作明文内容一致的证明。
- `new_context(checkpoint_path)` 仅安排切换；当前工具批次收尾后，才通过 DSH 持久事务把整个旧请求窗口替换为恢复指针。系统提示词保留，旧事件日志不删除；恢复与 fork 从日志重建窗口状态。新窗口先读 notes，再按需检索 history。
- **不调用 `/responses/compact`，不发送远程 v2 压缩请求，也不额外调用模型生成摘要。** `/compact` 对 OpenAI 仅在已有有效 checkpoint 时执行换窗；否则明确报错并保留历史。窗口意外耗尽且没有可用 handoff 时也保留历史，不盲目清空或偷偷改用摘要。
- OAuth 刷新和密钥解析由当前 DSH pi-ai 模型快照持有；插件不读本机 Codex/Pi 凭据文件。endpoint/account 与 checkpoint 绑定，改变身份后拒绝回放旧密文。
- 远程 history/notes 是实验性私有协议，需要当前后端和账户实际支持。普通 API key、OpenAI 兼容聊天或第三方网关可用，不代表支持该协议。接口错误不会触发破坏性换窗。已滚窗会话依赖 OpenAI 解读其加密 checkpoint；切到不兼容提供方时明确拒绝继续，须新建会话，避免静默丢失状态。未滚窗的其他模型会话不受影响。
- OpenAI 使用直接原生工具和 SSE，以承载加密工具参数/结果；在 PTC 预设中也仅对 OpenAI 会话切为原生工具。其他提供方的 PTC 展示和传输保持原样。

默认阈值为 `min(contextWindow × 0.8, contextWindow − outputReservation − 32768)`；窗口剩余预算是 DSH token meter 的估算，不是账户配额。可在已有 bundle 的配置中调整：

```yaml
- id: yu-openai-windows
  name: '@yu1745/dsh-extensions/openai-windows'
  config:
    enabled: true
    thresholdRatio: 0.8
    headroomTokens: 32768
    reminderTokens: 16384
```

设置 `enabled: false` 时，新会话恢复原始 compact；已有加密滚窗会话仍须使用兼容路径或新建会话。预设修订只对新建/重新组合的会话生效，现有运行中的会话不被强制迁移。

离线回归为 `npm run check`。显式授权联网/模型费用后，可运行 `DSH_TEST_OPENAI_WINDOWS=1 node scripts/test-openai-windows.mjs`（OpenAI SDK），或 `DSH_TEST_OPENAI_WINDOWS=1 node scripts/test-openai-window-agent.mjs`（真实 DSH Session、pi-ai 适配器、工具及换窗事务）。这两个开发诊断脚本只在内存读取本机 Codex 登录凭据，使用独立测试会话和随机笔记，不修改登录文件；测试笔记没有 delete 接口，不自动删除。

## 独立对话目录

侧栏的全局“新对话”和新会话快捷键，默认在 `$DSH_HOME/extensions/yu1745/workspaces/` 下生成一个不可预测的 `chat-*` 子目录，并注册为该会话的真实工作区。左侧将插件创建的这些子工作区**显示为同一个“不在工作区工作”组**，会话列在组内；现有由插件创建的工作区也自动归入此组，无需删除目录或迁移会话。界面只是合并显示：每条会话的原始目录、文件浏览根目录、Host 工作区注册都保持独立。普通项目工作区维持原样；在组内点“新对话”仍生成另一个独立目录。

可以覆盖默认根目录（须为绝对路径）：

```yaml
- id: yu-no-workspace
  name: '@yu1745/dsh-extensions/no-workspace'
  config:
    directory: /path/to/chats
```

每个独立会话对应一个持久目录和工作区注册；归档不会删除目录，插件不会自动清理文件。虚拟组不支持整体重命名、删除和跨独立目录拖动排序，以防把操作误施加到其中某一个真实工作区。停用插件会恢复原生侧栏（每个子工作区分别显示）和原来的“当前/最近工作区”新对话策略。聚合依赖当前 DSH 版本的客户端工作区快照与导航方法；升级 DSH 时须回归测试显示、恢复空白会话、新建与项目操作。

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

Codex 标准 API 价格按美元估算；`gpt-6-sol` 使用 PiAI 目录价格，新增 `gpt-6.1-terra` 按 [OpenAI 官方价格](https://developers.openai.com/api/docs/models/gpt-6.1-terra) 补充（2026-10-27 快照）：

| 模型 | 输入 / M | 缓存读 / M | 输出 / M | 缓存写 / M（30 分钟） |
| --- | ---: | ---: | ---: | ---: |
| gpt-6-sol | $2 | $0.20 | $10 | $2.50 |
| gpt-6.1-terra | $1 | $0.05 | $5 | $1.25 |

超过 272K 输入 token 时按长上下文阶梯计价；其他已知模型使用 PiAI 目录中的美元费率。`gpt-6-astra`、`gpt-6.1-sol`、`gpt-6-sol`、`gpt-6.1-terra` 和 `gpt-6-luna` 的 Fast 模式按各自[官方模型定价](https://developers.openai.com/api/docs/pricing)对对应标准档（包括长上下文）乘 2 估算；旧 Fast 请求若保留用量和速度标签，会在汇总时补算，不改写原始账本。这里显示的是**按所请求档位计算的 API 价格估算，不是 ChatGPT/Codex 套餐的实际扣费，也不能保证服务端实际采用的速度档位**。仍未知的 Fast 模型、Ultrafast 请求（无自定义费率时）、缺失用量或未知模型价格均记为未知，不按零元计。需要覆盖费率时，可在 `yu-quota` 的配置中提供 `rates.<provider>.<model>`，字段为每百万 token 的 `input/output/cacheRead/cacheWrite`；DeepSeek 官方覆盖值按人民币、其他提供方按美元解释。

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

选中 OpenAI Codex 模型时，输入框底部显示圆角闪电开关，点击切换当前会话 Fast 模式；点亮表示加速已开启。`/fast`、`/ultrafast` 和 `/codex-speed` 命令继续可用，并与开关共用会话设置。

## 模型自动回退

在 **设置 → 模型自动回退** 中选择模型、拖动排序并保存，然后开启自动回退。候选区按 **提供方 → 模型** 折叠展示；优先级队列只包含勾选的单个模型，可跨提供方交错排列。候选区勾选即加入队列，不支持拖拽；只有队列中的已选模型支持拖动排序，同时提供上移/下移按钮。该设置独立于 DSH 原有模型设置。

自动回退默认关闭。启用后，只有会话当前模型在排序队列中时才会自动回退；手动选中的队列内模型视为第一位，后续按队列顺序尝试，重复模型只尝试一次。手动切换到队列外的模型时，即使它报错也不会触发回退或被插件标记为额度耗尽；子代理的独立模型选择不受影响。每次新请求优先尝试队列内的手动首选模型；请求遇到用量上限、5 小时/周额度耗尽或余额不足时，通过 DSH 原生请求恢复接口顺位重试。请求头、费用归属和会话模型选择随实际模型更新，不覆盖全局默认模型。普通网络错误、短时限流、认证失败、上下文过长和取消不触发该插件回退。

后台额度快照明确显示耗尽的窗口会被跳过；支持 Codex、GLM、MiniMax、DeepSeek 和 Gemini 的已知额度池，不将 Gemini 的池套用到 Claude。已知恢复时间使用额度重置时间及服务端 Retry-After；未知时冷却 5 分钟后允许实际请求验证。额度刷新确认恢复后，下一次请求自动优先回到手动首选模型，再按备用顺序寻找可用模型，不打断正在生成的回复，也不额外发送付费探测请求。同一次失败步骤不会循环尝试同一个模型；全部耗尽时保留 DSH 原有错误处理。

排序和开关保存在 `$DSH_HOME/extensions/yu1745/model-fallback.json`，额度错误冷却保存在同目录 `model-fallback-state.json`。设置页中的“重试”可清除单模型错误冷却，但不会绕过额度接口仍明确耗尽的窗口。

手动首选模型与自动选择的备用模型分开记录，保存在 `model-fallback-sessions/<sessionId>.json`，服务重启后仍能恢复首选；手动再次选中模型（包括当前正在使用的备用模型）会更新首选。
