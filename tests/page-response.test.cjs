const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createHash, webcrypto} = require('node:crypto');
const {test} = require('node:test');

function setup(body, status = 200) {
  const event = {addListener() {}};
  const page = vm.createContext({URL, Map, Set, Uint8Array, AbortController, crypto: webcrypto, btoa, setTimeout, clearTimeout,
    location: {href: 'https://www.youtube.com/watch?v=jNQXAC9IVRw'}, fetch: async () => new Response(body, {status}),
    chrome: {webRequest: {onBeforeRequest: event}, runtime: {onMessage: event, onConnect: event}, downloads: {onChanged: event}, tabs: {onRemoved: event}}});
  vm.runInContext(fs.readFileSync('extension/background.js', 'utf8'), page);
  const messages = [];
  globalThis.chrome = {runtime: {sendMessage: async message => {
    messages.push(message.type);
    const data = message.type === 'page-fetch'
      ? await page.fetchFromYouTube(message.url, message.body, 'jNQXAC9IVRw', message.taskId)
      : await page.readYouTubeResponse(message.requestId, message.taskId, message.type === 'page-fetch-cancel');
    const json = JSON.stringify({data});
    if (Buffer.byteLength(json) > 64 * 1024 * 1024) throw new Error('Message exceeded maximum allowed size of 64MiB.');
    setup.largestMessage = Math.max(setup.largestMessage, Buffer.byteLength(json));
    return JSON.parse(json);
  }}};
  setup.largestMessage = 0;
  return {messages, pending: () => vm.runInContext('globalThis[Symbol.for("youtube-local.fetches")]?.size || 0', page)};
}

test('transfiere una respuesta mayor de 64 MiB sin enviar mensajes grandes ni perder bytes', async () => {
  const {fetchPlayback} = await import('../src/page-response.js');
  const source = new Uint8Array(80 * 1024 * 1024 + 37).fill(211);
  const {pending, messages} = setup(source);
  const response = await fetchPlayback('https://r1.googlevideo.com/videoplayback?id=stream', new Uint8Array([1]), 'task', new AbortController().signal);
  const output = new Uint8Array(await response.arrayBuffer());
  assert.equal(output.length, source.length);
  assert.equal(createHash('sha256').update(output).digest('hex'), createHash('sha256').update(source).digest('hex'));
  assert.ok(setup.largestMessage < 2 * 1024 * 1024);
  assert.ok(messages.filter(type => type === 'page-fetch-read').length > 80);
  assert.equal(pending(), 0);
});

test('cancelar libera el lector y las peticiones de la página', async () => {
  const {fetchPlayback} = await import('../src/page-response.js');
  let cancelled = false;
  const {pending} = setup(new ReadableStream({pull(controller) { controller.enqueue(new Uint8Array([1, 2])); }, cancel() { cancelled = true; }}));
  const response = await fetchPlayback('https://r1.googlevideo.com/videoplayback?id=stream', new Uint8Array([1]), 'task', new AbortController().signal);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(pending(), 0);
});

test('abortar detiene la lectura y libera la respuesta de origen', async () => {
  const {fetchPlayback} = await import('../src/page-response.js');
  const {pending} = setup(new Uint8Array(2 * 1024 * 1024));
  const controller = new AbortController();
  const response = await fetchPlayback('https://r1.googlevideo.com/videoplayback?id=stream', new Uint8Array([1]), 'task', controller.signal);
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read(), {name: 'AbortError'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending(), 0);
});

test('propaga el error de lectura y conserva los estados HTTP del servidor', async () => {
  const {fetchPlayback} = await import('../src/page-response.js');
  const {pending} = setup(new ReadableStream({start(controller) { controller.error(new Error('Conexión interrumpida')); }}));
  const response = await fetchPlayback('https://r1.googlevideo.com/videoplayback?id=stream', new Uint8Array([1]), 'task', new AbortController().signal);
  await assert.rejects(response.arrayBuffer(), /Conexión interrumpida/);
  assert.equal(pending(), 0);
  setup(new Uint8Array([1, 2]), 403);
  const rejected = await fetchPlayback('https://r1.googlevideo.com/videoplayback?id=stream', new Uint8Array([1]), 'task', new AbortController().signal);
  assert.equal(rejected.status, 403);
  assert.deepEqual(Array.from(new Uint8Array(await rejected.arrayBuffer())), [1, 2]);
});
