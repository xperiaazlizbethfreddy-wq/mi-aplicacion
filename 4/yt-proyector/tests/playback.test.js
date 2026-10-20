'use strict';
/**
 * Pruebas del estado centralizado. Simulan las DOS ventanas:
 *  - "panel de control": llama a los métodos del controlador.
 *  - "pantalla de reproducción": recibe 'display-command' y responde con eventos.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PlaybackController } = require('../src/main/playback');

const V = (n) => ({ videoId: String(n).padStart(11, 'a'), title: `Video ${n}x`, duration: 100 });
const ids = ['a', 'b', 'c'].map((c) => c.repeat(11));
const vids = ids.map((videoId, i) => ({ videoId, title: `Título ${i + 1}`, duration: 60 }));

function setup({ ready = true, items = vids } = {}) {
  const c = new PlaybackController({ skipDelayMs: 0 });
  const sent = [];
  const notices = [];
  c.on('display-command', (x) => sent.push(x));
  c.on('notice', (n) => notices.push(n));
  if (ready) c.onDisplayEvent({ type: 'ready' });
  sent.length = 0;
  if (items.length) c.addItems(items);
  // la "pantalla" confirma lo que recibe
  const screen = {
    playing(videoId) { c.onDisplayEvent({ type: 'state', state: 1, videoId }); },
    ended(videoId) { c.onDisplayEvent({ type: 'state', state: 0, videoId }); },
    error(videoId, code) { c.onDisplayEvent({ type: 'error', code, videoId }); }
  };
  return { c, sent, notices, screen };
}
const last = (a) => a[a.length - 1];
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

test('seleccionar un video envía "load" a la pantalla externa', () => {
  const { c, sent } = setup();
  c.playIndex(1);
  assert.deepEqual(sent.map((s) => s.type), ['load']);
  assert.equal(sent[0].videoId, ids[1]);
  assert.equal(sent[0].autoplay, true);
  assert.equal(c.currentId, c.queue[1].id);
});

test('pausar / reanudar se reflejan inmediatamente en la pantalla', () => {
  const { c, sent, screen } = setup();
  c.playIndex(0); screen.playing(ids[0]);
  assert.equal(c.status, 'playing');
  c.pause();
  assert.equal(last(sent).type, 'pause');
  assert.equal(c.status, 'paused');
  c.toggle();
  assert.equal(last(sent).type, 'play');
  assert.equal(c.status, 'playing');
});

test('volumen, silencio, avance y retroceso se envían al reproductor', () => {
  const { c, sent, screen } = setup();
  c.playIndex(0); screen.playing(ids[0]);
  c.onDisplayEvent({ type: 'time', videoId: ids[0], position: 20, duration: 60 });
  c.setVolume(35);
  assert.deepEqual(last(sent), { type: 'volume', volume: 35, muted: false });
  c.setMuted(true);
  assert.deepEqual(last(sent), { type: 'volume', volume: 35, muted: true });
  c.setVolume(50);
  assert.equal(c.muted, false, 'subir el volumen quita el silencio');
  c.seekBy(10);
  assert.deepEqual(last(sent), { type: 'seek', seconds: 30 });
  c.seekBy(-100);
  assert.deepEqual(last(sent), { type: 'seek', seconds: 0 });
  c.seekBy(500);
  assert.equal(last(sent).seconds, 60, 'no pasa de la duración');
});

test('siguiente / anterior / reiniciar', () => {
  const { c, sent, screen } = setup();
  c.playIndex(0); screen.playing(ids[0]);
  c.next();
  assert.equal(last(sent).videoId, ids[1]);
  c.onDisplayEvent({ type: 'time', videoId: ids[1], position: 1, duration: 60 });
  c.prev(); // posición < 3 s: va al anterior
  assert.equal(last(sent).videoId, ids[0]);
  c.onDisplayEvent({ type: 'time', videoId: ids[0], position: 40, duration: 60 });
  c.prev(); // posición > 3 s: reinicia el mismo
  assert.equal(last(sent).type, 'play');
  assert.ok(sent.some((s) => s.type === 'seek' && s.seconds === 0));
});

test('reproducción automática del siguiente al finalizar (activada)', () => {
  const { c, sent, screen } = setup();
  c.playIndex(0); screen.playing(ids[0]);
  screen.ended(ids[0]);
  assert.equal(last(sent).type, 'load');
  assert.equal(last(sent).videoId, ids[1]);
  assert.equal(c.queue[0].played, true);
});

test('con reproducción automática desactivada se detiene al finalizar', () => {
  const { c, sent, screen } = setup();
  c.setAutoplay(false);
  c.playIndex(0); screen.playing(ids[0]);
  const n = sent.length;
  screen.ended(ids[0]);
  assert.equal(sent.length, n);
  assert.equal(c.status, 'ended');
  assert.equal(c.snapshot().nextId, c.queue[1].id, 'el siguiente queda identificado');
});

test('repetir video y repetir lista', () => {
  const { c, sent, screen } = setup();
  c.setRepeat('one');
  c.playIndex(1); screen.playing(ids[1]);
  screen.ended(ids[1]);
  assert.equal(last(sent).videoId, ids[1]);
  c.setRepeat('all');
  c.playIndex(2); screen.playing(ids[2]);
  screen.ended(ids[2]);
  assert.equal(last(sent).videoId, ids[0], 'vuelve al inicio');
  c.setRepeat('off');
  c.playIndex(2); screen.playing(ids[2]);
  screen.ended(ids[2]);
  assert.equal(c.status, 'ended');
});

test('detener libera la pantalla sin perder la lista', () => {
  const { c, sent, screen } = setup();
  c.playIndex(0); screen.playing(ids[0]);
  c.stop();
  assert.equal(last(sent).type, 'stop');
  assert.equal(c.status, 'idle');
  assert.equal(c.queue.length, 3);
});

test('gestión de la cola: mover, quitar, vaciar', () => {
  const { c } = setup();
  const [a, b, d] = c.queue.map((i) => i.id);
  c.move(0, 2);
  assert.deepEqual(c.queue.map((i) => i.id), [b, d, a]);
  assert.equal(c.move(0, 9), false);
  c.remove(d);
  assert.deepEqual(c.queue.map((i) => i.id), [b, a]);
  c.clear();
  assert.equal(c.queue.length, 0);
  assert.equal(c.currentId, null);
});

test('mover elementos no cambia el video actual', () => {
  const { c, screen } = setup();
  c.playIndex(0); screen.playing(ids[0]);
  const cur = c.currentId;
  c.move(0, 2);
  assert.equal(c.currentId, cur);
  assert.equal(c.currentIndex, 2);
});

test('quitar el video en reproducción pasa al siguiente', () => {
  const { c, sent, screen } = setup();
  c.playIndex(0); screen.playing(ids[0]);
  c.remove(c.currentId);
  assert.equal(last(sent).type, 'load');
  assert.equal(last(sent).videoId, ids[1]);
});

test('reemplazar la cola detiene la reproducción', () => {
  const { c, sent, screen } = setup();
  c.playIndex(0); screen.playing(ids[0]);
  c.addItems([{ videoId: 'z'.repeat(11), title: 'Nuevo' }], 'replace');
  assert.ok(sent.some((s) => s.type === 'stop'));
  assert.equal(c.queue.length, 1);
});

test('rechaza elementos con ID de video inválido', () => {
  const { c } = setup({ items: [] });
  const n = c.addItems([{ videoId: 'corto' }, { videoId: '<script>1</script>' }, { videoId: 'x'.repeat(11) }]);
  assert.equal(n, 1);
});

test('error de video: informa y continúa con el siguiente', async () => {
  const { c, sent, notices, screen } = setup();
  c.playIndex(0);
  screen.error(ids[0], 150);
  assert.equal(c.status, 'error');
  assert.match(c.queue[0].error, /restricción de edad|privado/);
  assert.equal(notices[0].level, 'error');
  await tick();
  assert.equal(last(sent).videoId, ids[1]);
});

test('si todos los videos fallan no entra en bucle infinito', async () => {
  const { c, sent, screen } = setup();
  c.setRepeat('all');
  c.playIndex(0);
  for (let i = 0; i < 6; i++) {
    const cur = c.current;
    screen.error(cur.videoId, 100);
    await tick();
  }
  const loads = sent.filter((s) => s.type === 'load').length;
  assert.ok(loads <= 3, `cargas: ${loads}`);
});

test('eventos de un video anterior se ignoran (sin desincronización)', () => {
  const { c, screen } = setup();
  c.playIndex(0);
  c.playIndex(1);
  screen.playing(ids[0]); // llega tarde el evento del video anterior
  assert.notEqual(c.status, 'playing');
  screen.playing(ids[1]);
  assert.equal(c.status, 'playing');
});

test('cerrar accidentalmente la pantalla y volver a abrirla conserva lista y posición', () => {
  const { c, sent, screen } = setup();
  c.playIndex(1); screen.playing(ids[1]);
  c.onDisplayEvent({ type: 'time', videoId: ids[1], position: 42, duration: 60 });
  c.displayClosed();
  assert.equal(c.displayReady, false);
  assert.equal(c.queue.length, 3);
  sent.length = 0;
  c.onDisplayEvent({ type: 'ready' }); // la ventana se abre otra vez
  assert.equal(sent[0].type, 'load');
  assert.equal(sent[0].videoId, ids[1]);
  assert.equal(sent[0].startSeconds, 42);
  assert.equal(sent[0].autoplay, true);
});

test('si la pantalla aún no está abierta, el video se carga al conectarse', () => {
  const { c, sent } = setup({ ready: false });
  c.playIndex(0);
  assert.equal(sent.length, 0);
  c.onDisplayEvent({ type: 'ready' });
  assert.equal(sent[0].type, 'load');
  assert.equal(sent[0].videoId, ids[0]);
});

test('sesión: persistir y restaurar cola, video actual y ajustes', () => {
  const a = setup();
  a.c.playIndex(2); a.screen.playing(ids[2]);
  a.c.onDisplayEvent({ type: 'time', videoId: ids[2], position: 12.7, duration: 60 });
  a.c.setVolume(55); a.c.setRepeat('all'); a.c.setAutoplay(false);
  const saved = JSON.parse(JSON.stringify(a.c.toPersist()));
  const b = new PlaybackController();
  b.restore(saved);
  assert.equal(b.queue.length, 3);
  assert.equal(b.current.videoId, ids[2]);
  assert.equal(b.position, 12);
  assert.equal(b.volume, 55);
  assert.equal(b.repeat, 'all');
  assert.equal(b.autoplay, false);
  assert.equal(b.status, 'idle');
});

test('estado y duración se actualizan desde el reproductor', () => {
  const { c, screen } = setup({ items: [{ videoId: 'q'.repeat(11), title: 'Video qqqqqqqqqqq', duration: 0 }] });
  c.playIndex(0); screen.playing('q'.repeat(11));
  c.onDisplayEvent({ type: 'time', videoId: 'q'.repeat(11), position: 1, duration: 321.4 });
  assert.equal(c.queue[0].duration, 321);
  c.onDisplayEvent({ type: 'meta', videoId: 'q'.repeat(11), title: 'Título real' });
  assert.equal(c.queue[0].title, 'Título real');
});

test('historial: se emite al iniciar cada video', () => {
  const { c } = setup();
  const h = [];
  c.on('history', (x) => h.push(x.item.videoId));
  c.playIndex(0); c.next();
  assert.deepEqual(h, [ids[0], ids[1]]);
});
