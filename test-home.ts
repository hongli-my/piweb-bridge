import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

console.log("=== 1. 打开首页 ===");
await page.goto("http://localhost/", { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(1000);
const homeTitle = await page.title();
console.log("首页标题:", homeTitle);

console.log("=== 2. 点击「对话」tab ===");
await page.click('button.tab[data-tab="piweb"]');
await page.waitForTimeout(2000);

// 进入 iframe
const frame = page.frameLocator('iframe[data-tab="piweb"]');
const frameTitle = await frame.locator(".logo").textContent().catch(() => "(无)");
console.log("iframe 内 logo:", frameTitle);

const status = await frame.locator("#gateway-status .status-text").textContent().catch(() => "(无)");
console.log("pi-bridge 状态:", status);

console.log("=== 3. iframe 内发消息 ===");
await frame.locator("#btn-new-chat").click();
await page.waitForTimeout(1500);
await frame.locator("#chat-input").fill("只回复：测试成功");
await frame.locator("#btn-send").click();

console.log("等待回复...");
await frame.locator("#chat-messages .turn").last().waitFor({ state: "attached", timeout: 10000 });
const ok = await page.waitForFunction(
  () => {
    const f = document.querySelector('iframe[data-tab="piweb"]')?.contentDocument;
    if (!f) return false;
    const t = f.querySelectorAll("#chat-messages .turn");
    if (!t.length) return false;
    return t[t.length - 1].getAttribute("data-streaming") === null;
  },
  { timeout: 60000 },
).then(() => true).catch(() => false);

const reply = await frame.locator("#chat-messages .turn").last().locator(".turn-agent-body").textContent().catch(() => "");
console.log("agent 完成:", ok ? "✅" : "❌超时");
console.log("回复:", (reply || "").replace(/\s+/g, " ").slice(0, 80));

console.log("\n=== 错误 ===");
console.log(errors.length === 0 ? "✅ 无错误" : errors.map(e => "❌ " + e).join("\n"));

await page.screenshot({ path: "/tmp/piweb-home.png" });
console.log("截图: /tmp/piweb-home.png");
await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
