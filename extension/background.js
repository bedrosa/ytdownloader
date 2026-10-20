let creating;
const popups = new Set();
const captureWrites = new Map();
const pageRequests = new Set();

async function playbackCaptures(tabId) {
  const key = `playback:${tabId}`;
  await captureWrites.get(key);
  const captures = [...((await chrome.storage.session.get(key))[key] || [])];
  try {
    const [result] = await chrome.scripting.executeScript({target: {tabId}, world: "MAIN", func: () => {
      const captures = globalThis[Symbol.for("youtube-local.playback")]?.captures;
      if (!Array.isArray(captures)) return [];
      return captures.slice(-4).filter(capture => {
        try {
          const url = new URL(capture.url);
          return url.protocol === "https:" && url.hostname.endsWith(".googlevideo.com") && url.pathname === "/videoplayback" &&
            Number.isFinite(capture.time) && Array.isArray(capture.body) && capture.body.length > 0 && capture.body.length <= 128 * 1024 &&
            capture.body.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
        } catch { return false; }
      }).map(({url, time, body}) => ({url, time, body}));
    }});
    if (Array.isArray(result?.result)) captures.push(...result.result);
  } catch { /* Durante una recarga se conservan las capturas del navegador */ }
  return captures.sort((a, b) => a.time - b.time).slice(-8);
}

function hasPlaybackCapture(data, captures) {
  const streamUrl = data?.page?.streamingData?.serverAbrStreamingUrl;
  if (!streamUrl) return false;
  const streamId = new URL(streamUrl).searchParams.get("id");
  return captures.some(capture => {
    try { return capture.body?.length && Date.now() - capture.time < 10 * 60 * 1000 && new URL(capture.url).searchParams.get("id") === streamId; }
    catch { return false; }
  });
}

function readYouTubePlayer(expectedId) {
  const candidates = [];
  let failure = "El reproductor no ha entregado datos del vídeo";
  for (const player of document.querySelectorAll("#movie_player, #shorts-player, .html5-video-player")) {
    try {
      const response = player.getPlayerResponse?.();
      if (response) candidates.push({source: "player", response});
    } catch { failure = "La función del reproductor ha rechazado la consulta"; }
  }
  if (globalThis.ytInitialPlayerResponse) candidates.push({source: "initial", response: globalThis.ytInitialPlayerResponse});
  const configurations = [globalThis.ytplayer?.config];
  try { configurations.push(globalThis.ytcfg?.get?.("PLAYER_CONFIG")); } catch { /* La configuración puede no estar disponible en esta versión de YouTube */ }
  for (const config of configurations) {
    if (config?.args?.raw_player_response) candidates.push({source: "config", response: config.args.raw_player_response});
    if (config?.args?.player_response) candidates.push({source: "config", response: config.args.player_response});
  }
  let partial;
  for (const candidate of candidates) {
    try {
      const response = typeof candidate.response === "string" ? JSON.parse(candidate.response) : candidate.response;
      if (response?.videoDetails?.videoId !== expectedId) { failure = "Los datos del reproductor pertenecen a otro vídeo"; continue; }
      const page = JSON.parse(JSON.stringify({videoDetails: response.videoDetails, streamingData: response.streamingData, playabilityStatus: response.playabilityStatus, playerConfig: response.playerConfig}));
      if (page.streamingData?.serverAbrStreamingUrl) return {page, playerSource: candidate.source};
      partial ||= page;
      failure = page.streamingData ? "YouTube no ha expuesto el enlace de reproducción en esta pestaña" : "El reproductor ha omitido los datos de las pistas";
    } catch { failure = "No se han podido interpretar los datos del reproductor"; }
  }
  return {page: partial || null, playerFailure: failure};
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0 || details.method !== "POST" || !["https://www.youtube.com", "https://m.youtube.com", "https://youtube.com"].includes(details.initiator) || pageRequests.has(details.url)) return;
  const chunks = details.requestBody?.raw;
  if (!chunks?.length || chunks.some(chunk => !chunk.bytes)) return;
  const size = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
  if (!size || size > 128 * 1024) return;
  const body = chunks.flatMap(chunk => Array.from(new Uint8Array(chunk.bytes)));
  const key = `playback:${details.tabId}`;
  const previous = captureWrites.get(key) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const tab = await chrome.tabs.get(details.tabId);
    if (!/^https:\/\/(www\.|m\.)?youtube\.com\//.test(tab.url || "")) return;
    const stored = (await chrome.storage.session.get(key))[key] || [];
    await chrome.storage.session.set({[key]: [...stored, {url: details.url, body, time: Date.now()}].slice(-4)});
  }).catch(() => {}).finally(() => { if (captureWrites.get(key) === write) captureWrites.delete(key); });
  captureWrites.set(key, write);
}, {urls: ["https://*.googlevideo.com/videoplayback*"], types: ["xmlhttprequest"]}, ["requestBody"]);

