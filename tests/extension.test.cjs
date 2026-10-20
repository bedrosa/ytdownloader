const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

function setup(environment = {}) {
  const events = {};
  const state = {documents: [], task: null, sent: [], closed: 0, stored: {}, rules: null};
  const event = name => ({addListener(listener) { events[name] = listener; }});
  const chrome = {
    runtime: {
      id: 'test-id', getURL: path => 'chrome-extension://test-id/' + path,
      getContexts: async () => state.documents,
      onMessage: event('message'), onConnect: event('connect'),
      sendMessage: async message => { state.sent.push(message); return {}; },
    },
    offscreen: {createDocument: async () => { state.documents = [{}]; }, closeDocument: async () => { state.documents = []; state.closed++; }},
    storage: {session: {get: async () => ({...state.stored, task: state.task}), set: async value => { if ('task' in value) state.task = value.task; Object.assign(state.stored, value); }, remove: async key => { delete state.stored[key]; }}},
    tabs: {get: async () => ({url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw'}), onRemoved: event('tabRemoved')},
    downloads: {onChanged: event('downloadChanged')},
    declarativeNetRequest: {updateSessionRules: async rules => { state.rules = rules; }},
    webRequest: {onBeforeRequest: event('webRequest')},
    scripting: {executeScript: async () => []},
  };
  const context = {chrome, URL, Set, Uint8Array, console, setTimeout, crypto: require('node:crypto'), ...environment};
  vm.runInNewContext(fs.readFileSync('extension/background.js', 'utf8'), context);
  const send = (message, sender = {url: chrome.runtime.getURL('popup.html')}) => new Promise(resolve => events.message(message, sender, resolve));
  function popup() {
    let disconnect;
    events.connect({name: 'popup', sender: {url: chrome.runtime.getURL('popup.html')}, onMessage: {addListener() {}}, onDisconnect: {addListener(listener) { disconnect = listener; }}});
    return async () => { disconnect(); await new Promise(resolve => setImmediate(resolve)); };
  }
  return {events, state, send, popup, chrome, readPlayer: id => context.readYouTubePlayer(id)};
}

test('la extensión solo usa el popup y no necesita localhost ni programas nativos', () => {
  const manifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.deepEqual(manifest.content_scripts[0].js, ['capture.js']);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(manifest.permissions.includes('nativeMessaging'), false);
  assert.equal(manifest.host_permissions.some(host => host.includes('127.0.0.1')), false);
});

test('arranca el procesamiento al pedirlo desde el popup', async () => {
  const {state, send} = setup();
  assert.equal(state.documents.length, 0);
  const result = await send({type: 'inspect', videoId: 'jNQXAC9IVRw', tabId: 1});
  assert.ok(result.data);
  assert.equal(state.documents.length, 1);
  assert.equal(state.sent[0].target, 'engine');
  assert.equal(state.sent[0].type, 'inspect');
});

test('rechaza órdenes de páginas web y vídeos que ya no coinciden con la pestaña', async () => {
  const {state, send} = setup();
  assert.match((await send({type: 'inspect'}, {url: 'https://www.youtube.com/'})).error, /Emisor/);
  assert.match((await send({type: 'inspect', videoId: 'aqz-KE-bpKQ', tabId: 1})).error, /cambiado/);
  assert.equal(state.documents.length, 0);
});

test('cerrar el popup libera una consulta y permite volver a abrirla', async () => {
  const {state, popup} = setup();
  state.documents = [{}];
  state.task = {state: 'loading'};
  const close = popup();
  await close();
  assert.equal(state.task.state, 'cancelled');
  assert.equal(state.documents.length, 0);
});

test('cerrar el popup durante una descarga no la cancela', async () => {
  const {state, popup} = setup();
  state.documents = [{}];
  state.task = {state: 'downloading'};
  const close = popup();
  await close();
  assert.equal(state.documents.length, 1);
  assert.equal(state.task.state, 'downloading');
});

test('cerrar la pestaña de origen cancela el procesamiento', async () => {
  const {state, events} = setup();
  state.documents = [{}];
  state.task = {state: 'merging', tabId: 4};
  await events.tabRemoved(3);
  assert.equal(state.task.state, 'merging');
  await events.tabRemoved(4);
  assert.equal(state.task.state, 'cancelled');
  assert.equal(state.documents.length, 0);
  assert.equal(state.sent[0].type, 'cancel');
});

test('el guardado libera las pistas y termina el procesamiento sin popup', async () => {
  const {state, events} = setup();
  state.documents = [{}];
  state.task = {state: 'saving', downloadId: 1};
  events.downloadChanged({id: 1, state: {current: 'complete'}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.task.state, 'done');
  assert.equal(state.sent[0].type, 'release');
  assert.equal(state.documents.length, 0);
});

test('prefiere el reproductor de la pestaña y conserva el agente del navegador', async () => {
  const {state, send, chrome} = setup();
  const page = {videoDetails: {videoId: 'jNQXAC9IVRw'}, streamingData: {serverAbrStreamingUrl: 'https://r1.googlevideo.com/videoplayback?id=stream'}};
  chrome.scripting.executeScript = async () => [{result: {page, playerSource: 'player'}}];
  state.stored['playback:1'] = [{url: 'https://r1.googlevideo.com/videoplayback?id=stream', body: [1], time: Date.now()}];
  const response = await send({type: 'inspect', videoId: 'jNQXAC9IVRw', tabId: 1});
  assert.equal(response.error, undefined);
  assert.equal(state.sent[0].page, page);
  assert.equal(state.sent[0].captures.length, 1);
  assert.equal(state.rules.addRules[0].action.requestHeaders.some(header => header.header === 'user-agent'), false);
});

test('lee los datos iniciales si el método del reproductor omite las pistas', () => {
  const id = 'jNQXAC9IVRw';
  const complete = {videoDetails: {videoId: id}, streamingData: {serverAbrStreamingUrl: 'https://r1.googlevideo.com/videoplayback?id=stream'}};
  const {readPlayer} = setup({document: {querySelectorAll: () => [{getPlayerResponse: () => ({videoDetails: {videoId: id}})}]}, ytInitialPlayerResponse: complete});
  const result = readPlayer(id);
  assert.equal(result.playerSource, 'initial');
  assert.equal(result.page.streamingData.serverAbrStreamingUrl, complete.streamingData.serverAbrStreamingUrl);
});

test('interpreta respuestas JSON y no usa datos del vídeo anterior en una navegación interna', () => {
  const id = 'jNQXAC9IVRw';
  const complete = {videoDetails: {videoId: id}, streamingData: {serverAbrStreamingUrl: 'https://r1.googlevideo.com/videoplayback?id=stream'}};
  const {readPlayer} = setup({document: {querySelectorAll: () => []}, ytInitialPlayerResponse: {videoDetails: {videoId: 'i0wdgHcXLJg'}}, ytplayer: {config: {args: {player_response: JSON.stringify(complete)}}}});
  assert.equal(readPlayer(id).playerSource, 'config');
  assert.equal(readPlayer('abcdefghijk').page, null);
});

test('conserva el motivo si no puede leer las pistas y tolera configuraciones que fallan', () => {
  const id = 'jNQXAC9IVRw';
  const {readPlayer} = setup({document: {querySelectorAll: () => [{getPlayerResponse: () => ({videoDetails: {videoId: id}})}]}, ytcfg: {get() { throw new Error('No disponible'); }}});
  const result = readPlayer(id);
  assert.equal(result.page.videoDetails.videoId, id);
  assert.match(result.playerFailure, /omitido los datos/);
});

test('las peticiones desde la pestaña exigen una tarea activa y destino de YouTube', async () => {
  const {state, send, chrome} = setup();
  const sender = {url: chrome.runtime.getURL('offscreen.html')};
  const message = {target: 'background', type: 'page-fetch', taskId: 'current', url: 'https://r1.googlevideo.com/videoplayback?id=stream', body: [1, 2]};
  state.task = {id: 'current', videoId: 'jNQXAC9IVRw', tabId: 1, state: 'downloading'};
  let calls = 0;
  chrome.scripting.executeScript = async options => {
    calls++;
    assert.equal(options.target.tabId, 1);
    assert.equal(options.world, 'MAIN');
    assert.equal(options.args[2], 'jNQXAC9IVRw');
    return [{result: {status: 200, data: 'AQI=', headers: {}}}];
  };
  assert.match((await send({...message, url: 'https://example.com/videoplayback'}, sender)).error, /Destino/);
  assert.match((await send({...message, body: [256]}, sender)).error, /no válida/);
  assert.match((await send({...message, taskId: 'old'}, sender)).error, /ya no está activa/);
  assert.equal(calls, 0);
  assert.equal((await send(message, sender)).data.status, 200);
  assert.equal(calls, 1);
  state.task.state = 'cancelled';
  assert.match((await send(message, sender)).error, /ya no está activa/);
});

test('los fragmentos solo se leen o cancelan desde el motor de la tarea activa', async () => {
  const {state, send, chrome} = setup();
  state.task = {id: 'task', tabId: 1, state: 'downloading'};
  const message = {target: 'background', type: 'page-fetch-read', taskId: 'task', requestId: '12345678-1234-1234-1234-123456789abc'};
  const sender = {url: chrome.runtime.getURL('offscreen.html')};
  let calls = 0;
  chrome.scripting.executeScript = async options => { calls++; assert.equal(options.target.tabId, 1); return [{result: {done: options.args[2], data: 'AQI='}}]; };
  assert.match((await send(message, {url: 'https://www.youtube.com/'})).error, /Emisor/);
  assert.match((await send({...message, taskId: 'other'}, sender)).error, /ya no está activa/);
  assert.match((await send({...message, requestId: '../other'}, sender)).error, /no válida/);
  assert.equal(calls, 0);
  assert.equal((await send(message, sender)).data.data, 'AQI=');
  assert.equal((await send({...message, type: 'page-fetch-cancel'}, sender)).data.done, true);
  state.task.state = 'cancelled';
  assert.match((await send(message, sender)).error, /ya no está activa/);
});

test('solo conserva peticiones de vídeo de YouTube y las elimina al cerrar su pestaña', async () => {
  const {state, events} = setup();
  const request = {tabId: 1, method: 'POST', url: 'https://r1.googlevideo.com/videoplayback?id=stream', initiator: 'https://www.youtube.com', requestBody: {raw: [{bytes: new Uint8Array([1, 2, 3]).buffer}]}};
  events.webRequest({...request, initiator: 'https://other.test'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.stored['playback:1'], undefined);
  for (let index = 0; index < 6; index++) events.webRequest({...request, url: request.url + '&rn=' + index});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.stored['playback:1'].length, 4);
  assert.equal(state.stored['playback:1'][3].url.endsWith('rn=5'), true);
  state.task = {state: 'ready', tabId: 2};
  await events.tabRemoved(1);
  assert.equal(state.stored['playback:1'], undefined);
});

test('entrega capturas nuevas solo al motor de la descarga activa y de su propia pestaña', async () => {
  const {state, send, chrome} = setup();
  state.task = {id: 'current', tabId: 1, state: 'downloading'};
  const capture = {url: 'https://r1.googlevideo.com/videoplayback?id=stream', body: [1], time: Date.now()};
  state.stored['playback:1'] = [capture];
  state.stored['playback:2'] = [{body: [2]}];
  const message = {type: 'playback-captures', target: 'background', taskId: 'current', tabId: 2};
  const sender = {url: chrome.runtime.getURL('offscreen.html')};
  assert.deepEqual(Array.from((await send(message, sender)).data), [capture]);
  assert.match((await send({...message, taskId: 'old'}, sender)).error, /no está activa/);
  assert.match((await send(message, {url: 'https://www.youtube.com/'})).error, /Emisor/);
  state.task.state = 'cancelled';
  assert.match((await send(message, sender)).error, /no está activa/);
});

test('recarga una sola vez si faltan capturas y usa los datos nuevos para descargar', async () => {
  const {state, send, chrome} = setup();
  const id = 'jNQXAC9IVRw';
  let reloads = 0;
  const player = stream => ({page: {videoDetails: {videoId: id}, streamingData: {serverAbrStreamingUrl: `https://r1.googlevideo.com/videoplayback?id=${stream}`}}});
  chrome.scripting.executeScript = async () => [{result: player(reloads ? 'new' : 'old')}];
  chrome.tabs.reload = async tabId => {
    reloads++;
    assert.equal(tabId, 1);
    assert.match(state.task.message, /Recargando/);
    state.stored['playback:1'] = [{url: 'https://r1.googlevideo.com/videoplayback?id=new', time: Date.now(), body: [1]}];
  };
  const message = {type: 'download', videoId: id, tabId: 1, height: 1080, container: 'mp4'};
  assert.equal((await send(message)).error, undefined);
  assert.equal(reloads, 1);
  assert.match(state.sent[0].page.streamingData.serverAbrStreamingUrl, /id=new$/);
  assert.equal(state.sent[0].captures.length, 1);
  state.task.state = 'done';
  assert.equal((await send(message)).error, undefined);
  assert.equal(reloads, 1);
});

test('cancelar mientras recarga no inicia el motor ni sobrescribe la cancelación', async () => {
  const {state, send, chrome} = setup();
  const id = 'jNQXAC9IVRw';
  chrome.scripting.executeScript = async () => [{result: {page: {videoDetails: {videoId: id}, streamingData: {serverAbrStreamingUrl: 'https://r1.googlevideo.com/videoplayback?id=stream'}}}}];
  chrome.tabs.reload = async () => { state.task.state = 'cancelled'; };
  assert.equal((await send({type: 'download', videoId: id, tabId: 1, height: 1080, container: 'mp4'})).error, undefined);
  assert.equal(state.task.state, 'cancelled');
  assert.equal(state.sent.length, 0);
  assert.equal(state.documents.length, 0);
});

test('descarga con las capturas de la página aunque webRequest no haya recibido ninguna', async () => {
  const {state, send, chrome} = setup();
  const id = 'jNQXAC9IVRw';
  const capture = {url: 'https://r1.googlevideo.com/videoplayback?id=stream', time: Date.now(), body: [1, 2]};
  chrome.scripting.executeScript = async ({func}) => [{result: func.name === 'readYouTubePlayer'
    ? {page: {videoDetails: {videoId: id}, streamingData: {serverAbrStreamingUrl: capture.url}}}
    : [capture]}];
  chrome.tabs.reload = async () => { assert.fail('No debe recargar cuando la página ya tiene capturas'); };
  assert.equal((await send({type: 'download', videoId: id, tabId: 1, height: 1080, container: 'mp4'})).error, undefined);
  assert.equal(state.sent[0].captures[0], capture);
  const response = await send({target: 'background', type: 'playback-captures', taskId: state.task.id},
    {url: chrome.runtime.getURL('offscreen.html')});
  assert.equal(response.data[0], capture);
  assert.equal(state.stored['playback:1'], undefined);
});
