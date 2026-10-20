const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

async function setup() {
  const ports = [];
  const intervals = new Map();
  const timeouts = new Map();
  const events = {};
  const elements = new Map();
  let timer = 0;
  const chrome = {runtime: {
    getManifest: () => ({version: '2.1.2'}),
    connect: () => {
      const port = {closed: false, disconnected: null, onDisconnect: {addListener(listener) { port.disconnected = listener; }}, postMessage() { if (port.closed) throw new Error('Attempting to use a disconnected port object'); }, disconnect() { port.closed = true; }};
      ports.push(port);
      return port;
    },
  }, tabs: {query: async () => []}, storage: {session: {get: async () => ({})}, onChanged: {addListener() {}}}};
  const context = {chrome, videoId: () => null, document: {querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, {textContent: '', hidden: false, classList: {add() {}, toggle() {}}, addEventListener() {}});
    return elements.get(selector);
  }}, setInterval(fn) { const id = ++timer; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); }, setTimeout(fn) { const id = ++timer; timeouts.set(id, fn); return id; }, clearTimeout(id) { timeouts.delete(id); }, addEventListener(name, fn) { events[name] = fn; }};
  const source = fs.readFileSync('src/popup.js', 'utf8').replace(/^import[^\n]+\r?\n/, '');
  await vm.runInNewContext(`(async () => {${source}\n})()`, context);
  return {ports, intervals, timeouts, events, elements};
}

test('deja de usar el puerto desconectado y vuelve a conectar el popup', async () => {
  const {ports, intervals, timeouts} = await setup();
  ports[0].closed = true;
  assert.doesNotThrow(() => [...intervals.values()][0]());
  assert.equal(intervals.size, 0);
  const [id, reconnect] = [...timeouts][0];
  timeouts.delete(id);
  reconnect();
  assert.equal(ports.length, 2);
  assert.doesNotThrow(() => [...intervals.values()][0]());
});

test('un cierre tardío del puerto anterior no desconecta el nuevo', async () => {
  const {ports, intervals, timeouts} = await setup();
  ports[0].disconnected();
  const [id, reconnect] = [...timeouts][0];
  timeouts.delete(id);
  reconnect();
  ports[0].disconnected();
  assert.equal(intervals.size, 1);
  assert.equal(timeouts.size, 0);
});

test('cerrar el popup cancela los temporizadores y no lo vuelve a conectar', async () => {
  const {ports, intervals, timeouts, events} = await setup();
  ports[0].disconnected();
  events.pagehide();
  assert.equal(intervals.size, 0);
  assert.equal(timeouts.size, 0);
  assert.equal(ports.length, 1);
});

test('limita las reconexiones si el proceso de la extensión sigue fallando', async () => {
  const {ports, intervals, timeouts, elements} = await setup();
  for (let index = 0; index < 3; index++) {
    ports[index].disconnected();
    for (const [id, reconnect] of timeouts) { timeouts.delete(id); reconnect(); }
  }
  assert.equal(intervals.size, 0);
  assert.equal(timeouts.size, 0);
  assert.match(elements.get('#status').textContent, /Cierra este popup/);
});
