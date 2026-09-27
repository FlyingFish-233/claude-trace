# OIDC 发布流程（GitHub Actions）

本文档说明如何通过 **npm Trusted Publishing (OIDC)** 发布 `@uvl000/claude-trace`。

本地机器**不执行** `npm publish`，也**不需要** npm Access Token。推送 `v*` 标签后，GitHub Actions 工作流 `.github/workflows/publish.yml` 会自动完成构建、npm 发布和 GitHub Release。

> 如果通过 HTTPS 使用 GitHub Personal Access Token（classic）执行 `git push`，该 Token 除了仓库写入权限外，还必须勾选 `workflow` scope（Update GitHub Action workflows）；否则无法新增或修改 `.github/workflows/` 下的 Workflow 文件。

## 架构

```
本地 npm version + git push
  → git push commit + tag vX.Y.Z
    → GitHub Actions (publish.yml)
      → typecheck / test / build
      → npm publish（OIDC，无需 NPM_TOKEN）
      → GitHub Release
```

## 一次性配置

### 1. npm Trusted Publisher

在 [npm 包设置](https://www.npmjs.com/package/@uvl000/claude-trace/access) → **Trusted Publisher** → **GitHub Actions** 中配置：

| 字段 | 值 |
|------|-----|
| Organization or user | `FlyingFish-233` |
| Repository | `claude-trace` |
| Workflow filename | `publish.yml` |
| Environment name | （留空） |
| Allowed actions | `npm publish` |

> 工作流文件名只填 `publish.yml`，不要写完整路径。

## 标准发布（推荐）

```bash
git checkout main
npm run typecheck
npm run test:unit
npm run build
npm pack --dry-run
npm version patch -m "chore: release v%s"
git push origin HEAD
git push origin "$(git describe --tags --exact-match HEAD)"
```

`npm version patch` 会创建版本提交和匹配的 `vX.Y.Z` 标签。推送标签后，GitHub Actions 会自动发布。

发布流程为：

1. 本地运行检查、测试和构建
2. `npm version patch` 升版本并创建 commit + tag
3. 推送 commit 和 `vX.Y.Z` 标签
4. GitHub Actions 自动构建并通过 OIDC 发布
5. 在 GitHub Actions 页面和 npm 注册表验证结果

## 版本选择

| 变更类型 | 命令 | 示例 |
|----------|------|------|
| Bug 修复 | `npm version patch` | 3.0.9 → 3.0.10 |
| 新功能（向后兼容） | `npm version minor` | 3.0.9 → 3.1.0 |
| 破坏性变更 | `npm version major` | 3.0.9 → 4.0.0 |

## 发布后验证

```bash
npm view @uvl000/claude-trace version
npm install -g @uvl000/claude-trace
claude-trace --help
```

## GitHub Actions 工作流说明

工作流文件：`.github/workflows/publish.yml`

工作流仅由 `v*` 标签推送触发，并同时发布 npm 包和创建 GitHub Release。

### 工作流自动执行

1. 校验 tag 与 `package.json` 版本一致
2. 使用 Node.js 24 自带的兼容 npm，并关闭发布任务的依赖缓存
3. `npm ci`（根目录 + frontend）
4. typecheck、单测、构建和 CLI smoke test
5. 预览 npm 包内容
6. 通过 OIDC 发布到 npm（自动生成 provenance）
7. 验证 npm 注册表版本
8. 创建 GitHub Release（自动生成变更说明）

## 常见问题

### 推送 tag 后 Actions 未启动

- 确认 tag 格式为 `vX.Y.Z`（如 `v3.0.10`）
- 确认 `publish.yml` 已在 `main` 分支
- 查看 Actions 页面是否有权限或规则拦截

### Actions 发布失败：Trusted Publisher 不匹配

错误通常表现为 `E404` 或认证失败。检查 npm Trusted Publisher 配置：

- owner: `FlyingFish-233`
- repo: `claude-trace`
- workflow: `publish.yml`（仅文件名）

### tag 与 package.json 版本不一致

```
Tag v3.0.10 does not match package.json version 3.0.9
```

处理：重新执行 `npm version patch` 或手动修正 `package.json` 后重新打 tag。

### 版本已在 npm 上存在

```
版本 3.0.10 已在 npm 上发布。请先用 patch/minor/major 升版本
```

处理：升版本后重新发布，不要重复推送同一版本 tag。

## 发布方式

本项目统一使用 GitHub Actions 的 npm Trusted Publishing。发布任务在 GitHub 托管 Runner 中获取短期 OIDC 凭证，成功后自动创建 GitHub Release；本地不保存 npm 发布 Token。

## 相关链接

- npm 包页：https://www.npmjs.com/package/@uvl000/claude-trace
- GitHub Actions：https://github.com/FlyingFish-233/claude-trace/actions/workflows/publish.yml
- npm Trusted Publishing 文档：https://docs.npmjs.com/trusted-publishers/
- GitHub OIDC 文档：https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect
