/**
 * sse.ts — SSE 流：透传 pi 原生 AgentSessionEvent。
 *
 * 根治要点：
 *   旧版 sseResponse 调用 transformEvent() → toHermesMessage() 把 pi 的
 *   content blocks 翻译成 Hermes 的 content:string+tool_calls+reasoning。
 *   现在删除翻译层，事件原样透传，前端认 pi 原生结构。
 *
 * 保留的体积裁剪（传输优化，非契约翻译）：
 *   - agent_end.messages        前端用 message_end 即可，剥离可达数 MB 的全量历史
 *   - turn_end.message/toolResults 前端无处理分支，剥离
 *   - message_update.partial    每个 delta 都带从头累积的完整 AssistantMessage，冗余
 *
 * 前端用 text_delta/thinking_delta/toolcall_end + tool_execution_* 事件
 * 自行重建 content blocks（与 pi SDK 内部构建 partial 的逻辑一致）。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { CORS, ts } from "./config.ts";

// 进程内同步忙锁：防止同一 session 并发 prompt 搅乱状态
const busySessions = new Set<string>();
export function isBusy(sid: string): boolean { return busySessions.has(sid); }
export function acquireBusy(sid: string): void { busySessions.add(sid); }
export function releaseBusy(sid: string): void { busySessions.delete(sid); }

// 活跃 SSE 流的 finish 回调集合：进程收到 SIGTERM/SIGINT 优雅退出时，
// 先把所有在途流正常 finish，避免前端 ERR_INCOMPLETE_CHUNKED_ENCODING。
const activeStreamFinishers = new Set<() => void>();

const HEARTBEAT_MS = Number(process.env.PIWEB_HEARTBEAT_MS || 5000);
const MAX_STREAM_MS = Number(process.env.PIWEB_MAX_STREAM_MS || 30 * 60 * 1000);
const FLUSH_MS = 40;

/** 体积裁剪：剥离前端不消费的重量级字段（非翻译） */
function stripEvent(event: any): any {
  const t = event?.type;
  if (t === "agent_end") {
    const { messages, ...rest } = event;
    return rest;
  }
  if (t === "turn_end") {
    const { message, toolResults, ...rest } = event;
    return rest;
  }
  if (t === "message_update" && event.assistantMessageEvent) {
    const { partial, ...aeRest } = event.assistantMessageEvent;
    return { ...event, assistantMessageEvent: aeRest };
  }
  return event;
}

/** 构造 SSE 流：订阅 session 事件 → 原样透传；prompt 驱动。
 *  images 为 pi 原生 ImageContent[]（可选，截图/图片转笔记用），直接随消息发送。 */
export function sseResponse(session: AgentSession, message: string, lockSid?: string, images?: ImageContent[]): Response {
  const enc = new TextEncoder();
  let unsub: (() => void) | undefined;
  let finished = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let hbCount = 0;
  const startedAt = Date.now();
  let finishReason = "unknown";

  // text_delta / thinking_delta 帧合并状态
  let pendingText = "";
  let pendingThinking = "";
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendRaw = (obj: any) => {
        if (finished) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {}
      };
      const flushBuffer = () => {
        if (finished) return;
        if (pendingText) {
          const delta = pendingText;
          pendingText = "";
          sendRaw({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
        }
        if (pendingThinking) {
          const delta = pendingThinking;
          pendingThinking = "";
          sendRaw({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta } });
        }
        if (flushTimer && !pendingText && !pendingThinking) {
          clearInterval(flushTimer);
          flushTimer = undefined;
        }
      };
      const doSend = (obj: any) => {
        flushBuffer();
        sendRaw(obj);
      };
      const ensureFlushTimer = () => {
        if (!flushTimer) flushTimer = setInterval(flushBuffer, FLUSH_MS);
      };
      const finish = (reason?: string) => {
        if (finished) return;
        try { flushBuffer(); } catch {}
        finished = true;
        if (reason) finishReason = reason;
        try { if (unsub) unsub(); } catch {}
        try { if (heartbeat) clearInterval(heartbeat); } catch {}
        try { if (watchdog) clearTimeout(watchdog); } catch {}
        try { if (flushTimer) clearInterval(flushTimer); } catch {}
        try { if (lockSid) releaseBusy(lockSid); } catch {}
        try { controller.close(); } catch {}
        try { activeStreamFinishers.delete(finisher); } catch {}
        console.log(`[pi-bridge] [${ts()}] SSE finish sid=${lockSid || "-"} reason=${finishReason} hb=${hbCount} elapsed=${Date.now() - startedAt}ms`);
      };
      const finisher = () => finish("shutdown");
      activeStreamFinishers.add(finisher);

      // 心跳：SSE 注释行，前端解析器忽略，但字节流保持流动防 idle 断开
      try { controller.enqueue(enc.encode(`: ping\n\n`)); hbCount++; } catch {}
      heartbeat = setInterval(() => {
        if (finished) return;
        try { controller.enqueue(enc.encode(`: ping\n\n`)); hbCount++; } catch {}
      }, HEARTBEAT_MS);

      // 兑底最大寿命：agent 真正卡死时强制结束
      watchdog = setTimeout(() => {
        console.warn(`[pi-bridge] [${ts()}] stream max lifetime reached, force finish sid=${lockSid || "-"}`);
        doSend({ type: "error", error: "agent timed out (max stream lifetime)" });
        finish("max_lifetime");
      }, MAX_STREAM_MS);

      // 订阅事件：原样透传（仅体积裁剪），不翻译
      unsub = session.subscribe((event: any) => {
        try {
          const t = event?.type;
          const ae = t === "message_update" ? event?.assistantMessageEvent : null;
          const isDelta =
            ae && (ae.type === "text_delta" || ae.type === "thinking_delta") &&
            typeof ae.delta === "string" && ae.delta.length > 0;
          if (isDelta) {
            if (ae.type === "text_delta") pendingText += ae.delta;
            else pendingThinking += ae.delta;
            ensureFlushTimer();
          } else {
            doSend(stripEvent(event));
          }
        } catch (e: any) {
          console.warn(`[pi-bridge] [${ts()}] send event failed:`, e?.message, "type=", event?.type);
        }
        try {
          if (event?.type === "agent_settled") finish("settled");
        } catch {}
      });

      try {
        console.log(`[pi-bridge] [${ts()}] prompt start sid=${lockSid || "-"}: ${message.slice(0, 40)}${images?.length ? ` | images=${images.length}` : ""} | isStreaming: ${(session as any).isStreaming}`);
        await session.prompt(message, images && images.length ? { images } : undefined);
        console.log(`[pi-bridge] [${ts()}] prompt done sid=${lockSid || "-"}`);
      } catch (e: any) {
        console.log(`[pi-bridge] [${ts()}] prompt error sid=${lockSid || "-"}:`, e.message);
        doSend({ type: "error", error: e.message || String(e) });
      } finally {
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
      try { if (flushTimer) clearInterval(flushTimer); } catch {}
      try { if (lockSid) releaseBusy(lockSid); } catch {}
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

/** 优雅退出：finish 所有在途流 */
export function gracefulShutdown(sig: string, done: () => void): void {
  console.log(`[pi-bridge] [${ts()}] ${sig} received, finishing ${activeStreamFinishers.size} active stream(s)...`);
  for (const f of activeStreamFinishers) {
    try { f(); } catch {}
  }
  setTimeout(done, 400);
}
