# 贡献说明 / Contributing

## 开始前

本仓库处理远程代码执行、文件访问、主机身份和端到端加密，修改必须说明信任边界、失败行为和回滚方式

不要提交真实会话、提示词、回复、代码、账户、主机名、域名、路径、终端截图、访问令牌、密钥、配对码或生产配置

## 本地检查

使用 Node.js 24.15.x、pnpm 10.33.4 和 Bun 1.3.14

```bash
corepack enable # 使用仓库锁定的 pnpm
pnpm install --frozen-lockfile # 安装锁定依赖
pnpm format:check # 检查统一格式
pnpm check # 检查类型、单元测试和网络出口
pnpm build # 构建协议、控制平面和 Agent
pnpm build:official-app # 从锁定上游源码构建官方 App 包装层
pnpm exec playwright install chromium # 首次安装浏览器运行时
pnpm test:e2e # 运行官方 App 和中继重连端到端测试
pnpm verify:upstream # 核对源码、OpenAPI、能力清单和发行包锁
```

## 修改边界

- 协议变更先更新 `packages/protocol`，再更新控制平面、Agent 和浏览器适配层
- 新远程操作必须来自生成的能力清单，不得引入任意网址或任意 localhost 代理
- 所有网络出口必须被 `scripts/scan-upstream-network.mjs` 发现并由锁文件明确记录
- 新持久化字段必须说明是否包含内容、是否加密和离线时能否显示
- 会话、请求、事件和 PTY 的键必须包含 `hostId`
- Agent 只以普通用户运行，OpenCode Server 只监听随机回环端口并启用随机 Basic Auth
- 合成测试只能使用保留域名、合成主机和临时工作区
- 不得在测试中调用真实模型，除非发布门明确授权并设置独立成本上限

## 提交前

确认中英文 README 的版本、命令、验证状态和限制一致

依赖、GitHub Actions、工具链和上游版本必须固定到可核对版本或 commit，生产路径不能使用浮动最新版

上游候选只允许创建审核分支，不得由定时任务直接推广到生产

安全问题不要通过普通拉取请求披露，改用 [SECURITY.md](SECURITY.md) 的私密入口

## English summary

Use Node.js 24.15.x, pnpm 10.33.4, and Bun 1.3.14, then run every command in the local-check section

Document trust boundaries and rollback behavior, keep remote operations manifest-backed, use synthetic fixtures, keep upstream source unpatched, and report vulnerabilities privately
