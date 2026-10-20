'use strict';
/**
 * Validación de enlaces de YouTube.
 * Solo se aceptan dominios de YouTube y formatos conocidos. El resultado son
 * identificadores (videoId / playlistId); nunca se navega a la URL original.
 */

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com'
]);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

function fail(error) {
  return { ok: false, error };
}

function parseYouTubeUrl(input) {
  if (typeof input !== 'string') return fail('Escribe o pega un enlace de YouTube.');
  let text = input.trim();
  if (!text) return fail('Escribe o pega un enlace de YouTube.');
  if (text.length > 2048) return fail('El enlace es demasiado largo.');

  // Se admite un ID de video suelto.
  if (VIDEO_ID.test(text)) {
    return { ok: true, kind: 'video', videoId: text, playlistId: null };
  }

  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = 'https://' + text;

  let url;
  try {
    url = new URL(text);
  } catch {
    return fail('El texto ingresado no es un enlace válido.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return fail('Solo se aceptan enlaces http o https.');
  }

  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return fail('Solo se aceptan enlaces de YouTube (youtube.com o youtu.be).');
  }

  let videoId = null;
  let playlistId = null;

  const list = url.searchParams.get('list');
  if (list && PLAYLIST_ID.test(list)) playlistId = list;

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = url.pathname.split('/')[1] || '';
    if (VIDEO_ID.test(id)) videoId = id;
  } else {
    const path = url.pathname;
    if (path === '/watch' || path === '/watch/') {
      const v = url.searchParams.get('v');
      if (v && VIDEO_ID.test(v)) videoId = v;
    } else {
      const m = path.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/);
      if (m) videoId = m[1];
    }
  }

  if (!videoId && !playlistId) {
    return fail('No se encontró un video ni una lista de reproducción en ese enlace.');
  }

  const kind = videoId && playlistId ? 'both' : videoId ? 'video' : 'playlist';
  return { ok: true, kind, videoId, playlistId };
}

module.exports = { parseYouTubeUrl, VIDEO_ID, PLAYLIST_ID, ALLOWED_HOSTS };
