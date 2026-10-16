# Third-party notices

The Antigravity provider, web search, browser reader and quota parsers in `src/vendor/` are ported from
[yu1745/pi-extensions](https://github.com/yu1745/pi-extensions), under the MIT
license (snapshot c66681c). Their upstream copyright notices and the original MIT license are
retained. DSH integration, credentials, classifier routing, polling, cost storage
and browser UI live outside that directory.

The CodeBuddy model catalog and account protocol in `src/codebuddy-*.ts` are
adapted from the same MIT-licensed source. Its FP switch, official prompt/tool
replacement and simulated telemetry are not included.

The preset declarations in `presets/` are adapted from
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
DSH 0.2.1-alpha.4, under the MIT license (Copyright (c) 2026 DeepSeek). Only the web-tool registration module
is changed; the native preset components remain DSH packages.

The plugin uses DSH's exported PiAiAdapter to add request options while enabled.
It neither modifies the installed DSH package files nor distributes a fork of
DSH's adapter.
