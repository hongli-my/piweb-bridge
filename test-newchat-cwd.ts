import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto("http://localhost/piweb/", { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2000);

console.log("=== 1. 选中 openresty 目录项目 ===");
await page.click("#project-trigger");
await page.waitForTimeout(400);
const items = page.locator(".project-item");
if (await items.count() > 1) {
  await items.nth(1).click();
  await page.waitForTimeout(1500);
}
const beforeCount = await page.locator("#session-list .session-item").count();
console.log("选中后该目录会话数:", beforeCount);

console.log("=== 2. 在该目录下新建会话 ===");
await page.click("#btn-new-chat");
await page.waitForTimeout(2000);
const chatLabel = await page.locator("#chat-session-label").textContent().catch(() => "");
console.log("进入对话:", chatLabel.slice(0, 30));

console.log("=== 3. 发消息让 agent 读当前目录 ===");
await page.fill("#chat-input", "用 bash 工具执行 pwd，告诉我当前目录");
await page.click("#btn-send");
const ok = await page.waitForFunction(
  () => {
    const t = document.querySelectorAll("#chat-messages .turn");
    if (!t.length) return false;
    return t[t.length - 1].getAttribute("data-streaming") === null;
  },
  { timeout: 60000 },
).then(() => true).catch(() => false);
const reply = await page.locator("#chat-messages .turn").last().locator(".turn-agent-body").textContent().catch(() => "");
console.log("agent 完成:", ok ? "✅" : "❌超时");
console.log("回复含 pwd:", reply.includes("openresty") ? "✅ " + reply.match(/\/[^\s]+openresty[^\s]*/)?.[0] : "❌ " + reply.slice(0, 100));

console.log("\n=== 错误 ===");
console.log(errors.length === 0 ? "✅ 无" : errors.map(e => "❌ " + e).join("\n"));
await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
