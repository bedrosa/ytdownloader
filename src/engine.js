import {Innertube, Constants} from "youtubei.js/web";
import {FFmpeg} from "@ffmpeg/ffmpeg";
import {choices, playable, selectTracks, filename} from "./media.js";
import {readTrack} from "./transfer.js";
import {playbackInfo, readPlayback} from "./playback.js";
import {fetchPlayback} from "./page-response.js";

let session;
let state;
let busy = false;
let operation = 0;
let controller;
let ffmpeg;
let blobUrl;

async function publish(values) {
  state = {...state, ...values};
  const response = await chrome.runtime.sendMessage({target: "background", type: "state", task: state});
  if (response?.error) throw new Error(response.error);
}

async function info(id, signal, page) {
  const playback = playbackInfo(page, id);
  if (playback) return playback;
  session ||= await Innertube.create({
    retrieve_player: false, generate_session_locally: true, lang: "es", location: "ES",
    user_agent: Constants.CLIENTS.IOS.USER_AGENT,
    fetch: (input, init) => globalThis.fetch(input, {...init, cache: "no-store", credentials: "omit", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])}),
  });
  const video = await session.getBasicInfo(id, {client: "IOS"});
  signal.throwIfAborted();
  if (video.playability_status?.status !== "OK") throw new Error(video.playability_status?.reason || "YouTube no permite descargar este vídeo");
  if (video.basic_info.is_live) throw new Error("Los directos en curso no están admitidos");
  const formats = playable([...(video.streaming_data?.formats || []), ...(video.streaming_data?.adaptive_formats || [])]);
  const qualities = choices(formats);
  if (!qualities.length) throw new Error("YouTube no ha ofrecido pistas directas descargables para este vídeo");
  return {id, title: video.basic_info.title, formats, qualities};
}

async function run(message) {
  busy = true;
  const version = ++operation;
  controller = new AbortController();
  const signal = controller.signal;
  state = {id: message.taskId, videoId: message.videoId, tabId: message.tabId};
  try {
    await publish({state: message.type === "inspect" ? "loading" : "downloading", message: "Consultando las calidades de YouTube…", percent: null});
    const video = await info(message.videoId, signal, message.page);
    signal.throwIfAborted();
    await publish({title: video.title, qualities: video.qualities, method: video.protocol === "sabr" ? "player" : "direct"});
    if (message.type === "inspect") {
      await publish({state: "ready", message: "Elige la calidad. El audio se incluye en el archivo"});
      return;
    }
    const tracks = selectTracks(video.formats, message.height, message.container);
    const total = tracks.reduce((sum, track) => sum + (track.content_length || 0), 0);
    let buffers = [];
    let downloaded = 0;
    if (video.protocol === "sabr") {
      await publish({message: "Descargando desde la reproducción de YouTube…", percent: 0});
      buffers = await readPlayback(video, tracks, message.captures, signal, async (count, message) => {
        await publish({...(message ? {message} : {}), percent: count != null && total ? Math.min(99, Math.round(count * 100 / total)) : null});
      }, (url, body) => fetchPlayback(url, body, state.id, signal), async () => {
        signal.throwIfAborted();
        const response = await chrome.runtime.sendMessage({target: "background", type: "playback-captures", taskId: state.id});
        signal.throwIfAborted();
        if (response?.error) throw new Error(response.error);
        return response?.data || [];
      });
    } else for (const track of tracks) {
      await publish({message: track.has_video ? "Descargando vídeo…" : "Descargando audio…", percent: Math.round(downloaded * 100 / total)});
      buffers.push(await readTrack(track, signal, async offset => { await publish({percent: Math.round((downloaded + offset) * 100 / total)}); }, async () => {
        await publish({message: "Renovando el enlace de descarga…"});
        const refreshed = await info(message.videoId, signal);
        const renewed = refreshed.formats.find(format => format.itag === track.itag && format.audio_track?.id === track.audio_track?.id);
        await publish({message: track.has_video ? "Descargando vídeo…" : "Descargando audio…"});
        return renewed;
      }));
      downloaded += buffers.at(-1).byteLength;
    }
    signal.throwIfAborted();
    await publish({state: "merging", message: "Uniendo las pistas en el navegador…", percent: null});
    ffmpeg = new FFmpeg();
    await ffmpeg.load({classWorkerURL: chrome.runtime.getURL("vendor/ffmpeg/worker.js"), coreURL: chrome.runtime.getURL("vendor/core/ffmpeg-core.js"), wasmURL: chrome.runtime.getURL("vendor/core/ffmpeg-core.wasm")});
    signal.throwIfAborted();
    const args = [];
    for (let index = 0; index < buffers.length; index++) {
      await ffmpeg.writeFile(`input${index}`, buffers[index]);
      buffers[index] = null;
      args.push("-i", `input${index}`);
    }
    const output = `output.${message.container}`;
    const code = await ffmpeg.exec([...args, "-map", "0:v:0", "-map", tracks.length > 1 ? "1:a:0" : "0:a:0", "-c", "copy", output]);
    if (code !== 0) throw new Error("No se ha podido unir el archivo. Prueba el formato MKV");
    const file = await ffmpeg.readFile(output);
    ffmpeg.terminate();
    ffmpeg = null;
    signal.throwIfAborted();
    blobUrl = URL.createObjectURL(new Blob([file], {type: message.container === "mp4" ? "video/mp4" : "video/x-matroska"}));
    const name = filename(video.title, message.videoId, message.height, message.container);
    await publish({state: "saving", filename: name, message: "Guardando el archivo…", percent: null});
    const response = await chrome.runtime.sendMessage({target: "background", type: "save", taskId: state.id, url: blobUrl, filename: name});
    if (response?.error) throw new Error(response.error);
  } catch (error) {
    if (version !== operation) return;
    session = null;
    const detail = error.message.includes("HTTP 403") && message.playerFailure ? `${error.message}. Lectura del reproductor: ${message.playerFailure}` : error.message;
    await publish({state: signal.aborted ? "cancelled" : "error", message: signal.aborted ? "Descarga cancelada" : detail, percent: null});
  } finally {
    if (version === operation) { busy = false; ffmpeg?.terminate(); ffmpeg = null; }
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "engine" || sender.id !== chrome.runtime.id) return;
  if (["cancel", "release"].includes(message.type)) {
    operation++;
    controller?.abort();
    ffmpeg?.terminate();
    ffmpeg = null;
    busy = false;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = null;
    respond({});
    return;
  }
  if (busy) { respond({error: "Ya hay una operación en curso"}); return; }
  if (!["inspect", "download"].includes(message.type)) return;
  run(message);
  respond({});
});
