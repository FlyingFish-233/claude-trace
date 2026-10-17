# 命令使用手册

适用于 claude-trace 5、schema-v2。本文按 CLI 参数解析和运行实现说明选项；架构见 [architecture.md](architecture.md)，旧接口迁移见 [MIGRATION.md](../MIGRATION.md)。

## 选择入口与安装

| 入口 | 用途 | 是否启动模型客户端 |
| --- | --- | --- |
| `llm-trace capture` | 反向代理；任意客户端手动配置 base URL 后接入 | 否 |
| `llm-trace export / validate / report / replay` | 导出训练数据、校验、HTML、同协议重放 | 否；replay 自己发送 HTTP 请求 |
| `claude-trace` | 为 Claude Code 配置代理并启动它 | 是 |
| `codex-trace` | 为 Codex 配置代理并启动它 | 是 |
| `opencode-trace` | 为 OpenCode 配置代理并启动它 | 是 |
| `vibe-coding-proxy` | 独立正向代理，客户端通过代理环境变量接入 | 否 |

运行要求 Node.js 20+。需要已发布版本时可安装 npm 包，并确认安装版本确实包含本文接口：

```bash
npm install -g @uvl000/claude-trace
npm list -g @uvl000/claude-trace --depth=0
llm-trace --help
```

未发布的本地代码应从源码构建，不假定 npm 的 latest 已等于仓库版本：

```bash
cd /raid/zwx/claude-trace
npm ci --ignore-scripts
npm --prefix frontend ci --ignore-scripts
npm run build
node dist/cli/llm-trace.js --help
```

本文的 `llm-trace ...` 可替换成 `node /raid/zwx/claude-trace/dist/cli/llm-trace.js ...`。其他源码入口分别为 `cli.js`、`codex-cli.js`、`opencode-cli.js`、`vibe-coding-proxy-cli.js`。这些启动器不附带对应的模型客户端。

