# 安全策略 / Security Policy

## 私密报告

请使用仓库的 [GitHub 私密漏洞报告](https://github.com/AIALRA-0/AIALRA-OPENCODE/security/advisories/new)

不要在公开 Issue、讨论、截图或日志中提交令牌、密码、私钥、配对码、真实会话、提示词、回复、代码、文件正文、终端内容、内部地址或绝对路径

报告只需包含最小复现信息，包括受影响版本、入口、预期行为、实际行为、影响范围和已经采用的临时缓解措施

## 支持范围

安全修复面向最新发布版本与当前维护的预发布分支

只有 `upstream.lock.json` 固定的 OpenCode 源码、发行包、OpenAPI 摘要、路由能力清单和网络出口基线属于当前兼容范围

部署方仍需负责身份提供方、TLS、反向代理、边缘规则、操作系统、模型账户和私有运维仓库的安全配置

## 重点关注问题

- OIDC 绕过、会话固定、CSRF 或 WebSocket 劫持
- 主机身份伪造、短时授权重放、跨主机数据混淆或撤销失效
- 提示词、回复、代码、文件正文、终端内容、绝对路径或模型密钥进入控制平面存储与日志
- 未知 OpenCode 路由、路径穿越、SSRF、任意网址或任意 localhost 代理
- 官方 App 新增网络出口却绕过适配层
- SSE 重复或乱序、PTY 重放、慢消费者、背压失控或断线后跨会话串流
- XSS、恶意前端资源、CSP、SRI、制品摘要或发布来源证明绕过
- OpenCode Server、Agent 或内部端口意外暴露到公网

## English summary

Use [GitHub private vulnerability reporting](https://github.com/AIALRA-0/AIALRA-OPENCODE/security/advisories/new) and include only the minimum reproducible details

Never post credentials, pairing codes, real sessions, prompts, answers, code, file bodies, terminal data, internal addresses, or absolute paths in public issues, screenshots, or logs

The compatibility boundary is the source, release assets, OpenAPI digest, capability manifest, and network-exit baseline pinned in `upstream.lock.json`
