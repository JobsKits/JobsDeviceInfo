/* JobsDeviceInfo · Created by Jobs. */
"use strict";

(() => {
  const timeoutSetting = Number(document.querySelector('meta[name="api-timeout-ms"]')?.content);
  const API_TIMEOUT_MS = Number.isFinite(timeoutSetting) && timeoutSetting >= 1000 ? timeoutSetting : 3000;
  const fields = [
    ["platformName", "设备系统"], ["browserName", "浏览器"], ["screenSize", "屏幕尺寸"], ["language", "浏览器语言"],
    ["udid", "UDID"], ["imei", "IMEI"], ["imei2", "IMEI2"], ["iccid", "ICCID"], ["meid", "MEID"],
    ["osVersion", "系统版本"], ["modelName", "型号名称"], ["serial", "序列号"],
    ["modelNumber", "型号号码 / 部件号"], ["seid", "SEID"], ["product", "产品型号标识"], ["version", "系统构建号"]
  ].map(([key, label]) => ({ key, label }));
  const manualKeys = ["imei", "imei2", "iccid", "meid", "osVersion", "modelName", "serial", "modelNumber", "seid"];
  const manualId = (key) => `manual${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  const ids = [
    "connection", "connectionLabel", "demoBanner", "demoRetry", "flash", "supportNote", "consent",
    "platformBadge", "captureOptions", "platformSelect", "captureMethod", "captureMethodLabel", "capabilityNote", "consentDescription", "resultCapability", "useThisDevice",
    "step1Title", "step1Copy", "step2Title", "step2Copy",
    "startCapture", "startLabel", "downloadAgain", "actionFootnote", "copyLink", "resultTag", "sessionTime",
    "reload", "emptyState", "emptyTitle", "emptyCopy", "emptyReload", "resultDetails", "udidHelp", "imeiHelp", "verificationNote",
    "manualSection", "detailsForm", "saveDetails", "copyAll", "clearData", "consentLabel", "pairedConsent",
    "pairSection", "pairIntro", "qrPanel", "pairQr", "qrState", "qrExpiry", "copyPair", "generatePair",
    "pairFootnote", "pairNotice", "copyPendingPair", "copyDialog", "copyDialogTitle", "copyDialogMessage", "copyDialogClose",
    ...fields.flatMap(({ key }) => [`${key}Value`, `${key}Source`]),
    ...manualKeys.flatMap((key) => [manualId(key), `${manualId(key)}Status`])
  ];
  const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const detected = JobsDeviceBrowser.detect(navigator);
  const mobileSafari = detected.safari;
  const platformNames = { ios: "iOS / iPadOS", android: "Android", harmonyos: "鸿蒙", unknown: "未识别系统" };
  const localPreview = /^(localhost|127(?:\.[0-9]+){3}|\[::1\])$/.test(window.location.hostname)
    || window.location.protocol !== "https:";
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const rawPairToken = fragment.get("pair");
  const validPairToken = typeof rawPairToken === "string" && /^[a-f0-9]{64}$/i.test(rawPairToken) ? rawPairToken : "";
  const startPairRequested = window.location.hash === "#start-pair";
  if (rawPairToken !== null || startPairRequested) {
    // 配对秘密只留在内存，避免后续复制网址时带出。
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  const state = {
    mode: "connecting",
    session: null,
    demoSession: null,
    busy: false,
    refreshing: false,
    pendingDelete: false,
    pollTimer: null,
    operation: "",
    expired: false,
    incomingPair: validPairToken,
    pairUrl: "",
    qrExpiresAt: 0,
    qrError: "",
    publicOrigin: localPreview ? "" : window.location.origin,
    publicCheckDone: !localPreview,
    forceCapture: false
  };
  let copyTrigger = null;

  function capturePlatform() {
    return ui.platformSelect.value === "auto" ? detected.platform : ui.platformSelect.value;
  }

  function usesProfile() {
    return capturePlatform() === "ios" && mobileSafari && ui.captureMethod.value === "profile";
  }

  function missingReason(key, session) {
    if (!session || session.state !== "received") return "待采集";
    const device = session.device || {};
    const browser = session.verification === "browser-reported";
    if (key === "udid" && device.platform && device.platform !== "ios") return "不适用（苹果专用）";
    if (browser && ["udid", "imei", "imei2", "iccid", "meid", "serial", "modelNumber", "seid", "version"].includes(key)) {
      return "浏览器无读取权限";
    }
    if (["browserName", "screenSize", "language"].includes(key)) return "此采集方式未提供";
    if (key === "imei" && device.imeiStatus === "unrecognized_format") return "回传格式无法识别";
    if (!browser && ["imei2", "modelNumber", "seid"].includes(key)) return "当前系统采集接口不提供";
    if (key === "iccid") {
      return { empty: "系统返回空值", unsupported_type: "系统返回类型不支持", unrecognized_format: "回传格式无法识别" }[device.iccidStatus]
        || "系统未提供（受 SIM / 系统限制）";
    }
    if (browser && key === "osVersion") return device.platform === "harmonyos" ? "浏览器未公开鸿蒙版本" : "浏览器未公开真实版本";
    if (browser && ["modelName", "product"].includes(key)) return "浏览器未公开具体型号";
    return "本次系统未提供";
  }

  class ApiError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch(path, {
        method: options.method || "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok !== true) {
        const message = typeof data?.error === "string" ? data.error.slice(0, 180)
          : typeof data?.error?.message === "string" ? data.error.message.slice(0, 180) : "采集服务暂时不可用";
        throw new ApiError(message, response.status);
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new ApiError("连接超时，请检查网络后重试");
      }
      if (error instanceof ApiError) {
        throw error;
      }
      throw new ApiError("无法连接采集服务，请检查网络后重试");
    } finally {
      clearTimeout(deadline);
    }
  }

  async function loadPublicOrigin() {
    if (!localPreview) {
      return;
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await fetch("/public-site.json", { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      const url = new URL(data.url);
      if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/"
        && !url.search && !url.hash && !/^(localhost|127(?:\.[0-9]+){3}|\[::1\])$/.test(url.hostname)) {
        state.publicOrigin = url.origin;
      }
    } catch {
      state.publicOrigin = "";
    } finally {
      clearTimeout(deadline);
      state.publicCheckDone = true;
      render();
    }
  }

  async function paintPairQr(value) {
    let deadline;
    const module = await Promise.race([
      import("/qr-code.js"),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new ApiError("二维码组件加载超时，请重新尝试")), API_TIMEOUT_MS);
      })
    ]).finally(() => clearTimeout(deadline));
    const toCanvas = module.toCanvas || module.default?.toCanvas;
    if (typeof toCanvas !== "function") {
      throw new ApiError("二维码组件未加载，请重新部署完整项目");
    }
    await toCanvas(ui.pairQr, value, {
      width: 224,
      margin: 4,
      color: { dark: "#17392d", light: "#ffffff" },
      errorCorrectionLevel: "M"
    });
  }

  async function generatePair() {
    if (state.busy || state.refreshing || !state.publicOrigin) {
      return;
    }
    if (localPreview) {
      window.location.assign(`${state.publicOrigin}/#start-pair`);
      return;
    }
    state.busy = true;
    state.operation = "pair";
    state.qrError = "";
    render();
    try {
      const data = await api("/api/pair", { method: "POST", body: {} });
      if (typeof data.pairToken !== "string" || !/^[a-f0-9]{64}$/i.test(data.pairToken)) {
        throw new ApiError("服务端返回的配对入口无法解析");
      }
      const session = normalizeSession(data.session);
      const pairUrl = `${window.location.origin}/#pair=${data.pairToken}`;
      state.session = session;
      state.mode = "live";
      state.demoSession = null;
      resetManualFields();
      state.incomingPair = "";
      state.pairUrl = pairUrl;
      state.qrExpiresAt = session.expiresAt;
      state.expired = false;
      state.pendingDelete = false;
      await paintPairQr(pairUrl);
      flash("二维码已生成。请用 iPhone、Android 或鸿蒙手机扫码，确认采集后，电脑本页会自动显示结果。");
    } catch (error) {
      state.pairUrl = "";
      state.qrExpiresAt = 0;
      state.qrError = error.message;
      flash(`${error.message}。未生成可用二维码，请重新尝试。`, true);
    } finally {
      state.busy = false;
      state.operation = "";
      render();
      schedulePoll();
    }
  }

  function timestamp(value) {
    if (typeof value === "number") {
      return value < 100000000000 ? value * 1000 : value;
    }
    return Date.parse(value);
  }

  function normalizeSession(value) {
    if (value === null) {
      return null;
    }
    if (!value || !Number.isFinite(timestamp(value.expiresAt))) {
      throw new ApiError("服务端会话格式无法解析");
    }
    const device = {};
    for (const key of [...fields.map((field) => field.key), "imeiSource", "imeiStatus", "iccidStatus", "platform", "platformSource"]) {
      device[key] = typeof value.device?.[key] === "string" ? value.device[key].slice(0, 256) : "";
    }
    const iccidAvailability = value.device?.fieldAvailability?.iccid;
    if (["not_returned", "unsupported_type", "empty", "provided", "unrecognized_format"].includes(iccidAvailability)) {
      device.iccidStatus = iccidAvailability;
    }
    device.fieldSources = {};
    for (const { key } of fields) {
      const source = value.device?.fieldSources?.[key];
      if (["profile", "manual", "derived", "browser", "browser-hint", "selected"].includes(source)) {
        device.fieldSources[key] = source;
      }
    }
    if (!device.imeiSource && typeof value.imeiSource === "string") {
      device.imeiSource = value.imeiSource;
    }
    return {
      ...value,
      state: value.state === "received" ? "received" : "waiting",
      device,
      expiresAt: timestamp(value.expiresAt)
    };
  }

  function newDemoSession() {
    const appleDemo = capturePlatform() === "ios";
    return {
      state: "received",
      expiresAt: Date.now() + 15 * 60 * 1000,
      receivedAt: new Date().toISOString(),
      verification: "demo",
      device: {
        platform: capturePlatform(),
        platformName: `${platformNames[capturePlatform()]}（本地演示）`,
        browserName: "演示浏览器",
        screenSize: "演示屏幕尺寸",
        language: "演示语言",
        udid: appleDemo ? "演示 UDID · 非真实设备编号" : "",
        imei: "",
        product: appleDemo ? "iPhone（本地演示）" : "",
        version: appleDemo ? "演示构建号" : "",
        osVersion: "演示系统版本",
        modelName: "演示型号名称",
        serial: "",
        modelNumber: "",
        imeiSource: "",
        fieldSources: { platformName: "browser", browserName: "browser", screenSize: "browser", language: "browser", udid: "profile", product: "profile", version: "profile", osVersion: "browser", modelName: "browser" }
      }
    };
  }

  function enterDemo() {
    if (state.mode !== "demo") {
      resetManualFields();
      state.demoSession = newDemoSession();
    }
    state.mode = "demo";
    state.session = null;
    render();
  }

  function flash(message, error = false) {
    ui.flash.textContent = message;
    ui.flash.dataset.error = String(error);
    ui.flash.hidden = !message;
  }

  function currentSession() {
    return state.mode === "demo" ? state.demoSession : state.session;
  }

  function setField(element, value, fallback) {
    element.textContent = value || fallback;
    element.classList.toggle("is-empty", !value);
  }

  function fieldSource(device, key) {
    const source = device.fieldSources?.[key];
    if (["profile", "manual", "derived", "browser", "browser-hint", "selected"].includes(source)) {
      return source;
    }
    return key === "imei" && ["profile", "manual"].includes(device.imeiSource) ? device.imeiSource : "";
  }

  function sourceLabel(source, key) {
    if (source === "derived") {
      return key === "modelName" ? "型号映射" : key === "osVersion" ? "版本映射" : "资料映射";
    }
    return { profile: "系统回传", manual: "手动填写", browser: "浏览器报告", "browser-hint": "浏览器提示（UA-CH）", selected: "用户选择" }[source] || "来源未标明";
  }

  function canEditField(device, key) {
    const source = fieldSource(device, key);
    return !device[key] || ["manual", "browser", "browser-hint", "derived"].includes(source);
  }

  function resetManualFields() {
    for (const key of manualKeys) {
      const input = ui[manualId(key)];
      input.value = "";
      input.dataset.edited = "false";
    }
  }

  function renderManualFields(device, session, demo) {
    for (const key of manualKeys) {
      const input = ui[manualId(key)];
      const source = fieldSource(device, key);
      const readOnly = Boolean(device[key] && !canEditField(device, key));
      input.readOnly = readOnly;
      input.disabled = state.busy || !session;
      if (readOnly || input.dataset.edited !== "true") {
        input.value = device[key] || "";
        input.dataset.edited = "false";
      }
      const description = readOnly ? `${sourceLabel(source, key)}，只读`
        : source === "derived" ? `${sourceLabel(source, key)}，可手动更正`
          : source === "manual" ? "手动填写，可修改" : source.startsWith("browser") ? "浏览器报告，可更正" : "尚未获取，可补录";
      ui[`${manualId(key)}Status`].textContent = `${demo ? "仅本地演示 · " : ""}${description}`;
    }
  }

  function renderClock() {
    if (state.pairUrl && state.qrExpiresAt > Date.now()) {
      const qrRemaining = Math.ceil((state.qrExpiresAt - Date.now()) / 1000);
      ui.qrExpiry.textContent = `${String(Math.floor(qrRemaining / 60)).padStart(2, "0")}:${String(qrRemaining % 60).padStart(2, "0")} 后到期`;
    } else {
      ui.qrExpiry.textContent = "";
    }
    const session = currentSession();
    if (state.mode === "demo") {
      ui.sessionTime.textContent = session ? "本地示例 · 不代表当前设备" : "本地演示数据已清空";
      return;
    }
    if (!session) {
      ui.sessionTime.textContent = state.expired ? "本次会话已到期，请重新发起采集" : "确认采集后，结果显示在这里";
      return;
    }
    const remaining = Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000));
    const minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
    const seconds = String(remaining % 60).padStart(2, "0");
    const waitingLabel = session.paired && session.role === "desktop" ? "等待手机确认并回传" : "等待设备回传";
    ui.sessionTime.textContent = `${session.state === "received" ? "已收到设备信息" : waitingLabel} · ${minutes}:${seconds} 后到期`;
  }

  function render() {
    const demo = state.mode === "demo";
    const session = currentSession();
    const device = session?.device || {};
    const received = session?.state === "received";
    const callbackCode = !demo && !received && /^[a-z0-9_]{1,64}$/.test(session?.callbackError?.code || "")
      ? session.callbackError.code : "";
    const hasDetails = Boolean(session && (received || fields.some(({ key }) => device[key])));
    const pairedPhone = Boolean(state.incomingPair || (session?.paired && session.role === "phone"));
    const canDownload = session?.canDownload !== false;
    const platform = capturePlatform();
    const profile = usesProfile();
    const onPhone = detected.mobile || pairedPhone || state.forceCapture;
    ui.useThisDevice.hidden = onPhone || Boolean(session?.paired && session.role === "desktop");
    ui.platformSelect.options[0].textContent = `自动识别（${platformNames[detected.platform]}）`;
    ui.platformBadge.textContent = onPhone ? platformNames[platform] : "三端扫码";
    ui.captureOptions.hidden = !onPhone && !demo;
    ui.captureMethodLabel.hidden = !mobileSafari || platform !== "ios";
    ui.platformSelect.disabled = state.busy || state.refreshing;
    ui.captureMethod.disabled = state.busy || state.refreshing;
    ui.capabilityNote.textContent = profile
      ? "系统确认可读取 UDID 和部分设备标识。IMEI2、型号号码 / 部件号、SEID 未在当前接口开放；ICCID 等取决于系统实际回传。"
      : "读取浏览器公开的系统、浏览器、屏幕、语言，以及可用的型号与版本。网页无权直接读取 IMEI、ICCID、序列号等硬件编号。鸿蒙 3 可能仅显示 Android 兼容信息，可在上方选择鸿蒙；系统版本仍以浏览器实际公开内容为准。";
    ui.connection.dataset.state = state.mode;
    ui.connectionLabel.textContent = demo ? "本地演示" : state.mode === "live" ? "采集服务已连接" : "正在连接服务";
    ui.demoBanner.hidden = !demo;
    ui.supportNote.textContent = !onPhone
      ? "在下方生成二维码，使用 iPhone、Android 或鸿蒙手机扫码。手机确认采集后，本电脑自动显示结果。"
      : profile ? "当前 Safari 支持苹果系统确认流程，请检查描述文件内容后再安装。"
        : platform === "ios" ? "当前使用浏览器基础信息采集。如需 UDID 等设备标识，请复制本站或配对链接到 Safari 中打开。"
          : "当前使用浏览器基础信息采集。请核对本机系统；内置浏览器读取受限时，可在系统浏览器中打开本次链接。";
    ui.consentLabel.hidden = !onPhone && !demo;
    ui.startCapture.hidden = !onPhone && !demo;
    ui.pairedConsent.hidden = !pairedPhone;
    ui.pairNotice.hidden = !pairedPhone;
    ui.copyPendingPair.hidden = !state.incomingPair || platform !== "ios" || mobileSafari;
    ui.pairSection.hidden = onPhone;
    ui.step1Title.textContent = profile ? "下载设备确认文件" : "核对本机系统与采集范围";
    ui.step1Copy.textContent = profile ? "勾选下方同意项，下载苹果描述文件。网页本身无法直接读取设备编号。"
      : "支持 iPhone / iPad、Android、鸿蒙。浏览器可能隐藏真实系统或型号，请先核对系统选择。";
    ui.step2Title.textContent = profile ? "在系统设置中确认" : "同意并回传可用信息";
    ui.step2Copy.textContent = profile ? "打开「设置」→「已下载描述文件」，检查信息后点「安装」。下载后请在 8 分钟内完成。"
      : "手机勾选同意后点击采集，无需安装描述文件。系统或浏览器未开放的字段会逐项说明。";
    ui.consentDescription.textContent = profile
      ? "我同意将系统允许回传的 UDID、IMEI、ICCID、MEID 及基础设备信息发送到本站的 Cloudflare 后端，结果 15 分钟后不可访问。"
      : "我同意将本次浏览器公开的设备与浏览器信息（包括 User-Agent、可用的型号与版本、屏幕尺寸和语言）发送到本站的 Cloudflare 后端，结果 15 分钟后不可访问。";
    ui.generatePair.disabled = state.busy || state.refreshing || !state.publicCheckDone || !state.publicOrigin;
    ui.generatePair.textContent = state.operation === "pair" ? "正在生成二维码…"
      : !state.publicCheckDone ? "正在检测部署地址…"
        : localPreview && state.publicOrigin ? "前往线上网站生成二维码"
          : received && session?.paired ? "开始新的扫码采集"
            : state.pairUrl ? "刷新二维码（替换本次会话）" : "生成扫码二维码";
    ui.pairIntro.textContent = localPreview
      ? state.publicOrigin ? "将前往已部署网站，生成可供手机访问的二维码。手机确认后，当前电脑标签页自动显示同一份结果。"
        : "本地地址无法供手机直接访问。请先运行一键部署，取得线上 HTTPS 地址后再生成扫码入口。"
      : "用 iPhone、Android 或鸿蒙手机扫码。手机确认采集后，本页自动显示同一份结果。";
    ui.pairFootnote.textContent = state.qrError || (session?.paired && session.role === "desktop" && received
      ? "本次手机信息已回传，二维码不再重复使用。开始新的扫码采集将替换当前会话。"
      : session?.paired && session.role === "desktop" && !state.pairUrl
        ? "网页刷新后不会重新显示旧配对链接；需要时请生成新二维码。生成会替换本次旧会话。"
        : "手机同意后才采集：苹果设备可走系统确认；Android、鸿蒙使用浏览器基础信息采集。");
    ui.qrPanel.hidden = !state.pairUrl || state.qrExpiresAt <= Date.now() || received;
    ui.qrState.textContent = received ? "手机信息已回传" : "等待手机扫码并确认";
    ui.copyPair.disabled = !state.pairUrl || state.busy || received;
    ui.startCapture.disabled = !ui.consent.checked || state.busy || state.refreshing || state.mode === "connecting"
      || (!demo && !state.incomingPair && session?.paired && received && pairedPhone)
      || (!demo && !state.incomingPair && session?.paired && !canDownload);
    ui.startLabel.textContent = state.operation === "start" ? profile ? "正在准备确认文件…" : "正在采集并回传…"
      : demo ? "模拟一次采集（仅本地演示）"
        : pairedPhone && received && !state.incomingPair ? "本次配对采集已完成"
          : profile ? pairedPhone ? "同意并下载本次确认文件" : "下载设备确认文件" : "同意并采集基础信息";
    ui.actionFootnote.textContent = demo
      ? "演示操作仅在当前页面生效，不会下载描述文件或读取真实设备编号。"
      : callbackCode ? `系统回传未通过校验（${callbackCode}）。请保留本次会话，修复后再重试安装。`
      : !onPhone ? "请保持本页打开，等待手机确认采集与回传。"
        : pairedPhone && received && !state.incomingPair ? "本次配对采集已完成。重新采集时，请先清除本次会话，再由电脑生成新二维码。"
          : "勾选同意并点击后才采集，不会因为打开网页就自动上传。";
    ui.downloadAgain.hidden = demo || !session || !profile || received || state.busy || state.refreshing || !canDownload;
    ui.resultTag.textContent = demo ? "演示数据" : received ? "已回传" : callbackCode ? "回传未通过" : session ? "等待确认" : state.expired ? "已到期" : "等待采集";
    ui.resultTag.dataset.state = demo ? "demo" : received ? "received" : "waiting";
    ui.emptyState.hidden = hasDetails;
    ui.resultDetails.hidden = !hasDetails;
    ui.emptyTitle.textContent = state.expired && !demo ? "本次采集已到期"
      : callbackCode ? "系统回传未通过校验"
      : session ? "等待设备回传信息" : demo ? "演示数据已清空" : "还没有设备信息";
    ui.emptyCopy.textContent = state.expired && !demo ? "结果已不可查询。重新勾选同意项，再开始一次采集。"
      : callbackCode ? `错误码：${callbackCode}。请保留本次会话并将错误码反馈给维护者，可重新加载查看处理结果。`
      : session?.paired && session.role === "desktop" ? "使用 iPhone、Android 或鸿蒙手机扫描本页二维码，完成对应采集步骤后，此处自动更新。"
        : session ? profile ? "请完成手机设置中的描述文件安装，再返回本站。页面会自动更新。" : "请点击采集回传可用信息；网络失败可重试。"
        : demo ? "可以重新模拟一次采集，或重新连接服务获取真实结果。" : "从采集步骤开始。这里只展示本次会话回传的信息。";
    for (const { key } of fields) {
      setField(ui[`${key}Value`], device[key], missingReason(key, session));
      const source = fieldSource(device, key);
      const badge = ui[`${key}Source`];
      badge.hidden = !device[key];
      badge.textContent = `${demo ? "演示 · " : ""}${sourceLabel(source, key)}`;
      badge.dataset.source = source || "unknown";
    }
    ui.resultCapability.textContent = demo ? "本地演示示例，不代表扫码设备的实际采集能力。"
      : session?.verification === "browser-reported"
        ? "本次为浏览器基础信息。系统与型号由浏览器报告或用户选择，可能被隐藏、缩减或修改；不代表硬件校验结果。"
        : "本次为苹果系统确认采集。部分字段受接口、SIM 与系统限制；未取得的编号无法通过网页自动补齐。";
    ui.udidHelp.textContent = demo ? "此文字仅演示展示与复制，不是有效 UDID。" : "苹果设备标识；Android、鸿蒙不适用，浏览器基础信息采集无法读取。";
    ui.imeiHelp.textContent = fieldSource(device, "imei") === "manual"
      ? "这项内容由你手动填写，未由系统回传验证。"
      : !device.imei && device.imeiStatus === "unrecognized_format"
        ? "本次系统回传的 IMEI 格式无法识别，未保存该值。可到手机设置查看后手动补录。"
      : session?.verification === "browser-reported" ? "网页没有直接读取 IMEI 的权限。需要编号时可到手机设置核对；手动补录会单独注明来源。"
        : "并非所有设备或系统都会回传 IMEI；Wi-Fi 版设备没有 IMEI。";
    ui.verificationNote.textContent = demo ? "本地演示没有进行真实设备采集，也没有验证设备身份。"
      : session?.verification === "browser-reported" ? "浏览器回传信息未经硬件验证，不能用于设备身份认证。手动更正会单独标注来源。"
      : !received ? "目前仅保存手动填写的内容，仍在等待设备回传。手工内容不作为设备身份认证凭据。"
        : "已接收本次确认流程的数据。CMS 签名校验只验证报文完整性，不等同于 Apple 身份链认证；请勿用于设备身份认证。";
    for (const button of document.querySelectorAll("[data-copy]")) {
      const key = button.dataset.copy;
      const label = fields.find((field) => field.key === key)?.label || key;
      button.disabled = !device[key] || state.busy;
      button.setAttribute("aria-label", `${label}：${device[key] || missingReason(key, session)}${device[key] ? "，点击复制" : ""}`);
    }
    ui.manualSection.hidden = !session;
    renderManualFields(device, session, demo);
    ui.saveDetails.disabled = state.busy || state.refreshing || !session;
    ui.copyAll.disabled = !hasDetails || state.busy;
    ui.clearData.disabled = !session || state.busy || state.refreshing;
    ui.reload.disabled = state.busy || state.refreshing;
    ui.emptyReload.disabled = state.busy || state.refreshing;
    ui.demoRetry.disabled = state.busy || state.refreshing;
    renderClock();
  }

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (document.hidden) {
      return;
    }
    const interval = state.mode === "demo" ? 10000 : state.session?.state === "waiting" ? 4000 : 15000;
    state.pollTimer = setTimeout(() => refresh(false), interval);
  }

  async function refresh(announce = true) {
    if (state.refreshing || state.busy) {
      schedulePoll();
      return;
    }
    state.refreshing = true;
    render();
    const wasDemo = state.mode === "demo";
    try {
      if (state.pendingDelete) {
        await api("/api/session", { method: "DELETE" });
        state.pendingDelete = false;
      }
      const data = await api("/api/session");
      const next = normalizeSession(data.session);
      const previousState = state.session?.state;
      if (!next || next.expiresAt !== state.session?.expiresAt) {
        resetManualFields();
      }
      state.mode = "live";
      state.session = next;
      state.demoSession = null;
      if (!next || (next.paired !== true && state.pairUrl)) {
        state.pairUrl = "";
        state.qrExpiresAt = 0;
      }
      if (next) {
        state.expired = false;
      }
      if (wasDemo) {
        flash("采集服务已恢复，当前显示服务端结果。本地演示内容不会自动提交。");
      } else if (next?.state === "received" && previousState !== "received") {
        flash("已收到本次设备信息，可以复制查看。未获取的项目已注明原因。");
      } else if (announce) {
        flash(next ? "已重新加载本次会话。" : "已连接服务，当前还没有采集会话。");
      }
    } catch (error) {
      enterDemo();
      if (announce) {
        flash(`${error.message}。已切换到明确标注的本地演示。`, true);
      }
    } finally {
      state.refreshing = false;
      render();
      schedulePoll();
    }
  }

  function safeProfileUrl(value) {
    const url = new URL(value || "/profile.mobileconfig", window.location.origin);
    if (url.origin !== window.location.origin || url.pathname !== "/profile.mobileconfig" || url.search || url.hash) {
      throw new ApiError("服务端返回的确认文件地址不符合预期");
    }
    return url.href;
  }

  async function startCapture() {
    if (!ui.consent.checked || state.busy || state.refreshing) {
      return;
    }
    if (state.mode === "demo") {
      state.demoSession = newDemoSession();
      render();
      flash("已生成本地演示内容。没有下载描述文件，也没有读取真实设备信息。");
      return;
    }
    if (state.session?.paired && state.session.state === "received" && !state.incomingPair) {
      flash("本次配对已完成。需要重新采集时，请由电脑生成新二维码。", true);
      return;
    }
    state.busy = true;
    state.operation = "start";
    render();
    try {
      const pairToken = state.incomingPair;
      const resumePairedPhone = !pairToken && state.session && state.session.role === "phone"
        && state.session.canDownload === true && state.session.state === "waiting";
      const data = resumePairedPhone ? { session: state.session }
        : pairToken ? await api("/api/pair/claim", { method: "POST", body: { token: pairToken, consent: true } })
          : await api("/api/session", { method: "POST", body: { consent: true } });
      state.session = normalizeSession(data.session);
      resetManualFields();
      state.incomingPair = "";
      state.mode = "live";
      state.expired = false;
      if (usesProfile()) {
        const profileUrl = safeProfileUrl(data.session?.profileUrl || data.profileUrl);
        flash("确认文件已准备好。下载后打开系统设置，检查内容并手动确认安装。");
        window.location.assign(profileUrl);
      } else {
        const browser = await JobsDeviceBrowser.collect(navigator, window.screen, window.devicePixelRatio || 1);
        const result = await api("/api/session/browser", {
          method: "POST",
          body: { consent: true, platform: capturePlatform(), platformSource: ui.platformSelect.value === "auto" ? "detected" : "selected", browser }
        });
        state.session = normalizeSession(result.session);
        flash("可用基础信息已回传；通过电脑二维码进入时，电脑会自动显示相同结果。硬件编号仍受系统权限限制。");
      }
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        flash(error.message, true);
      } else {
        enterDemo();
        flash(`${error.message}。本次采集尚未确认成功；当前为本地演示，可重新连接后核对或重试。`, true);
      }
    } finally {
      state.busy = false;
      state.operation = "";
      render();
      schedulePoll();
    }
  }

  async function saveDetails(event) {
    event.preventDefault();
    if (state.busy || state.refreshing || !currentSession()) {
      return;
    }
    const device = currentSession().device || {};
    const changed = {};
    for (const key of manualKeys) {
      const input = ui[manualId(key)];
      const value = input.value.trim();
      if (canEditField(device, key) && value && value !== (device[key] || "")) {
        changed[key] = value;
      }
    }
    if (!Object.keys(changed).length) {
      flash("本次没有新增或更改的非空内容；系统已返回的值不会被覆盖。");
      return;
    }
    for (const key of ["imei", "imei2"]) {
      if (changed[key] && !/^[0-9]{15}$/.test(changed[key])) {
        flash(`${key.toUpperCase()} 应为 15 位数字，请按设备设置中的内容填写。`, true);
        ui[manualId(key)].focus();
        return;
      }
    }
    if (state.mode === "demo") {
      for (const [key, value] of Object.entries(changed)) {
        state.demoSession.device[key] = value;
        state.demoSession.device.fieldSources[key] = "manual";
      }
      if (changed.imei) {
        state.demoSession.device.imeiSource = "manual";
        state.demoSession.device.imeiStatus = "provided";
      }
      resetManualFields();
      render();
      flash("已保存到本页演示内容，没有上传。连接恢复后将以服务端结果为准。");
      return;
    }
    state.busy = true;
    state.operation = "details";
    render();
    try {
      const data = await api("/api/session/details", { method: "POST", body: { fields: changed } });
      state.session = normalizeSession(data.session);
      resetManualFields();
      flash("补录信息已保存，来源已标注为「手动填写」。系统回传的值保持只读。");
    } catch (error) {
      if (!error.status || error.status >= 500) {
        enterDemo();
        flash(`${error.message}。本次保存未确认，请恢复连接后核对；刚填写的内容未写入演示，也未保存在本机。`, true);
      } else {
        flash(error.message, true);
      }
    } finally {
      state.busy = false;
      state.operation = "";
      render();
      schedulePoll();
    }
  }

  async function clearData() {
    if (state.busy || state.refreshing || !currentSession()) {
      return;
    }
    if (state.mode === "demo") {
      state.demoSession = null;
      resetManualFields();
      render();
      flash("本页演示数据已清空。此操作没有删除服务端数据。");
      return;
    }
    state.busy = true;
    render();
    try {
      await api("/api/session", { method: "DELETE" });
      state.session = null;
      state.pairUrl = "";
      state.qrExpiresAt = 0;
      state.expired = false;
      ui.consent.checked = false;
      resetManualFields();
      flash("应用中的本次会话数据已清除。Cloudflare 平台备份按其保留策略处理。");
    } catch (error) {
      state.pendingDelete = true;
      enterDemo();
      state.demoSession = null;
      resetManualFields();
      flash("网络不可用，已隐藏当前页面的设备信息；服务端删除尚未确认。页面会在连接恢复后优先重试删除。", true);
    } finally {
      state.busy = false;
      render();
      schedulePoll();
    }
  }

  function restoreCopyFocus() {
    const target = copyTrigger;
    copyTrigger = null;
    if (target?.isConnected && !target.disabled) {
      target.focus();
    }
  }

  function showCopyDialog(title, message, error = false, trigger = document.activeElement) {
    copyTrigger = trigger;
    ui.copyDialogTitle.textContent = title;
    ui.copyDialogMessage.textContent = message;
    ui.copyDialog.dataset.error = String(error);
    if (typeof ui.copyDialog.showModal === "function") {
      try {
        if (!ui.copyDialog.open) {
          ui.copyDialog.showModal();
        }
        ui.copyDialogClose.focus();
        return;
      } catch {}
    }
    // 较旧浏览器仍使用真正的系统对话框，不把失败当成复制成功。
    window.alert(`${title}\n\n${message}`);
    restoreCopyFocus();
  }

  async function copyText(value, success) {
    const trigger = document.activeElement;
    if (!value) {
      showCopyDialog("无法复制", "这项信息尚未返回，没有可复制的值。", true, trigger);
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = value;
        textArea.className = "clipboard-fallback";
        textArea.setAttribute("aria-label", "待复制内容");
        document.body.append(textArea);
        textArea.select();
        const copied = document.execCommand("copy");
        textArea.remove();
        if (!copied) {
          throw new Error("clipboard-unavailable");
        }
      }
      showCopyDialog("复制成功", success, false, trigger);
    } catch {
      showCopyDialog("复制失败", "浏览器未允许写入剪贴板，内容没有确认复制成功。请选中需要的文字手动复制。", true, trigger);
    }
  }

  function copyAll() {
    const session = currentSession();
    if (!session) {
      return;
    }
    const device = session.device;
    const demo = state.mode === "demo";
    const lines = [
      demo ? "JobsDeviceInfo · 本地演示（非真实设备信息）" : "JobsDeviceInfo · 本次设备信息",
      ...fields.map(({ key, label }) => `${label}：${device[key] || missingReason(key, session)}${device[key] ? `（${demo ? "演示 · " : ""}${sourceLabel(fieldSource(device, key), key)}）` : ""}`),
      demo ? "演示内容未进行设备身份验证。" : "仅用于信息展示，不作为设备身份认证凭据。"
    ];
    copyText(lines.join("\n"), demo ? "已复制本地演示内容，包含明确的演示标注。" : "已复制本次设备信息。");
  }

  ui.consent.addEventListener("change", render);
  ui.useThisDevice.addEventListener("click", () => {
    state.forceCapture = true;
    render();
  });
  for (const select of [ui.platformSelect, ui.captureMethod]) {
    select.addEventListener("change", () => {
      ui.consent.checked = false;
      render();
    });
  }
  ui.startCapture.addEventListener("click", startCapture);
  ui.reload.addEventListener("click", () => refresh(true));
  ui.emptyReload.addEventListener("click", () => refresh(true));
  ui.demoRetry.addEventListener("click", () => refresh(true));
  ui.detailsForm.addEventListener("submit", saveDetails);
  for (const key of manualKeys) {
    ui[manualId(key)].addEventListener("input", () => {
      ui[manualId(key)].dataset.edited = "true";
    });
  }
  ui.copyDialog.addEventListener("close", restoreCopyFocus);
  ui.clearData.addEventListener("click", clearData);
  ui.copyAll.addEventListener("click", copyAll);
  ui.generatePair.addEventListener("click", generatePair);
  ui.copyPair.addEventListener("click", () => copyText(state.pairUrl, "已复制本次配对链接。持有人可加入本次会话并查看结果，请只交给本次采集设备。"));
  ui.copyPendingPair.addEventListener("click", () => copyText(`${window.location.origin}/#pair=${state.incomingPair}`, "本次配对链接已复制。请粘贴到 Safari；持有人可加入本次会话，请勿转发。"));
  ui.copyLink.addEventListener("click", () => {
    const origin = state.publicOrigin;
    if (!origin) {
      showCopyDialog("无法复制", "尚无可供手机访问的线上地址，请先运行一键部署。", true);
      return;
    }
    copyText(`${origin}/`, "本站地址已复制，请在 iPhone、Android 或鸿蒙手机浏览器中打开。普通网址不包含本次配对码。");
  });
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.copy;
      const value = currentSession()?.device?.[key];
      const label = fields.find((field) => field.key === key)?.label || key;
      copyText(value, state.mode === "demo" ? `已复制演示「${label}」，不是当前设备的真实信息。` : `已复制「${label}」。`);
    });
  }
  ui.downloadAgain.addEventListener("click", (event) => {
    if (state.mode !== "live" || !state.session || !mobileSafari || state.session.expiresAt <= Date.now()) {
      event.preventDefault();
      flash("请重新发起一次设备采集。", true);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(state.pollTimer);
    } else {
      refresh(false);
    }
  });
  window.addEventListener("online", () => refresh(false));
  window.addEventListener("pagehide", () => clearTimeout(state.pollTimer));
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      refresh(false);
    }
  });
  setInterval(() => {
    if (state.pairUrl && state.qrExpiresAt <= Date.now()) {
      state.pairUrl = "";
      state.qrExpiresAt = 0;
      render();
    }
    const session = state.session;
    if (state.mode === "live" && session && session.expiresAt <= Date.now()) {
      state.session = null;
      state.pairUrl = "";
      state.qrExpiresAt = 0;
      state.expired = true;
      ui.consent.checked = false;
      resetManualFields();
      render();
      flash("本次会话已到期，结果已不可查询。需要时可以重新开始采集。");
      refresh(false);
    } else {
      renderClock();
    }
  }, 1000);

  render();
  if (rawPairToken !== null && !validPairToken) {
    flash("配对链接格式不正确，请回到电脑重新生成并扫码。", true);
  }
  Promise.all([refresh(false), loadPublicOrigin()]).then(() => {
    if (startPairRequested) {
      if (state.session?.state === "received") {
        flash("已恢复本次设备信息。需要采集另一部设备时，请点击开始新的扫码采集。");
      } else {
        generatePair();
      }
    }
  });
})();
