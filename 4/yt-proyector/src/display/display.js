'use strict';
/**
 * Pantalla de reproducción: solo ejecuta los comandos que envía el proceso
 * principal y reporta eventos del reproductor oficial (YouTube IFrame API).
 */
(() => {
  let player = null;
  let ready = false;
  let currentVideoId = null;
  let metaSent = false;
  let queued = [];

  const emit = (ev) => window.projector.emit(ev);

  function setIdle(on) { document.body.classList.toggle('idle', on); }

  function loadApi() {
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { emit({ type: 'online', online: false }); setTimeout(loadApi, 5000); s.remove(); };
    document.head.appendChild(s);
  }

  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player('player', {
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3,
        modestbranding: 1, rel: 0, playsinline: 1, enablejsapi: 1, origin: location.origin
      },
      events: {
        onReady: () => {
          ready = true;
          emit({ type: 'ready' });
          const q = queued; queued = [];
          q.forEach(run);
        },
        onStateChange: (e) => emit({ type: 'state', state: e.data, videoId: currentVideoId }),
        onError: (e) => emit({ type: 'error', code: e.data, videoId: currentVideoId })
      }
    });
  };

  function run(c) {
    if (!ready) { queued.push(c); return; }
    switch (c.type) {
      case 'load':
        currentVideoId = c.videoId;
        metaSent = false;
        setIdle(false);
        player.setVolume(c.volume);
        if (c.muted) player.mute(); else player.unMute();
        if (c.autoplay) player.loadVideoById({ videoId: c.videoId, startSeconds: c.startSeconds || 0 });
        else player.cueVideoById({ videoId: c.videoId, startSeconds: c.startSeconds || 0 });
        break;
      case 'play': player.playVideo(); break;
      case 'pause': player.pauseVideo(); break;
      case 'seek': player.seekTo(c.seconds, true); break;
      case 'volume':
        player.setVolume(c.volume);
        if (c.muted) player.mute(); else player.unMute();
        break;
      case 'stop':
      case 'idle':
        currentVideoId = null;
        try { player.stopVideo(); } catch { /* ignore */ }
        setIdle(true);
        break;
    }
  }

  window.projector.onCommand(run);

  setInterval(() => {
    if (!ready || !currentVideoId) return;
    let position = 0, duration = 0;
    try { position = player.getCurrentTime(); duration = player.getDuration(); } catch { return; }
    emit({ type: 'time', videoId: currentVideoId, position, duration });
    if (!metaSent && duration > 0) {
      metaSent = true;
      try {
        const d = player.getVideoData();
        if (d && d.title) emit({ type: 'meta', videoId: currentVideoId, title: d.title });
      } catch { /* ignore */ }
    }
  }, 500);

  window.addEventListener('online', () => emit({ type: 'online', online: true }));
  window.addEventListener('offline', () => emit({ type: 'online', online: false }));

  document.addEventListener('contextmenu', (e) => e.preventDefault());
  loadApi();
})();
