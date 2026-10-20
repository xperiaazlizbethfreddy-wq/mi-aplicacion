'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseYouTubeUrl } = require('../src/shared/urlparser');

test('video con enlace watch', () => {
  const r = parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'video');
  assert.equal(r.videoId, 'dQw4w9WgXcQ');
});

test('formatos youtu.be, shorts, embed, live, móvil y música', () => {
  for (const u of [
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'youtube.com/watch?v=dQw4w9WgXcQ',
    'dQw4w9WgXcQ'
  ]) {
    const r = parseYouTubeUrl(u);
    assert.equal(r.ok, true, u);
    assert.equal(r.videoId, 'dQw4w9WgXcQ', u);
  }
});

test('lista de reproducción y enlace mixto', () => {
  const p = parseYouTubeUrl('https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  assert.equal(p.kind, 'playlist');
  assert.equal(p.playlistId, 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  const b = parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  assert.equal(b.kind, 'both');
});

test('rechaza dominios ajenos, protocolos peligrosos y basura', () => {
  for (const u of [
    'https://evil.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
    'https://evil.com/?u=youtube.com/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=corto',
    'https://www.youtube.com/',
    '',
    '   ',
    'hola mundo'
  ]) {
    assert.equal(parseYouTubeUrl(u).ok, false, u);
  }
  assert.equal(parseYouTubeUrl(null).ok, false);
  assert.equal(parseYouTubeUrl('https://youtu.be/' + 'a'.repeat(3000)).ok, false);
});