async function fetchFromYouTube(url, body, videoId, taskId) {
  const pageUrl = new URL(location.href);
  const currentId = pageUrl.pathname === "/watch" ? pageUrl.searchParams.get("v") : pageUrl.pathname.match(/^\/shorts\/([\w-]{11})\/?$/)?.[1];
  if (pageUrl.protocol !== "https:" || !["www.youtube.com", "m.youtube.com", "youtube.com"].includes(pageUrl.hostname) || currentId !== videoId) throw new Error("El vídeo de la pestaña ha cambiado");
  const key = Symbol.for("youtube-local.fetches");
  const pending = globalThis[key] ||= new Map();
  const controller = new AbortController();
  const requestId = crypto.randomUUID();
  const active = pending.get(taskId) || new Map();
  const entry = {controller, reader: null, buffer: null, offset: 0};
  active.set(requestId, entry);
  pending.set(taskId, active);
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const fetchVideo = globalThis[Symbol.for("youtube-local.playback")]?.fetch || globalThis.fetch;
    const response = await fetchVideo.call(globalThis, url, {method: "POST", body: Uint8Array.from(body), headers: {"content-type": "application/x-protobuf", accept: "application/vnd.yt-ump"}, credentials: "include", signal: controller.signal});
    entry.reader = response.body?.getReader();
    return {status: response.status, headers: Object.fromEntries(response.headers), requestId};
  } catch (error) {
    controller.abort();
    active.delete(requestId);
    if (!active.size) pending.delete(taskId);
    if (!pending.size) delete globalThis[key];
    throw error;
  } finally { clearTimeout(timer); }
}

async function readYouTubeResponse(requestId, taskId, cancel) {
  const key = Symbol.for("youtube-local.fetches");
  const pending = globalThis[key];
  const active = pending?.get(taskId);
  const entry = active?.get(requestId);
  if (!entry) throw new Error("La petición del vídeo ya no está disponible");
  let finished = false;
  const timer = setTimeout(() => entry.controller.abort(), 30000);
  try {
    if (cancel) {
      entry.controller.abort();
      await entry.reader?.cancel().catch(() => {});
      finished = true;
      return {done: true};
    }
    while (!entry.buffer || entry.offset === entry.buffer.length) {
      const chunk = await entry.reader?.read();
      if (!chunk || chunk.done) { finished = true; return {done: true}; }
      entry.buffer = chunk.value;
      entry.offset = 0;
    }
    const bytes = entry.buffer.subarray(entry.offset, entry.offset + 1024 * 1024);
    entry.offset += bytes.length;
    let data = "";
    for (let index = 0; index < bytes.length; index += 32768) data += String.fromCharCode(...bytes.subarray(index, index + 32768));
    return {done: false, data: btoa(data)};
  } catch (error) {
    entry.controller.abort();
    await entry.reader?.cancel().catch(() => {});
    finished = true;
    throw error;
  } finally {
    clearTimeout(timer);
    if (finished) {
      entry.reader?.releaseLock();
      entry.buffer = null;
      active.delete(requestId);
      if (!active.size) pending.delete(taskId);
      if (!pending.size) delete globalThis[key];
    }
  }
}

