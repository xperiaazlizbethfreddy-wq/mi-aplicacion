'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIsoDuration, parseFeed, extractPlaylistFromHtml } = require('../src/main/youtube');

test('duraciones ISO 8601', () => {
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('PT10M'), 600);
  assert.equal(parseIsoDuration('P0D'), 0);
  assert.equal(parseIsoDuration('basura'), 0);
});

test('feed RSS de una lista', () => {
  const xml = `<feed><entry><yt:videoId>dQw4w9WgXcQ</yt:videoId><title>Uno &amp; &quot;dos&quot;</title></entry>
  <entry><yt:videoId>malo</yt:videoId><title>x</title></entry>
  <entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>Tres</title></entry></feed>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Uno & "dos"');
});

test('lectura de la página de una lista (ytInitialData)', () => {
  const data = {
    contents: [{ playlistVideoRenderer: { videoId: 'dQw4w9WgXcQ', title: { runs: [{ text: 'Primero' }] }, lengthSeconds: '212' } },
      { playlistVideoRenderer: { videoId: 'aaaaaaaaaaa', title: { simpleText: 'Segundo' }, lengthSeconds: '10' } },
      { continuationItemRenderer: {} }]
  };
  const html = `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
  const r = extractPlaylistFromHtml(html);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].title, 'Primero');
  assert.equal(r.items[0].duration, 212);
  assert.equal(r.partial, true);
  assert.deepEqual(extractPlaylistFromHtml('<html></html>'), { items: [], partial: false });
});
