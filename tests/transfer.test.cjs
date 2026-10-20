const assert = require('node:assert/strict');
const {test} = require('node:test');
const transfer = import('../src/transfer.js');

test('renueva un enlace rechazado y descarga exactamente la misma pista', async t => {
  const {readTrack} = await transfer;
  const urls = [];
  let renewals = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    return urls.length === 1 ? new Response(null, {status: 403}) : new Response(new Uint8Array([1, 2, 3]));
  });
  const bytes = await readTrack({url: 'https://r1.googlevideo.com/video?token=old', content_length: 3}, new AbortController().signal, async () => {}, async () => {
    renewals++;
    return {url: 'https://r1.googlevideo.com/video?token=new', content_length: 3};
  });
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(renewals, 1);
  assert.equal(new URL(urls[1]).searchParams.get('token'), 'new');
  assert.equal(new URL(urls[1]).searchParams.get('range'), '0-2');
});

test('mantiene los fragmentos descargados al renovar un enlace a mitad de pista', async t => {
  const {readTrack} = await transfer;
  const size = 4 * 1024 * 1024;
  const ranges = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    ranges.push(new URL(url).searchParams.get('range'));
    calls++;
    if (calls === 1) return new Response(new Uint8Array(size).fill(7));
    if (calls === 2) return new Response(null, {status: 403});
    return new Response(new Uint8Array([8, 9]));
  });
  const bytes = await readTrack({url: 'https://r1.googlevideo.com/video?token=old', content_length: size + 2}, new AbortController().signal, async () => {}, async () => ({url: 'https://r1.googlevideo.com/video?token=new', content_length: size + 2}));
  assert.equal(bytes[0], 7);
  assert.equal(bytes[size - 1], 7);
  assert.deepEqual([...bytes.slice(size)], [8, 9]);
  assert.deepEqual(ranges, [`0-${size - 1}`, `${size}-${size + 1}`, `${size}-${size + 1}`]);
});

test('no reintenta indefinidamente si YouTube mantiene el 403', async t => {
  const {readTrack} = await transfer;
  let renewals = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {status: 403}));
  await assert.rejects(readTrack({url: 'https://r1.googlevideo.com/video', content_length: 3}, new AbortController().signal, async () => {}, async () => {
    renewals++;
    return {url: 'https://r1.googlevideo.com/new', content_length: 3};
  }), /después de renovar/);
  assert.equal(renewals, 1);
});

test('no mezcla fragmentos si la pista cambia de tamaño', async t => {
  const {readTrack} = await transfer;
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {status: 403}));
  await assert.rejects(readTrack({url: 'https://r1.googlevideo.com/video', content_length: 3}, new AbortController().signal, async () => {}, async () => ({url: 'https://r1.googlevideo.com/new', content_length: 4})), /pista ha cambiado/);
});

test('rechaza fragmentos truncados y respeta la cancelación', async t => {
  const {readTrack} = await transfer;
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1])));
  await assert.rejects(readTrack({url: 'https://r1.googlevideo.com/video', content_length: 3}, new AbortController().signal, async () => {}, async () => {}), /pista incompleta/);
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, 'fetch', async (url, init) => { init.signal.throwIfAborted(); });
  await assert.rejects(readTrack({url: 'https://r1.googlevideo.com/video', content_length: 3}, controller.signal, async () => {}, async () => {}), {name: 'AbortError'});
});
