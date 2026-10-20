export async function readTrack(track, signal, report, renew) {
  const total = track.content_length;
  if (!(total > 0)) throw new Error("YouTube no anuncia el tamaño de esta pista y no se puede descargar de forma completa");
  const bytes = new Uint8Array(total);
  let renewed = false;
  for (let offset = 0; offset < total;) {
    const end = Math.min(offset + 4 * 1024 * 1024, total) - 1;
    const url = new URL(track.url);
    url.searchParams.set("range", `${offset}-${end}`);
    const response = await fetch(url, {signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), credentials: "omit"});
    if (response.status === 403 && !renewed) {
      renewed = true;
      track = await renew();
      if (!track || track.content_length !== total) throw new Error("La pista ha cambiado al renovar el enlace. Consulta de nuevo el vídeo");
      continue;
    }
    if (response.status === 403) throw new Error("YouTube sigue rechazando esta pista (HTTP 403) después de renovar el enlace. El método actual de la extensión no ha podido descargar este vídeo");
    if (!response.ok) throw new Error(`YouTube ha rechazado la pista (HTTP ${response.status}). Consulta de nuevo el vídeo`);
    const chunk = new Uint8Array(await response.arrayBuffer());
    if (chunk.length !== end - offset + 1) throw new Error("YouTube ha devuelto una pista incompleta. Vuelve a consultar el vídeo");
    bytes.set(chunk, offset);
    offset += chunk.length;
    await report(offset, total);
  }
  return bytes;
}
