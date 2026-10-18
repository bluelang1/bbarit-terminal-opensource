// bbarit browser bridge — connects to the local bbarit agent over WebSocket and
// runs commands against the active tab. Load this folder via chrome://extensions
// (Developer mode → Load unpacked). It reconnects automatically.

const PORT = 7333;
let ws = null;

function isLive() {
  return ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

function connect() {
  if (isLive()) return;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  } catch (e) {
    ws = null;
    return;
  }
  ws.onmessage = async (event) => {
    let cmd;
    try {
      cmd = JSON.parse(event.data);
    } catch {
      return;
    }
    const reply = (payload) => {
      try {
        ws.send(JSON.stringify({ id: cmd.id, ...payload }));
      } catch {}
    };
    try {
      reply({ ok: true, result: await runCommand(cmd) });
    } catch (e) {
      reply({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  };
  ws.onclose = () => {
    ws = null;
    // Fast retry while the service worker is still alive…
    setTimeout(connect, 1500);
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
    ws = null;
  };
}

// …and a keepalive alarm wakes the service worker if Chrome suspended it, so it
// reconnects once bbarit is running (the WS keeps the worker alive once open).
chrome.alarms.create("bbarit-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

async function activeTab() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no active tab");
  return tab;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForLoad(tabId, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await sleep(150);
  }
}

async function inPage(func, args) {
  const tab = await activeTab();
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func,
    args: args || [],
  });
  return res.result;
}

async function runCommand(cmd) {
  switch (cmd.action) {
    case "navigate": {
      const tab = await activeTab();
      await chrome.tabs.update(tab.id, { url: cmd.url });
      await waitForLoad(tab.id);
      return "navigated to " + cmd.url;
    }
    case "newtab": {
      const tab = await chrome.tabs.create({ url: cmd.url || "about:blank" });
      await waitForLoad(tab.id);
      return "opened new tab" + (cmd.url ? " at " + cmd.url : "");
    }
    case "back": {
      const tab = await activeTab();
      await chrome.tabs.goBack(tab.id);
      await waitForLoad(tab.id);
      return "went back";
    }
    case "forward": {
      const tab = await activeTab();
      await chrome.tabs.goForward(tab.id);
      await waitForLoad(tab.id);
      return "went forward";
    }
    case "wait":
      await sleep(cmd.ms || 1000);
      return "waited " + (cmd.ms || 1000) + "ms";
    case "waitfor": {
      const tab = await activeTab();
      const timeout = cmd.timeout || 8000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => !!document.querySelector(sel),
          args: [cmd.selector],
        });
        if (r.result) return "found " + cmd.selector;
        await sleep(200);
      }
      return "timeout waiting for " + cmd.selector;
    }
    case "scroll":
      return await inPage(
        (dy) => {
          window.scrollBy(0, dy);
          return "scrolled " + dy + "px (y=" + Math.round(window.scrollY) + ")";
        },
        [cmd.dy || 600],
      );
    case "read":
      return await inPage(() => document.body.innerText.slice(0, 12000));
    case "html":
      return await inPage(() => document.documentElement.outerHTML.slice(0, 12000));
    case "url":
      return (await activeTab()).url || "";
    case "click":
      return await inPage(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return "not found: " + sel;
          el.click();
          return "clicked " + sel;
        },
        [cmd.selector],
      );
    case "type":
      return await inPage(
        (sel, text) => {
          const el = document.querySelector(sel);
          if (!el) return "not found: " + sel;
          el.focus();
          if ("value" in el) {
            el.value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            el.textContent = text;
          }
          return "typed into " + sel;
        },
        [cmd.selector, cmd.text || ""],
      );
    case "text":
      return await inPage(
        (sel) => {
          const el = document.querySelector(sel);
          return el ? (el.innerText || el.textContent || "").slice(0, 4000) : "not found: " + sel;
        },
        [cmd.selector],
      );
    case "attr":
      return await inPage(
        (sel, name) => {
          const el = document.querySelector(sel);
          if (!el) return "not found: " + sel;
          return String(el.getAttribute(name));
        },
        [cmd.selector, cmd.name || cmd.attr || "value"],
      );
    case "value":
      return await inPage(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return "not found: " + sel;
          return String(el.value !== undefined ? el.value : el.textContent);
        },
        [cmd.selector],
      );
    case "exists":
      return await inPage((sel) => String(!!document.querySelector(sel)), [cmd.selector]);
    case "count":
      return await inPage(
        (sel) => String(document.querySelectorAll(sel).length),
        [cmd.selector],
      );
    case "links":
      return await inPage(() => {
        const out = [];
        for (const a of document.querySelectorAll("a[href]")) {
          const t = (a.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60);
          out.push((t || "(no text)") + " -> " + a.href);
          if (out.length >= 80) break;
        }
        return out.join("\n");
      });
    case "press":
      return await inPage(
        (sel, key) => {
          const el = sel ? document.querySelector(sel) : document.activeElement;
          if (!el) return "no element to press on";
          el.focus();
          for (const type of ["keydown", "keypress", "keyup"]) {
            el.dispatchEvent(
              new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }),
            );
          }
          if (key === "Enter" && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
          return "pressed " + key + (sel ? " on " + sel : "");
        },
        [cmd.selector || "", cmd.key || "Enter"],
      );
    case "screenshot": {
      return await chrome.tabs.captureVisibleTab();
    }
    case "eval":
      return await inPage(
        (code) => {
          try {
            return String(eval(code));
          } catch (e) {
            return "error: " + e;
          }
        },
        [cmd.js || ""],
      );
    default:
      return "unknown action: " + cmd.action;
  }
}

connect();
