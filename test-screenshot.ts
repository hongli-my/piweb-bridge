import { chromium } from "playwright";
const BASE = "http://localhost/piweb/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(BASE, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(1000);
await page.click("#btn-new-chat");
await page.waitForTimeout(1500);
await page.fill("#chat-input", "请用 read 工具读取当前目录的 README.md，然后告诉我前两行");
await page.click("#btn-send");
console.log("等待 agent 完成...");
await page.waitForFunction(
  () => {
    const t = document.querySelectorAll("#chat-messages .turn");
    if (!t.length) return false;
    return t[t.length - 1].getAttribute("data-streaming") === null;
  },
  { timeout: 90000 },
).catch(() => {});
await page.waitForTimeout(1000);
await page.screenshot({ path: "/tmp/piweb-screenshot.png", fullPage: false });
console.log("截图已保存: /tmp/piweb-screenshot.png");
await browser.close();
