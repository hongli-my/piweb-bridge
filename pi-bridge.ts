#!/usr/bin/env bun
/**
 * pi-bridge — 把 pi-coding-agent 的 AgentSession 桥接成 HTTP/SSE，供 OpenResty piweb 前端消费。
 *
 * 架构（方案 B）：
 *   浏览器 ──HTTP/SSE──▶ OpenResty(/piweb/api 反代) ──▶ pi-bridge:8643 ──SDK──▶ pi AgentSession
 *
 * 协议：
 *   - REST 响应统一 { ok:true, ... } / { ok:false, error } （匹配前端 api.js 解包约定）
 *   - 对话流式：POST /chat/stream 返回 SSE，每个 pi AgentSessionEvent 序列化为一条 data: <json>
 *   - 消息格式：pi 的 AgentMessage(content blocks) → Hermes 兼容格式(content string + tool_calls + reasoning)，
 *     使前端 session.js 的 renderMessages/groupIntoTurns 无需改动
 *
 * 启动：bun run pi-bridge.ts
 *   环境变量：PIWEB_PORT(默认8643) PIWEB_CWD(默认process.cwd()) PIWEB_AGENT_DIR(默认~/.pi/agent)
 */

import { unlink, readdir, readFile, writeFile, mkdir, rm, rename, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Cron } from "croner";
import {
  createAgentSession,
  SessionManager,
  ModelRuntime,
  parseFrontmatter,
  loadSkills,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

// ---------------- 配置 ----------------
const PORT = Number(process.env.PIWEB_PORT || 8643);
const CWD = process.env.PIWEB_CWD || process.cwd();
const AGENT_DIR = process.env.PIWEB_AGENT_DIR || undefined;
// 解析后的 agent 目录（扫描 agents/extensions/skills/settings 用）
const RESOLVED_AGENT_DIR = AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

const modelRuntime = await ModelRuntime.create(AGENT_DIR ? { agentDir: AGENT_DIR } : undefined);
const availableModels = await modelRuntime.getAvailable();
// 用户在 models.json 里自定义配置的 provider 白名单（过滤掉 SDK 内置 provider 如 openai/anthropic）
let customProviderNames: Set<string> = new Set();
try {
  const modelsJson = JSON.parse(await readFile(path.join(RESOLVED_AGENT_DIR, "models.json"), "utf8"));
  customProviderNames = new Set(Object.keys(modelsJson.providers || {}));
} catch {}
// 仅保留自定义 provider 的模型（前端选择器展示 + 切换均基于此）
const visibleModels = availableModels.filter((mm: any) => customProviderNames.has(mm.provider));
// 默认模型：优先环境变量 PI_PROVIDER/PI_MODEL（与 pi CLI 启动一致），其次 anthropic/openai
const _envProvider = process.env.PI_PROVIDER;
const _envModel = process.env.PI_MODEL;
let defaultModel =
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

// ---------------- Subagent / Extension / Skill 管理辅助 ----------------
async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function readSettings(): Promise<any> {
  try { return JSON.parse(await readFile(path.join(RESOLVED_AGENT_DIR, "settings.json"), "utf8")); }
  catch { return {}; }
}
async function writeSettings(s: any): Promise<void> {
  await writeFile(path.join(RESOLVED_AGENT_DIR, "settings.json"), JSON.stringify(s, null, 2) + "\n", "utf8");
}

/** 扫描 agents 目录，解析每个 subagent 的 frontmatter + body */
async function listAgents(): Promise<any[]> {
  const dir = path.join(RESOLVED_AGENT_DIR, "agents");
  const out: any[] = [];
  let entries: any[] = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const subDir = path.join(dir, name);
    // 找 .md：优先 <name>.md，否则目录下第一个 .md
    let file = path.join(subDir, name + ".md");
    if (!await pathExists(file)) {
      let files: string[] = [];
      try { files = await readdir(subDir); } catch { continue; }
      const md = files.find(f => f.endsWith(".md"));
      if (!md) continue;
      file = path.join(subDir, md);
    }
    let content = "";
    try { content = await readFile(file, "utf8"); } catch { continue; }
    const { frontmatter, body } = parseFrontmatter<any>(content);
    const toArray = (v: any): string[] => {
      if (Array.isArray(v)) return v.map(String);
      if (typeof v === "string") return v.split(",").map((s: string) => s.trim()).filter(Boolean);
      return [];
    };
    out.push({
      name: String(frontmatter.name || name),
      description: String(frontmatter.description || ""),
      model: frontmatter.model ? String(frontmatter.model) : "",
      tools: toArray(frontmatter.tools),
      systemPromptMode: String(frontmatter.systemPromptMode || "append"),
      inheritProjectContext: frontmatter.inheritProjectContext !== false,
      inheritSkills: frontmatter.inheritSkills !== false,
      defaultContext: String(frontmatter.defaultContext || "fresh"),
      skills: toArray(frontmatter.skills),
      skillPath: frontmatter.skillPath ? String(frontmatter.skillPath) : "",
      hasSkillsDir: await pathExists(path.join(subDir, "skills")),
      dir: subDir,
      file,
      body: (body || "").trim(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 把 frontmatter + body 序列化为 .md（YAML frontmatter）*/
function serializeAgent(fm: Record<string, any>, body: string): string {
  const order = ["name", "description", "model", "tools", "systemPromptMode", "inheritProjectContext", "inheritSkills", "defaultContext", "skillPath", "skills", "acceptance", "acceptanceRole", "agentContract"];
  const lines = ["---"];
  const seen = new Set<string>();
  const fmt = (v: any): string => {
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
  };
  for (const k of order) {
    if (fm[k] === undefined || fm[k] === null || fm[k] === "") continue;
    if (Array.isArray(fm[k]) && fm[k].length === 0) continue;
    seen.add(k);
    lines.push(`${k}: ${fmt(fm[k])}`);
  }
  for (const k of Object.keys(fm)) {
    if (seen.has(k)) continue;
    if (fm[k] === undefined || fm[k] === null || fm[k] === "") continue;
    if (Array.isArray(fm[k]) && fm[k].length === 0) continue;
    lines.push(`${k}: ${fmt(fm[k])}`);
  }
  lines.push("---", "", (body || "").trim());
  return lines.join("\n") + "\n";
}

/** 列出扩展：本地目录 + settings.packages(npm) */
async function listExtensions(): Promise<any[]> {
  const out: any[] = [];
  // 1. 本地目录扩展
  const localDir = path.join(RESOLVED_AGENT_DIR, "extensions");
  let entries: any[] = [];
  try { entries = await readdir(localDir, { withFileTypes: true }); } catch {}
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const fullPath = path.join(localDir, name);
    const info: any = { name, type: "local", path: fullPath };
    try {
      const pkg = JSON.parse(await readFile(path.join(fullPath, "package.json"), "utf8"));
      info.description = pkg.description || "";
      info.version = pkg.version || "";
      if (pkg.pi) info.pi = pkg.pi;
    } catch {}
    out.push(info);
  }
  // 2. settings.packages 配置的 npm 包
  const settings = await readSettings();
  const packages: any[] = settings.packages || [];
  for (const pkg of packages) {
    const src = typeof pkg === "string" ? pkg : (pkg && pkg.source);
    if (typeof src !== "string") continue;
    if (src.startsWith("npm:")) {
      const pkgName = src.slice(4);
      const realPath = path.join(RESOLVED_AGENT_DIR, "npm", "node_modules", pkgName);
      const info: any = { name: pkgName, type: "package", source: src, path: realPath, configured: true };
      try {
        const p = JSON.parse(await readFile(path.join(realPath, "package.json"), "utf8"));
        info.description = p.description || "";
        info.version = p.version || "";
      } catch { info.installed = false; }
      out.push(info);
    } else if (src.startsWith("git+") || src.startsWith("file:") || src.startsWith("/")) {
      out.push({ name: src, type: "path", source: src, path: src, configured: true });
    } else {
      out.push({ name: src, type: "package", source: src, path: "", configured: true });
    }
  }
  return out;
}

/** 加载 skills（真实，替换空桩）*/
async function listAllSkills(): Promise<any[]> {
  try {
    const res = loadSkills({ cwd: CWD, agentDir: RESOLVED_AGENT_DIR, skillPaths: [], includeDefaults: true });
    return (res.skills || []).map((s: any) => ({
      name: s.name,
      description: s.description || "",
      filePath: s.filePath || "",
      baseDir: s.baseDir || "",
      disableModelInvocation: !!s.disableModelInvocation,
    }));
  } catch (e: any) {
    console.warn("[pi-bridge] loadSkills failed:", e.message);
    return [];
  }
}

// ---------------- 定时任务调度器 ----------------
interface ScheduleTask {
  id: string;
  name: string;
  prompt: string;
  cron: string;            // 5-field cron expression
  timezone: string;        // e.g. "Asia/Shanghai"
  model?: string;          // model id or name; empty = default
  cwd?: string;            // working directory; empty = CWD
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
}

interface ScheduleRun {
  id: string;
  taskId: string;
  status: "running" | "success" | "failed" | "skipped" | "timeout";
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  sessionId?: string;      // pi session id — click to view full conversation
  error?: string;
  snippet?: string;        // first 200 chars of final assistant reply
}

const SCHEDULES_FILE = path.join(RESOLVED_AGENT_DIR, "schedules.json");
const SCHEDULE_RUNS_FILE = path.join(RESOLVED_AGENT_DIR, "schedule_runs.json");
const SCHEDULE_TIMEOUT_MS = Number(process.env.PIWEB_SCHEDULE_TIMEOUT_MS || 5 * 60 * 1000);
const MAX_RUNS_PER_TASK = 50;

const cronJobs = new Map<string, Cron>();           // taskId -> live Cron job
const runningTasks = new Set<string>();              // single-flight guard
let scheduleTasksCache: ScheduleTask[] = [];

async function loadScheduleTasks(): Promise<ScheduleTask[]> {
  try { return JSON.parse(await readFile(SCHEDULES_FILE, "utf8")); } catch { return []; }
}
async function saveScheduleTasks(tasks: ScheduleTask[]): Promise<void> {
  await writeFile(SCHEDULES_FILE, JSON.stringify(tasks, null, 2), "utf8");
}
async function loadScheduleRuns(): Promise<ScheduleRun[]> {
  try { return JSON.parse(await readFile(SCHEDULE_RUNS_FILE, "utf8")); } catch { return []; }
}
async function saveScheduleRuns(runs: ScheduleRun[]): Promise<void> {
  await writeFile(SCHEDULE_RUNS_FILE, JSON.stringify(runs, null, 2), "utf8");
}
async function reloadScheduleTasksCache(): Promise<ScheduleTask[]> {
  scheduleTasksCache = await loadScheduleTasks();
  return scheduleTasksCache;
}

async function appendScheduleRun(run: ScheduleRun): Promise<void> {
  let runs = await loadScheduleRuns();
  runs.unshift(run);
  // Cap per task
  const byTask: Record<string, number> = {};
  const capped: ScheduleRun[] = [];
  for (const r of runs) {
    const n = (byTask[r.taskId] = (byTask[r.taskId] || 0) + 1);
    if (n <= MAX_RUNS_PER_TASK) capped.push(r);
  }
  await saveScheduleRuns(capped);
}

/** Register (or replace) a croner job for a task */
function registerScheduleTask(task: ScheduleTask): void {
  const existing = cronJobs.get(task.id);
  if (existing) { try { existing.stop(); } catch {} }
  if (!task.enabled) return;
  try {
    const job = new Cron(task.cron, { timezone: task.timezone, protect: true }, () => {
      runScheduledTask(task.id).catch(e => console.error(`[pi-bridge] schedule task ${task.id} failed:`, e));
    });
    cronJobs.set(task.id, job);
    task.nextRunAt = job.nextRun()?.getTime() || undefined;
  } catch (e: any) {
    console.error(`[pi-bridge] failed to register cron "${task.cron}" for task ${task.id}:`, e.message);
  }
}

function unregisterScheduleTask(taskId: string): void {
  const job = cronJobs.get(taskId);
  if (job) { try { job.stop(); } catch {} cronJobs.delete(taskId); }
}

/** Execute a scheduled task: create one-shot AgentSession, run prompt, collect result */
async function runScheduledTask(taskId: string): Promise<ScheduleRun> {
  // Single-flight: skip if already running
  if (runningTasks.has(taskId)) {
    const skipRun: ScheduleRun = {
      id: crypto.randomUUID(), taskId, status: "skipped",
      startedAt: Date.now(), finishedAt: Date.now(), durationMs: 0,
    };
    await appendScheduleRun(skipRun);
    console.log(`[pi-bridge] schedule task ${taskId} skipped (already running)`);
    return skipRun;
  }
  runningTasks.add(taskId);

  const tasks = await reloadScheduleTasksCache();
  const task = tasks.find(t => t.id === taskId);
  const runId = crypto.randomUUID();
  const startedAt = Date.now();

  if (!task) {
    const run: ScheduleRun = { id: runId, taskId, status: "failed", startedAt, finishedAt: Date.now(), durationMs: 0, error: "task not found" };
    await appendScheduleRun(run);
    runningTasks.delete(taskId);
    return run;
  }

  console.log(`[pi-bridge] [${ts()}] schedule task "${task.name}" starting...`);

  // Resolve model
  const model = task.model ? availableModels.find((mm: any) => mm.id === task.model || mm.name === task.model) : defaultModel;
  const cwd = task.cwd || CWD;

  let sid = "";
  let status: ScheduleRun["status"] = "success";
  let errorMessage: string | undefined;
  let snippet: string | undefined;
  let session: AgentSession | null = null;

  try {
    const sm = SessionManager.create(cwd);
    const result = await createAgentSession({
      sessionManager: sm,
      modelRuntime,
      cwd,
      model: model || defaultModel,
      ...(AGENT_DIR ? { agentDir: AGENT_DIR } : {}),
    });
    session = result.session;
    sid = session.sessionId;
    await initSessionExtensions(session, result.extensionsResult);
    if (session.sessionFile) idToPath.set(sid, session.sessionFile);

    // Timeout via abort
    const timeout = setTimeout(() => {
      try { session?.abort(); } catch {}
    }, SCHEDULE_TIMEOUT_MS);

    try {
      await session.prompt(task.prompt);
    } finally {
      clearTimeout(timeout);
    }

    // Collect final assistant message for snippet
    const msgs = session.messages;
    const lastAssistant = [...msgs].reverse().find((mm: any) => mm.role === "assistant");
    if (lastAssistant) {
      const text = Array.isArray(lastAssistant.content)
        ? lastAssistant.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
        : (lastAssistant.content || "");
      snippet = text ? text.slice(0, 200) : undefined;
    }
  } catch (e: any) {
    status = e?.message?.includes("abort") ? "timeout" : "failed";
    errorMessage = e?.message || String(e);
  } finally {
    try { session?.dispose(); } catch {}
  }

  const finishedAt = Date.now();
  const run: ScheduleRun = {
    id: runId, taskId, status, startedAt, finishedAt,
    durationMs: finishedAt - startedAt,
    sessionId: sid || undefined, error: errorMessage, snippet,
  };

  // Update task lastRunAt + nextRunAt
  task.lastRunAt = startedAt;
  const job = cronJobs.get(taskId);
  if (job) task.nextRunAt = job.nextRun()?.getTime() || undefined;
  await saveScheduleTasks(tasks);

  await appendScheduleRun(run);
  runningTasks.delete(taskId);
  console.log(`[pi-bridge] [${ts()}] schedule task "${task.name}" ${status} in ${run.durationMs}ms sid=${sid}`);
  return run;
}

// ---------------- 会话缓存 ----------------
// LRU 缓存：长时间运行时避免打开过的 session 全部常驻导致 OOM 崩溃。
// 仅淘汰非流式中的 session；容量可通过 PIWEB_SESSION_CACHE_SIZE 配置（默认 16）。
const SESSION_CACHE_MAX = Number(process.env.PIWEB_SESSION_CACHE_SIZE || 16);
const sessionCache = new Map<string, AgentSession>(); // sessionId -> session（Map 按插入序，touch 时删除再 set 置尾）
const idToPath = new Map<string, string>();           // sessionId -> session 文件路径

/** 命中时调用，把 session 移到 LRU 尾部（最近使用） */
function touchSessionCache(sid: string) {
  const s = sessionCache.get(sid);
  if (s) { sessionCache.delete(sid); sessionCache.set(sid, s); }
}

/** 超容量时淘汰最久未用的非流式 session，释放内存 */
function evictSessionCache() {
  let guard = 0;
  while (sessionCache.size > SESSION_CACHE_MAX && guard++ < SESSION_CACHE_MAX + 4) {
    const oldest = sessionCache.keys().next().value;
    if (oldest === undefined) break;
    const s = sessionCache.get(oldest);
    // 正在流式的 session 不能淘汰：置尾跳过，避免误杀活跃流
    if (s && (s as any).isStreaming) {
      sessionCache.delete(oldest);
      sessionCache.set(oldest, s);
      continue;
    }
    sessionCache.delete(oldest);
    try { s?.dispose(); } catch {}
    console.log("[pi-bridge] LRU evict session:", oldest);
  }
}

async function refreshIdToPath() {
  const all = await SessionManager.listAll();
  for (const s of all) idToPath.set(s.id, s.path);
}

/**
 * 绑定扩展：触发 session_start 事件，让 otel-viewer 等扩展的事件处理器生效。
 * 同时检查 extensionsResult.errors 和运行时 onError，补可观测性。
 */
async function initSessionExtensions(
  session: AgentSession,
  extensionsResult?: { errors?: unknown[] },
) {
  if (extensionsResult?.errors?.length) {
    for (const e of extensionsResult.errors) {
      console.error("[pi-bridge] extension load error:", e instanceof Error ? e.message : e);
    }
  }
  await session.bindExtensions({
    mode: "print",
    onError: (err: unknown) =>
      console.error("[pi-bridge] extension runtime error:", err instanceof Error ? err.message : err),
  });
}

/** 按 sessionId 拿到（或从文件恢复）一个 AgentSession */
async function ensureSession(sid: string): Promise<AgentSession> {
  const cached = sessionCache.get(sid);
  if (cached) { touchSessionCache(sid); return cached; }
  if (!idToPath.has(sid)) await refreshIdToPath();
  const path = idToPath.get(sid);
  if (!path) throw new Error("session not found: " + sid);
  const sm = SessionManager.open(path);
  // 用 session 自身记录的 cwd，而非全局 CWD：恢复已有会话时必须保持原 cwd，
  // 否则 agent 会在 sidecar 启动目录（通常 / 或 home）而非项目目录执行。
  // 旧 session 无 cwd 时回退全局 CWD。
  const cwd = sm.getCwd() || CWD;
  const { session, extensionsResult } = await createAgentSession({
    sessionManager: sm,
    modelRuntime,
    cwd,
    model: defaultModel,
    ...(AGENT_DIR ? { agentDir: AGENT_DIR } : {}),
  });
  await initSessionExtensions(session, extensionsResult);
  sessionCache.set(sid, session);
  evictSessionCache();
  return session;
}

// ---------------- 消息格式转换：pi AgentMessage → Hermes 兼容 ----------------
function toHermesMessage(msg: any): any {
  if (!msg) return msg;
  const ts = msg.timestamp ? Math.floor(new Date(msg.timestamp).getTime() / 1000) : undefined;

  if (msg.role === "user") {
    let content = msg.content;
    if (Array.isArray(content)) {
      content = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    }
    return { role: "user", content, timestamp: ts, id: msg.id };
  }

  if (msg.role === "assistant") {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const thinking = blocks.filter((b: any) => b.type === "thinking").map((b: any) => b.thinking).join("");
    const tool_calls = blocks
      .filter((b: any) => b.type === "toolCall")
      .map((b: any) => ({
        id: b.id,
        type: "function",
        function: {
          name: b.name,
          arguments: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments || {}),
        },
      }));
    return {
      role: "assistant",
      content: text,
      reasoning: thinking,
      tool_calls,
      timestamp: ts,
      _usage: msg.usage,
      id: msg.id,
    };
  }

  if (msg.role === "toolResult") {
    const text = Array.isArray(msg.content)
      ? msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
      : msg.content || "";
    return {
      role: "tool",
      tool_call_id: msg.toolCallId,
      toolName: msg.toolName,
      content: text,
      isError: msg.isError,
      timestamp: ts,
      id: msg.id,
    };
  }

  return msg;
}

/** 把事件里的 message/messages/toolResults 字段转成 Hermes 格式，type 保持 pi 原生；
 *  同时裁剪前端不消费的重量级字段，避免 SSE 体积爆炸（多轮+大工具输出时 agent_end.messages 可达数 MB） */
function transformEvent(event: any): any {
  const t = event?.type;
  // agent_end：前端无处理分支，messages 数组（含全部历史+工具输出）可达数 MB，剥离
  if (t === "agent_end") {
    const { messages, ...rest } = event;
    return rest;
  }
  // turn_end：前端无处理分支，message(完整 content blocks)/toolResults 剥离
  if (t === "turn_end") {
    const { message, toolResults, ...rest } = event;
    return rest;
  }
  // message_update：前端只用 assistantMessageEvent.delta/type/toolCall，
  // partial 是累积全量（每个 delta 都带从头累积的完整内容，冗余且随回复变长膨胀），剥离
  if (t === "message_update" && event.assistantMessageEvent) {
    const { partial, ...aeRest } = event.assistantMessageEvent;
    return { ...event, assistantMessageEvent: aeRest };
  }
  // 其余事件：转换 message/messages/toolResults 字段为 Hermes 格式
  let out = event;
  if (event.message) out = { ...event, message: toHermesMessage(event.message) };
  if (event.messages) out = { ...event, messages: event.messages.map(toHermesMessage) };
  if (event.toolResults) out = { ...event, toolResults: event.toolResults.map(toHermesMessage) };
  return out;
}

// ---------------- HTTP 辅助 ----------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Hermes-Session-Id, X-Pi-Session-Id",
  "Access-Control-Expose-Headers": "X-Hermes-Session-Id",
};

function json(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function readBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

// 进程内同步忙锁：防止同一 session 并发 prompt 搅乱状态（isStreaming 检查有异步窗口，不可靠）
const busySessions = new Set<string>();

// 活跃 SSE 流的 finish 回调集合：进程收到 SIGTERM/SIGINT 优雅退出时，
// 先把所有在途流正常 finish（发送 chunked 终止符），避免 nginx 报
// "upstream prematurely closed connection" / 浏览器报 ERR_INCOMPLETE_CHUNKED_ENCODING。
const activeStreamFinishers = new Set<() => void>();

// SSE 心跳间隔（保持连接活性，防 nginx/浏览器 idle 断开）与最大流寿命（agent 卡死时兑底强制结束）
const HEARTBEAT_MS = Number(process.env.PIWEB_HEARTBEAT_MS || 5000);
const MAX_STREAM_MS = Number(process.env.PIWEB_MAX_STREAM_MS || 30 * 60 * 1000);

// 时间戳辅助（诊断日志用，HH:MM:SS.mmm）
function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/** 构造 SSE 流：订阅 session 事件 → 序列化推送；prompt 驱动 */
function sseResponse(session: AgentSession, message: string, lockSid?: string): Response {
  const enc = new TextEncoder();
  let unsub: (() => void) | undefined;
  let finished = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let hbCount = 0;
  const startedAt = Date.now();
  let finishReason = "unknown";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const doSend = (obj: any) => {
        if (finished) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {}
      };
      const finish = (reason?: string) => {
        if (finished) return;
        finished = true;
        if (reason) finishReason = reason;
        try { if (unsub) unsub(); } catch {}
        try { if (heartbeat) clearInterval(heartbeat); } catch {}
        try { if (watchdog) clearTimeout(watchdog); } catch {}
        try { if (lockSid) busySessions.delete(lockSid); } catch {}
        try { controller.close(); } catch {}
        try { activeStreamFinishers.delete(finisher); } catch {}
        console.log(`[pi-bridge] [${ts()}] SSE finish sid=${lockSid || "-"} reason=${finishReason} hb=${hbCount} elapsed=${Date.now() - startedAt}ms`);
      };
      // 注册到全局集合，供优雅退出时调用
      const finisher = () => finish("shutdown");
      activeStreamFinishers.add(finisher);

      // 心跳：SSE 注释行（: ping），前端解析器忽略，但字节流保持流动，防止中间链路 idle 断开
      // 关键：Bun.serve 默认 idleTimeout=10s，而 setInterval 首次触发在间隔之后，
      // 若间隔>10s 则首次心跳永远赶不上 → 连接被掐。故：① 流启动立即发一个 ping 覆盖开头空窗；
      // ② 间隔降到 5s（< 10s idle 窗口），保证任何静默期内都有字节流过。
      try { controller.enqueue(enc.encode(`: ping\n\n`)); hbCount++; } catch {}
      heartbeat = setInterval(() => {
        if (finished) return;
        try { controller.enqueue(enc.encode(`: ping\n\n`)); hbCount++; } catch {}
      }, HEARTBEAT_MS);

      // 兑底最大寿命：agent 真正卡死（进程活着但不发事件）时强制结束，避免前端永远转圈
      watchdog = setTimeout(() => {
        console.warn(`[pi-bridge] [${ts()}] stream max lifetime reached, force finish sid=${lockSid || "-"}`);
        doSend({ type: "error", error: "agent timed out (max stream lifetime)" });
        finish("max_lifetime");
      }, MAX_STREAM_MS);

      // 订阅事件：每个事件独立 try/catch，避免单个坏事件导致 agent_settled 漏处理 → 流永不关闭
      unsub = session.subscribe((event: any) => {
        try {
          doSend(transformEvent(event));
        } catch (e: any) {
          console.warn(`[pi-bridge] [${ts()}] transform/send event failed:`, e?.message, "type=", event?.type);
        }
        try {
          if (event?.type === "agent_settled") finish("settled");
        } catch {}
      });

      try {
        console.log(`[pi-bridge] [${ts()}] prompt start sid=${lockSid || "-"}: ${message.slice(0, 40)} | isStreaming: ${(session as any).isStreaming}`);
        await session.prompt(message);
        console.log(`[pi-bridge] [${ts()}] prompt done sid=${lockSid || "-"}`);
      } catch (e: any) {
        console.log(`[pi-bridge] [${ts()}] prompt error sid=${lockSid || "-"}:`, e.message);
        doSend({ type: "error", error: e.message || String(e) });
      } finally {
        // 给 agent_settled 一点时间到达；若无则强制收尾
        setTimeout(() => finish("prompt_done"), 500);
      }
    },
    cancel() {
      finished = true;
      finishReason = "client_cancel";
      console.log(`[pi-bridge] [${ts()}] SSE cancel (client disconnected) sid=${lockSid || "-"} hb=${hbCount} elapsed=${Date.now() - startedAt}ms`);
      try { if (unsub) unsub(); } catch {}
      try { if (heartbeat) clearInterval(heartbeat); } catch {}
      try { if (watchdog) clearTimeout(watchdog); } catch {}
      try { if (lockSid) busySessions.delete(lockSid); } catch {}
      try { activeStreamFinishers.delete(finisher); } catch {}
      try { session.abort(); } catch {}
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...CORS,
    },
  });
}

