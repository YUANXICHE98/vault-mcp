# vault-mcp

BIP39 助记词驱动的本地加密保险箱，MCP Server 实现。

为 AI Agent 工作流提供安全的密钥管理——API Key、Token、密码等敏感信息用 AES-256-GCM 加密存储在本地，只有持有 12 位助记词的人才能解锁。

## 为什么需要这个？

AI Agent（如 Claude Code、Proma）在自动化工作流中需要访问各种 API Key（飞书、小红书、GitHub 等）。这些 key 通常明文存在配置文件里，存在风险：

- Agent 高频操作时可能误删配置
- 配置文件泄露 = 所有 key 泄露
- 换机器/重装后需要重新收集所有 key

vault-mcp 解决这个问题：**把所有敏感信息加密存储，用助记词做钥匙。**

## 与现有方案对比

| 方案 | 依赖 | 存储位置 | 加密方式 | 适用场景 |
|------|------|---------|---------|---------|
| **vault-mcp** | 无外部依赖 | 本地文件 | AES-256-GCM + BIP39 | 个人/本地 Agent 工作流 |
| [doppler-mcp](https://github.com/adamkane/doppler-mcp) | Doppler SaaS | 云端 | Doppler 托管 | 团队/企业，需要付费账号 |
| [botlockbox](https://github.com/trodemaster/botlockbox) | HTTPS 代理 | 本地加密文件 | 代理注入 | 需要代理架构 |
| 环境变量 / .env | 无 | 明文文件 | 无 | 开发环境，不安全 |
| macOS Keychain | 系统 API | 系统钥匙串 | 系统级 | 仅 macOS，无 MCP 接口 |

**vault-mcp 的优势：**
- 零外部依赖（不需要云服务、不需要代理）
- BIP39 标准助记词（和加密钱包同一套体系，未来可扩展）
- 纯 Node.js 内置 crypto，无第三方加密库
- MCP 原生接口，任何支持 MCP 的 AI 客户端都能用

## 安装

```bash
git clone https://github.com/YUANXICHE98/vault-mcp.git
cd vault-mcp
npm install
```

## 配置 MCP

在你的 MCP 配置文件中添加：

```json
{
  "vault-mcp": {
    "type": "stdio",
    "command": "node",
    "args": ["/path/to/vault-mcp/index.js"],
    "enabled": true
  }
}
```

## 使用

### 1. 初始化

```
> vault_init
🔐 Vault 初始化成功！
你的12位助记词：abandon ability able about above absent absorb abstract absurd abuse access accident
⚠️ 这是唯一一次显示助记词，丢失后无法恢复！
```

**立即抄写助记词并安全保管。**

### 2. 存入密钥

```
> vault_add(mnemonic="你的助记词", key="github_token", value="ghp_xxx", description="GitHub PAT")
✅ 已存入: github_token (GitHub PAT)
```

### 3. 查看有什么

```
> vault_list
📋 2 条信息:
1. github_token — GitHub PAT
2. openai_key — OpenAI API Key
```

### 4. 取出密钥

```
> vault_get(mnemonic="你的助记词", key="github_token")
🔓 github_token: ghp_xxx
```

### 5. 检查状态

```
> vault_status
🟢 Vault 已就绪
📁 ~/.vault-mcp
🔑 2 条信息
📅 2026-03-12T04:20:00.000Z
```

## 工具列表

| 工具 | 需要助记词 | 说明 |
|------|-----------|------|
| `vault_init` | 否（生成新的） | 初始化保险箱，生成 12 位助记词 |
| `vault_add` | 是 | 存入一条敏感信息 |
| `vault_get` | 是 | 取出一条敏感信息 |
| `vault_list` | 否 | 列出所有 key 名称（不显示值） |
| `vault_remove` | 是 | 删除一条信息 |
| `vault_export` | 是 | 导出全部信息 |
| `vault_status` | 否 | 检查保险箱状态 |

## 安全设计

- **加密算法**: AES-256-GCM（认证加密，防篡改）
- **密钥派生**: BIP39 助记词 → PBKDF2(2048轮, SHA-512) → 256-bit key
- **存储**: `~/.vault-mcp/vault.enc`（权限 600）
- **元数据**: `~/.vault-mcp/meta.json` 只存 key 名称和描述，不存值
- **助记词验证**: SHA-256 哈希前 16 位，不存储原文
- **BIP39 词表**: 标准英文 2048 词，内置无外部依赖

## 典型工作流

```
1. vault_init → 抄写助记词
2. 把 mcp.json 里的 API Key 全部 vault_add 进去
3. vault 作为备份，mcp.json 保持现状正常使用
4. 万一配置丢失 → 用助记词 vault_export 恢复所有 key
5. 换机器 → 复制 ~/.vault-mcp/ 目录 + 助记词即可恢复
```

## 未来扩展

- [ ] HD 钱包派生（从同一助记词派生加密货币钱包地址）
- [ ] 定时自动备份 mcp.json 到 vault
- [ ] 恢复脚本（从 vault 自动填充 mcp.json 模板）
- [ ] 多 vault 支持（不同助记词管理不同类别的密钥）

## License

MIT
