/* JobsDeviceInfo · Created by Jobs. */
"use strict";

(() => {
  function detect(navigatorValue = {}) {
    const ua = navigatorValue.userAgent || "";
    const hints = navigatorValue.userAgentData || {};
    const apple = /iPhone|iPad|iPod/i.test(ua) || /^(iOS|iPadOS)$/i.test(hints.platform || "")
      || (/Macintosh/i.test(ua) && navigatorValue.maxTouchPoints > 1);
    const harmony = /HarmonyOS|OpenHarmony|\bOHOS\b/i.test(`${ua} ${hints.platform || ""}`);
    const android = /Android/i.test(ua) || hints.platform === "Android";
    const platform = apple ? "ios" : harmony ? "harmonyos" : android ? "android" : "unknown";
    const mobile = apple || harmony || android || hints.mobile === true || /Mobile/i.test(ua);
    const safari = apple && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|MicroMessenger|FBAN|FBAV/i.test(ua);
    return { platform, mobile, safari };
  }

  async function collect(navigatorValue, screenValue, ratio = 1) {
    const browser = { userAgent: (navigatorValue.userAgent || "").slice(0, 1024) };
    if (navigatorValue.language) browser.language = navigatorValue.language.slice(0, 40);
    if (screenValue?.width > 0 && screenValue?.height > 0) {
      browser.screen = { width: screenValue.width, height: screenValue.height, pixelRatio: ratio };
    }
    const hints = navigatorValue.userAgentData;
    if (hints) {
      browser.clientHints = { platform: hints.platform || "", mobile: Boolean(hints.mobile) };
      if (typeof hints.getHighEntropyValues === "function") {
        let deadline;
        try {
          const values = await Promise.race([
            hints.getHighEntropyValues(["platformVersion", "model", "architecture", "bitness"]),
            new Promise((resolve) => { deadline = setTimeout(() => resolve({}), 1200); })
          ]);
          for (const key of ["platformVersion", "model", "architecture", "bitness"]) {
            if (typeof values[key] === "string") browser.clientHints[key] = values[key].slice(0, key === "model" ? 80 : 40);
          }
        } catch {
          // UA-CH 并非所有浏览器都开放，继续提交现有的浏览器信息。
        } finally {
          clearTimeout(deadline);
        }
      }
    }
    return browser;
  }

  globalThis.JobsDeviceBrowser = Object.freeze({ detect, collect });
})();
