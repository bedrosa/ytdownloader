export async function fetchPlayback(url, body, taskId, signal) {
  signal.throwIfAborted();
  const response = await chrome.runtime.sendMessage({target: "background", type: "page-fetch", taskId, url, body: Array.from(body)});
  if (response?.error) throw new Error(response.error);
  const result = response?.data;
  if (!result?.requestId) throw new Error("No se ha recibido la respuesta del reproductor de YouTube");
  let finished = false;
  const cancel = async () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", abort);
    await chrome.runtime.sendMessage({target: "background", type: "page-fetch-cancel", taskId, requestId: result.requestId}).catch(() => {});
  };
  const abort = () => { cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, {once: true});
  if (signal.aborted) { await cancel(); signal.throwIfAborted(); }
  if ([204, 205, 304].includes(result.status)) {
    await cancel();
    return new Response(null, {status: result.status, headers: result.headers});
  }
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const reply = await chrome.runtime.sendMessage({target: "background", type: "page-fetch-read", taskId, requestId: result.requestId});
        signal.throwIfAborted();
        if (reply?.error) throw new Error(reply.error);
        if (!reply?.data) throw new Error("No se ha recibido el fragmento del reproductor de YouTube");
        if (reply.data.done) {
          finished = true;
          signal.removeEventListener("abort", abort);
          controller.close();
        } else controller.enqueue(Uint8Array.from(atob(reply.data.data), value => value.charCodeAt(0)));
      } catch (error) {
        await cancel();
        controller.error(error);
      }
    },
    cancel,
  }, {highWaterMark: 0}), {status: result.status, headers: result.headers});
}
