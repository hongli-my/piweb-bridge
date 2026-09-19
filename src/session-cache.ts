/**
 * session-cache.ts — AgentSession 的 LRU 缓存与恢复。
 *
 * 根治要点：保留 LRU（长会话防 OOM），但不再有翻译层。ensureSession 返回的
 * session 就是 pi 原生 AgentSession，事件透传由 sse.ts 负责。
 */
import path from "node:path";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { CWD, AGENT_DIR, modelRuntime, defaultModel, ts } from "./config.ts";

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

export async function refreshIdToPath() {
  const all = await SessionManager.listAll();
  for (const s of all) idToPath.set(s.id, s.path);
}

/** 缓存路径映射，供 schedules 等外部模块查询 */
export function getPathForId(sid: string): string | undefined {
  return idToPath.get(sid);
}
export function setPathForId(sid: string, p: string) {
  idToPath.set(sid, p);
}

/**
 * 绑定扩展：触发 session_start 事件，让 otel-viewer 等扩展的事件处理器生效。
 * 导出供 schedules.ts 的一次性 session 复用。
 */
export async function initSessionExtensions(
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
export async function ensureSession(sid: string): Promise<AgentSession> {
  const cached = sessionCache.get(sid);
  if (cached) { touchSessionCache(sid); return cached; }
  if (!idToPath.has(sid)) await refreshIdToPath();
  const p = idToPath.get(sid);
  if (!p) throw new Error("session not found: " + sid);
  const sm = SessionManager.open(p);
  // 用 session 自身记录的 cwd，而非全局 CWD：恢复已有会话时必须保持原 cwd
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

/** 新建会话并放入缓存 */
export async function createSession(cwd: string): Promise<AgentSession> {
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
  return session;
}

/** 新建"剪藏"会话（编辑器 网页/截图转笔记 用）。
 *  与 createSession 同构，但工具白名单为空：agent 纯问答输出整理结果，
 *  不会中途读文件/跑命令改东西。会话同样走 SessionManager 持久化，
 *  保留在历史里可回看。 */
export async function createClipSession(cwd: string): Promise<AgentSession> {
  const sm = SessionManager.create(cwd);
  const { session, extensionsResult } = await createAgentSession({
    sessionManager: sm,
    modelRuntime,
    cwd,
    model: defaultModel,
    // 空白名单 → 不暴露任何工具（见 SDK AgentSessionConfig.allowedToolNames）
    allowedToolNames: [],
    ...(AGENT_DIR ? { agentDir: AGENT_DIR } : {}),
  });
  await initSessionExtensions(session, extensionsResult);
  const sid = session.sessionId;
  sessionCache.set(sid, session);
  evictSessionCache();
  if (session.sessionFile) idToPath.set(sid, session.sessionFile);
  return session;
}

/** 删除会话：清缓存 + 删文件 */
export async function deleteSession(sid: string): Promise<void> {
  const p = idToPath.get(sid);
  if (p) { const { unlink } = await import("node:fs/promises"); try { await unlink(p); } catch {} }
  const s = sessionCache.get(sid);
  if (s) { try { s.dispose(); } catch {} }
  sessionCache.delete(sid);
  idToPath.delete(sid);
}

/** 获取缓存中的 session（不恢复）— /context 等只读查询用 */
export function getCachedSession(sid: string): AgentSession | undefined {
  return sessionCache.get(sid);
}

/** 切换所有缓存 session 的模型 */
export async function setModelForAll(model: any): Promise<void> {
  for (const s of sessionCache.values()) {
    try { await s.setModel(model); } catch {}
  }
}

export { ts };
