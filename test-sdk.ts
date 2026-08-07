import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const mr = await ModelRuntime.create();
const models = await mr.getAvailable();
const m = models.find((x: any) => x.provider === process.env.PI_PROVIDER && x.id === process.env.PI_MODEL) || models[0];
console.log("model:", (m as any).id, "| provider:", (m as any).provider, "| api:", (m as any).api, "| baseUrl:", (m as any).baseUrl);

const { session } = await createAgentSession({
  sessionManager: SessionManager.create("/Users/honglichang/openresty"),
  modelRuntime: mr,
  model: m as any,
  cwd: "/Users/honglichang/openresty",
});
session.subscribe((e: any) => console.log("EVENT:", e.type, e.assistantMessageEvent?.type || ""));
console.log("prompting...");
const t0 = Date.now();
try {
  await session.prompt("hi");
  console.log("prompt done in", Date.now() - t0, "ms");
} catch (e: any) {
  console.log("prompt ERROR:", e.message);
}
process.exit(0);
