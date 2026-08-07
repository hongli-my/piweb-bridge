import { chromium } from "playwright";

const BASE = "http://localhost/piweb/";

const browser = await chromium.launch();
const page = await browser.newPage();

const errors: string[] = [];
const consoleMsgs: string[] = [];

page.on("console", (msg) => {
  const t = msg.type();
  const text = msg.text();
  consoleMsgs.push(`[${t}] ${text}`);
  if (t === "error") errors.push(text);
});
page.on("pageerror", (err) => {
  errors.push("PAGEERROR: " + err.message);
});
page.on("requestfailed", (req) => {
  errors.push("REQFAIL: " + req.url() + " " + req.failure()?.errorText);
});

console.log("=== 1. 打开页面 ===");
await page.goto(BASE, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2000);

const title = await page.title();
console.log("title:", title);

// 检查 gateway 状态文本
const statusText = await page.locator("#gateway-status .status-text").textContent();
console.log("gateway status:", statusText);

console.log("\n=== 2. 新建会话 ===");
await page.click("#btn-new-chat");
await page.waitForTimeout(2000);

const chatLabel = await page.locator("#chat-session-label").textContent().catch(() => "(无)");
console.log("chat label:", chatLabel);

console.log("\n=== 3. 发送消息 ===");
await page.fill("#chat-input", "请只回复：你好");
await page.click("#btn-send");

console.log("等待回复...");
// 等待助手回复出现（最多 60 秒）
let reply = "";
try {
  await page.waitForFunction(
    () => {
      const turns = document.querySelectorAll("#chat-messages .turn");
      if (turns.length === 0) return false;
      const last = turns[turns.length - 1];
      const agent = last.querySelector(".turn-agent-body");
      // 流结束后没有 data-streaming
      const streaming = last.getAttribute("data-streaming");
      return agent && agent.textContent && agent.textContent.trim().length > 0 && !streaming;
    },
    { timeout: 60000 },
  );
  reply = await page.locator("#chat-messages .turn").last().locator(".turn-agent-body").textContent();
} catch (e: any) {
  console.log("等待回复超时或失败:", e.message);
}

console.log("\n=== 结果 ===");
console.log("助手回复:", reply ? reply.slice(0, 200) : "(无)");
console.log("\n=== Console 消息（最后10条）===");
consoleMsgs.slice(-10).forEach((m) => console.log(m));
console.log("\n=== 错误 ===");
if (errors.length === 0) console.log("✅ 无错误");
else errors.forEach((e) => console.log("❌ " + e));

await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
