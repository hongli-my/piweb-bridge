/**
 * server.ts — Bun.serve 入口 + 路由分发 + 优雅退出。
 *
 * 根治要点：原 pi-bridge.ts 1343 行单文件 god-server 拆成模块。路由按
 * 前缀分发到 routes/* 模块，每个模块返回 Response | null（null = 不匹配）。
 */
import { PORT, CORS, json, readBody, ts } from "./config.ts";
import { handleSessionsRoute } from "./routes/sessions.ts";
import { handleChatRoute } from "./routes/chat.ts";
import { handleModelsRoute } from "./routes/models.ts";
import { handleAgentsRoute, handleMiscRoute } from "./agents.ts";
import { handleSchedulesRoute, initSchedules } from "./schedules.ts";
import { gracefulShutdown } from "./sse.ts";

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // body 预读：POST/PATCH/PUT 共用（GET 无 body）
    const body = (m === "POST" || m === "PATCH" || m === "PUT") ? await readBody(req) : {};

    try {
      // ---- 健康检查 ----
      if (p === "/health" && m === "GET") return json({ ok: true, status: "up" });
      if ((p === "/status" || p === "/gateway_status") && m === "GET")
        return json({ ok: true, data: { status: "up", http_code: 200 }, model: (await import("./config.ts")).defaultModel?.name });

      // ---- 路由分发 ----
      // chat 类（含 SSE）
      let res = await handleChatRoute(p, m, req, body, json);
      if (res) return res;
      // sessions / messages / fork / context / projects
      res = await handleSessionsRoute(p, m, req, body, json);
      if (res) return res;
      // models / providers
      res = await handleModelsRoute(p, m, body, json);
      if (res) return res;
      // agents CRUD
      res = await handleAgentsRoute(p, m, body, json);
      if (res) return res;
      // schedules（cron 定时任务）
      res = await handleSchedulesRoute(p, m, req, body, json);
      if (res) return res;
      // extensions / skills / settings
      res = await handleMiscRoute(p, m, body, json);
      if (res) return res;

      // ---- 其它 Hermes 专属功能桩化 ----
      if (p.startsWith("/memory") || p.startsWith("/cron") || p.startsWith("/kanban") ||
          p.startsWith("/workflow") || p.startsWith("/search")) {
        return json({ ok: true, data: [], items: [], sessions: [] });
      }

      return json({ ok: false, error: "not found: " + m + " " + p }, 404);
    } catch (e: any) {
      console.error("[pi-bridge] error:", e);
      return json({ ok: false, error: e.message || String(e) }, 500);
    }
  },
});

console.log(`[pi-bridge] listening on http://127.0.0.1:${server.port}  cwd=${(await import("./config.ts")).CWD}`);

// ---- 定时任务初始化 ----
initSchedules().catch();

// ---- 优雅退出 ----
let shuttingDown = false;
function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  gracefulShutdown(sig, () => {
    try { server.stop(true); } catch {}
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
