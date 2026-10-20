const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const playback = import('../src/playback.js');
const library = import('../vendor/googlevideo.js');
const id = 'i0wdgHcXLJg';
const streamId = 'stream-for-this-video';

function page() {
  return {videoDetails: {videoId: id, title: 'Vídeo de prueba'}, playabilityStatus: {status: 'OK'}, streamingData: {
    serverAbrStreamingUrl: `https://r1.googlevideo.com/videoplayback?id=${streamId}&n=encrypted`,
    adaptiveFormats: [
      {itag: 137, width: 1920, height: 1080, qualityLabel: '1080p', fps: 30, bitrate: 4000000, mimeType: 'video/mp4; codecs="avc1.640028"', contentLength: '72437697', approxDurationMs: '269000', lastModified: '1000'},
      {itag: 140, audioQuality: 'AUDIO_QUALITY_MEDIUM', bitrate: 128000, mimeType: 'audio/mp4; codecs="mp4a.40.2"', contentLength: '4369414', approxDurationMs: '269000', lastModified: '1000'},
      {itag: 999, width: 3840, height: 2160, qualityLabel: '2160p', mimeType: 'video/mp4', drmFamilies: ['WIDEVINE']},
    ],
  }};
}

async function capture(overrides = {}) {
  const {VideoPlaybackAbrRequest} = await library;
  const packet = {initializationFormatIds: [], bufferedRanges: [], selectedAudioFormatIds: [], selectedVideoFormatIds: [], selectedCaptionFormatIds: [], ssapPlaybackInfos: [], field1000: [],
    videoPlaybackUstreamerConfig: new Uint8Array([1, 2, 3]), streamerContext: {clientInfo: {clientName: 1, clientVersion: 'test'}, poToken: new Uint8Array(100).fill(9), sabrContexts: [], unsentSabrContexts: []}, ...overrides.packet};
  return {url: `https://r1.googlevideo.com/videoplayback?id=${streamId}&n=already-deciphered`, time: Date.now(), body: Array.from(VideoPlaybackAbrRequest.encode(packet).finish()), ...overrides};
}

test('obtiene 1080p del reproductor sin exigir URLs directas y descarta DRM', async () => {
  const {playbackInfo} = await playback;
  const info = playbackInfo(page(), id);
  assert.equal(info.protocol, 'sabr');
  assert.deepEqual(info.qualities.map(quality => quality.height), [1080]);
  assert.equal(info.qualities[0].containers.mp4.bytes, 72437697 + 4369414);
  assert.equal(info.formats.length, 2);
  assert.equal(playbackInfo(page(), 'jNQXAC9IVRw'), null);
  const invalid = page();
  invalid.streamingData.serverAbrStreamingUrl = 'https://googlevideo.com.evil.test/videoplayback?id=x';
  assert.throws(() => playbackInfo(invalid, id), /dirección/);
});

test('solo usa la validación reciente del mismo vídeo', async () => {
  const {playbackSession} = await playback;
  const valid = await capture();
  const other = await capture({url: 'https://r1.googlevideo.com/videoplayback?id=another-video'});
  const chosen = playbackSession({streamId}, [valid, other]);
  assert.equal(chosen.url, valid.url);
  assert.equal(chosen.packet.streamerContext.poToken.length, 100);
  assert.throws(() => playbackSession({streamId}, [other]), /no corresponden/);
  assert.throws(() => playbackSession({streamId}, [{...valid, time: Date.now() - 11 * 60 * 1000}]), /caducado/);
});

test('acepta tokens iniciales cortos y distingue las peticiones incompletas', async () => {
  const {playbackSession} = await playback;
  const cold = await capture({packet: {streamerContext: {clientInfo: {clientName: 1}, poToken: new Uint8Array(10), sabrContexts: [], unsentSabrContexts: []}}});
  assert.equal(playbackSession({streamId}, [cold]).packet.streamerContext.poToken.length, 10);
  const incomplete = await capture({packet: {videoPlaybackUstreamerConfig: undefined}});
  assert.throws(() => playbackSession({streamId}, [incomplete]), /configuración/);
  assert.throws(() => playbackSession({streamId}, [{url: 'https://r1.googlevideo.com/videoplayback?id=' + streamId, time: Date.now(), body: [255]}]), /interpretar/);
});

test('no hace peticiones si la descarga ya está cancelada', async () => {
  const {readPlayback} = await playback;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readPlayback({}, [], [], controller.signal, async () => {}, async () => { assert.fail('No debe iniciar la descarga'); }), {name: 'AbortError'});
});

