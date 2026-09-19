/**
 * routes/chat.ts — 对话流式 + 控制。
 *
 * 根治要点：/chat/stream 调 sseResponse() 透传 pi 原生事件（见 sse.ts），
 * 不再 transformEvent/toHermesMessage。忙锁由 sse.ts 的 busySessions 统一管理。
 */
import { json, readBody } from "../config.ts";
import { ensureSession } from "../session-cache.ts";
import { sseResponse, isBusy, acquireBusy, releaseBusy } from "../sse.ts";
import type { ImageContent } from "@earendil-works/pi-ai";

export async function handleChatRoute(p: string, m: string, req: Request, body: any, jsonFn: (o: any, s?: number) => Response): Promise<Response | null> {
  // ---- 对话流式 ----
  if (p === "/chat/stream" && m === "POST") {
    const sid = body.session_id;
    if (!sid) return jsonFn({ ok: false, error: "session_id required" }, 400);
    // 同步忙锁：在任何 await 之前抢占，消除并发竞态窗口
    if (isBusy(sid)) return jsonFn({ ok: false, error: "session is busy" }, 409);
    acquireBusy(sid);
    try {
      const session = await ensureSession(sid);
      return sseResponse(session, body.message || "", sid, parseBodyImages(body.images));
    } catch (e) {
      releaseBusy(sid);
      throw e;
    }
  }

  // ---- 插话 / 跟进 ----
  if (p === "/steer" && m === "POST") {
    const session = await ensureSession(body.session_id);
    await session.steer(body.message || "");
    return jsonFn({ ok: true });
  }
  if (p === "/follow_up" && m === "POST") {
    const session = await ensureSession(body.session_id);
    await session.followUp(body.message || "");
    return jsonFn({ ok: true });
  }

  // ---- 中止 ----
  if (p === "/abort" && m === "POST") {
    const sid = body.session_id;
    if (sid) releaseBusy(sid);   // 立即释放忙锁，前端可马上重发
    try {
      const session = await ensureSession(sid);
      await session.abort();
    } catch {}
    return jsonFn({ ok: true });
  }

  // ---- ui-response（extension UI 桥接，TODO）----
  if (p === "/ui-response" && m === "POST") return jsonFn({ ok: true });

  // ---- 手动压缩上下文 ----
  if (p === "/compact" && m === "POST") {
    const sid = body.session_id;
    if (!sid) return jsonFn({ ok: false, error: "missing session_id" }, 400);
    if (isBusy(sid)) return jsonFn({ ok: false, error: "session is busy" }, 409);
    acquireBusy(sid);
    try {
      const session = await ensureSession(sid);
      const result = await session.compact();
      return jsonFn({ ok: true, result: result || null });
    } catch (e: any) {
      return jsonFn({ ok: false, error: e?.message || String(e) }, 500);
    } finally {
      releaseBusy(sid);
    }
  }

  return null;
}

/** dataURL（data:<mime>;base64,<payload>）→ pi 原生 ImageContent（data 为裸 base64）。
 *  非 dataURL / 非字符串项跳过；无有效项返回 undefined（退化为纯文本消息）。 */
function parseBodyImages(raw: unknown): ImageContent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ImageContent[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const comma = item.indexOf(",");
    const header = comma > 0 ? item.slice(0, comma) : "";
    if (!header.startsWith("data:")) continue;
    const mimeType = header.slice(5).split(";")[0] || "image/png";
    out.push({ type: "image", data: item.slice(comma + 1), mimeType });
  }
  return out.length ? out : undefined;
}
