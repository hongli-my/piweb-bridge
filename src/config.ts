/**
 * config.ts — 全局配置、modelRuntime、共享工具。
 *
 * 根治要点：原 pi-bridge.ts 把所有常量/工具/模型选择混在一个作用域。
 * 这里抽出为独立模块，供 routes/sse/cache 共享。
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// ---------------- 配置 ----------------
export const PORT = Number(process.env.PIWEB_PORT || 8643);
export const CWD = process.env.PIWEB_CWD || process.cwd();
export const AGENT_DIR = process.env.PIWEB_AGENT_DIR || undefined;
export const RESOLVED_AGENT_DIR = AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

// ---------------- 模型 ----------------
export const modelRuntime = await ModelRuntime.create(AGENT_DIR ? { agentDir: AGENT_DIR } : undefined);
export const availableModels = await modelRuntime.getAvailable();

// 用户在 models.json 里自定义配置的 provider 白名单（过滤掉 SDK 内置 provider）
let customProviderNames: Set<string> = new Set();
try {
  const modelsJson = JSON.parse(await readFile(path.join(RESOLVED_AGENT_DIR, "models.json"), "utf8"));
  customProviderNames = new Set(Object.keys(modelsJson.providers || {}));
} catch {}
export const visibleModels = availableModels.filter((mm: any) => customProviderNames.has(mm.provider));

// 默认模型：优先环境变量，其次 anthropic/openai，最后第一个
const _envProvider = process.env.PI_PROVIDER;
const _envModel = process.env.PI_MODEL;
export let defaultModel =
  (_envProvider
    ? availableModels.find((mm: any) => mm.provider === _envProvider && (_envModel ? mm.id === _envModel || mm.name === _envModel : true))
    : undefined) ||
  availableModels.find((mm: any) => mm.provider === "anthropic") ||
  availableModels.find((mm: any) => mm.provider === "openai") ||
  availableModels[0];

if (!defaultModel) {
  console.error("[pi-bridge] 没有可用模型，请先配置 pi 的 API key：pi login 或编辑 ~/.pi/agent/auth.json");
  process.exit(1);
}
console.log(`[pi-bridge] 默认模型: ${defaultModel.name} (${defaultModel.provider}/${defaultModel.id})`);

/** /model POST 时切换默认模型（live binding：import 侧可见最新值） */
export function setDefaultModel(m: any): void { defaultModel = m; }

// ---------------- 文件/设置工具 ----------------
export async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export async function readSettings(): Promise<any> {
  try { return JSON.parse(await readFile(path.join(RESOLVED_AGENT_DIR, "settings.json"), "utf8")); }
  catch { return {}; }
}
export async function writeSettings(s: any): Promise<void> {
  await writeFile(path.join(RESOLVED_AGENT_DIR, "settings.json"), JSON.stringify(s, null, 2) + "\n", "utf8");
}

// ---------------- HTTP 工具 ----------------
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Hermes-Session-Id, X-Pi-Session-Id",
  "Access-Control-Expose-Headers": "X-Hermes-Session-Id",
};

export function json(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

/** 时间戳辅助（诊断日志用，HH:MM:SS.mmm）*/
export function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
