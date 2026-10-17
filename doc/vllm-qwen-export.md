# 面向 vLLM / Qwen 的训练轨迹导出

本文以 **shouyun2 上 Qwen3.5-9B 的实际验证环境**说明：采集请求 → 校验 → 导出训练轨迹 → 重放与 prompt 比较。它不是完整 GPU 部署教程，也不把一套参数当作所有 Qwen/vLLM 版本的通用保证。

通用选项见 [使用手册](usage.md)，消息规范化和轨迹关联机制见 [架构文档](architecture.md)。命令使用本地构建的 `dist/cli/llm-trace.js`，不依赖 npm 上是否已经发布当前代码。

## 1. 确认服务和模板

2026-10-17 核对的环境如下：

| 项目 | 实际配置 |
| --- | --- |
| 模型目录 | `/raid/zwx/models/Qwen3.5-9B` |
| API 模型名 | `qwen3.5-9b` |
| API 前缀 | `http://127.0.0.1:30011/v1` |
| 模板 | `/raid/zwx/models/Qwen3.5-9B/chat_template.jinja` |
| reasoning parser | `qwen3` |
| 工具解析 | `--enable-auto-tool-choice --tool-call-parser qwen3_coder` |
| 认证 | `VLLM_API_KEY` 环境变量，服务要求 `Authorization: Bearer ...`，Messages 接口也一样 |
| 服务脚本 | `/raid/zwx/WorkflowExp/server/vllm_rtx4090/serve_qwen3.5-9b.sh` |
| Python 环境 | `/raid/zwx/WorkflowExp/server/vllm_rtx4090/.venv/bin/python` |
| DEBUG 日志 | `/raid/zwx/WorkflowExp/server/vllm_rtx4090/serve_qwen3.5-9b_debug.log` |

服务脚本启用 `VLLM_LOGGING_LEVEL=DEBUG`、`--enable-log-requests` 和 `--enable-log-outputs`，用于匹配实际请求与 prompt。其 TP/DP、显存和上下文配置针对该机器，不是导出工具的要求。模型、tokenizer、chat template 及服务端模板处理应来自同一实际部署；记录本地 vLLM 版本和模板校验和，以便后续升级比较。

在凭据已通过环境安全加载的 shell 中，可做只读连接检查：

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${VLLM_API_KEY}" \
  http://127.0.0.1:30011/v1/models
sha256sum /raid/zwx/models/Qwen3.5-9B/chat_template.jinja
/raid/zwx/WorkflowExp/server/vllm_rtx4090/.venv/bin/python -m pip show vllm
```

确认模型名确实可用，且所选 Messages、Responses 或 Chat Completions endpoint 由目标服务支持。不要通过更改 `--api-format` 来弥补服务器缺少某个接口。

## 2. 采集 schema-v2 请求

### 通用代理接入

在 tmux 中运行长驻采集代理：

```bash
node /raid/zwx/claude-trace/dist/cli/llm-trace.js capture \
  --upstream http://127.0.0.1:30011/v1 \
  --log-dir /raid/zwx/workspaces/qwen-training/capture-001 \
  --host 127.0.0.1 \
  --port 18080
```

将客户端指向代理：若客户端需要完整 API 前缀，使用 `http://127.0.0.1:18080/v1`；若客户端自行追加 `/v1`，使用代理根地址。客户端模型设为 `qwen3.5-9b`，认证使用目标 vLLM 的 Bearer key。这里不配置 replay 的 `--api-key-env`：采集代理直接转发客户端的认证。

先运行真实任务，再正常结束客户端和代理。采集目录应包含 `manifest.json`、`trace.jsonl`；每次新任务使用新的目录，不复用已经写入的运行目录。

### 现有启动器接入

也可先将客户端自身的上游、模型和认证配置为该 vLLM，再运行对应启动器：

```bash
node /raid/zwx/claude-trace/dist/cli/cli.js \
  --log-dir /raid/zwx/workspaces/qwen-training/claude-001 \
  -- --print "完成当前测试任务"

node /raid/zwx/claude-trace/dist/cli/codex-cli.js \
  --log-dir /raid/zwx/workspaces/qwen-training/codex-001 \
  -- exec "完成当前测试任务"
```