async function abortPageRequests(task) {
  if (task?.tabId == null) return;
  await chrome.scripting.executeScript({target: {tabId: task.tabId}, world: "MAIN", func: taskId => {
    const key = Symbol.for("youtube-local.fetches");
    const pending = globalThis[key];
    for (const entry of pending?.get(taskId)?.values() || []) {
      entry.controller.abort();
      entry.reader?.cancel().catch(() => {});
    }
    pending?.delete(taskId);
    if (pending && !pending.size) delete globalThis[key];
  }, args: [task.id]}).catch(() => {});
}

async function engine() {
  if (creating) return creating;
  creating = (async () => {
    const documents = await chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"]});
    if (!documents.length) await chrome.offscreen.createDocument({url: "offscreen.html", reasons: ["WORKERS", "BLOBS"], justification: "Descargar y unir las pistas dentro del navegador mientras la descarga está activa"});
  })();
  try { await creating; } finally { creating = null; }
}

async function closeIfIdle() {
  const {task} = await chrome.storage.session.get("task");
  if (popups.size || ["downloading", "merging", "saving"].includes(task?.state)) return;
  if (task?.state === "loading") await chrome.storage.session.set({task: {...task, state: "cancelled", message: "Consulta cancelada al cerrar el popup"}});
  const documents = await chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"]});
  if (documents.length) await chrome.offscreen.closeDocument();
}

