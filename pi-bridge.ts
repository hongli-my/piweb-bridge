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

// ---------------- 会话缓存 ----------------
const sessionCache = new Map<string, AgentSession>(); // sessionId -> session
const idToPath = new Map<string, string>();           // sessionId -> session 文件路径

async function refreshIdToPath() {
  const all = await SessionManager.listAll();
  for (const s of all) idToPath.set(s.id, s.path);
}

/** 按 sessionId 拿到（或从文件恢复）一个 AgentSession */
async function ensureSession(sid: string): Promise<AgentSession> {
  const cached = sessionCache.get(sid);
  if (cached) return cached;
  if (!idToPath.has(sid)) await refreshIdToPath();
  const path = idToPath.get(sid);
  if (!path) throw new Error("session not found: " + sid);
  const sm = SessionManager.open(path);
  const { session } = await createAgentSession({
    sessionManager: sm,
    modelRuntime,
    cwd: CWD,
    model: defaultModel,
    ...(AGENT_DIR ? { agentDir: AGENT_DIR } : {}),
  });
  sessionCache.set(sid, session);
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

/** 把事件里的 message/messages/toolResults 字段转成 Hermes 格式，type 保持 pi 原生 */
function transformEvent(event: any): any {
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

/** 构造 SSE 流：订阅 session 事件 → 序列化推送；prompt 驱动 */
function sseResponse(session: AgentSession, message: string): Response {
  const enc = new TextEncoder();
  let unsub: (() => void) | undefined;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const doSend = (obj: any) => {
        if (finished) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {}
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        try { if (unsub) unsub(); } catch {}
        try { controller.close(); } catch {}
      };
      unsub = session.subscribe((event: any) => {
        doSend(transformEvent(event));
        if (event.type === "agent_settled") finish();
      });
      try {
        console.log("[pi-bridge] prompt start:", message.slice(0, 40), "| isStreaming:", (session as any).isStreaming);
        await session.prompt(message);
        console.log("[pi-bridge] prompt done");
      } catch (e: any) {
        console.log("[pi-bridge] prompt error:", e.message);
        doSend({ type: "error", error: e.message || String(e) });
      } finally {
        setTimeout(finish, 500);
      }
    },
    cancel() {
      finished = true;
      try { if (unsub) unsub(); } catch {}
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
        const { session } = await createAgentSession({
          sessionManager: sm,
          modelRuntime,
          cwd,
          model: defaultModel,
          ...(AGENT_DIR ? { agentDir: AGENT_DIR } : {}),
        });
        const sid = session.sessionId;
        sessionCache.set(sid, session);
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

        // PATCH /sessions/:id — rename（暂桩，pi 用 set_session_name 但需 SessionManager）
        if (!sub && m === "PATCH") return json({ ok: true });
      }

      // ---- 对话流式 ----
      if (p === "/chat/stream" && m === "POST") {
        const body = await readBody(req);
        const sid = body.session_id;
        if (!sid) return json({ ok: false, error: "session_id required" }, 400);
        const session = await ensureSession(sid);
        if ((session as any).isStreaming) return json({ ok: false, error: "session is busy" }, 409);
        return sseResponse(session, body.message || "");
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
        const session = await ensureSession(body.session_id);
        await session.abort();
        return json({ ok: true });
      }

      // ---- 审批/扩展 UI 响应回传（TODO: SDK 模式 extension UI 桥接）----
      if (p === "/ui-response" && m === "POST") {
        // SDK 模式下 extension UI 的 select/confirm 等回传通道尚未接通，先记录
        return json({ ok: true });
      }

      // ---- 上下文用量 ----
      if (p === "/context" && m === "GET") {
        const sid = url.searchParams.get("session_id") || "";
        let model = "-", active = false, max = 0, used = 0;
        const cached = sid ? sessionCache.get(sid) : undefined;
        if (cached) {
          active = (cached as any).isStreaming;
          model = (cached as any).model?.name || "-";
          max = (cached as any).model?.contextWindow || 0;
          for (const mm of cached.messages) {
            if (mm.usage) used += (mm.usage.input || 0) + (mm.usage.cacheRead || 0);
          }
        }
        return json({
          ok: true,
          context: {
            model, active,
            max_tokens: max,
            used_tokens: used,
            percent: max ? Math.min(100, Math.round((used / max) * 100)) : 0,
            duration: "-",
          },
        });
      }

      // ---- 模型 / Provider（前端 provider-selector 复用）----
      if (p === "/providers" && m === "GET") {
        return json({
          ok: true,
          providers: availableModels.slice(0, 12).map((mm: any) => ({ name: mm.id, model: mm.name })),
          current_provider: defaultModel?.id || "",
        });
      }
      if (p === "/models" && m === "GET") {
        return json({ ok: true, models: availableModels.map((mm: any) => ({ id: mm.id, name: mm.name, provider: mm.provider })) });
      }
      if (p === "/model" && m === "POST") {
        const body = await readBody(req);
        const target = availableModels.find((mm: any) => mm.id === body.provider || mm.id === body.modelId);
        if (!target) return json({ ok: false, error: "model not found" }, 404);
        defaultModel = target;
        // 切换所有缓存 session 的模型
        for (const s of sessionCache.values()) {
          try { await s.setModel(target); } catch {}
        }
        return json({ ok: true });
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
