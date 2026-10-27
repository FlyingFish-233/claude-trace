# claude-trace 5

项目文档：[npm 发布](doc/npm-publishing.md) · [项目架构](doc/architecture.md) · [命令使用](doc/usage.md) · [vLLM/Qwen 训练轨迹导出](doc/vllm-qwen-export.md)。

按协议统一采集、导出、校验、报告和重放 LLM HTTP 请求。支持 `anthropic-messages`、`openai-responses`、`openai-chat-completions`。Claude Code、Codex、OpenCode 保留客户端启动器，其余客户端手动设置 base URL 即可接入。

需要 Node.js 20+。源码构建：`npm install`、`npm --prefix frontend install`、`npm run build`。可直接运行 `node dist/cli/llm-trace.js --help`；安装本包后可使用 npm bin 命令。离线操作不需要安装任何客户端。

## 使用

```sh
llm-trace capture --upstream https://provider.example/v1 --log-dir captures/run-001
# Point any client's API base URL at the printed loopback URL.
llm-trace validate --input captures/run-001 --output validation.json
llm-trace export --input captures/run-001 --output training.jsonl
llm-trace report --input captures/run-001 --output report.html
llm-trace report --input training.jsonl --output training-report.html
llm-trace replay --input captures/run-001/trace.jsonl --line-number 1 \
  --base-url https://target.example/v1 --api-key-env TARGET_API_KEY --output replay/run-001

claude-trace --log-dir captures/claude-001 -- --print "hello"
codex-trace --log-dir captures/codex-001 -- exec "hello"
opencode-trace --log-dir captures/opencode-001 -- run "hello"
```

`capture` 只启动反向代理，默认监听 `127.0.0.1` 随机端口，输出代理地址与记录路径。可设置 `--host`、`--port`、`--api-format auto|FORMAT`。通用代理一个实例对应一个上游，已有 profile 的多 provider 路由保留。客户端可在打印的代理根地址后追加 `/v1` 或 operation；上游前缀已有 `/v1` 时不重复添加。上游 URL 不接受内嵌凭据、query 或 fragment。

三个客户端入口只接受采集参数：`--log-dir`、`--binary`、`--api-format`、`--include-sensitive-headers`。`--` 后全部传给客户端。默认在各自隐藏目录下创建唯一运行目录。保留已有配置覆盖逻辑，不改原始配置。仅启动客户端时查询其版本；离线命令不会启动客户端。

正向代理示例：`vibe-coding-proxy --log-dir captures/forward-001 --mitm-host api.example.com`。`--target-url`、`--mitm-host` 可重复，HTTPS 仅解密白名单目的地；其他 CONNECT 仅隧道转发。客户端通过 `SSL_CERT_FILE` 或 `NODE_EXTRA_CA_CERTS` 等方式信任打印出的 CA；不自动安装系统证书。`--no-mitm` 关闭 HTTPS 解密，`--include-all-requests` 额外记录非目标的明文/已解密 HTTP。

## 采集数据

每次运行默认只有 `manifest.json` 和 `trace.jsonl`。schema v2 一行对应一次请求尝试，重试单独记录；包含 run/request ID、协议、请求、原生 JSON 或完整 SSE 文本、结束状态、错误，以及开始/响应头/首 chunk/结束的毫秒时间。解压仅用于记录，不改变转发字节；无法解码的数据以 base64 保留。未知协议也保存原文和诊断。断流、取消和正常停机保存部分记录；不承诺 SIGKILL 或掉电后的在途恢复。

默认脱敏 Authorization、Cookie 等敏感头，不是通用的 prompt/body/query 内容清洗。原始数据保全以此规则为边界。显式 `--include-sensitive-headers` 可关闭头脱敏；validate 会诊断未脱敏凭据，不原地清洗文件。

export/validate/report 的 `--input` 可重复，接受文件或目录；目录仅递归读取 schema-v2 manifest 指向的 trace，避免误读训练结果或 replay 报告。不覆盖已有输出或运行目录；不兼容、不删除、不批量转换历史 schema-v1 记录。