async function request(message, sender) {
  if (message.target === "background" && sender.url === chrome.runtime.getURL("offscreen.html")) {
    if (message.type === "playback-captures") {
      const {task} = await chrome.storage.session.get("task");
      if (task?.id !== message.taskId || task.state !== "downloading") throw new Error("La descarga ya no está activa");
      return playbackCaptures(task.tabId);
    }
    if (message.type === "page-fetch") {
      const {task} = await chrome.storage.session.get("task");
      if (task?.id !== message.taskId || task.state !== "downloading") throw new Error("La descarga ya no está activa");
      const url = new URL(message.url);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".googlevideo.com") || url.pathname !== "/videoplayback") throw new Error("Destino de vídeo no permitido");
      if (!Array.isArray(message.body) || message.body.length > 128 * 1024 || !message.body.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error("Petición de vídeo no válida");
      pageRequests.add(url.href);
      try {
        const [result] = await chrome.scripting.executeScript({target: {tabId: task.tabId}, world: "MAIN", func: fetchFromYouTube, args: [url.href, message.body, task.videoId, task.id]});
        if (!result?.result) throw new Error("YouTube no ha devuelto la pista solicitada");
        return result.result;
      } finally { pageRequests.delete(url.href); }
    }
    if (["page-fetch-read", "page-fetch-cancel"].includes(message.type)) {
      const {task} = await chrome.storage.session.get("task");
      if (task?.id !== message.taskId || task.state !== "downloading") throw new Error("La descarga ya no está activa");
      if (typeof message.requestId !== "string" || !/^[\w-]{36}$/.test(message.requestId)) throw new Error("Petición de vídeo no válida");
      const [result] = await chrome.scripting.executeScript({target: {tabId: task.tabId}, world: "MAIN", func: readYouTubeResponse,
        args: [message.requestId, task.id, message.type === "page-fetch-cancel"]});
      if (!result?.result) throw new Error("YouTube no ha devuelto el fragmento solicitado");
      return result.result;
    }
    if (message.type === "state") {
      const {task} = await chrome.storage.session.get("task");
      if (task?.id !== message.task.id || ["done", "cancelled"].includes(task?.state)) return {};
      if (["error", "cancelled"].includes(message.task.state)) await abortPageRequests(task);
      await chrome.storage.session.set({task: message.task});
      await closeIfIdle();
      return {};
    }
    if (message.type === "save") {
      if (!message.url?.startsWith(`blob:${chrome.runtime.getURL("")}`)) throw new Error("Archivo no permitido");
      const current = (await chrome.storage.session.get("task")).task;
      if (current?.id !== message.taskId || current.state !== "saving") throw new Error("La descarga ya no está activa");
      const downloadId = await chrome.downloads.download({url: message.url, filename: message.filename, saveAs: false});
      const {task} = await chrome.storage.session.get("task");
      await chrome.storage.session.set({task: {...task, downloadId}});
      const [download] = await chrome.downloads.search({id: downloadId});
      if (["complete", "interrupted"].includes(download?.state)) await finishDownload(downloadId, download.state);
      return {downloadId};
    }
    return {};
  }
  if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("Emisor no permitido");
  if (message.type === "cancel") {
    const {task} = await chrome.storage.session.get("task");
    await abortPageRequests(task);
    if (task?.state === "saving" && task.downloadId != null) await chrome.downloads.cancel(task.downloadId);
    const documents = await chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"]});
    if (documents.length) await chrome.runtime.sendMessage({target: "engine", type: "cancel"});
    await chrome.storage.session.set({task: {...task, state: "cancelled", message: "Descarga cancelada", percent: null}});
    await closeIfIdle();
    return {};
  }
  if (!["inspect", "download"].includes(message.type)) throw new Error("Petición no permitida");
  const {task} = await chrome.storage.session.get("task");
  if (["downloading", "merging", "saving"].includes(task?.state)) throw new Error("Ya hay una descarga en curso");
  const tab = await chrome.tabs.get(message.tabId);
  const url = new URL(tab.url);
  if (url.protocol !== "https:" || !["www.youtube.com", "m.youtube.com", "youtube.com", "youtu.be"].includes(url.hostname)) throw new Error("Abre primero un vídeo de YouTube");
  const id = url.hostname === "youtu.be" ? url.pathname.slice(1) : url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/shorts\/([\w-]{11})\/?$/)?.[1];
  if (!/^[\w-]{11}$/.test(id || "") || id !== message.videoId) throw new Error("El vídeo de la pestaña ha cambiado. Abre otra vez el popup");
  if (message.type === "download" && (!Number.isInteger(message.height) || !["mp4", "mkv"].includes(message.container))) throw new Error("Selección no válida");
  const taskId = crypto.randomUUID();
  await chrome.storage.session.set({task: {id: taskId, videoId: id, tabId: message.tabId, state: message.type === "download" ? "downloading" : "loading", message: "Preparando la consulta…", percent: null}});
  try {
    let playerData;
    try {
      const [result] = await chrome.scripting.executeScript({target: {tabId: message.tabId}, world: "MAIN", func: readYouTubePlayer, args: [id]});
      playerData = result?.result || {playerFailure: "El navegador no ha devuelto los datos del reproductor"};
    } catch (error) { playerData = {playerFailure: `No se ha podido acceder a la pestaña: ${error.message}`}; }
    let captures = await playbackCaptures(message.tabId);
    if (message.type === "download" && playerData.page?.streamingData?.serverAbrStreamingUrl && !hasPlaybackCapture(playerData, captures)) {
      const {task: current} = await chrome.storage.session.get("task");
      if (current?.id !== taskId || current.state === "cancelled") return {};
      await chrome.storage.session.set({task: {...current, message: "Recargando YouTube para obtener los datos de reproducción…"}});
      await chrome.tabs.reload(message.tabId);
      const until = Date.now() + 30000;
      do {
        await new Promise(resolve => setTimeout(resolve, 250));
        const {task: active} = await chrome.storage.session.get("task");
        if (active?.id !== taskId || active.state === "cancelled") return {};
        const refreshed = await chrome.tabs.get(message.tabId);
        if (refreshed.url !== tab.url) throw new Error("El vídeo de la pestaña ha cambiado durante la preparación");
        try {
          const [result] = await chrome.scripting.executeScript({target: {tabId: message.tabId}, world: "MAIN", func: readYouTubePlayer, args: [id]});
          if (result?.result?.page?.videoDetails?.videoId === id) playerData = result.result;
        } catch { /* La pestaña puede seguir cambiando de documento durante la recarga */ }
        captures = await playbackCaptures(message.tabId);
        if (hasPlaybackCapture(playerData, captures)) break;
      } while (Date.now() < until);
      if (!hasPlaybackCapture(playerData, captures)) {
        const [diagnostic] = await chrome.scripting.executeScript({target: {tabId: message.tabId}, world: "MAIN", func: () => {
          const state = globalThis[Symbol.for("youtube-local.playback")];
          return state ? `Captura de página activa: GET ${Number(state.get) || 0}, POST ${Number(state.post) || 0}` : "La captura de página no se ha iniciado";
        }});
        throw new Error(`${captures.length ? "Las peticiones recibidas no corresponden a los datos del vídeo que entrega YouTube" : "No se han recibido peticiones compatibles del reproductor tras recargar"}. ${diagnostic?.result || "No se ha podido leer el diagnóstico de la página"}`);
      }
    }
    const page = playerData.page;
    const playback = page?.videoDetails?.videoId === id && page.streamingData?.serverAbrStreamingUrl;
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [1], addRules: [{
      id: 1, priority: 1,
      action: {type: "modifyHeaders", requestHeaders: [
        {header: "origin", operation: "set", value: "https://www.youtube.com"},
        {header: "referer", operation: "set", value: "https://www.youtube.com/"},
        ...(!playback ? [{header: "user-agent", operation: "set", value: "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)"}] : []),
      ]},
      condition: {requestDomains: ["youtube.com", "googlevideo.com"], initiatorDomains: [chrome.runtime.id], resourceTypes: ["xmlhttprequest"]},
    }]});
    await engine();
    const current = (await chrome.storage.session.get("task")).task;
    if (current?.id !== taskId) return {};
    if (current.state === "cancelled") { await chrome.offscreen.closeDocument(); return {}; }
    const response = await chrome.runtime.sendMessage({...message, ...playerData, captures, taskId, target: "engine"});
    if (response?.error) throw new Error(response.error);
    return {};
  } catch (error) {
    const current = (await chrome.storage.session.get("task")).task;
    if (current?.id === taskId && current.state !== "cancelled") await chrome.storage.session.set({task: {...current, state: "error", message: error.message}});
    await closeIfIdle();
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === "engine") return;
  request(message, sender).then(data => respond({data})).catch(error => respond({error: error.message}));
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "popup" || port.sender?.url !== chrome.runtime.getURL("popup.html")) return;
  popups.add(port);
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => { popups.delete(port); closeIfIdle().catch(console.error); });
});

