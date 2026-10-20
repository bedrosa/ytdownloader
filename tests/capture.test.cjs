const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
const script = fs.readFileSync('extension/capture.js', 'utf8');
const url = 'https://r1.googlevideo.com/videoplayback?id=stream';

function setup() {
  const calls = [];
  const response = Promise.resolve('original response');
  class XHR {
    open(...args) { calls.push(['open', ...args]); }
    send(...args) { calls.push(['send', ...args]); return 'original send'; }
  }
  const context = vm.createContext({URL, Request, Blob, ArrayBuffer, Uint8Array, location: {href: 'https://www.youtube.com/watch?v=jNQXAC9IVRw'},
    XMLHttpRequest: XHR, fetch(...args) { calls.push(['fetch', ...args]); return response; }});
  vm.runInContext(script, context);
  return {context, calls, response, state: vm.runInContext('globalThis[Symbol.for("youtube-local.playback")]', context), XHR};
}

test('observa fetch sin modificar sus argumentos, su respuesta ni el buffer enviado', async () => {
  const {context, calls, response, state} = setup();
  const bytes = new Uint8Array([9, 1, 2, 9]);
  const init = {method: 'POST', body: bytes.subarray(1, 3)};
  assert.equal(context.fetch(url, init), response);
  assert.equal(calls[0][2], init);
  assert.deepEqual(Array.from(state.captures[0].body), [1, 2]);
  bytes.fill(0);
  assert.deepEqual(Array.from(state.captures[0].body), [1, 2]);
  vm.runInContext(script, context);
  await context.fetch(url, init);
  assert.equal(state.captures.length, 2);
});

test('observa XMLHttpRequest y conserva el envío original', () => {
  const {XHR, calls, state} = setup();
  const xhr = new XHR();
  const body = new Uint8Array([3, 4]).buffer;
  xhr.open('POST', url, true);
  assert.equal(xhr.send(body), 'original send');
  assert.equal(calls[1][1], body);
  assert.deepEqual(Array.from(state.captures[0].body), [3, 4]);
  xhr.open('GET', url);
  xhr.send();
  assert.equal(state.captures.length, 1);
});

test('lee Request y Blob sin consumir el Request que usa YouTube', async () => {
  const {context, state} = setup();
  const request = new Request(url, {method: 'POST', body: new Uint8Array([5, 6])});
  await context.fetch(request);
  await context.fetch(url, {method: 'POST', body: new Blob([new Uint8Array([7, 8])])});
  for (let n = 0; n < 50 && state.captures.length < 2; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(request.bodyUsed, false);
  assert.equal(state.captures.length, 2);
  assert.deepEqual(Array.from(state.captures, c => Array.from(c.body)).sort().flat(), [5, 6, 7, 8]);
});

test('solo conserva cuatro peticiones de pistas y descarta otros destinos y cuerpos grandes', async () => {
  const {context, state} = setup();
  const init = {method: 'POST', body: new Uint8Array([1])};
  for (const target of ['https://example.com/videoplayback', 'https://r1.googlevideo.com/other', 'http://r1.googlevideo.com/videoplayback']) await context.fetch(target, init);
  await context.fetch(url, {method: 'GET'});
  await context.fetch(url, {method: 'POST', body: new Uint8Array(128 * 1024 + 1)});
  assert.equal(state.captures.length, 0);
  for (let n = 0; n < 6; n++) await context.fetch(url + '&rn=' + n, init);
  assert.equal(state.captures.length, 4);
  assert.ok(state.captures[0].url.endsWith('rn=2'));
});
