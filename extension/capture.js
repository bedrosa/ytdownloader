(() => {
  const key = Symbol.for("youtube-local.playback");
  if (globalThis[key]) return;
  const state = {captures: [], get: 0, post: 0, fetch: globalThis.fetch};
  globalThis[key] = state;
  const requests = new WeakMap();
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;

  async function capture(input, method, body) {
    const url = new URL(input, location.href);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".googlevideo.com") || url.pathname !== "/videoplayback") return;
    if (method.toUpperCase() === "GET") state.get++;
    if (method.toUpperCase() !== "POST") return;
    state.post++;
    if (body instanceof Request) body = await body.clone().arrayBuffer();
    if (body instanceof Blob) {
      if (body.size > 128 * 1024) return;
      body = await body.arrayBuffer();
    }
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : null;
    if (!bytes?.length || bytes.length > 128 * 1024) return;
    state.captures.push({url: url.href, body: Array.from(bytes), time: Date.now()});
    state.captures = state.captures.slice(-4);
  }

  globalThis.fetch = function(input, init) {
    try {
      const request = input instanceof Request;
      capture(request ? input.url : String(input), init?.method || (request ? input.method : "GET"),
        init?.body ?? (request ? input : null)).catch(() => {});
    } catch { /* La observación no debe impedir las peticiones de YouTube */ }
    return Reflect.apply(state.fetch, this, arguments);
  };
  XMLHttpRequest.prototype.open = function(method, url) {
    const result = Reflect.apply(open, this, arguments);
    requests.set(this, {method: String(method), url: String(url)});
    return result;
  };
  XMLHttpRequest.prototype.send = function(body) {
    const request = requests.get(this);
    if (request) capture(request.url, request.method, body).catch(() => {});
    return Reflect.apply(send, this, arguments);
  };
})();