test('descarga ambas pistas por SABR manteniendo los formatos seleccionados', {timeout: 3000}, async () => {
  const {playbackInfo, readPlayback} = await playback;
  const {VideoPlaybackAbrRequest} = await library;
  const info = playbackInfo(page(), id);
  const fixture = Buffer.from(fs.readFileSync('tests/fixtures/sabr-complete.base64', 'utf8').trim(), 'base64');
  let requests = 0;
  let progress = 0;
  const bytes = await readPlayback(info, info.formats, [await capture()], new AbortController().signal, async count => { progress = count; }, async (url, body) => {
    requests++;
    const packet = VideoPlaybackAbrRequest.decode(body);
    assert.equal(new URL(url).hostname, 'r1.googlevideo.com');
    assert.equal(packet.selectedVideoFormatIds[0].itag, 137);
    assert.equal(packet.selectedAudioFormatIds[0].itag, 140);
    return new Response(fixture, {headers: {'content-type': 'application/vnd.yt-ump'}});
  });
  assert.equal(requests, 1);
  assert.equal(progress, 6);
  assert.deepEqual(bytes.map(track => [...track]), [[1, 2, 3], [4, 5, 6]]);
});

test('detiene el rechazo de validación sin reintentos indefinidos', {timeout: 3000}, async () => {
  const {playbackInfo, readPlayback} = await playback;
  const info = playbackInfo(page(), id);
  let requests = 0;
  await assert.rejects(readPlayback(info, info.formats, [await capture()], new AbortController().signal, async () => {}, async () => {
    requests++;
    return new Response(new Uint8Array([58, 2, 8, 3]), {headers: {'content-type': 'application/vnd.yt-ump'}});
  }), /rechazado la validación/);
  assert.equal(requests, 1);
});

test('recoge la validación nueva de la pestaña cuando YouTube deja la inicial pendiente', {timeout: 4000}, async () => {
  const {playbackInfo, readPlayback} = await playback;
  const {VideoPlaybackAbrRequest} = await library;
  const info = playbackInfo(page(), id);
  const cold = await capture({packet: {streamerContext: {clientInfo: {clientName: 1}, poToken: new Uint8Array(10).fill(1), field4: new Uint8Array([7]), field7: 'contexto-del-navegador', sabrContexts: [], unsentSabrContexts: []}}});
  const validated = await capture({packet: {streamerContext: {clientInfo: {clientName: 1}, poToken: new Uint8Array(91).fill(9), field4: new Uint8Array([8]), field7: 'contexto-renovado', sabrContexts: [], unsentSabrContexts: []}}});
  const fixture = Buffer.from(fs.readFileSync('tests/fixtures/sabr-complete.base64', 'utf8').trim(), 'base64');
  let requests = 0;
  let checks = 0;
  const states = [];
  const bytes = await readPlayback(info, info.formats, [cold], new AbortController().signal, async (_, state) => { if (state) states.push(state); }, async (_, body) => {
    const packet = VideoPlaybackAbrRequest.decode(body);
    requests++;
    if (requests === 1) {
      assert.equal(packet.streamerContext.poToken.length, 10);
      assert.equal(packet.streamerContext.field7, 'contexto-del-navegador');
      return new Response(new Uint8Array([58, 2, 8, 2]), {headers: {'content-type': 'application/vnd.yt-ump'}});
    }
    assert.equal(packet.streamerContext.poToken.length, 91);
    assert.deepEqual([...packet.streamerContext.field4], [8]);
    assert.equal(packet.streamerContext.field7, 'contexto-renovado');
    return new Response(fixture, {headers: {'content-type': 'application/vnd.yt-ump'}});
  }, async () => ++checks === 1 ? [cold] : [validated]);
  assert.equal(requests, 2);
  assert.equal(checks, 2);
  assert.ok(states.some(state => state.includes('Esperando la validación')));
  assert.deepEqual(bytes.map(track => [...track]), [[1, 2, 3], [4, 5, 6]]);
});

test('espera una captura que llega después de pulsar descargar y permite cancelar la espera', {timeout: 3000}, async () => {
  const {playbackInfo, readPlayback} = await playback;
  const info = playbackInfo(page(), id);
  const fixture = Buffer.from(fs.readFileSync('tests/fixtures/sabr-complete.base64', 'utf8').trim(), 'base64');
  const valid = await capture();
  let checks = 0;
  const bytes = await readPlayback(info, info.formats, [], new AbortController().signal, async () => {}, async () => new Response(fixture, {headers: {'content-type': 'application/vnd.yt-ump'}}), async () => ++checks === 1 ? [] : [valid]);
  assert.equal(bytes[0].length, 3);
  assert.equal(checks, 2);
  const controller = new AbortController();
  const pending = readPlayback(info, info.formats, [], controller.signal, async () => {}, async () => assert.fail('No debe pedir pistas'), async () => { setTimeout(() => controller.abort(), 10); return []; });
  await assert.rejects(pending, {name: 'AbortError'});
});
