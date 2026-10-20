import {Parser} from "youtubei.js/web";
import {SabrStream, buildSabrFormat, VideoPlaybackAbrRequest, Logger, LogLevel, u8ToBase64} from "../vendor/googlevideo.js";
import {choices} from "./media.js";

Logger.getInstance().setLogLevels(LogLevel.NONE);

export function playbackInfo(page, id) {
  if (page?.videoDetails?.videoId !== id || !page.streamingData?.serverAbrStreamingUrl) return null;
  if (page.playabilityStatus?.status !== "OK") throw new Error("YouTube no permite reproducir este vídeo en la pestaña");
  if (page.videoDetails.isLive) throw new Error("Los directos en curso no están admitidos");
  const url = new URL(page.streamingData.serverAbrStreamingUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".googlevideo.com") || !url.searchParams.get("id")) throw new Error("La dirección del reproductor no es válida");
  const parsed = Parser.parseResponse(page);
  const formats = (parsed.streaming_data?.adaptive_formats || []).filter(format => !format.drm_families?.length && !format.drm_track_type && !format.is_type_otf);
  const qualities = choices(formats);
  if (!qualities.length) return null;
  return {id, title: page.videoDetails.title || "Vídeo", formats, qualities, protocol: "sabr", streamId: url.searchParams.get("id"), postLive: Boolean(page.videoDetails.isPostLiveDvr)};
}

export function playbackSession(video, captures) {
  let reason = "No se han recibido peticiones de reproducción de esta pestaña";
  for (const capture of [...(captures || [])].reverse()) {
    try {
      const url = new URL(capture.url);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".googlevideo.com") || url.searchParams.get("id") !== video.streamId) { reason = "Las peticiones capturadas no corresponden al vídeo actual"; continue; }
      if (Date.now() - capture.time > 10 * 60 * 1000) { reason = "Las peticiones de reproducción han caducado"; continue; }
      const packet = VideoPlaybackAbrRequest.decode(Uint8Array.from(capture.body));
      if (!packet.streamerContext?.clientInfo || !packet.videoPlaybackUstreamerConfig?.length) { reason = "La petición no contiene la configuración necesaria para descargar"; continue; }
      return {url: url.href, packet};
    } catch { reason = "No se ha podido interpretar la petición de reproducción"; }
  }
  throw new Error(`${reason}. No se puede iniciar la descarga desde el reproductor`);
}

async function waitForPlaybackSession(video, signal, readCaptures, previousToken) {
  const until = Date.now() + 15000;
  let failure;
  do {
    signal.throwIfAborted();
    try {
      const session = playbackSession(video, await readCaptures());
      const token = session.packet.streamerContext.poToken;
      if (previousToken == null || token?.length && u8ToBase64(token) !== previousToken) return session;
    } catch (error) { failure = error; }
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, 250);
      signal.addEventListener("abort", done, {once: true});
      if (signal.aborted) done();
    });
  } while (Date.now() < until);
  signal.throwIfAborted();
  throw previousToken == null && failure ? failure : new Error("YouTube ha solicitado otra validación y el reproductor no la ha entregado en 15 segundos. La descarga se ha detenido");
}

export async function readPlayback(video, tracks, captures, signal, report, fetchPage, readCaptures) {
  signal.throwIfAborted();
  let session;
  try { session = playbackSession(video, captures); }
  catch (error) {
    if (!readCaptures) throw error;
    await report(null, "Esperando los datos de reproducción de YouTube…");
    session = await waitForPlaybackSession(video, signal, readCaptures);
    await report(null, "Descargando desde la reproducción de YouTube…");
  }
  let context = session.packet.streamerContext;
  let validationError;
  let refreshRequired = false;
  const stream = new SabrStream({
    videoId: video.id, formats: tracks.map(buildSabrFormat), serverAbrStreamingUrl: session.url,
    videoPlaybackUstreamerConfig: u8ToBase64(session.packet.videoPlaybackUstreamerConfig),
    poToken: context.poToken?.length ? u8ToBase64(context.poToken) : undefined, clientInfo: context.clientInfo,
    fetchFunction: async (url, init) => {
      signal.throwIfAborted();
      if (refreshRequired) {
        if (!readCaptures) throw new Error("YouTube solicita una validación nueva que el reproductor no ha proporcionado");
        await report(null, "Esperando la validación del reproductor de YouTube…");
        const previousToken = context.poToken?.length ? u8ToBase64(context.poToken) : "";
        const next = await waitForPlaybackSession(video, signal, readCaptures, previousToken);
        context = next.packet.streamerContext;
        refreshRequired = false;
        await report(null, "Descargando desde la reproducción de YouTube…");
      }
      const body = VideoPlaybackAbrRequest.decode(init.body);
      const current = body.streamerContext;
      body.streamerContext = {...context, ...current, poToken: context.poToken,
        field4: context.field4, field7: context.field7, field8: context.field8,
        playbackCookie: current.playbackCookie?.length ? current.playbackCookie : context.playbackCookie,
        sabrContexts: [...context.sabrContexts.filter(old => !current.sabrContexts.some(item => item.type === old.type)), ...current.sabrContexts]};
      return fetchPage(String(url), VideoPlaybackAbrRequest.encode(body).finish());
    },
  });
  stream.on("streamProtectionStatusUpdate", status => {
    if (status.status === 2) refreshRequired = true;
    if (status.status === 3) {
      validationError = new Error("YouTube ha rechazado la validación que usa esta descarga. El método de la extensión no puede descargar este vídeo en esta sesión");
      throw validationError;
    }
  });
  const abort = () => { stream.abort().catch(() => {}); };
  signal.addEventListener("abort", abort, {once: true});
  try {
    const {videoStream, audioStream, selectedFormats} = stream.start({videoFormat: buildSabrFormat(tracks[0]), audioFormat: buildSabrFormat(tracks[1]), maxRetries: 0, stallDetectionMs: 10000, isPostLiveDvr: video.postLive});
    if (selectedFormats.videoFormat?.height !== tracks[0].height) throw new Error("YouTube no ha mantenido la calidad seleccionada");
    let downloaded = 0;
    const buffers = await Promise.all([videoStream, audioStream].map(async source => {
      const chunks = [];
      const reader = source.getReader();
      let size = 0;
      for (;;) {
        const {value, done} = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        chunks.push(bytes);
        size += bytes.length;
        downloaded += bytes.length;
        await report(downloaded);
      }
      if (!size) throw new Error("YouTube no ha entregado una pista completa");
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
      return output;
    }));
    return buffers;
  } catch (error) {
    await stream.abort().catch(() => {});
    signal.throwIfAborted();
    throw validationError || error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