const finishing = new Set();
async function finishDownload(id, downloadState) {
  if (finishing.has(id)) return;
  finishing.add(id);
  try {
    const {task} = await chrome.storage.session.get("task");
    if (task?.downloadId !== id || task.state !== "saving") return;
    const complete = downloadState === "complete";
    await chrome.storage.session.set({task: {...task, state: complete ? "done" : "error", percent: complete ? 100 : null,
      message: complete ? "Archivo guardado en las descargas del navegador" : "El navegador ha interrumpido el guardado"}});
    const documents = await chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"]});
    if (documents.length) await chrome.runtime.sendMessage({target: "engine", type: "release"});
    await closeIfIdle();
  } finally { finishing.delete(id); }
}

chrome.downloads.onChanged.addListener(delta => {
  if (delta.state && ["complete", "interrupted"].includes(delta.state.current)) finishDownload(delta.id, delta.state.current).catch(console.error);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  await captureWrites.get(`playback:${tabId}`);
  await chrome.storage.session.remove(`playback:${tabId}`);
  const {task} = await chrome.storage.session.get("task");
  if (task?.tabId !== tabId || !["loading", "downloading", "merging"].includes(task.state)) return;
  const documents = await chrome.runtime.getContexts({contextTypes: ["OFFSCREEN_DOCUMENT"]});
  if (documents.length) await chrome.runtime.sendMessage({target: "engine", type: "cancel"});
  await chrome.storage.session.set({task: {...task, state: "cancelled", percent: null, message: "Descarga cancelada al cerrar la pestaña de YouTube"}});
  await closeIfIdle();
});
