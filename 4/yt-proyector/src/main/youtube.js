'use strict';
/**
 * Obtención de metadatos (título, miniatura, duración) y de los videos de una
 * lista. Se ejecuta SOLO en el proceso principal: la clave de la API de YouTube
 * Data (opcional) nunca llega al código de las ventanas.
 *
 * Fuentes para listas, en orden:
 *   1. API de YouTube Data v3 (si el usuario configuró una clave): listas largas + duraciones.
 *   2. Lectura de la página pública de la lista (hasta ~100 videos).
 *   3. Feed RSS público (primeros 15 videos).
 * La reproducción nunca depende de estas fuentes: usa el reproductor IFrame oficial.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_ITEMS = 5000;
const { VIDEO_ID } = require('../shared/urlparser');

const sig = (ms = 12000) => AbortSignal.timeout(ms);

function parseIsoDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x || 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parseFeed(xml) {
  const items = [];
  for (const entry of String(xml).split('<entry>').slice(1)) {
    const id = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(entry);
    const title = /<title>([^<]*)<\/title>/.exec(entry);
    if (id && VIDEO_ID.test(id[1])) {
      items.push({ videoId: id[1], title: decodeEntities(title ? title[1] : `Video ${id[1]}`), duration: 0 });
    }
  }
  return items;
}

function extractPlaylistFromHtml(html) {
  const m = /var ytInitialData\s*=\s*(\{[\s\S]+?\});\s*<\/script>/.exec(html);
  if (!m) return { items: [], partial: false };
  let data;
  try { data = JSON.parse(m[1]); } catch { return { items: [], partial: false }; }
  const items = [];
  let partial = false;
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]); continue; }
    if (node.continuationItemRenderer) partial = true;
    const r = node.playlistVideoRenderer;
    if (r && VIDEO_ID.test(r.videoId || '')) {
      const title = (r.title && ((r.title.runs && r.title.runs[0] && r.title.runs[0].text) || r.title.simpleText)) || `Video ${r.videoId}`;
      items.push({ videoId: r.videoId, title, duration: Number(r.lengthSeconds) || 0 });
      continue;
    }
    for (const k of Object.keys(node)) stack.push(node[k]);
  }
  return { items, partial };
}

async function getVideoMeta(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`;
    const r = await fetch(url, { signal: sig(8000), headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    return { videoId, title: j.title || `Video ${videoId}`, duration: 0 };
  } catch {
    return { videoId, title: `Video ${videoId}`, duration: 0, unavailable: true };
  }
}

async function viaApi(id, key) {
  const scrub = (msg) => String(msg).split(key).join('***');
  const get = async (url) => {
    const r = await fetch(url, { signal: sig(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(scrub((j.error && j.error.message) || `HTTP ${r.status}`));
    return j;
  };
  const items = [];
  let token = '';
  let skipped = 0;
  do {
    const j = await get(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(id)}` +
      `&key=${encodeURIComponent(key)}${token ? '&pageToken=' + encodeURIComponent(token) : ''}`
    );
    for (const it of j.items || []) {
      const sn = it.snippet || {};
      const vid = sn.resourceId && sn.resourceId.videoId;
      if (!VIDEO_ID.test(vid || '')) continue;
      if (/^(Private video|Deleted video)$/i.test(sn.title || '')) { skipped++; continue; }
      items.push({ videoId: vid, title: sn.title || `Video ${vid}`, duration: 0 });
    }
    token = j.nextPageToken || '';
  } while (token && items.length < MAX_ITEMS);

  for (let i = 0; i < items.length; i += 50) {
    const chunk = items.slice(i, i + 50);
    try {
      const j = await get(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${chunk.map((c) => c.videoId).join(',')}&key=${encodeURIComponent(key)}`
      );
      const map = new Map((j.items || []).map((v) => [v.id, parseIsoDuration(v.contentDetails && v.contentDetails.duration)]));
      for (const c of chunk) c.duration = map.get(c.videoId) || 0;
    } catch { break; }
  }
  return {
    items,
    source: 'api',
    warning: skipped ? `${skipped} video(s) privados o eliminados se omitieron.` : null
  };
}

async function viaScrape(id) {
  const r = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(id)}&hl=es`, {
    signal: sig(15000),
    headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.7' }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const { items, partial } = extractPlaylistFromHtml(await r.text());
  return {
    items,
    source: 'page',
    warning: partial ? 'Solo se pudieron leer los primeros videos de la lista. Para listas largas configura una clave de la API de YouTube Data (pestaña Pantalla).' : null
  };
}

async function viaFeed(id) {
  const r = await fetch(`https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(id)}`, {
    signal: sig(12000), headers: { 'User-Agent': UA }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return {
    items: parseFeed(await r.text()),
    source: 'feed',
    warning: 'Solo se pudieron obtener los primeros 15 videos. Para listas largas configura una clave de la API de YouTube Data.'
  };
}

async function getPlaylist(id, apiKey) {
  if (/^(RD|WL|LL|LM)/.test(id)) {
    throw new Error('Este tipo de lista (mezcla automática, «Ver más tarde» o «Me gusta») no se puede importar. Usa una lista pública creada por un canal o usuario.');
  }
  let apiWarning = null;
  if (apiKey) {
    try { return await viaApi(id, apiKey); } catch (e) { apiWarning = `API de YouTube: ${e.message}.`; }
  }
  const withNote = (res) => ({ ...res, warning: [apiWarning, res.warning].filter(Boolean).join(' ') || null });
  try { const r = await viaScrape(id); if (r.items.length) return withNote(r); } catch { /* siguiente fuente */ }
  try { const r = await viaFeed(id); if (r.items.length) return withNote(r); } catch { /* sin fuentes */ }
  throw new Error('No se pudo leer la lista: puede ser privada, no existir o no hay conexión a Internet.');
}

module.exports = { getVideoMeta, getPlaylist, parseIsoDuration, parseFeed, extractPlaylistFromHtml };
