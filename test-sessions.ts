import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto("http://localhost/piweb/", { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2500);

const statusText = await page.locator("#gateway-status .status-text").textContent();
const sessionCount = await page.locator("#session-list .session-item").count();
const sessionTitles = await page.locator("#session-list .session-item .session-item-title").allTextContents();

console.log("=== 结果 ===");
console.log("gateway 状态:", statusText);
console.log("会话列表数量:", sessionCount);
console.log("前5个会话:");
sessionTitles.slice(0, 5).forEach((t, i) => console.log(`  ${i + 1}. ${t.slice(0, 40)}`));
console.log("\n错误:", errors.length === 0 ? "✅ 无" : errors.map(e => "❌ " + e).join("\n"));

await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
