/**
 * routes/sessions.ts — 会话 CRUD + 消息 + fork + 项目。
 *
 * 根治要点：GET /sessions/:id/messages 直接返回 pi 原生 AgentMessage[]，
 * 不再调用 toHermesMessage() 翻译。前端认 content blocks (Text|Thinking|ToolCall)
 * + toolResult 消息。
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CWD, json } from "../config.ts";
import { ensureSession, createSession, createClipSession, deleteSession, getCachedSession, refreshIdToPath, setPathForId } from "../session-cache.ts";

export async function handleSessionsRoute(p: string, m: string, req: Request, body: any, jsonFn: (o: any, s?: number) => Response): Promise<Response | null> {
  // ---- 会话列表 ----
  if (p === "/sessions" && m === "GET") {
    const all = await SessionManager.listAll();
    for (const s of all) setPathForId(s.id, s.path);
    return jsonFn({
      ok: true,
      data: all.map((s: any) => ({
        id: s.id,
        title: s.name || (s.firstMessage || "").slice(0, 48) || "Session",
        message_count: s.messageCount,
        started_at: Math.floor(s.created.getTime() / 1000),
        ended_at: Math.floor(s.modified.getTime() / 1000),
        model: "", input_tokens: 0, output_tokens: 0,
        path: s.path,
        cwd: s.cwd || CWD,
      })),
    });
  }

  // ---- 新建会话 ----
  // body.clip=true → 无工具"剪藏"会话（编辑器 网页/截图转笔记 用，纯问答输出）；
  // 否则普通对话会话。均持久化，可在历史里回看。
  if (p === "/sessions" && m === "POST") {
    const cwd = body.working_dir || CWD;
    const session = body.clip === true ? await createClipSession(cwd) : await createSession(cwd);
    const sid = session.sessionId;
    return jsonFn({ ok: true, session: { id: sid }, session_id: sid });
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
      return jsonFn({
        ok: true,
        data: {
          title: sid.slice(0, 12),
          model: (session as any).model?.name || "",
          started_at: first?.timestamp ? Math.floor(new Date(first.timestamp).getTime() / 1000) : 0,
          ended_at: last?.timestamp ? Math.floor(new Date(last.timestamp).getTime() / 1000) : 0,
          message_count: msgs.length,
          input_tokens: inT, output_tokens: outT,
        },
      });
    }

    // GET /sessions/:id/messages — pi 原生 AgentMessage[]，零翻译
    // 可选 ?offset=N：只返回第 N 条起（含 N）的消息。供前端 backgroundReFetch
    // 增量拉取流式期间新增的部分，避免长会话每次流结束后全量拉取。
    if (sub === "/messages" && m === "GET") {
      const session = await ensureSession(sid);
      let msgs = session.messages;
      const url = new URL(req.url);
      const offsetParam = url.searchParams.get("offset");
      if (offsetParam !== null) {
        const offset = Number(offsetParam);
        if (Number.isInteger(offset) && offset >= 0) {
          msgs = msgs.slice(offset);
        }
      }
      return jsonFn({ ok: true, data: msgs });
    }

    // POST /sessions/:id/fork — 复制当前路径为新会话
    if (sub === "/fork" && m === "POST") {
      const session = await ensureSession(sid);
      if (!session.sessionFile) throw new Error("session 无文件，无法 fork");
      const sm = SessionManager.open(session.sessionFile);
      const leaf = sm.getLeafEntry();
      const newPath = sm.createBranchedSession(leaf.id);
      // listAll 已按 path 索引，直接查新 session id
      const all = await SessionManager.listAll();
      let newId = "";
      for (const s of all) if (s.path === newPath) { newId = s.id; setPathForId(s.id, s.path); break; }
      return jsonFn({ ok: true, session_id: newId || newPath });
    }

    // DELETE /sessions/:id
    if (!sub && m === "DELETE") {
      await deleteSession(sid);
      return jsonFn({ ok: true });
    }

    // PATCH /sessions/:id — rename
    if (!sub && m === "PATCH") {
      const newTitle = (body.title || "").toString().trim();
      if (!newTitle) return jsonFn({ ok: false, error: "title required" }, 400);
      const session = await ensureSession(sid);
      session.setSessionName(newTitle);
      return jsonFn({ ok: true, title: newTitle });
    }
  }

  // ---- 上下文用量 ----
  if (p === "/context" && m === "GET") {
    const url = new URL(req.url);
    const sid = url.searchParams.get("session_id") || "";
    const FALLBACK_CONTEXT_WINDOW = 128000;
    let model = "-", active = false, max = 0, used = 0;
    let lastInput = 0, lastOutput = 0;
    let estimated = false;
    const cached = sid ? getCachedSession(sid) : undefined;
    if (cached) {
      active = (cached as any).isStreaming;
      model = (cached as any).model?.name || "-";
      const declaredWin = (cached as any).model?.contextWindow || 0;
      if (declaredWin > 0) max = declaredWin;
      else { max = FALLBACK_CONTEXT_WINDOW; estimated = true; }
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
    return jsonFn({
      ok: true,
      context: {
        model, active, max_tokens: max, used_tokens: used,
        percent: max ? Math.min(100, Math.round((used / max) * 100)) : 0,
        next_input: used + lastOutput, last_input: lastInput, last_output: lastOutput,
        estimated, duration: "-",
      },
    });
  }

  // ---- 项目 = 目录 ----
  if (p.startsWith("/projects")) {
    if (p === "/projects/mapping" && m === "GET") {
      const all = await SessionManager.listAll();
      const map: Record<string, string> = {};
      for (const s of all) map[s.id] = s.cwd || CWD;
      return jsonFn({ ok: true, data: map });
    }
    if (p === "/projects" && m === "GET") {
      const all = await SessionManager.listAll();
      const byCwd: Record<string, { count: number; modified: Date }> = {};
      for (const s of all) {
        const c = s.cwd || CWD;
        if (!byCwd[c]) byCwd[c] = { count: 0, modified: s.modified };
        byCwd[c].count++;
        if (s.modified > byCwd[c].modified) byCwd[c].modified = s.modified;
      }
      return jsonFn({
        ok: true,
        data: Object.entries(byCwd).map(([cwd, info]) => ({
          id: cwd, name: cwd.split("/").pop() || cwd, path: cwd,
          created_at: Math.floor(Date.now() / 1000), session_count: info.count,
        })),
      });
    }
    if (p === "/projects" && m === "POST") {
      const path = body.path || CWD;
      return jsonFn({ ok: true, data: { id: path, name: body.name || (path.split("/").pop() || path), path } });
    }
    if (p.match(/^\/projects\/[^/]+\/assign$/) && m === "POST") return jsonFn({ ok: true });
    return jsonFn({ ok: true });
  }

  return null;
}
