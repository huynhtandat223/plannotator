#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startLiveMessageReviewServer } from "../../../apps/ex-pi-extension/server.ts";

class CdpClient {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) {
        const waiters = this.events.get(message.method) ?? [];
        this.events.set(message.method, []);
        for (const resolve of waiters) resolve(message.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  waitEvent(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const waiters = this.events.get(method) ?? [];
      waiters.push((params) => {
        clearTimeout(timer);
        resolve(params);
      });
      this.events.set(method, waiters);
    });
  }

  close() {
    this.ws?.close();
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) resolve(address.port);
        else reject(new Error("Could not allocate a port"));
      });
    });
    server.on("error", reject);
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function waitForJson(url) {
  let lastError;
  for (let index = 0; index < 100; index += 1) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function navigate(page, targetUrl) {
  const loaded = page.waitEvent("Page.loadEventFired", 15000).catch(() => null);
  await page.send("Page.navigate", { url: targetUrl });
  await loaded;
}

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result.value;
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error("Could not find Chrome.");
    process.exit(1);
  }

  // --- Step 1: Start temporary live message review server ---
  console.log("Starting temporary live review server...");
  const htmlPath = path.resolve("apps/hook/dist/index.html");
  if (!fs.existsSync(htmlPath)) {
    console.error(`HTML file not found at ${htmlPath}. Run bun run build:hook first.`);
    process.exit(1);
  }
  const htmlContent = fs.readFileSync(htmlPath, "utf8");

  const messages = [
    { messageId: "p1:r1", paneId: "p1", piSessionId: "pi-1", text: "Response 1" },
    { messageId: "p1:r2", paneId: "p1", piSessionId: "pi-1", text: "Response 2" },
    { messageId: "p1:r3", paneId: "p1", piSessionId: "pi-1", text: "Response 3" },
  ];

  const server = await startLiveMessageReviewServer({
    htmlContent,
    messages,
  });

  const serverUrl = `http://127.0.0.1:${server.port}`;
  console.log(`Server started at: ${serverUrl}`);

  // --- Step 2: Start headless Chrome and run regression tests ---
  console.log("Starting headless Chrome...");
  const chromePort = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "plannotator-regression-chrome-"));

  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { stdio: "ignore" });

  let browser;
  let page;
  try {
    const version = await waitForJson(`http://127.0.0.1:${chromePort}/json/version`);
    browser = new CdpClient(version.webSocketDebuggerUrl);
    await browser.connect();

    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const targets = await fetchJson(`http://127.0.0.1:${chromePort}/json/list`);
    const target = targets.find((item) => item.id === targetId);
    if (!target?.webSocketDebuggerUrl) throw new Error("Could not find Chrome target websocket.");

    page = new CdpClient(target.webSocketDebuggerUrl);
    await page.connect();
    await page.send("Page.enable");
    await page.send("Runtime.enable");

    // Enable console reporting
    await page.send("Runtime.runIfWaitingForDebugger");
    page.ws.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data));
      if (data.method === "Runtime.consoleAPICalled") {
        const args = data.params.args.map(a => a.value || a.unserializableValue || JSON.stringify(a));
        console.log(`[BROWSER CONSOLE]`, ...args);
      }
      if (data.method === "Runtime.exceptionThrown") {
        console.error(`[BROWSER EXCEPTION]`, JSON.stringify(data.params.exceptionDetails));
      }
    });

    // --- TEST 1: Mobile width (412x915) ---
    console.log("Running mobile tests (412x915)...");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 412,
      height: 915,
      deviceScaleFactor: 1,
      mobile: true,
    });

    await navigate(page, serverUrl);
    await delay(1000);

    // Bypass look-and-feel and plan-ai announcements by setting cookies and localStorage keys
    await evaluate(page, `(() => {
      document.cookie = 'plannotator-look-feel-announcement-seen=2; path=/; max-age=31536000; SameSite=Lax';
      document.cookie = 'plannotator-plan-ai-announcement-seen=1; path=/; max-age=31536000; SameSite=Lax';
      localStorage.setItem('plannotator-look-feel-announcement-seen', '2');
      localStorage.setItem('plannotator-plan-ai-announcement-seen', '1');
    })()`);

    // Reload to apply the bypass configuration
    console.log("Reloading page to apply bypass configuration...");
    await page.send("Page.reload", { ignoreCache: true });
    await delay(3000); // wait for page to render fully

    // Check Initial view (selected response is primary, no scroll list above it)
    const initialCheck = await evaluate(page, `(() => {
      const timeline = document.querySelector('[data-live-session-timeline="true"]');
      if (!timeline) {
        return { error: "Timeline container not found", body: document.body.innerHTML };
      }

      const selectedResponse = document.querySelector('[data-live-timeline-selected-response="true"]');
      if (!selectedResponse) return { error: "Selected response container not found" };

      const rect = selectedResponse.getBoundingClientRect();
      const isTopInViewport = rect.top >= 0 && rect.top < 915;

      const inlineScroll = document.querySelector('[data-live-timeline-scroll="true"]');
      if (inlineScroll) return { error: "History scroll area rendered inline initially" };

      // Ensure 'AGENT #' or 'Response N' is never shown in the header
      const headerTitle = timeline.querySelector('header p.font-semibold')?.textContent || '';
      if (/AGENT\s*#?\d+/i.test(headerTitle) || /Response\s+\d+/i.test(headerTitle)) {
        return { error: "Header title contains AGENT # or Response N: " + headerTitle };
      }

      return {
        ok: isTopInViewport,
        top: rect.top,
        title: headerTitle
      };
    })()`);

    if (initialCheck.error) {
      console.log("Initial check failed. Inner HTML of body was:");
      console.log(initialCheck.body);
      throw new Error("Mobile initial view verification failed: " + initialCheck.error);
    }
    console.log("Mobile Initial View check:", initialCheck);

    // Click History button
    console.log("Opening History sheet...");
    const clickHistory = await evaluate(page, `(() => {
      const buttons = [...document.querySelectorAll('button')];
      const historyBtn = buttons.find(b => b.textContent.trim() === 'History');
      if (!historyBtn) return "History button not found";
      historyBtn.click();
      return "ok";
    })()`);

    if (clickHistory !== "ok") throw new Error(clickHistory);
    await delay(1000);

    // Verify modal is full-height and has history scroll
    const modalCheck = await evaluate(page, `(() => {
      const scrollArea = document.querySelector('[data-live-timeline-scroll="true"]');
      if (!scrollArea) return { error: "History scroll area not found in modal" };

      const modalSection = scrollArea.closest('section');
      if (!modalSection) return { error: "Modal section element not found" };

      const rect = modalSection.getBoundingClientRect();
      const isFullHeight = Math.abs(rect.height - 915) < 15;

      // Ensure 'AGENT #' or 'Response N' is never shown inside the history modal header
      const modalHeaderTitle = modalSection.querySelector('header p.text-muted-foreground')?.textContent || '';
      if (/AGENT\s*#?\d+/i.test(modalHeaderTitle) || /Response\s+\d+/i.test(modalHeaderTitle)) {
        return { error: "Modal header contains AGENT # or Response N: " + modalHeaderTitle };
      }

      return {
        ok: isFullHeight,
        height: rect.height,
        title: modalHeaderTitle
      };
    })()`);

    console.log("History Modal check:", modalCheck);
    if (modalCheck.error || !modalCheck.ok) {
      throw new Error("Mobile history modal verification failed: " + JSON.stringify(modalCheck));
    }

    // Click Close
    console.log("Closing History sheet...");
    const clickClose = await evaluate(page, `(() => {
      const scrollArea = document.querySelector('[data-live-timeline-scroll="true"]');
      if (!scrollArea) return "History scroll area not found";
      const modalSection = scrollArea.closest('section');
      if (!modalSection) return "Modal section not found";
      const closeBtn = [...modalSection.querySelectorAll('button')].find(b => b.textContent.trim() === 'Close');
      if (!closeBtn) return "Close button not found in modal";
      closeBtn.click();
      return "ok";
    })()`);

    if (clickClose !== "ok") throw new Error(clickClose);
    await delay(1000);

    // Verify modal is gone, and layout is restored
    const postCloseCheck = await evaluate(page, `(() => {
      const scrollArea = document.querySelector('[data-live-timeline-scroll="true"]');
      if (scrollArea) return { error: "History scroll area is still visible after close" };

      const selectedResponse = document.querySelector('[data-live-timeline-selected-response="true"]');
      if (!selectedResponse) return { error: "Selected response container not found after close" };

      return { ok: true };
    })()`);

    console.log("Post-Close check:", postCloseCheck);
    if (postCloseCheck.error) {
      throw new Error("Mobile post-close verification failed: " + JSON.stringify(postCloseCheck));
    }

    // --- TEST 2: Desktop width (2200x1300) ---
    console.log("Running desktop tests (2200x1300)...");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 2200,
      height: 1300,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await delay(1500);

    const desktopCheck = await evaluate(page, `(() => {
      const scrollArea = document.querySelector('[data-live-timeline-scroll="true"]');
      if (!scrollArea) return { error: "Desktop history scroll area not found" };

      const selectedResponse = document.querySelector('[data-live-timeline-selected-response="true"]');
      if (selectedResponse) return { error: "Mobile selected-response-only block is rendered on desktop" };

      return { ok: true };
    })()`);

    console.log("Desktop check:", desktopCheck);
    if (desktopCheck.error) {
      throw new Error("Desktop verification failed: " + JSON.stringify(desktopCheck));
    }

    console.log("ALL REGRESSION TESTS PASSED!");
  } finally {
    page?.close();
    browser?.close();
    chrome.kill("SIGKILL");
    server.stop();
    await delay(500);
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
