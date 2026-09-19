/**
 * schedules.ts — 定时任务调度器（croner 驱动）。
 *
 * 从原 pi-bridge.ts 提取，逻辑不变。一次性 session 用完即 dispose，不进 LRU。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { RESOLVED_AGENT_DIR, CWD, AGENT_DIR, modelRuntime, defaultModel, availableModels, ts } from "./config.ts";
import { initSessionExtensions, setPathForId } from "./session-cache.ts";

interface ScheduleTask {
  id: string; name: string; prompt: string; cron: string; timezone: string;
  model?: string; cwd?: string; enabled: boolean; createdAt: number;
  lastRunAt?: number; nextRunAt?: number;
}
interface ScheduleRun {
  id: string; taskId: string; status: "running" | "success" | "failed" | "skipped" | "timeout";
  startedAt: number; finishedAt?: number; durationMs?: number;
  sessionId?: string; error?: string; snippet?: string;
}

const SCHEDULES_FILE = path.join(RESOLVED_AGENT_DIR, "schedules.json");
const SCHEDULE_RUNS_FILE = path.join(RESOLVED_AGENT_DIR, "schedule_runs.json");
const SCHEDULE_TIMEOUT_MS = Number(process.env.PIWEB_SCHEDULE_TIMEOUT_MS || 5 * 60 * 1000);
const MAX_RUNS_PER_TASK = 50;

const cronJobs = new Map<string, Cron>();
const runningTasks = new Set<string>();
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
export async function reloadScheduleTasksCache(): Promise<ScheduleTask[]> {
  scheduleTasksCache = await loadScheduleTasks();
  return scheduleTasksCache;
}

async function appendScheduleRun(run: ScheduleRun): Promise<void> {
  let runs = await loadScheduleRuns();
  runs.unshift(run);
  const byTask: Record<string, number> = {};
  const capped: ScheduleRun[] = [];
  for (const r of runs) {
    const n = (byTask[r.taskId] = (byTask[r.taskId] || 0) + 1);
    if (n <= MAX_RUNS_PER_TASK) capped.push(r);
  }
  await saveScheduleRuns(capped);
}

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

async function runScheduledTask(taskId: string): Promise<ScheduleRun> {
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
    if (session.sessionFile) setPathForId(sid, session.sessionFile);

    const timeout = setTimeout(() => { try { session?.abort(); } catch {} }, SCHEDULE_TIMEOUT_MS);
    try { await session.prompt(task.prompt); } finally { clearTimeout(timeout); }

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

  task.lastRunAt = startedAt;
  const job = cronJobs.get(taskId);
  if (job) task.nextRunAt = job.nextRun()?.getTime() || undefined;
  await saveScheduleTasks(tasks);

  await appendScheduleRun(run);
  runningTasks.delete(taskId);
  console.log(`[pi-bridge] [${ts()}] schedule task "${task.name}" ${status} in ${run.durationMs}ms sid=${sid}`);
  return run;
}

/** 启动时注册所有已启用的定时任务 */
export async function initSchedules(): Promise<void> {
  try {
    const tasks = await reloadScheduleTasksCache();
    let count = 0;
    for (const t of tasks) {
      if (t.enabled) { registerScheduleTask(t); count++; }
    }
    if (tasks.length > 0) await saveScheduleTasks(tasks);
    console.log(`[pi-bridge] schedules: ${count}/${tasks.length} tasks registered`);
  } catch (e: any) {
    console.error("[pi-bridge] failed to load schedules:", e.message);
  }
}

// ---- Route handlers ----
export async function handleSchedulesRoute(p: string, m: string, req: Request, body: any, json: (o: any, s?: number) => Response): Promise<Response | null> {
  if (p === "/schedules" && m === "GET") {
    const tasks = await reloadScheduleTasksCache();
    for (const t of tasks) {
      const job = cronJobs.get(t.id);
      if (job && t.enabled) t.nextRunAt = job.nextRun()?.getTime() || undefined;
    }
    return json({ ok: true, data: tasks });
  }
  if (p === "/schedules" && m === "POST") {
    const task: ScheduleTask = {
      id: crypto.randomUUID(),
      name: body.name || "Untitled", prompt: body.prompt || "",
      cron: body.cron || "* * * * *", timezone: body.timezone || "Asia/Shanghai",
      model: body.model || undefined, cwd: body.cwd || CWD,
      enabled: body.enabled !== false, createdAt: Date.now(),
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
  return null;
}
