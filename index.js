import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- BIP39 minimal implementation (no external deps) ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORDLIST_FILE = path.join(__dirname, "wordlist.json");

function getWordlist() {
  return JSON.parse(fs.readFileSync(WORDLIST_FILE, "utf8"));
}

function generateMnemonic() {
  const entropy = crypto.randomBytes(16); // 128 bits -> 12 words
  const bits = Array.from(entropy).map(b => b.toString(2).padStart(8, "0")).join("");
  const checksum = crypto.createHash("sha256").update(entropy).digest();
  const checksumBits = Array.from(checksum).map(b => b.toString(2).padStart(8, "0")).join("").slice(0, 4);
  const allBits = bits + checksumBits;
  const wordlist = getWordlist();
  const words = [];
  for (let i = 0; i < 12; i++) {
    const idx = parseInt(allBits.slice(i * 11, (i + 1) * 11), 2);
    words.push(wordlist[idx]);
  }
  return words.join(" ");
}

function validateMnemonic(mnemonic) {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 12) return false;
  const wordlist = getWordlist();
  return words.every(w => wordlist.includes(w));
}

function mnemonicToSeed(mnemonic) {
  // PBKDF2 with "mnemonic" as salt, same as BIP39 spec
  return crypto.pbkdf2Sync(mnemonic, "mnemonic", 2048, 64, "sha512");
}

// --- Crypto ---

function deriveKey(mnemonic) {
  return mnemonicToSeed(mnemonic).subarray(0, 32);
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(encoded, key) {
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, 16);
  const tag = buf.subarray(16, 32);
  const ciphertext = buf.subarray(32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, "utf8") + decipher.final("utf8");
}

// --- Vault storage ---

const VAULT_DIR = path.join(process.env.HOME || "/tmp", ".vault-mcp");
const VAULT_FILE = path.join(VAULT_DIR, "vault.enc");
const META_FILE = path.join(VAULT_DIR, "meta.json");

function ensureDir() {
  if (!fs.existsSync(VAULT_DIR)) fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
}

function loadMeta() {
  if (!fs.existsSync(META_FILE)) return null;
  return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
}

function saveMeta(meta) {
  ensureDir();
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), { mode: 0o600 });
}

function hashMnemonic(m) {
  return crypto.createHash("sha256").update(m).digest("hex").slice(0, 16);
}

function decryptVault(mnemonic) {
  const meta = loadMeta();
  if (!meta) throw new Error("Vault 未初始化，请先执行 vault_init");
  if (hashMnemonic(mnemonic) !== meta.mnemonicHash) throw new Error("助记词不正确");
  if (!fs.existsSync(VAULT_FILE)) return {};
  const key = deriveKey(mnemonic);
  return JSON.parse(decrypt(fs.readFileSync(VAULT_FILE, "utf8"), key));
}

function saveVault(data, mnemonic) {
  ensureDir();
  const key = deriveKey(mnemonic);
  fs.writeFileSync(VAULT_FILE, encrypt(JSON.stringify(data), key), { mode: 0o600 });
  const meta = loadMeta();
  meta.keys = Object.entries(data).map(([k, v]) => ({ key: k, description: v.description || "" }));
  saveMeta(meta);
}

// --- MCP Server ---

const server = new McpServer({ name: "vault-mcp", version: "1.0.0" });

server.tool("vault_init", "初始化加密保险箱，生成12位BIP39助记词", {}, async () => {
  if (loadMeta()) {
    return { content: [{ type: "text", text: "⚠️ Vault 已存在。如需重新初始化，请先手动删除 ~/.vault-mcp 目录。" }] };
  }
  const mnemonic = generateMnemonic();
  saveMeta({ mnemonicHash: hashMnemonic(mnemonic), createdAt: new Date().toISOString(), keys: [] });
  saveVault({}, mnemonic);
  return {
    content: [{
      type: "text",
      text: [
        "🔐 Vault 初始化成功！",
        "",
        "你的12位助记词（请立即抄写并安全保管）：",
        "",
        `  ${mnemonic}`,
        "",
        "⚠️ 这是唯一一次显示助记词，丢失后无法恢复！",
        `📁 Vault 位置: ${VAULT_DIR}`,
      ].join("\n"),
    }],
  };
});

server.tool("vault_add", "向保险箱存入敏感信息（需要助记词）", {
  mnemonic: z.string().describe("12位BIP39助记词"),
  key: z.string().describe("名称，如 ssh_key, db_password"),
  value: z.string().describe("敏感信息内容"),
  description: z.string().optional().describe("可选描述"),
}, async ({ mnemonic, key, value, description }) => {
  try {
    const data = decryptVault(mnemonic);
    data[key] = { value, description: description || "", updatedAt: new Date().toISOString() };
    saveVault(data, mnemonic);
    return { content: [{ type: "text", text: `✅ 已存入: ${key}${description ? ` (${description})` : ""}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true };
  }
});

server.tool("vault_get", "从保险箱取出敏感信息（需要助记词）", {
  mnemonic: z.string().describe("12位BIP39助记词"),
  key: z.string().describe("信息名称"),
}, async ({ mnemonic, key }) => {
  try {
    const data = decryptVault(mnemonic);
    if (!(key in data)) return { content: [{ type: "text", text: `❌ 未找到: ${key}` }], isError: true };
    return { content: [{ type: "text", text: `🔓 ${key}: ${data[key].value}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true };
  }
});

server.tool("vault_list", "列出保险箱中所有名称（不显示内容，不需要助记词）", {}, async () => {
  const meta = loadMeta();
  if (!meta) return { content: [{ type: "text", text: "Vault 未初始化" }], isError: true };
  const keys = meta.keys || [];
  if (keys.length === 0) return { content: [{ type: "text", text: "保险箱为空" }] };
  const lines = keys.map((k, i) => `${i + 1}. ${k.key}${k.description ? ` — ${k.description}` : ""}`);
  return { content: [{ type: "text", text: `📋 ${keys.length} 条信息:\n\n${lines.join("\n")}` }] };
});

server.tool("vault_remove", "从保险箱删除一条信息（需要助记词）", {
  mnemonic: z.string().describe("12位BIP39助记词"),
  key: z.string().describe("要删除的名称"),
}, async ({ mnemonic, key }) => {
  try {
    const data = decryptVault(mnemonic);
    if (!(key in data)) return { content: [{ type: "text", text: `❌ 未找到: ${key}` }], isError: true };
    delete data[key];
    saveVault(data, mnemonic);
    return { content: [{ type: "text", text: `✅ 已删除: ${key}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true };
  }
});

server.tool("vault_export", "导出全部信息（需要助记词，谨慎使用）", {
  mnemonic: z.string().describe("12位BIP39助记词"),
}, async ({ mnemonic }) => {
  try {
    const data = decryptVault(mnemonic);
    const entries = Object.entries(data);
    if (entries.length === 0) return { content: [{ type: "text", text: "保险箱为空" }] };
    const lines = entries.map(([k, v]) => `[${k}]${v.description ? ` (${v.description})` : ""}\n${v.value}`);
    return { content: [{ type: "text", text: `🔓 共 ${entries.length} 条:\n\n${lines.join("\n\n")}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true };
  }
});

server.tool("vault_status", "检查保险箱状态", {}, async () => {
  const meta = loadMeta();
  if (!meta) return { content: [{ type: "text", text: "🔴 Vault 未初始化" }] };
  return {
    content: [{
      type: "text",
      text: `🟢 Vault 已就绪\n📁 ${VAULT_DIR}\n🔑 ${(meta.keys || []).length} 条信息\n📅 ${meta.createdAt}`,
    }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
