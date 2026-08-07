import { chromium } from "playwright";

const BASE = "http://localhost/piweb/";
const browser = await chromium.launch();
const page = await browser.newPage();

const errors: string[] = [];
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("pageerror", (err) => errors.push("PAGEERROR: " + err.message));
page.on("requestfailed", (req) => errors.push("REQFAIL: " + req.url()));

console.log("=== 打开页面 ===");
await page.goto(BASE, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(1500);

console.log("=== 新建会话 ===");
await page.click("#btn-new-chat");
await page.waitForTimeout(1500);

console.log("=== 发送带工具调用的消息（让 agent 读文件）===");
await page.fill("#chat-input", "请用 read 工具读取当前目录的 README.md 文件，然后告诉我前两行内容");
await page.click("#btn-send");

console.log("等待 agent 完成（最多 90 秒）...");
const ok = await page.waitForFunction(
  () => {
    const turns = document.querySelectorAll("#chat-messages .turn");
    if (turns.length === 0) return false;
    const last = turns[turns.length - 1];
    return last.getAttribute("data-streaming") === null;
  },
  { timeout: 90000 },
).then(() => true).catch(() => false);

const bodyText = await page.locator("#chat-messages .turn").last().locator(".turn-agent-body").textContent();

// 统计工具卡片
const toolCount = await page.locator("#chat-messages .turn").last().locator(".ow-tl-item").count();

console.log("\n=== 结果 ===");
console.log("agent 完成:", ok ? "✅" : "❌ 超时");
console.log("工具调用数:", toolCount);
console.log("agent body 前300字:", (bodyText || "").slice(0, 300));
console.log("\n=== 错误 ===");
console.log(errors.length === 0 ? "✅ 无错误" : errors.map(e => "❌ " + e).join("\n"));

await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