`report` 也接受显式指定的 `train.jsonl` 文件（由 `export` 生成）。每一行作为一条可切换的轨迹，沿用原有 Step 布局展示消息、推理、工具调用和结果。左侧目录可选择 trace 报告的 conversation 或训练报告的轨迹，并跳转到所选内容的 system message、tools 和 Step；仅在包含可训练助手输出的 Step 标题和对应目录项标注 `TRAINABLE`。同一份报告不能混用 trace 与训练文件。

## 导出

统一输出 `messages + tools + metadata`。成功、完整的模型返回标记 `trainable: true`，请求历史标记 false。metadata 记录协议、来源请求与物理行、usage、推理来源和分段原因。失败、截断或不支持的多模态/工具结构跳过，原因写到 `<output>.diagnostics.json`。Responses 的完整 reasoning_text 不再漏掉；summary 与加密推理单独记录来源信息，不冒充完整推理；加密原文仍在原始记录中。

以下选项默认全部关闭，按顺序作用于规范化后的消息：

1. `--convert-developer-to-system`：原位转换 developer；无法保留的专有语义给出诊断。
2. `--filter-system-messages`：只保留第一条 system。
3. `--merge-system-messages`：剩余 system 用双换行拼接并置于开头。

启用合并时，可用 `--merge-system-separator TEXT` 显式指定分隔符。对于直接拼接 inline
system 的 vLLM Messages 接口，使用 `--merge-system-messages --merge-system-separator ''`。
所有协议的默认分隔符仍为双换行。导出规范化会过滤 system 中的 billing 标记，按换行拼接
OpenAI 文本块，并按稳定顺序输出 Responses 函数字段；采集原文和 replay 请求内容不变。

Anthropic 顶层 system 和 Responses instructions 先映射到开头。过滤/合并不依赖 developer 转换，未转换 developer 保留原位。轨迹关联使用转换前历史，按 run、协议、明确 session header 隔离；唯一最长历史前缀匹配时继续同一轨迹，即使历史中包含压缩文字。工具变化、歧义或历史分叉才新建片段，不会跨运行拼接。

## 校验与报告

validate 独立报告采集完整性、协议有效性、HTTP 成功、模型完成。完整采到的 401/429 可以是有效采集，但不是训练目标；token 截断单独标记。只检查已有工具历史，不要求末尾新生成的 tool call 已有结果。`--outcome incomplete` 不会自动升级。退出码：有效且完整 0；无效或不完整 1；命令参数错误 2。`report` 离线生成自包含的 conversation viewer；校验结果继续通过 `validate` 查看。

## 重放

必须提供完整 API 前缀 `--base-url https://host/v1`，不要填 operation 地址。使用可重复的 `--line-number N` 选择一个 trace 文件的物理行，或显式 `--seed N [--count N]` 做可复现抽样，两种模式互斥。`--output DIR` 默认创建 `replay-<timestamp>`。

`--stream preserve|on|off` 默认 preserve。可设置 `--model`、`--max-tokens`、`--concurrency`（默认 1）、`--timeout-ms`（默认 120000）、`--api-key-env`。token 参数由协议映射；默认保留其他请求参数。原始认证不重用，目标 key 分别作为 Messages 的 x-api-key 或 OpenAI 的 Bearer。`--auth-scheme protocol|bearer|x-api-key` 默认 protocol；若目标（例如 vLLM）在 Messages 接口也要求 Bearer，应显式选择 bearer。带 previous_response_id、conversation、previous_input_messages 的服务端历史依赖在发送前拒绝。不跨协议、不执行工具、不自动续轮。

输出新 manifest、trace 与 replay.json，包含来源索引、实际发送请求及结果，可继续 validate/export/report。HTTP 200 不等于模型正常完成。

## 开发与迁移

必跑：`npm run typecheck`、`npm run test:unit`、`npm run build`。测试使用 mock upstream 与受控客户端，覆盖原文保全、协议转换、错误/取消、轨迹关联及 replay。构建会清理旧 dist；离线打包脚本检查所有入口并要求干净 Git 工作区，不自动发布。

参见 [MIGRATION.md](MIGRATION.md)。本次不修改外部 WorkflowExp、不替换线上安装、不发布 npm、不处理历史 trace。

Built/offline acceptance: `npm run test:built` (after build; local temporary npm tarball only).