// ---------------- 路由 ----------------
const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      // ---- 健康检查 ----
      if (p === "/health" && m === "GET") return json({ ok: true, status: "up" });
      if ((p === "/status" || p === "/gateway_status") && m === "GET")
        return json({ ok: true, data: { status: "up", http_code: 200 }, model: defaultModel?.name });

      // ---- 会话列表 ----
      if (p === "/sessions" && m === "GET") {
        const all = await SessionManager.listAll();
        for (const s of all) idToPath.set(s.id, s.path);
        return json({
          ok: true,
          data: all.map((s: any) => ({
            id: s.id,
            title: s.name || (s.firstMessage || "").slice(0, 48) || "Session",
            message_count: s.messageCount,
            started_at: Math.floor(s.created.getTime() / 1000),
            ended_at: Math.floor(s.modified.getTime() / 1000),
            model: "",
            input_tokens: 0,
            output_tokens: 0,
            path: s.path,
            cwd: s.cwd || CWD,   // 项目=目录：每个会话带 cwd，前端用于项目过滤
          })),
        });
      }

      // ---- 新建会话 ----
      if (p === "/sessions" && m === "POST") {
        const body = await readBody(req);
        const cwd = body.working_dir || CWD;
        const sm = SessionManager.create(cwd);
        const { session, extensionsResult } = await createAgentSession({
          sessionManager: sm,
          modelRuntime,
          cwd,
          model: defaultModel,
          ...(AGENT_DIR ? { agentDir: AGENT_DIR } : {}),
        });
        await initSessionExtensions(session, extensionsResult);
        const sid = session.sessionId;
        sessionCache.set(sid, session);
        evictSessionCache();
        if (session.sessionFile) idToPath.set(sid, session.sessionFile);
        return json({ ok: true, session: { id: sid }, session_id: sid });
      }

      // ---- /sessions/:id[/sub] ----
      const sMatch = p.match(/^\/sessions\/([^/]+)(\/.*)?$/);
      if (sMatch) {
        const sid = sMatch[1];
        const sub = sMatch[2];

        // GET /sessions/:id — 详情
        if (!sub && m === "GET") {
          const session = await ensureSession(sid);
          const msgs = session.messages;
          let inT = 0, outT = 0;
          for (const mm of msgs) {
            if (mm.usage) { inT += mm.usage.input || 0; outT += mm.usage.output || 0; }
          }
          const first = msgs[0], last = msgs[msgs.length - 1];
          return json({
            ok: true,
            data: {
              title: sid.slice(0, 12),
              model: (session as any).model?.name || "",
              started_at: first?.timestamp ? Math.floor(new Date(first.timestamp).getTime() / 1000) : 0,
              ended_at: last?.timestamp ? Math.floor(new Date(last.timestamp).getTime() / 1000) : 0,
              message_count: msgs.length,
              input_tokens: inT,
              output_tokens: outT,
            },
          });
        }

        // GET /sessions/:id/messages — 消息（转换格式）
        if (sub === "/messages" && m === "GET") {
          const session = await ensureSession(sid);
          return json({ ok: true, data: session.messages.map(toHermesMessage) });
        }

        // POST /sessions/:id/fork — 复制当前路径为新会话
        if (sub === "/fork" && m === "POST") {
          const session = await ensureSession(sid);
          if (!session.sessionFile) throw new Error("session 无文件，无法 fork");
          const sm = SessionManager.open(session.sessionFile);
          const leaf = sm.getLeafEntry();
          const newPath = sm.createBranchedSession(leaf.id);
          await refreshIdToPath();
          let newId = "";
          for (const [k, v] of idToPath) if (v === newPath) newId = k;
          return json({ ok: true, session_id: newId || newPath });
        }

        // DELETE /sessions/:id
        if (!sub && m === "DELETE") {
          const path = idToPath.get(sid);
          if (path) { try { await unlink(path); } catch {} }
          const s = sessionCache.get(sid);
          if (s) { try { s.dispose(); } catch {} }
          sessionCache.delete(sid);
          idToPath.delete(sid);
          return json({ ok: true });
        }

        // PATCH /sessions/:id — rename（setSessionName 内部调 sessionManager.appendSessionInfo 落盘）
        if (!sub && m === "PATCH") {
          const body = await readBody(req);
          const newTitle = (body.title || "").toString().trim();
          if (!newTitle) return json({ ok: false, error: "title required" }, 400);
          const session = await ensureSession(sid);
          session.setSessionName(newTitle);
          return json({ ok: true, title: newTitle });
        }
      }

      // ---- 对话流式 ----
      if (p === "/chat/stream" && m === "POST") {
        const body = await readBody(req);
        const sid = body.session_id;
        if (!sid) return json({ ok: false, error: "session_id required" }, 400);
        // 同步忙锁：在任何 await 之前抢占，消除并发竞态窗口（isStreaming 检查有异步窗口不可靠）
        if (busySessions.has(sid)) return json({ ok: false, error: "session is busy" }, 409);
        busySessions.add(sid);
        try {
          const session = await ensureSession(sid);
          return sseResponse(session, body.message || "", sid);
        } catch (e) {
          busySessions.delete(sid);
          throw e;
        }
      }

      // ---- 插话（边跑边改需求）----
      if (p === "/steer" && m === "POST") {
        const body = await readBody(req);
        const session = await ensureSession(body.session_id);
        await session.steer(body.message || "");
        return json({ ok: true });
      }

      // ---- 跟进（跑完再做）----
      if (p === "/follow_up" && m === "POST") {
        const body = await readBody(req);
        const session = await ensureSession(body.session_id);
        await session.followUp(body.message || "");
        return json({ ok: true });
      }

      // ---- 中止 ----
      if (p === "/abort" && m === "POST") {
        const body = await readBody(req);
        const sid = body.session_id;
        if (sid) busySessions.delete(sid);   // 立即释放忙锁，前端可马上重发
        try {
          const session = await ensureSession(sid);
          await session.abort();
        } catch {}
        return json({ ok: true });
      }

      // ---- 审批/扩展 UI 响应回传（TODO: SDK 模式 extension UI 桥接）----
      if (p === "/ui-response" && m === "POST") {
        // SDK 模式下 extension UI 的 select/confirm 等回传通道尚未接通，先记录
        return json({ ok: true });
      }

      // ---- 手动压缩上下文 ----
      // 调用 session.compact()，SDK 会 emit compaction_start/compaction_end 事件。
      // 手动压缩时 agent 通常空闲（无活跃 SSE），事件无人接收，故在此同步返回 result 供前端展示。
      // 自动压缩（threshold/overflow）发生在 agent 回合中，有 SSE 连接，事件经 sseResponse 透传给前端。
      if (p === "/compact" && m === "POST") {
        const body = await readBody(req);
        const sid = body.session_id;
        if (!sid) return json({ ok: false, error: "missing session_id" }, 400);
        if (busySessions.has(sid)) return json({ ok: false, error: "session is busy" }, 409);
        busySessions.add(sid);
        try {
          const session = await ensureSession(sid);
          const result = await session.compact();
          return json({ ok: true, result: result || null });
        } catch (e: any) {
          return json({ ok: false, error: e?.message || String(e) }, 500);
        } finally {
          busySessions.delete(sid);
        }
      }

      // ---- 上下文用量 ----
      // 算法：当前上下文窗口占用 = 最后一条 assistant 消息的 usage.input + usage.cacheRead
      //   （每轮 LLM 调用回执的 input 已是该轮发给模型的完整上下文大小；
      //    cacheRead>0 时 input 是非缓存增量，两者之和即窗口实际占用）
      // 不再用历史所有轮次 input 累加（那是累计消耗，会虚高超过 contextWindow）。
      // 附带 next_input 估算：下一次请求 input ≈ 当前占用 + 末轮 output（再加新用户消息）
      //
      // contextWindow 兜底：与 pi SDK compaction/branch-summarization.js 一致，
      //   model.contextWindow 缺失或为 0 时用 128000。
      //   这样 /context 的百分比与 SDK 内部 shouldCompact 触发阈值对齐：
      //   压缩在 contextTokens > contextWindow - reserveTokens(默认16384) 时触发，
      //   即 128K 窗口 ≈ 111.6K 时压缩；此端点 percent 也基于同一 max 计算。
      if (p === "/context" && m === "GET") {
        const sid = url.searchParams.get("session_id") || "";
        const FALLBACK_CONTEXT_WINDOW = 128000;
        let model = "-", active = false, max = 0, used = 0;
        let lastInput = 0, lastOutput = 0;
        let estimated = false;
        const cached = sid ? sessionCache.get(sid) : undefined;
        if (cached) {
          active = (cached as any).isStreaming;
          model = (cached as any).model?.name || "-";
          const declaredWin = (cached as any).model?.contextWindow || 0;
          if (declaredWin > 0) {
            max = declaredWin;
          } else {
            max = FALLBACK_CONTEXT_WINDOW;
            estimated = true;  // 标记窗口为兜底估算值
          }
          // 倒序找最后一条带 usage 的 assistant 消息
          for (let i = cached.messages.length - 1; i >= 0; i--) {
            const mm: any = cached.messages[i];
            if (mm.role === "assistant" && mm.usage) {
              lastInput = (mm.usage.input || 0) + (mm.usage.cacheRead || 0);
              lastOutput = mm.usage.output || 0;
              used = lastInput;
              break;
            }
          }
        }
        return json({
          ok: true,
          context: {
            model, active,
            max_tokens: max,
            used_tokens: used,
            percent: max ? Math.min(100, Math.round((used / max) * 100)) : 0,
            // 下一次请求 input 估算 = 当前窗口占用 + 末轮 output（不含待发的新用户消息）
            next_input: used + lastOutput,
            last_input: lastInput,
            last_output: lastOutput,
            estimated,  // true=窗口大小为兜底估算（model 未声明 contextWindow）
            duration: "-",
          },
        });
      }

      // ---- 模型 / Provider（前端模型选择器复用）----
      if (p === "/providers" && m === "GET") {
        // 按 provider 动态分组，只返回用户在 models.json 里配置的自定义 provider
        const providersMap = new Map<string, any[]>();
        for (const mm of visibleModels) {
          const pv = (mm as any).provider;
          if (!providersMap.has(pv)) providersMap.set(pv, []);
          providersMap.get(pv)!.push(mm);
        }
        const providers = Array.from(providersMap.entries()).map(([name, models]) => ({
          name,
          models: models.map((mm: any) => ({
            id: mm.id, name: mm.name,
            reasoning: !!mm.reasoning,
            contextWindow: mm.contextWindow || 0,
            input: mm.input || [],
          }))
        }));
        return json({
          ok: true,
          providers,
          current: defaultModel ? { provider: defaultModel.provider, modelId: defaultModel.id, name: defaultModel.name } : null,
          // 兼容旧字段
          current_provider: defaultModel?.id || "",
        });
      }
      if (p === "/models" && m === "GET") {
        return json({ ok: true, models: visibleModels.map((mm: any) => ({ id: mm.id, name: mm.name, provider: mm.provider })) });
      }
      if (p === "/model" && m === "POST") {
        const body = await readBody(req);
        // 优先 provider + modelId 精确定位；兼容旧 provider=模型id
        let target: any;
        if (body.provider && body.modelId) {
          target = visibleModels.find((mm: any) => mm.provider === body.provider && mm.id === body.modelId);
        } else if (body.modelId) {
          target = visibleModels.find((mm: any) => mm.id === body.modelId);
        } else if (body.provider) {
          target = visibleModels.find((mm: any) => mm.id === body.provider || mm.provider === body.provider);
        }
        if (!target) return json({ ok: false, error: "model not found" }, 404);
        defaultModel = target;
        // 切换所有缓存 session 的模型
        for (const s of sessionCache.values()) {
          try { await s.setModel(target); } catch {}
        }
        return json({ ok: true, data: { provider: target.provider, modelId: target.id, name: target.name } });
      }

      // ---- Subagents 管理（读写 ~/.pi/agent/agents）----
      if (p === "/agents" && m === "GET") return json({ ok: true, data: await listAgents() });

      const agentMatch = p.match(/^\/agents\/([^/]+)$/);
      if (agentMatch && m === "GET") {
        const list = await listAgents();
        const a = list.find(x => x.name === agentMatch[1] || path.basename(x.dir) === agentMatch[1]);
        if (!a) return json({ ok: false, error: "agent not found" }, 404);
        return json({ ok: true, data: a });
      }
      if (agentMatch && m === "DELETE") {
        const dir = path.join(RESOLVED_AGENT_DIR, "agents", agentMatch[1]);
        if (!await pathExists(dir)) return json({ ok: false, error: "not found" }, 404);
        await rm(dir, { recursive: true, force: true });
        return json({ ok: true });
      }
      if (p === "/agents" && m === "POST") {
        const b = await readBody(req);
        const name = String(b.name || "").trim();
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) return json({ ok: false, error: "invalid name (a-z 0-9 _ -)" }, 400);
        const agentDir = path.join(RESOLVED_AGENT_DIR, "agents", name);
        if (await pathExists(agentDir)) return json({ ok: false, error: "agent already exists" }, 409);
        await mkdir(agentDir, { recursive: true });
        const file = path.join(agentDir, name + ".md");
        const fm: Record<string, any> = {
          name,
          description: b.description || "",
          model: b.model || "",
          tools: b.tools || [],
          systemPromptMode: b.systemPromptMode || "append",
          inheritProjectContext: b.inheritProjectContext !== false,
          inheritSkills: b.inheritSkills !== false,
          defaultContext: b.defaultContext || "fresh",
          skillPath: b.skillPath || "",
          skills: b.skills || [],
        };
        await writeFile(file, serializeAgent(fm, b.body || ""), "utf8");
        return json({ ok: true, data: { ...fm, dir: agentDir, file, body: (b.body || "").trim(), hasSkillsDir: false } });
      }
      if (agentMatch && m === "PATCH") {
        const oldName = agentMatch[1];
        const b = await readBody(req);
        const list = await listAgents();
        const a = list.find(x => x.name === oldName || path.basename(x.dir) === oldName);
        if (!a) return json({ ok: false, error: "agent not found" }, 404);
        const newName = String(b.name || a.name).trim();
        let dir = a.dir, file = a.file, finalName = a.name;
        if (newName !== a.name && newName) {
          if (!/^[a-zA-Z0-9_-]+$/.test(newName)) return json({ ok: false, error: "invalid name" }, 400);
          const newDir = path.join(RESOLVED_AGENT_DIR, "agents", newName);
          if (await pathExists(newDir)) return json({ ok: false, error: "name already exists" }, 409);
          await rename(a.dir, newDir);
          const oldFile = path.join(newDir, path.basename(a.file));
          const newFile = path.join(newDir, newName + ".md");
          if (await pathExists(oldFile)) await rename(oldFile, newFile);
          dir = newDir; file = newFile; finalName = newName;
        }
        const fm: Record<string, any> = {
          name: finalName,
          description: b.description !== undefined ? b.description : a.description,
          model: b.model !== undefined ? b.model : a.model,
          tools: b.tools !== undefined ? b.tools : a.tools,
          systemPromptMode: b.systemPromptMode !== undefined ? b.systemPromptMode : a.systemPromptMode,
          inheritProjectContext: b.inheritProjectContext !== undefined ? b.inheritProjectContext : a.inheritProjectContext,
          inheritSkills: b.inheritSkills !== undefined ? b.inheritSkills : a.inheritSkills,
          defaultContext: b.defaultContext !== undefined ? b.defaultContext : a.defaultContext,
          skillPath: b.skillPath !== undefined ? b.skillPath : a.skillPath,
          skills: b.skills !== undefined ? b.skills : a.skills,
        };
        const bodyText = b.body !== undefined ? b.body : a.body;
        await writeFile(file, serializeAgent(fm, bodyText), "utf8");
        return json({ ok: true, data: { ...fm, dir, file, body: (bodyText || "").trim(), hasSkillsDir: a.hasSkillsDir } });
      }

      // ---- Extensions 展示（本地目录 + packages）----
      if (p === "/extensions" && m === "GET") return json({ ok: true, data: await listExtensions() });

      // ---- Skills（真实加载，替换空桩）----
      if ((p === "/skills" || p === "/skills/builtin") && m === "GET") {
        const skills = await listAllSkills();
        return json({ ok: true, skills, data: skills });
      }

      // ---- Settings 读/写 ----
      if (p === "/settings" && m === "GET") return json({ ok: true, data: await readSettings() });
      if (p === "/settings" && m === "PATCH") {
        const b = await readBody(req);
        const s = await readSettings();
        Object.assign(s, b);
        await writeSettings(s);
        return json({ ok: true, data: s });
      }

      // ---- 项目 = 目录（pi session 按 cwd 存储，项目 id 直接用 cwd）----
      if (p.startsWith("/projects")) {
        // 聚合所有 session 的 cwd，去重成项目列表
        async function listProjects() {
          const all = await SessionManager.listAll();
          const byCwd: Record<string, { count: number; modified: Date }> = {};
          for (const s of all) {
            const c = s.cwd || CWD;
            if (!byCwd[c]) byCwd[c] = { count: 0, modified: s.modified };
            byCwd[c].count++;
            if (s.modified > byCwd[c].modified) byCwd[c].modified = s.modified;
          }
          return Object.entries(byCwd).map(([cwd, info]) => ({
            id: cwd,                          // 项目 id = cwd 路径
            name: cwd.split("/").pop() || cwd, // 项目名=目录名
            path: cwd,
            created_at: Math.floor(Date.now() / 1000),
            session_count: info.count,
          }));
        }
        // GET /projects/mapping — sessionId → cwd（项目 id）
        if (p === "/projects/mapping" && m === "GET") {
          const all = await SessionManager.listAll();
          const map: Record<string, string> = {};
          for (const s of all) map[s.id] = s.cwd || CWD;
          return json({ ok: true, data: map });
        }
        if (p === "/projects" && m === "GET") return json({ ok: true, data: await listProjects() });
        // POST /projects — 新增项目目录（前端“选择目录”用）
        if (p === "/projects" && m === "POST") {
          const body = await readBody(req);
          const path = body.path || CWD;
          return json({ ok: true, data: { id: path, name: body.name || (path.split("/").pop() || path), path } });
        }
        // POST /projects/:id/assign — pi 中 session 的 cwd 由创建时决定，不可后改；桩化
        if (p.match(/^\/projects\/[^/]+\/assign$/) && m === "POST") return json({ ok: true });
        return json({ ok: true });
      }

      // ---- 定时任务（Schedules）----
      if (p === "/schedules" && m === "GET") {
        const tasks = await reloadScheduleTasksCache();
        for (const t of tasks) {
          const job = cronJobs.get(t.id);
          if (job && t.enabled) t.nextRunAt = job.nextRun()?.getTime() || undefined;
        }
        return json({ ok: true, data: tasks });
      }
      if (p === "/schedules" && m === "POST") {
        const body = await readBody(req);
        const task: ScheduleTask = {
          id: crypto.randomUUID(),
          name: body.name || "Untitled",
          prompt: body.prompt || "",
          cron: body.cron || "* * * * *",
          timezone: body.timezone || "Asia/Shanghai",
          model: body.model || undefined,
          cwd: body.cwd || CWD,
          enabled: body.enabled !== false,
          createdAt: Date.now(),
        };
        const tasks = await reloadScheduleTasksCache();
        tasks.push(task);
        registerScheduleTask(task);
        await saveScheduleTasks(tasks);
        return json({ ok: true, data: task });
      }
      if (p.match(/^\/schedules\/[^/]+$/) && (m === "PUT" || m === "PATCH")) {
        const tid = p.split("/")[2];
        const tasks = await reloadScheduleTasksCache();
        const task = tasks.find(t => t.id === tid);
        if (!task) return json({ ok: false, error: "task not found" }, 404);
        const body = await readBody(req);
        if (body.name !== undefined) task.name = body.name;
        if (body.prompt !== undefined) task.prompt = body.prompt;
        if (body.cron !== undefined) task.cron = body.cron;
        if (body.timezone !== undefined) task.timezone = body.timezone;
        if (body.model !== undefined) task.model = body.model || undefined;
        if (body.cwd !== undefined) task.cwd = body.cwd;
        if (body.enabled !== undefined) task.enabled = body.enabled;
        registerScheduleTask(task);
        await saveScheduleTasks(tasks);
        return json({ ok: true, data: task });
      }
      if (p.match(/^\/schedules\/[^/]+$/) && m === "DELETE") {
        const tid = p.split("/")[2];
        unregisterScheduleTask(tid);
        const tasks = await reloadScheduleTasksCache();
        const idx = tasks.findIndex(t => t.id === tid);
        if (idx >= 0) tasks.splice(idx, 1);
        await saveScheduleTasks(tasks);
        return json({ ok: true });
      }
      if (p.match(/^\/schedules\/[^/]+\/run$/) && m === "POST") {
        const tid = p.split("/")[2];
        const run = await runScheduledTask(tid);
        return json({ ok: true, data: run });
      }
      if (p.match(/^\/schedules\/[^/]+\/runs$/) && m === "GET") {
        const tid = p.split("/")[2];
        const runs = await loadScheduleRuns();
        return json({ ok: true, data: runs.filter(r => r.taskId === tid) });
      }

      // ---- 其它 Hermes 专属功能（memory/cron/kanban/workflow/search）桩化 ----
      if (p.startsWith("/memory") || p.startsWith("/cron") || p.startsWith("/kanban") ||
          p.startsWith("/workflow") || p.startsWith("/search") || p.startsWith("/skills")) {
        return json({ ok: true, data: [], items: [], sessions: [] });
      }

      return json({ ok: false, error: "not found: " + m + " " + p }, 404);
    } catch (e: any) {
      console.error("[pi-bridge] error:", e);
      return json({ ok: false, error: e.message || String(e) }, 500);
    }
  },
});

