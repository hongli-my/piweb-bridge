import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto("http://localhost/piweb/", { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2500);

console.log("=== 1. 默认（全部目录）===");
const defaultCount = await page.locator("#session-list .session-item").count();
const projectName = await page.locator("#current-project-name").textContent();
console.log("项目名:", projectName, "| 会话数:", defaultCount);

console.log("\n=== 2. 打开项目下拉 ===");
await page.click("#project-trigger");
await page.waitForTimeout(500);
const projectItems = await page.locator(".project-item").allTextContents();
console.log("项目列表:");
projectItems.forEach((p) => console.log("  -", p.replace(/\s+/g, " ").trim()));

console.log("\n=== 3. 点选 openresty 目录项目 ===");
// 点第二个项目项（第一个是"全部目录"）
const projItems = page.locator(".project-item");
const count = await projItems.count();
if (count > 1) {
  await projItems.nth(1).click();
  await page.waitForTimeout(2000);
  const filteredCount = await page.locator("#session-list .session-item").count();
  const curName = await page.locator("#current-project-name").textContent();
  console.log("选中后项目名:", curName, "| 会话数:", filteredCount);
}

console.log("\n=== 4. 切回全部目录 ===");
await page.click("#project-trigger");
await page.waitForTimeout(300);
await projItems.nth(0).click();
await page.waitForTimeout(2000);
const backCount = await page.locator("#session-list .session-item").count();
console.log("切回后会话数:", backCount);

console.log("\n=== 错误 ===");
console.log(errors.length === 0 ? "✅ 无" : errors.map(e => "❌ " + e).join("\n"));

await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
