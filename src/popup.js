import {videoId} from "./media.js";

const $ = selector => document.querySelector(selector);
let port;
let heartbeat;
let reconnectTimer;
let reconnects = 0;
let closing = false;
let tab;
let current;
let task;
const version = chrome.runtime.getManifest().version;
$("#version").textContent = `v${version}`;

function disconnectPopup(connection) {
  void chrome.runtime.lastError;
  if (port !== connection) return;
  clearInterval(heartbeat);
  port = null;
  if (closing) return;
  if (reconnects++ < 2) reconnectTimer = setTimeout(connectPopup, 250);
  else showError(new Error("Se ha perdido la conexión con la extensión. Cierra este popup y vuelve a abrirlo"));
}

function connectPopup() {
  if (closing) return;
  try {
    const connection = chrome.runtime.connect({name: "popup"});
    port = connection;
    connection.onDisconnect.addListener(() => disconnectPopup(connection));
    heartbeat = setInterval(() => {
      try { connection.postMessage({type: "open"}); reconnects = 0; }
      catch { disconnectPopup(connection); }
    }, 20000);
  } catch {
    showError(new Error("La extensión se ha actualizado o desconectado. Cierra este popup y vuelve a abrirlo"));
  }
}

connectPopup();
addEventListener("pagehide", () => {
  closing = true;
  clearInterval(heartbeat);
  clearTimeout(reconnectTimer);
  try { port?.disconnect(); } catch { /* El navegador ya puede haber cerrado el puerto */ }
  port = null;
}, {once: true});

async function command(type, data = {}) {
  const response = await chrome.runtime.sendMessage({target: "background", type, videoId: current, tabId: tab?.id, ...data});
  if (response?.error) throw new Error(response.error);
}

function showError(error) {
  $("#status").textContent = error.message;
  $("#status").classList.add("error");
  $("#retry").hidden = !current;
}

function updateSize() {
  const quality = task?.qualities?.find(item => item.height === Number($("#quality").value));
  for (const option of $("#container").options) option.disabled = !quality?.containers[option.value];
  if (!quality?.containers[$("#container").value]) $("#container").value = "mkv";
  const info = quality?.containers[$("#container").value];
  $("#size").textContent = info?.bytes ? `${(info.bytes / 1024 / 1024).toFixed(1)} MB de pistas` : "Tamaño no anunciado por YouTube";
  $("#download").disabled = !info;
}

function render(value) {
  task = value;
  if (!task) return;
  $("#version").textContent = `v${version}${task.method ? ` · ${task.method === "player" ? "Reproductor de YouTube" : "Consulta directa"}` : ""}`;
  const busy = ["loading", "downloading", "merging", "saving"].includes(task.state);
  $("#title").textContent = task.title || "Consultando el vídeo…";
  $("#status").textContent = task.message + (task.percent != null && busy ? ` ${task.percent}%` : "");
  $("#status").classList.toggle("error", task.state === "error");
  $("#progress").hidden = !busy;
  if (task.percent != null) $("#progress").value = task.percent;
  else $("#progress").removeAttribute("value");
  $("#cancel").hidden = !busy;
  $("#retry").hidden = busy || !current;
  $("#show").hidden = task.state !== "done" || task.downloadId == null;
  $("#fields").hidden = busy || !task.qualities?.length || task.videoId !== current;
  if (!$("#fields").hidden) {
    const selected = $("#quality").value;
    $("#quality").replaceChildren(...task.qualities.map(quality => {
      const option = document.createElement("option");
      option.value = quality.height;
      const fps = Math.max(...Object.values(quality.containers).map(item => item.fps));
      option.textContent = `${quality.height}p${fps > 30 ? ` · hasta ${fps} fps` : ""}`;
      return option;
    }));
    if ([...$("#quality").options].some(option => option.value === selected)) $("#quality").value = selected;
    updateSize();
  }
}

$("#download").addEventListener("click", async () => {
  $("#download").disabled = true;
  try { await command("download", {height: Number($("#quality").value), container: $("#container").value}); }
  catch (error) { showError(error); updateSize(); }
});
$("#retry").addEventListener("click", () => command("inspect").catch(showError));
$("#cancel").addEventListener("click", () => command("cancel").catch(showError));
$("#quality").addEventListener("change", updateSize);
$("#container").addEventListener("change", updateSize);
$("#folder").addEventListener("click", () => chrome.downloads.showDefaultFolder());
$("#show").addEventListener("click", () => chrome.downloads.show(task.downloadId));
chrome.storage.onChanged.addListener((changes, area) => { if (area === "session" && changes.task) render(changes.task.newValue); });

try {
  [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  current = videoId(tab?.url);
  const stored = await chrome.storage.session.get("task");
  if (["loading", "downloading", "merging", "saving"].includes(stored.task?.state)) render(stored.task);
  else if (current) {
    if (stored.task?.videoId === current) render(stored.task);
    await command("inspect");
  } else {
    if (stored.task?.state === "done") render(stored.task);
    $("#status").textContent = "Abre un vídeo o Short de YouTube y vuelve a pulsar el icono de la extensión";
  }
} catch (error) { showError(error); }