console.log(`[pi-bridge] listening on http://127.0.0.1:${server.port}  cwd=${CWD}`);

// ---------------- 定时任务调度器初始化 ----------------
(async () => {
  try {
    const tasks = await reloadScheduleTasksCache();
    let count = 0;
    for (const t of tasks) {
      if (t.enabled) { registerScheduleTask(t); count++; }
    }
    if (tasks.length > 0) await saveScheduleTasks(tasks); // persist nextRunAt
    console.log(`[pi-bridge] schedules: ${count}/${tasks.length} tasks registered`);
  } catch (e: any) {
    console.error("[pi-bridge] failed to load schedules:", e.message);
  }
})();

// ---------------- 优雅退出 ----------------
// 收到 SIGTERM/SIGINT 时，先把所有在途 SSE 流正常 finish（发送 chunked 终止符），
// 再退出进程。避免 stop/restart 时进行中的流被强制截断，导致前端 ERR_INCOMPLETE_CHUNKED_ENCODING。
let shuttingDown = false;
function gracefulShutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[pi-bridge] [${ts()}] ${sig} received, finishing ${activeStreamFinishers.size} active stream(s)...`);
  for (const f of activeStreamFinishers) {
    try { f(); } catch {}
  }
  // 给 socket 一点时间把终止符/缓冲发出去再退
  setTimeout(() => {
    try { server.stop(true); } catch {}
    process.exit(0);
  }, 400);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
