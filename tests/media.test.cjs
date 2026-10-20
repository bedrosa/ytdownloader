const assert = require('node:assert/strict');
const {test} = require('node:test');
const media = import('../src/media.js');

test('reconoce vídeos y Shorts y rechaza otros dominios', async () => {
  const {videoId} = await media;
  for (const url of ['https://www.youtube.com/watch?v=jNQXAC9IVRw&list=123', 'https://youtu.be/jNQXAC9IVRw', 'https://m.youtube.com/shorts/jNQXAC9IVRw']) assert.equal(videoId(url), 'jNQXAC9IVRw');
  for (const url of ['https://www.youtube.com.evil.test/watch?v=jNQXAC9IVRw', 'http://youtube.com/watch?v=jNQXAC9IVRw', 'https://youtube.com/playlist?list=123', 'https://youtube.com/watch?v=invalid', undefined]) assert.equal(videoId(url), null);
});

const video = {has_video: true, has_audio: false, height: 1080, fps: 30, bitrate: 1000, content_length: 100, mime_type: 'video/mp4', url: 'https://r1.googlevideo.com/videoplayback?itag=137'};
const audio = {has_video: false, has_audio: true, bitrate: 100, content_length: 20, mime_type: 'audio/mp4', is_original: true, url: 'https://r1.googlevideo.com/videoplayback?itag=140'};

test('descarta DRM, pistas cifradas y destinos que no son de YouTube', async () => {
  const {playable} = await media;
  assert.deepEqual(playable([video, {...video, drm_families: ['widevine']}, {...video, url: null}, {...video, url: 'https://evil.test/v'}, {...video, url: video.url + '&n=encrypted'}, {...video, is_type_otf: true}]), [video]);
});

test('mantiene la resolución exacta y exige audio', async () => {
  const {selectTracks} = await media;
  assert.deepEqual(selectTracks([video, audio], 1080, 'mp4'), [video, audio]);
  assert.throws(() => selectTracks([video, audio], 2160, 'mp4'), /resolución/);
  assert.throws(() => selectTracks([video], 1080, 'mp4'), /audio/);
  assert.throws(() => selectTracks([video, audio], '1080', 'mp4'), /Selección/);
});

test('MP4 usa pistas compatibles y MKV permite vídeo WebM', async () => {
  const {selectTracks, choices} = await media;
  const webm = {...video, height: 2160, mime_type: 'video/webm'};
  assert.throws(() => selectTracks([webm, audio], 2160, 'mp4'));
  assert.deepEqual(selectTracks([webm, audio], 2160, 'mkv'), [webm, audio]);
  const options = choices([video, audio, webm]);
  assert.deepEqual(options.map(item => item.height), [2160, 1080]);
  assert.equal(options[0].containers.mp4, undefined);
  assert.equal(options[1].containers.mp4.bytes, 120);
});

test('elige fps superiores a la misma altura y prioriza audio original', async () => {
  const {selectTracks} = await media;
  const fast = {...video, fps: 60};
  const dub = {...audio, is_original: false, bitrate: 200};
  assert.deepEqual(selectTracks([video, fast, dub, audio], 1080, 'mp4'), [fast, audio]);
});

test('conserva las pistas ya combinadas y limpia nombres de archivo', async () => {
  const {selectTracks, filename} = await media;
  const combined = {...video, has_audio: true};
  assert.deepEqual(selectTracks([combined], 1080, 'mp4'), [combined]);
  assert.equal(filename('../Vídeo: prueba?', 'jNQXAC9IVRw', 1080, 'mp4'), '.._Vídeo_ prueba_ [jNQXAC9IVRw] 1080p.mp4');
});