两条是分别使用的示例，不要求同时执行。Claude 的 settings.json 可能优先于 ANTHROPIC_BASE_URL 环境变量；Codex 需配置相应 model_provider。检查启动器读取的配置来源，不能只修改一个环境变量就假定目标已切换。认证和模型选择由客户端负责，详见 [客户端配置来源](usage.md#上游与认证从哪里来)。

## 3. 先校验，再选择导出策略

```bash
node /raid/zwx/claude-trace/dist/cli/llm-trace.js validate \
  --input /raid/zwx/workspaces/qwen-training/capture-001 \
  --output /raid/zwx/workspaces/qwen-training/validation-001.json
```

检查采集完整性、协议有效性、HTTP 成功和模型完成。validate 退出 0 并不表示所有模型请求都成功，例如完整 HTTP 错误可以是有效采集。训练导出会进一步跳过失败、截断和不支持的结构，原因写入诊断文件。

导出策略由**真实协议和服务端模板行为**决定，而不是仅看客户端名字：

| 原始协议 | 当前 Qwen 验证使用的导出选项 | 原因 |
| --- | --- | --- |
| Messages | `--merge-system-messages --merge-system-separator ''` | 当前 vLLM Messages 适配把 inline system 与顶层 system 无分隔拼接 |
| Responses | `--convert-developer-to-system --merge-system-messages` | 当前模板使用 system 表达 developer 指令；合并仍使用默认双换行 |
| Chat Completions | 从不启用转换开始，按实际角色和模板选择 system 选项 | 本次真实 Qwen 验收没有覆盖它，不宣称逐字匹配已验证 |

以下使用已存在的两份 schema-v2 采集作为可复现输入，输出路径须尚不存在：

```bash
node /raid/zwx/claude-trace/dist/cli/llm-trace.js export \
  --input /raid/zwx/workspaces/llm-trace-v5-replay-20261017/claude/trace.jsonl \
  --output /raid/zwx/workspaces/qwen-training/messages-training-001.jsonl \
  --merge-system-messages \
  --merge-system-separator ''

node /raid/zwx/claude-trace/dist/cli/llm-trace.js export \
  --input /raid/zwx/workspaces/llm-trace-v5-replay-20261017/codex/trace.jsonl \
  --output /raid/zwx/workspaces/qwen-training/responses-training-001.jsonl \
  --convert-developer-to-system \
  --merge-system-messages
```

不要默认启用 `--filter-system-messages`：它会删除后续 system，未必与模型实际接收的 prompt 相同。`--merge-system-separator ''` 是当前 Messages 目标的显式选择，通用默认仍为双换行。

这两份验证输入是将历史 trace 前四条请求体重新发送给 Qwen 后采集的，来源映射保存在各自的 `recapture-sources.json`。历史文件没有转换或覆盖；它们适合回归验证，但不代表完整的、由 Qwen 从头执行的 Agent 任务。构建正式训练集应记录真实任务和模型来源。

## 4. 检查训练数据与模板

输出每行是 `messages + tools + metadata`。查看同名 `.diagnostics.json` 的 assigned、skipped、reason，以及 metadata 的来源请求、协议、rounds、usage 和分段原因。多轮请求可能被合并或拆分，输出行数不等于 HTTP 请求数。

与当前模板一致性相关的规则：

- **Billing**：派生 system 去掉 `x-anthropic-billing-header` 标记；采集原文保留。Messages 按其适配规则过滤对应块，OpenAI system 可保留 billing 首行后的文本。
- **文本块**：OpenAI 多个非空文本块以换行连接；不能直接拼成一串丢失边界。
- **工具**：Responses 函数定义按稳定字段顺序输出，namespace 名转换为双下划线形式。JSON 对象语义相等不保证模板生成的文本字节相等。
- **推理**：完整 reasoning_text 转为 reasoning_content；summary、加密信息记入来源 metadata，不能拿 summary 冒充完整思考。
- **训练目标**：`trainable: true` 标记实际成功回答，可能有多个目标消息；训练框架须据此生成 token loss mask，工具结果和用户文本不作为助手目标。

可用服务同目录的 tokenizer 和显式模板查看导出轨迹的完整文本。下面只渲染第一条轨迹，**不生成训练 mask，也不做按请求 prompt 等价验证**：

```python
import json
from pathlib import Path
from transformers import AutoTokenizer

model_dir = Path('/raid/zwx/models/Qwen3.5-9B')
training_file = Path('/raid/zwx/workspaces/qwen-training/messages-training-001.jsonl')
with training_file.open() as stream:
    row = json.loads(next(stream))
messages = [{k: v for k, v in message.items() if k != 'trainable'}
            for message in row['messages']]
tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
rendered = tokenizer.apply_chat_template(
    messages, tools=row['tools'],
    chat_template=(model_dir / 'chat_template.jinja').read_text(),
    tokenize=False, add_generation_prompt=False,
)
print(rendered)
```

这里包括已经生成的答案。训练目标 mask 需在保留原始 trainable 标记的数据上单独构造；不能从上述移除标记的 messages 盲目推断。

## 5. 重放后的回答与原始回答

若要让 Qwen 对选中请求重新回答，指定完整 API 前缀和目标认证：

```bash
node /raid/zwx/claude-trace/dist/cli/llm-trace.js replay \
  --input /raid/zwx/workspaces/llm-trace-v5-replay-20261017/claude/trace.jsonl \
  --line-number 1 --line-number 2 --line-number 3 --line-number 4 \
  --base-url http://127.0.0.1:30011/v1 \
  --api-key-env VLLM_API_KEY \
  --auth-scheme bearer \
  --model qwen3.5-9b \
  --max-tokens 60000 \
  --timeout-ms 1800000 \
  --stream off \
  --concurrency 4 \
  --output /raid/zwx/workspaces/qwen-training/replay-001
```

Messages 默认协议认证是 x-api-key，当前服务要求 Bearer，所以这里必须显式覆盖。输出 token 上限和超时是验证配置，不保证模型一定需要或能够生成这么多 token。

每条请求独立重放，不执行新 tool call，也不会把上一条新回答注入下一条历史。即使指定了新模型，已有 user/assistant/tool 历史仍来自原请求，因此不能将此过程称为完整 Qwen Agent 重跑。

需要训练**新回答**时，导出 replay 目录：

```bash
node /raid/zwx/claude-trace/dist/cli/llm-trace.js validate \
  --input /raid/zwx/workspaces/qwen-training/replay-001 \
  --output /raid/zwx/workspaces/qwen-training/replay-validation-001.json

node /raid/zwx/claude-trace/dist/cli/llm-trace.js export \
  --input /raid/zwx/workspaces/qwen-training/replay-001 \
  --output /raid/zwx/workspaces/qwen-training/replayed-training-001.jsonl \
  --merge-system-messages \
  --merge-system-separator ''
```

Responses 新 trace 使用前面的 Responses 导出选项。只修改 replay 的模型而仍导出旧目录，得到的仍是旧目录里的答案。

## 6. 比较真实 prompt

已有回归测试入口：`/raid/zwx/WorkflowExp/manual_tests/vllm_replay_test/run.sh`。它加载相对路径的 `server/.env`，两组显式命令各选 1–4 行、并发 4，指定 Qwen 模型、Bearer、stream off 和对应导出选项。在确认服务仍为上述环境后，需重新验收时在 tmux 中执行：

```bash
cd /raid/zwx/WorkflowExp/manual_tests/vllm_replay_test
bash run.sh
```

该命令会实际请求模型。本文整理时只读取已有结果，没有再次执行。

测试流程为：重放 → 用服务端 response ID 提取 vLLM 日志 → **逐个原始请求独立导出** → 去掉目标答案后，用同一 tokenizer/template 和 `add_generation_prompt=True` 渲染请求 → 与服务端 prompt 严格比较。

独立导出是必要的：整条关联轨迹包含后续请求，直接从最终合并轨迹截取早期轮次可能让后来加入的 system 指令污染早期 prompt。验证器通过 source.file、source.line、source.request_id 关联结果，不按并发完成顺序猜来源。

产物位于 `logs/<test-id>/`：

| 路径 | 内容 |
| --- | --- |
| `result.json` | 每条状态、耗时、首个不同位置、hash、比较计数 |
| `replay-run/` | 新 trace、manifest、replay.json |
| `line-N/replay/` | 实际重放请求、响应、记录和四项结果检查 |
| `line-N/openai-trace/` | 原始请求的导出、原始回答、渲染 prompt |
| `line-N/vllm/` | 对应服务端请求、实际渲染 prompt 和输出 |

请求成功不等于 prompt 匹配；必须同时检查四项结果和 comparison.equal。不要通过删除空白、重排 JSON、修改生成后的 prompt 来让比较通过。

## 7. 已验证范围与排错

2026-10-17 北京时间完成验证；结果目录使用 UTC 时间戳：

- `/raid/zwx/WorkflowExp/manual_tests/vllm_replay_test/logs/claude-vllm-20261016T230322Z/result.json`
- `/raid/zwx/WorkflowExp/manual_tests/vllm_replay_test/logs/codex-vllm-20261016T230322Z/result.json`

两组各 4 条均通过采集、协议、HTTP、模型完成检查，**8/8 prompt 逐字节一致，run.sh 退出码 0**。对应修复提交为 claude-trace `319938d`、WorkflowExp `ad2f43e`；配套检查为 90 项内核测试、17 项脚本测试及构建/打包入口检查通过。这些是该次验证数据，不是对未来版本的保证。

| 问题 | 排查方向 |
| --- | --- |
| Messages 返回 401 | 当前目标需 Bearer；检查 api-key-env 与 auth-scheme，不复用脱敏的源头 |
| 导出出现 billing 或 system 空白差异 | 是否使用修复后的 exporter、Messages 空分隔符及实际模型模板 |
| Responses 工具提示或文本长度差异 | 工具序列化顺序、多文本块换行、developer/system 策略 |
| HTTP 200 但没有训练样本 | 模型是否截断、工具参数是否完整、diagnostics 是否报告 unsupported 或服务端历史依赖 |
| 找不到服务端请求 | 使用 response ID 而不是采集器 request_id；检查 DEBUG 日志、请求/输出日志及截断情况 |
| 换模型或 vLLM 后不一致 | 重新记录版本与模板校验和，核对模板参数及服务端转换行为，再执行逐请求比较 |

当前真实验收覆盖 Messages 和 Responses；Chat Completions 的通用测试不能替代它在具体 Qwen 服务上的验证。历史 trace 不批量修改；正式训练数据保留模型、采集、模板和导出选项来源，以便复现。
