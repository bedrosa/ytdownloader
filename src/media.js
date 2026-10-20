export function videoId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname)) return null;
    const id = url.hostname === "youtu.be" ? url.pathname.slice(1) : url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/shorts\/([\w-]{11})\/?$/)?.[1];
    return /^[\w-]{11}$/.test(id || "") ? id : null;
  } catch { return null; }
}

export function playable(formats) {
  return formats.filter(format => {
    if (!format.url || format.is_type_otf || format.drm_families?.length || format.drm_track_type) return false;
    try {
      const url = new URL(format.url);
      return url.protocol === "https:" && url.hostname.endsWith(".googlevideo.com") && !url.searchParams.has("n");
    } catch { return false; }
  });
}

export function selectTracks(formats, height, container) {
  if (!Number.isInteger(height) || !["mp4", "mkv"].includes(container)) throw new Error("Selección no válida");
  const video = formats.filter(f => f.has_video && f.height === height && (container !== "mp4" || f.mime_type.startsWith("video/mp4")))
    .sort((a, b) => (b.fps || 0) - (a.fps || 0) || (b.bitrate || 0) - (a.bitrate || 0))[0];
  if (!video) throw new Error("La resolución elegida no está disponible en este formato");
  if (video.has_audio) return [video];
  const audio = formats.filter(f => f.has_audio && !f.has_video && (container !== "mp4" || f.mime_type.startsWith("audio/mp4")))
    .sort((a, b) => Number(Boolean(b.audio_track?.audio_is_default || b.is_original)) - Number(Boolean(a.audio_track?.audio_is_default || a.is_original)) || (b.bitrate || 0) - (a.bitrate || 0))[0];
  if (!audio) throw new Error("No hay una pista de audio compatible con el formato elegido");
  return [video, audio];
}

export function choices(formats) {
  return [...new Set(formats.filter(f => f.has_video && f.height).map(f => f.height))].sort((a, b) => b - a).flatMap(height => {
    const containers = {};
    for (const container of ["mp4", "mkv"]) {
      try {
        const tracks = selectTracks(formats, height, container);
        const known = tracks.every(track => track.content_length > 0);
        containers[container] = {bytes: known ? tracks.reduce((sum, track) => sum + track.content_length, 0) : null, fps: tracks[0].fps || 0};
      } catch { /* Esta resolución no tiene pistas compatibles con este contenedor */ }
    }
    return Object.keys(containers).length ? [{height, containers}] : [];
  });
}

export function filename(title, id, height, container) {
  const name = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").trim().slice(0, 120) || "Vídeo";
  return `${name} [${id}] ${height}p.${container}`;
}
