# DSH Extensions

一个 GitHub 分发的包，包含多个可独立启停的 DSH 插件。当前为一期测试版，适配 **DSH 0.2.1-alpha.4 / Node.js 22+**。

| 插件 | 功能 |
| --- | --- |
| `yu-web-search` | Google Antigravity、OpenAI Codex、DeepSeek、MiniMax、ZAI 五后端，保留各自原生参数 |
| `yu-web-reader` | Playwright 渲染、ARIA 提取、动态加载判断、Cloudflare 处理、截图与 DSH 附件 |
| `yu-quota` | 五源额度、余额与历史曲线；Codex 跨设备账本；本机和原生子代理美元费用 |
| `yu-codex-fast` | 会话级 `/fast`、`/ultrafast`、`/codex-speed`；子会话继承创建时快照 |

额度来源为 DeepSeek、GLM、MiniMax、OpenAI Codex、Antigravity。后台在 DSH 运行期间每分钟刷新，不依赖浏览器打开；同一个 DSH home 的多个进程共用轮询锁。

## 安装

推荐从 [GitHub Releases](https://github.com/yu1745/dsh-extensions/releases) 安装预构建包：

```bash
dsh plugin --profile web add 'https://github.com/yu1745/dsh-extensions/releases/download/v0.1.0-alpha.3/yu1745-dsh-extensions-0.1.0-alpha.3.tgz'
```

或安装固定版本的 GitHub 源码：

```bash
dsh plugin --profile web add 'github:yu1745/dsh-extensions#v0.1.0-alpha.3'
```

源码安装需要运行 `prepare` 构建。若 pnpm 要求构建授权，在该 profile 的 `pnpm-workspace.yaml` 中合并：

```yaml
allowBuilds:
  '@yu1745/dsh-extensions': true
```

然后重新安装。`headless` profile 使用同一个包，将命令中的 `web` 改为 `headless`。Web 专用的三个预设 patch 在 headless 中会被跳过；`--dump-config` 可能显示对应的“entry not found”提示。包会启用 headless 的本地 credentials 服务，以便查询额度和使用已有 DSH 凭据。

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

一期的 Antigravity 搜索和额度读取 Pi 的当前 access token，**不刷新 Pi 的 token**。过期时在 Pi 中刷新登录；独立模型接入与刷新职责迁移留到二期。

## 使用

- 打开右侧栏，在“开始”页选择 **额度与费用**；已有对话的输入框下方也提供入口和当前提供方摘要，同时显示所有可用额度窗口（例如 `5h 剩余 80% · 周 剩余 60%`）。
- 在面板中选择搜索后端、Decision 服务和模型；保存后重启 DSH 或重新加载对应插件。
- 输入 `/websearch-backend`，从指令菜单选中或按回车，会在输入框上方展开五个后端候选；支持搜索、方向键和回车选择，标记当前已保存的后端。也可直接输入 `/websearch-backend zai`，无效参数会被拒绝。选择后重新加载搜索插件或重启生效；工具参数随后端变化，提示缓存可能失效。
- 网页判断通过 PiAI 的通用 `Models.classify` 调用。默认 `typesafe / jev-latest`，也支持 `openai / gpt-6-luna` 和 OpenRouter `/api/alpha/decisions` 的任意可用模型 ID，例如 `microsoft/microsoft-decision-1`。
- OpenAI Decisions 需要 `OPENAI_API_KEY`，不能使用 Codex OAuth；另外两类使用 `TYPESAFE_API_KEY` 和 `OPENROUTER_API_KEY`。
- `/fast` 和 `/ultrafast` 分别请求 `priority` 和 `ultrafast` service tier。它们只影响当前会话以后的 Codex 请求；已创建的子会话保留各自快照，实际可用性由模型和账户决定。

在插件页分别停用 `yu-web-search` 或 `yu-web-reader` 时，恢复对应的 DSH 内置工具。标准、PTC 和 Creator 预设采用相同规则；最小预设保留原来的工具范围。组合胶水行 `yu-extensions` 和 `yu-web-tools` 随整个包启停。

## 费用与历史

费用全部为 **USD**。DeepSeek 使用[官方美元分时价](https://api-docs.deepseek.com/quick_start/pricing/)，不进行汇率换算；余额保留接口返回的原币种，不将人民币余额伪装为美元。

| 模型 | 时段 | 缓存命中输入 / M | 未命中输入 / M | 输出 / M |
| --- | --- | ---: | ---: | ---: |
| Flash | 非高峰 | $0.003 | $0.15 | $0.60 |
| Flash | 高峰 | $0.006 | $0.30 | $1.20 |
| Pro | 非高峰 | $0.022 | $0.66 | $1.98 |
| Pro | 高峰 | $0.044 | $1.32 | $3.96 |

高峰为周一至周五 UTC 01:00–04:00、06:00–10:00。价格快照日期为 2026-10-16。每个请求按发生时的费率保存金额，后续修改费率不重写历史。

其他已知模型使用 PiAI 目录中的美元费率，包括目录中已知的上下文阶梯价格；未知价格、缺失用量和没有匹配费率的 Codex 加速请求显示为未知。需要覆盖费率时，可在 `yu-quota` 的配置中提供 `rates.<provider>.<model>`，字段为每百万 token 的 `input/output/cacheRead/cacheWrite`。

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