离线环境的本地 npm 包制作见 [发布文档的本地打包说明](npm-publishing.md#1-检查与创建版本)。`offline/bin` 中的启动脚本是最终 bundle 的模板，需要对应的 Node 和 package 目录布局，不能直接把模板当作源码启动入口。外部 WorkflowExp 的旧打包器仍检查已删除的旧导出入口，不能直接作为 v5 安装方法；本仓库打包成功不表示外部 bundle 已完成迁移。

## 通用参数规则与产物

- 使用 `--选项 值`；未声明为可重复的选项只能出现一次。布尔开关通过出现/省略启用/关闭，不写 `--flag false`。
- `--help` 显示帮助；顶层 `llm-trace -h` 也可用。各子命令用 `--help`，客户端启动器应把 `--help` 放在第一个参数。
- 路径相对于执行命令的工作目录。每次采集选择新的运行目录，已有 trace/manifest 或输出文件会被拒绝覆盖。
- 默认采集产物只有 `trace.jsonl` 和 `manifest.json`；HTML、训练 JSONL、校验报告均离线生成。
- `export`、`validate`、`report` 的 `--input` 可重复；显式文件可直接读取，目录只递归查找 manifest 指向的 trace，导出结果不是 trace 输入。
- 凭据头默认脱敏；正文和 URL 不做通用秘密清洗。采集参数不改变 system、reasoning 或其他转发请求内容。

三个格式 ID 是 `anthropic-messages`、`openai-responses`、`openai-chat-completions`。`--api-format auto` 为自动识别；显式格式只指定如何解释请求，**不会把一种 API 转成另一种 API**。

## llm-trace capture

```bash
llm-trace capture \
  --upstream https://api.example.com/v1 \
  --log-dir captures/run-001 \
  --host 127.0.0.1 \
  --port 18080
```

| 选项 | 必填 / 默认 | 功能与限制 |
| --- | --- | --- |
| `--upstream URL` | 必填 | 唯一上游 HTTP(S) API 前缀，不含凭据、query、fragment |
| `--log-dir DIR` | 必填 | 本次采集目录 |
| `--api-format FORMAT` | `auto` | auto 或三种协议 ID |
| `--host HOST` | `127.0.0.1` | 本地监听地址 |
| `--port N` | `0` | 0–65535；0 由系统选择空闲端口 |
| `--include-sensitive-headers` | 关闭 | 在日志中保留凭据头；此选项实际受支持，即使当前帮助文本未列出 |

启动后打印 JSON，包含本地地址及日志路径。把客户端 base URL 指向该地址；需要 API 前缀的 SDK 一般设置为 `http://127.0.0.1:18080/v1`。代理处理与上游重复的 `/v1` 前缀，不改协议。自定义 URL 前缀应以实际上游路由为准。

客户端仍使用目标服务的认证；capture 不提供 `--api-key-env`，也不自动读取你的服务密钥。采集完成后正常停止代理，再执行离线命令，以便 manifest 完成收尾。

## 三个客户端启动器

```bash
claude-trace --log-dir captures/claude-001 -- --print "hello"
codex-trace --log-dir captures/codex-001 -- exec "hello"
opencode-trace --log-dir captures/opencode-001 -- run "hello"
```

`--` 前是采集器参数，之后原样传给客户端。例如 `claude-trace -- --help` 查看 Claude 的帮助，`claude-trace --help` 查看采集器帮助。未给 `--` 时，以空客户端参数启动；不能把客户端参数直接放在采集器选项中。

| 共用选项 | 必填 / 默认 | 功能 |
| --- | --- | --- |
| `--log-dir DIR` | 可选 | 明确指定本次运行目录；省略时在 profile 日志根目录下创建时间戳与随机后缀的子目录 |
| `--binary PATH` | 从 PATH/常见安装位置发现 | 对应客户端的可执行文件，不是 llm-trace |
| `--api-format FORMAT` | `auto` | 指定协议识别方式 |
| `--include-sensitive-headers` | 关闭 | 取消敏感头脱敏 |

默认日志根目录为 `.claude-trace`、`.codex-trace`、`.opencode-trace`。Claude 另支持绝对路径环境变量 `CLAUDE_TRACE_LOG_DIR` 作为默认根目录；显式 `--log-dir` 指定的是直接使用的运行目录。启动器会查询客户端版本并记录到 manifest，结束时收尾采集并传递客户端退出状态。

### 上游与认证从哪里来

| Profile | 上游配置来源 | 代理配置如何注入 |
| --- | --- | --- |
| Claude | `CLAUDE_CONFIG_DIR` 或 `~/.claude` 的 settings.json 中 `env.ANTHROPIC_BASE_URL`，其次环境变量，再其次官方默认地址 | 子进程设置 ANTHROPIC_BASE_URL；需要时使用持久配置覆盖目录，避免 settings 覆盖代理地址 |
| Codex | `CODEX_HOME` 或 `~/.codex` 的 config.toml；自定义 model_providers 的 base_url；内置 OpenAI/ChatGPT 路由结合配置、环境和认证模式解析 | 创建持久 CODEX_HOME 覆盖，重写上游地址；保留 provider 和模型路由 |
| OpenCode | 按顺序选择存在的 `OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR/opencode.json`、`~/.config/opencode/opencode.json`、`.opencode/opencode.json`；provider.options.baseURL 优先 | 子进程注入 OPENCODE_CONFIG_CONTENT 的 provider 地址覆盖，移除子进程 OPENCODE_CONFIG；按 provider/model 路由 |

认证仍由客户端读取自己的环境、配置或登录状态并发送；启动器不是独立登录工具。Claude/Codex 原配置不就地修改，持久覆盖目录用于复用；OpenCode 的覆盖位于子进程环境。当前 OpenCode profile 读取 JSON 文件，不能假定它实现了客户端全部配置来源和 JSONC 合并语义。

三个启动器只负责采集，离线功能全部使用 `llm-trace`。调整客户端模型、任务或权限，应使用客户端自身选项并放到 `--` 后面。

## llm-trace export

```bash
llm-trace export \
  --input captures/run-001 \
  --input captures/run-002 \
  --output exports/training.jsonl \
  --convert-developer-to-system \
  --merge-system-messages
```

| 选项 | 必填 / 默认 | 功能与依赖 |
| --- | --- | --- |
| `--input PATH` | 必填，可重复 | schema-v2 trace 文件或采集目录 |
| `--output FILE` | 必填 | 新训练 JSONL 文件 |
| `--convert-developer-to-system` | 关闭 | 原位转换 developer；无法保留的专有语义产生诊断 |
| `--filter-system-messages` | 关闭 | 转换后只保留第一条 system |
| `--merge-system-messages` | 关闭 | 合并剩余 system 并移到开头，默认双换行连接 |
| `--merge-system-separator TEXT` | 双换行 | 必须同时启用 merge；空字符串 `''` 表示直接拼接，传入的是字面字符串，不解释反斜杠转义 |

固定处理顺序为转换 → 过滤 → 合并；过滤和合并不要求 developer 转换。顶层 system/instructions 先规范化为前置消息，未转换的 developer 保留原位。适配器对派生数据做 billing 过滤、文本块拼接和工具规范化；原始 trace 不改变。

另生成 `FILE.diagnostics.json`，包含 assigned/skipped 数量、每条来源的归属或跳过原因。CLI 不提供自定义诊断路径选项。成功写出文件不代表所有请求均成功导出，必须检查 counts 和 skipped。

下面是缩减的记录示意，实际 metadata 还包含 rounds、usage 和推理来源等：

```json
{
  "messages": [
    {"role": "system", "content": "你是助手。", "trainable": false},
    {"role": "user", "content": "你好", "trainable": false},
    {"role": "assistant", "content": "你好！", "trainable": true}
  ],
  "tools": [],
  "metadata": {
    "chain_id": "chain-0",
    "run_id": "example-run",
    "protocol": "openai-chat-completions",
    "segment_reason": "initial",
    "response_sources": [{"file": "/data/trace.jsonl", "line": 1, "request_id": "example-request"}]
  }
}
```

工具调用使用 assistant.tool_calls，结果使用 tool 消息；推理文本在 reasoning_content，summary 和加密推理来源另记 metadata。`trainable` 标记实际成功回答，训练框架仍需生成 token 级 loss mask。不能直接将整个 messages 序列设为训练目标。

## llm-trace validate 与 report

```bash
llm-trace validate --input captures/run-001 --output reports/validation.json
llm-trace report --input captures/run-001 --output reports/trace.html
```

| 命令 | 选项 | 必填 / 默认 | 功能 |
| --- | --- | --- | --- |
| 两者 | `--input PATH` | 必填，可重复 | 原始 trace 文件或采集目录 |
| 两者 | `--output FILE` | 必填 | 新 JSON 校验报告或独立 HTML |
| validate | `--outcome complete\|incomplete` | `complete` | incomplete 强制报告采集不完整，不能被自动升级 |

validate 分开报告 capture_complete、protocol_valid、http_success、model_complete。完整采到 401/429 可能通过采集和协议检查，但不是训练样本；HTTP 200 也可能模型截断。它不修改 trace，不运行客户端。若使用未脱敏采集，报告可能包含 unredacted_header 错误。

report 可按 run、协议、模型和 URL 搜索，展示原始内容、规范化结果和校验诊断；不会自动打开浏览器。report 成功生成不代表其中所有请求通过校验。

## llm-trace replay

```bash
llm-trace replay \
  --input captures/run-001/trace.jsonl \
  --line-number 1 --line-number 3 \
  --base-url https://target.example/v1 \
  --api-key-env TARGET_API_KEY \
  --stream preserve \
  --concurrency 2 \
  --output replay/run-001
```

先通过自己的凭据管理方式将目标 key 放入 `TARGET_API_KEY` 环境变量。源 trace 中的认证不会复用。

| 选项 | 必填 / 默认 | 功能与约束 |
| --- | --- | --- |
| `--input FILE` | 必填，单次 | 一个 trace 文件；实现可解析只含一个 trace 文件的目录，不用于多文件批量重放 |
| `--base-url URL` | 必填 | 完整 API 前缀，如 `https://host/v1`；适配器追加 operation，不要写成 `/v1/messages` 等完整操作地址 |
| `--line-number N` | 与 seed 二选一，可重复 | 从 1 开始的物理行号；为避免重复发送，同一行只指定一次 |
| `--seed N` | 与 line-number 互斥 | 非负整数的确定性随机抽样种子，不是模型生成 seed |
| `--count N` | `1` | 正整数，仅 seed 模式可用；超过文件记录数时使用全部可抽记录 |
| `--output DIR` | `replay-<毫秒时间戳>` | 新运行目录 |
| `--stream preserve\|on\|off` | `preserve` | 保留原始 stream 设置，或显式强制布尔值 |
| `--model MODEL` | 不覆盖 | 替换请求模型，不改历史消息 |
| `--max-tokens N` | 不覆盖 | 正整数；Messages 为 max_tokens，Responses 为 max_output_tokens；Chat 若原有 max_completion_tokens 则使用它，否则 max_tokens |
| `--api-key-env NAME` | 不设置认证 | 从该环境变量读取目标 key；指定但为空/不存在时报错 |
| `--auth-scheme protocol\|bearer\|x-api-key` | `protocol` | 协议默认：Messages 用 x-api-key，OpenAI 用 Bearer；可覆盖。未设置 key 时不会凭空创建认证 |
| `--concurrency N` | `1` | 正整数，最大并发请求数 |
| `--timeout-ms N` | `120000` | 每次请求绝对超时，单位毫秒，正整数 |

原始请求参数和 stream 默认保留；不自动重试、不执行工具、不衔接下一轮。Responses 的 previous_response_id、conversation、previous_input_messages 等服务端状态依赖在发送前拒绝。

输出 `trace.jsonl`、`manifest.json`、`replay.json`。summary 中的来源索引和 trace.source 可定位原请求，新的 request_id 是采集器 ID；需要查上游日志时使用 response body 中的服务端 ID。新目录可继续交给 validate、report、export。

```bash
llm-trace validate --input replay/run-001 --output reports/replay-validation.json
llm-trace export --input replay/run-001 --output exports/replayed-training.jsonl
```

这次导出使用 replay 的新回答；原始采集目录的导出仍使用原始回答。

## vibe-coding-proxy

```bash
vibe-coding-proxy \
  --log-dir captures/forward-001 \
  --host 127.0.0.1 --port 18081 \
  --target-url https://api.example.com/v1
```

| 选项 | 必填 / 默认 | 功能 |
| --- | --- | --- |
| `--log-dir DIR` | `.vibe-coding-proxy/<毫秒时间戳>` | 新运行目录，实际可省略 |
| `--target-url URL` | 可重复 | 按协议、主机、端口和路径前缀限定记录；同时允许对应主机 TLS 检查 |
| `--mitm-host HOST` | 可重复 | 允许主机 TLS 检查；未设置 target-url 时记录这些主机的请求 |
| `--no-mitm` | 关闭 | HTTPS CONNECT 只建隧道，不解密内容 |
| `--ca-dir DIR` | `~/.claude-trace/vibe-coding-proxy-ca` | 本地 CA 存储目录 |
| `--host HOST` | `127.0.0.1` | 监听地址 |
| `--port N` | `0` | 0–65535，0 表示随机端口 |
| `--include-all-requests` | 关闭 | 也采集非目标的明文 HTTP 或已解密请求；不会解密未获准的 CONNECT 隧道 |
| `--include-sensitive-headers` | 关闭 | 保留原始敏感头 |

默认启用 MITM，因此至少指定一个 target-url 或 mitm-host；`--no-mitm` 时可不配置目标。两类目标一起用时，target-url 列表决定完整 URL 的记录范围，mitm-host 仅扩大主机解密许可；include-all-requests 可扩大已可见请求的记录范围。

启动输出提供代理地址和 `caCertPath`。在另一个 shell 为支持代理的客户端设置：

```bash
export HTTP_PROXY=http://127.0.0.1:18081
export HTTPS_PROXY=http://127.0.0.1:18081
export SSL_CERT_FILE=/absolute/path/from/caCertPath
export NODE_EXTRA_CA_CERTS=/absolute/path/from/caCertPath
```

将证书路径替换为实际输出，并按客户端的 TLS 实现选择信任方式。程序不会安装系统 CA；不支持这些代理环境变量的客户端应使用反向代理接入。

## 退出码与排错

| 命令 | 0 | 1 | 2 |
| --- | --- | --- | --- |
| validate | 有效且采集完整，即使模型请求本身失败 | 采集不完整或校验失败 | CLI 参数错误 |
| replay | 所有请求四项结果检查均成功 | 请求失败、截断、超时或其他运行错误 | CLI 参数错误 |
| export / report | 产物成功写出；export 仍可能有 skipped | 输入、文件或运行失败 | CLI 参数错误 |

capture/正向代理是长驻进程，启动或运行错误需看 stderr 和落盘记录；客户端启动器传递客户端退出状态。部分深层配置或数据错误以运行错误 1 返回，不应只凭退出码猜测具体原因。

| 现象 | 检查 |
| --- | --- |
| 没有采到请求 | 客户端 base URL/代理是否生效、provider 路由、请求是否属于允许范围 |
| unknown_protocol | URL、请求体、profile 格式提示；确认实际 API 后再显式指定格式 |
| capture_directory_already_used / output_already_exists | 为新运行指定新目录或新输出文件 |
| invalid_trace_record | 是否仍在使用旧 schema；重新采集，迁移说明不承诺自动转历史数据 |
| validate incomplete | manifest 是否结束、是否断流、是否显式选择 incomplete |
| export 无样本 | 查看 `.diagnostics.json`，检查失败返回、截断、状态引用或不支持的结构 |
| replay 401 | 目标环境变量和 auth-scheme；vLLM Messages 也可能要求 Bearer |
| prompt 不一致 | 模板、文本块换行、工具序列化及 system 分隔符，见 [Qwen 验证流程](vllm-qwen-export.md) |

参数事实来源：[通用 CLI](../src/cli/llm-trace.ts)、[客户端启动器](../src/cli/client-launcher.ts)、[正向代理 CLI](../src/cli/vibe-coding-proxy-cli.ts)。
