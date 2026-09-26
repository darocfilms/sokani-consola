/* =========================================================================
   app.js — Interfaz, motor de reproducción y cableado general
   ========================================================================= */
(function () {
  const SK = window.SK, U = SK.U, BLE = SK.BLE;
  // Devuelve un objeto inerte si el id no existe: asi un desajuste entre el
  // HTML cacheado y este script degrada un boton, no la consola entera.
  const $ = (id) => document.getElementById(id) || new Proxy({}, {
    get: (_, k) => (k === 'style' || k === 'classList' || k === 'dataset' ? {} :
      k === 'value' || k === 'textContent' || k === 'innerHTML' ? '' :
      k === 'querySelectorAll' ? () => [] :
      k === 'closest' || k === 'appendChild' || k === 'addEventListener' ? () => ({ style: {} }) :
      undefined),
    set: () => true
  });
  const LS = 'sokani.x25.v1';

  /* ---------------- estado ---------------- */
  const AUDIO = { level: 0, bass: 0, mid: 0, treble: 0 };   // compartido: solo hay un micro
  const paramsPorDefecto = () => ({
    bri: 1, speed: 1, intensity: .5, hue: 0, sat: 1, kelvin: 5600, smooth: .2, gm: 0,
    bpm: 120, phase: 0, beatCount: 0, text: 'SOS', audio: AUDIO
  });

  /* Un grupo es un motor de efecto independiente con sus propios parametros,
     su propio estado y su propio historial de color. Las luces se reparten
     entre grupos, asi el contraluz puede llevar fuego mientras el principal
     se queda en un blanco fijo. */
  let idGrupo = 0;
  const mkGrupo = (name) => ({
    gid: ++idGrupo, name,
    fxId: 'solid', st: {}, t0: performance.now(),
    p: paramsPorDefecto(),
    cur: [0, 0, 0], shown: [0, 0, 0],
    hist: SK.mkHist(),
    fadeFrom: null, fadeT0: 0, fadeDur: 0
  });

  const S = {
    grupos: [mkGrupo('Todas')],
    sel: 0,
    cat: 'todos', q: '',
    curva: 'lin',
    get g() { return this.grupos[Math.min(this.sel, this.grupos.length - 1)]; },
    get p() { return this.g.p; },
    get fxId() { return this.g.fxId; },
    set fxId(v) { this.g.fxId = v; },
    get shown() { return this.g.shown; },
    blackout: false, previewOnly: false, delta: true, fps: 18,
    fav: [], cues: [], cueIdx: -1, cueTimer: null,
    duck: false, beatSync: false, gain: 1, uuids: [], camFps: 0, fadeDefecto: 0,
    taps: [], strobeHold: null, presets: {}
  };

  /* ---------------- utilidades UI ---------------- */
  let toastT;
  function toast(m) {
    const t = $('toast'); t.textContent = m; t.classList.add('s');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('s'), 2000);
  }
  function log(msg, cls) {
    const el = $('log');
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = `${new Date().toLocaleTimeString('es', { hour12: false })}  ${msg}`;
    el.appendChild(d); el.scrollTop = el.scrollHeight;
    while (el.childNodes.length > 400) el.removeChild(el.firstChild);
  }
  BLE.onLog = log;
  const hex2 = (v) => Math.round(v).toString(16).padStart(2, '0');
  const toHex = (c) => '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);

  /* =====================================================================
     Rejilla de efectos
     ===================================================================== */
  function renderTabs() {
    const t = $('tabs'); t.innerHTML = '';
    for (const [id, name] of SK.CATS) {
      const b = document.createElement('button');
      b.className = 'tab' + (S.cat === id ? ' act' : '');
      const n = id === 'todos' ? SK.FX.length : id === 'fav' ? S.fav.length : SK.FX.filter((f) => f.cat === id).length;
      b.textContent = `${name} ${n}`;
      b.onclick = () => { S.cat = id; renderTabs(); renderGrid(); };
      t.appendChild(b);
    }
  }

  function visibleFx() {
    let list = SK.FX;
    if (S.cat === 'fav') list = list.filter((f) => S.fav.includes(f.id));
    else if (S.cat !== 'todos') list = list.filter((f) => f.cat === S.cat);
    if (S.q) {
      const q = S.q.toLowerCase();
      list = list.filter((f) => (f.n + ' ' + f.d + ' ' + f.id + ' ' + f.cat).toLowerCase().includes(q));
    }
    return list;
  }

  function renderGrid() {
    const g = $('grid'); g.innerHTML = '';
    const list = visibleFx();
    $('fxCount').textContent = list.length;
    if (!list.length) { g.innerHTML = '<div class="empty">Nada coincide con la búsqueda.</div>'; return; }
    for (const f of list) {
      const b = document.createElement('button');
      b.className = 'fx' + (f.id === S.fxId ? ' act' : '');
      b.innerHTML =
        `<span class="fav ${S.fav.includes(f.id) ? 'y' : ''}">★</span>
         <span class="i">${f.i}</span>
         <span class="n">${f.n}</span>
         <span class="d">${f.d}</span>` +
        (f.audio ? '<span class="badge">mic</span>' : '');
      b.onclick = (e) => {
        if (e.altKey) { toggleFav(f.id); return; }
        if (f.id === S.fxId && panelAbierto()) { cierraPanel(); return; }
        if (f.id !== S.fxId) setFx(f.id);
        abrePanel(f.id);
      };
      b.oncontextmenu = (e) => { e.preventDefault(); toggleFav(f.id); };
      g.appendChild(b);
    }
  }

  function setFx(id, silent) {
    const f = SK.FX_BY_ID[id]; if (!f) return;
    const g = S.g;
    // Congelar lo que sonaba para poder fundir hacia el efecto nuevo.
    if (S.fadeDefecto > 0) { g.fadeFrom = g.shown.slice(); g.fadeT0 = performance.now(); g.fadeDur = S.fadeDefecto; }
    g.fxId = id;
    g.st = f.init ? f.init(g.p) : {};
    g.t0 = performance.now();
    $('nowIc').textContent = f.i; $('nowName').textContent = f.n; $('nowDesc').textContent = f.d;
    if (f.audio && !audio.on) toast('Este efecto necesita el micrófono → «Activar micro»');
    const tf = document.getElementById('fxText');
    if (tf) tf.style.display = (id === 'morse') ? 'block' : 'none';
    renderGrid(); renderGrupos();
    if (!silent) save();
  }

  function toggleFav(id) {
    const i = S.fav.indexOf(id);
    if (i < 0) S.fav.push(id); else S.fav.splice(i, 1);
    renderTabs(); renderGrid(); save();
    toast(i < 0 ? '★ Añadido a favoritos' : 'Quitado de favoritos');
  }

  /* =====================================================================
     Motor: calcula color y lo pinta / transmite
     ===================================================================== */
  const scope = $('scope'), sctx = scope.getContext('2d');
  const hist = new Array(220).fill(0);

  function computeColor(g) {
    const f = SK.FX_BY_ID[g.fxId]; if (!f) return [0, 0, 0];
    const p = g.p;
    const sp = S.beatSync ? (p.bpm / 120) * p.speed : p.speed;
    const T = ((performance.now() - g.t0) / 1000) * sp;
    p.phase = (T * (p.bpm / 60)) % 1;
    p.beatCount = Math.floor(T * (p.bpm / 60));
    let c;
    try { c = f.tick(T, g.st, p) || [0, 0, 0]; } catch (e) { c = [255, 0, 255]; }
    c = [U.clamp(c[0]), U.clamp(c[1]), U.clamp(c[2])];
    if (p.gm) c = aplicaGM(c, p.gm);       // tinte verde/magenta como en las luces pro
    if (S.duck && audio.on) c = U.sc(c, 0.15 + 0.85 * U.clamp(AUDIO.level, 0, 1));
    return c;
  }

  /* Curva de dimado. En lineal, la mitad del recorrido del mando ya es media
     potencia y la zona baja —donde se trabaja de noche— queda sin resolucion. */
  const CURVAS = {
    lin: (x) => x,
    sq: (x) => x * x,
    s: (x) => x * x * (3 - 2 * x),
    log: (x) => Math.pow(x, 3)
  };
  const dim = (x) => (CURVAS[S.curva] || CURVAS.lin)(U.clamp(x, 0, 1));

  /* Desplazamiento verde/magenta (tinte). Positivo = más verde; negativo =
     magenta (sube rojo y azul, baja verde). Es la corrección que llevan Godox
     y Nanlite de fábrica; en el RGBCW del Sokani se aproxima con la mezcla. */
  function aplicaGM(c, gm) {
    // gm>0 (verde): sube el verde. gm<0 (magenta): baja el verde y sube rojo y
    // azul para conservar la luminosidad, como el tinte de una luz de video.
    const g = U.clamp(c[1] * (1 + gm * 0.55));
    const rb = 1 + Math.max(0, -gm) * 0.22;
    return [U.clamp(c[0] * rb), g, U.clamp(c[2] * rb)];
  }

  /* Fundido entre cues: congelamos el color que sonaba y lo mezclamos con el
     nuevo efecto ya vivo. Es la aproximacion que usan las mesas y no obliga a
     mantener dos motores corriendo por grupo. */
  function conFundido(g, c) {
    if (!g.fadeFrom) return c;
    const t = (performance.now() - g.fadeT0) / (g.fadeDur * 1000);
    if (t >= 1) { g.fadeFrom = null; return c; }
    return U.mix(g.fadeFrom, c, t);
  }

  /* El reloj del motor vive en un Web Worker: los navegadores estrangulan
     setInterval y congelan requestAnimationFrame en pestanas de fondo, y eso
     dejaria la luz clavada en el ultimo color a mitad de show. Los timers de
     un worker no se estrangulan, asi que el espectaculo sigue aunque el
     usuario cambie de pestana o minimice la ventana. */
  let clock = null;
  function startClock() {
    const src = 'let h=null;onmessage=e=>{clearInterval(h);if(e.data>0)h=setInterval(()=>postMessage(0),e.data)}';
    try {
      clock = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      clock.onmessage = engineTick;
      clock.postMessage(16);
      log('Reloj del motor en Web Worker (inmune al estrangulado de pestañas).', 'm');
    } catch (e) {
      log('Sin Web Worker; usando setInterval (el show se ralentiza en segundo plano).', 'w');
      setInterval(engineTick, 16);
    }
  }

  let lastTx = 0, ticks = 0;
  function engineTick() {
    ticks++;
    if (audio.on) pumpAudio();
    for (const g of S.grupos) {
      const raw = S.blackout ? [0, 0, 0] : conFundido(g, computeColor(g));
      g.cur = raw;
      const k = 1 - g.p.smooth;
      g.shown = [U.lerp(g.shown[0], raw[0], k), U.lerp(g.shown[1], raw[1], k), U.lerp(g.shown[2], raw[2], k)];
      SK.pushHist(g.hist, g.shown);
    }
    const now = performance.now();
    if (now - lastTx >= 1000 / S.fps) { lastTx = now; transmit(); }
    paint(S.g.shown);
  }

  const grupoDe = (l) => S.grupos[Math.min(l.group || 0, S.grupos.length - 1)] || S.grupos[0];

  function paint(c) {
    const br = dim(S.p.bri);
    const o = [c[0] * br, c[1] * br, c[2] * br];
    const css = `rgb(${o[0] | 0},${o[1] | 0},${o[2] | 0})`;
    $('glow').style.background = css;
    const lum = (o[0] * .299 + o[1] * .587 + o[2] * .114) / 255;
    $('glow').style.boxShadow = `0 0 ${40 + lum * 90}px ${css}`;
    $('spillT').style.background = css; $('spillB').style.background = css;
    if (document.body.classList.contains('stage')) {
      $('sGlow').style.background = css;
      $('sGlow').style.boxShadow = `0 0 ${60 + lum * 140}px ${css}`;
      $('sName').textContent = (SK.FX_BY_ID[S.fxId] || {}).n || '—';
      $('sMeta').textContent = `${S.g.name} · ${Math.round(br * 100)}%`;
    }
    $('mRgb').textContent = `${o[0] | 0} ${o[1] | 0} ${o[2] | 0}`;
    $('mHex').textContent = toHex(o).toUpperCase();
    $('mBr').textContent = Math.round(br * 100) + '%';
    hist.push(lum); hist.shift();
    drawScope();
  }

  function drawScope() {
    const w = Math.round(scope.clientWidth * devicePixelRatio);
    const h = Math.round(scope.clientHeight * devicePixelRatio);
    if (scope.width !== w || scope.height !== h) { scope.width = w; scope.height = h; }
    sctx.clearRect(0, 0, w, h);
    const grad = sctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(124,92,255,.85)'); grad.addColorStop(1, 'rgba(0,224,255,.12)');
    sctx.beginPath(); sctx.moveTo(0, h);
    for (let i = 0; i < hist.length; i++) sctx.lineTo(i / (hist.length - 1) * w, h - hist[i] * (h - 3) - 1);
    sctx.lineTo(w, h); sctx.closePath(); sctx.fillStyle = grad; sctx.fill();
    sctx.strokeStyle = 'rgba(255,255,255,.55)'; sctx.lineWidth = 1.2 * devicePixelRatio;
    sctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = i / (hist.length - 1) * w, y = h - hist[i] * (h - 3) - 1;
      i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
    }
    sctx.stroke();
  }

  /* --- transmisión al tubo, a ritmo controlado --- */
  function transmit() {
    const rig = SK.Rig;
    $('pFps').textContent = rig.activos.reduce((n, l) => n + l.stats.bps, 0);
    if (S.previewOnly || BLE.exclusive || !rig.activos.length) return;
    const enviado = rig.broadcast((l) => {
      const g = grupoDe(l);
      const f = SK.FX_BY_ID[g.fxId];
      const kel = g.fxId === 'cct' ? g.p.kelvin : (f && f.usaCCT) || 0;
      const br = dim(g.p.bri);
      if (kel) return { cct: true, kelvin: kel, br };
      const c = SK.histAt(g.hist, l.offset);
      return { rgb: [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])], br };
    });
    const prim = Array.isArray(enviado) ? enviado[0] : enviado;
    if (prim) $('mFrame').textContent = 'TX ' + SK.hex(prim);
  }

  /* =====================================================================
     Audio reactivo
     ===================================================================== */
  const audio = { on: false, ctx: null, an: null, data: null, stream: null };
  async function micOn() {
    try {
      audio.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audio.ctx.createMediaStreamSource(audio.stream);
      audio.an = audio.ctx.createAnalyser();
      audio.an.fftSize = 1024; audio.an.smoothingTimeConstant = .72;
      src.connect(audio.an);
      audio.data = new Uint8Array(audio.an.frequencyBinCount);
      audio.on = true;
      $('btnMic').disabled = true; $('btnMicOff').disabled = false;
      log('Micrófono activo.', 'o'); toast('Micrófono activo');
    } catch (e) { log('Micrófono: ' + e.message, 'e'); toast('No se pudo abrir el micrófono'); }
  }
  function micOff() {
    audio.on = false;
    if (audio.stream) audio.stream.getTracks().forEach((t) => t.stop());
    if (audio.ctx) audio.ctx.close();
    $('btnMic').disabled = false; $('btnMicOff').disabled = true;
    S.p.audio = { level: 0, bass: 0, mid: 0, treble: 0 };
    log('Micrófono detenido.', 'w');
  }
  // Se llama desde engineTick (worker), no desde rAF: asi el audio-reactivo
  // tampoco se congela con la pestana en segundo plano.
  function pumpAudio() {
    if (!audio.on) return;
    audio.an.getByteFrequencyData(audio.data);
    const d = audio.data, n = d.length;               // ~0-11 kHz repartidos en n bins
    const band = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += d[i]; return s / (b - a) / 255; };
    const g = S.gain;
    const A = S.p.audio;
    A.bass = Math.min(1, band(1, Math.floor(n * .05)) * g * 1.5);
    A.mid = Math.min(1, band(Math.floor(n * .05), Math.floor(n * .25)) * g * 1.9);
    A.treble = Math.min(1, band(Math.floor(n * .25), Math.floor(n * .7)) * g * 3.2);
    A.level = Math.min(1, (A.bass * .55 + A.mid * .3 + A.treble * .15) * 1.4);
    const bars = $('bars').children;
    for (let i = 0; i < bars.length; i++) {
      const v = d[Math.floor((i / bars.length) * n * .6)] / 255 * g;
      bars[i].style.height = Math.max(2, Math.min(1, v) * 26) + 'px';
    }
  }

  /* =====================================================================
     Grupos
     ===================================================================== */
  function renderGrupos() {
    const el = $('gtabs'); el.innerHTML = '';
    S.grupos.forEach((g, i) => {
      const f = SK.FX_BY_ID[g.fxId];
      const c = g.shown.map((v) => Math.round(v));
      const n = SK.Rig.lights.filter((l) => (l.group || 0) === i).length;
      const b = document.createElement('button');
      b.className = 'gt' + (i === S.sel ? ' act' : '');
      b.innerHTML = `<span class="gc" style="background:rgb(${c[0]},${c[1]},${c[2]})"></span>` +
        `<span class="gi">${f ? f.i : '?'}</span><span class="gn">${g.name}</span>` +
        `<span style="opacity:.55;font-size:11px">${n}💡</span>` +
        (S.grupos.length > 1 ? `<span class="gx" data-del="${i}">×</span>` : '');
      b.onclick = (e) => {
        if (e.target.dataset.del !== undefined) { borraGrupo(+e.target.dataset.del); return; }
        S.sel = i; sincronizaMandos(); renderGrupos(); renderGrid(); actualizaNow(); cierraPanel(); save();
      };
      b.ondblclick = () => {
        const n2 = prompt('Nombre del grupo', g.name);
        if (n2) { g.name = n2.slice(0, 18); renderGrupos(); save(); }
      };
      el.appendChild(b);
    });
    const add = document.createElement('button');
    add.className = 'gadd'; add.textContent = '+ Grupo';
    add.onclick = () => {
      if (S.grupos.length >= 6) { toast('Máximo seis grupos'); return; }
      S.grupos.push(mkGrupo('Grupo ' + (S.grupos.length + 1)));
      S.sel = S.grupos.length - 1;
      sincronizaMandos(); renderGrupos(); renderRig(); save();
    };
    el.appendChild(add);
  }
  function borraGrupo(i) {
    if (S.grupos.length < 2) return;
    S.grupos.splice(i, 1);
    for (const l of SK.Rig.lights) {
      if ((l.group || 0) === i) l.group = 0;
      else if ((l.group || 0) > i) l.group--;
    }
    S.sel = Math.min(S.sel, S.grupos.length - 1);
    sincronizaMandos(); renderGrupos(); renderRig(); save();
  }

  /* =====================================================================
     Cues — pila de looks con fundido y GO
     ===================================================================== */
  function snapshot() {
    return {
      bri: S.p.bri,
      grupos: S.grupos.map((g) => ({
        name: g.name, fxId: g.fxId,
        p: JSON.parse(JSON.stringify({ ...g.p, audio: undefined }))
      }))
    };
  }
  function aplicaCue(c, fade) {
    if (!c) return;
    const dur = fade !== undefined ? fade : (c.fade || 0);
    c.snap.grupos.forEach((gs, i) => {
      while (S.grupos.length <= i) S.grupos.push(mkGrupo(gs.name || 'Grupo'));
      const g = S.grupos[i];
      if (dur > 0) { g.fadeFrom = g.shown.slice(); g.fadeT0 = performance.now(); g.fadeDur = dur; }
      g.name = gs.name || g.name;
      Object.assign(g.p, gs.p, { audio: AUDIO });
      if (g.fxId !== gs.fxId) {
        const f = SK.FX_BY_ID[gs.fxId];
        g.fxId = gs.fxId; g.st = f && f.init ? f.init(g.p) : {}; g.t0 = performance.now();
      }
    });
    S.grupos.length = c.snap.grupos.length;
    S.sel = Math.min(S.sel, S.grupos.length - 1);
    sincronizaMandos(); renderGrupos(); renderGrid(); actualizaNow(); renderCues(); renderRig();
  }
  function go(dir) {
    if (!S.cues.length) { toast('No hay cues grabadas'); return; }
    let i = S.cueIdx + (dir || 1);
    if (i >= S.cues.length) i = $('chkCueLoop').checked ? 0 : S.cues.length - 1;
    if (i < 0) i = 0;
    S.cueIdx = i;
    aplicaCue(S.cues[i]);
    clearTimeout(S.cueTimer);
    const auto = S.cues[i].auto || 0;
    if (auto > 0) S.cueTimer = setTimeout(() => go(1), auto * 1000);
    save();
  }
  function renderCues() {
    const el = $('cueList'); el.innerHTML = '';
    $('cueInfo').textContent = S.cues.length ? `${S.cueIdx + 1}/${S.cues.length}` : '—';
    if (!S.cues.length) {
      el.innerHTML = '<div class="empty">Sin cues. Ajusta un look y pulsa «Grabar».</div>'; return;
    }
    S.cues.forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'step' + (i === S.cueIdx ? ' act' : '');
      d.innerHTML = `<span style="width:16px;color:var(--tx3);font-size:11px">${i + 1}</span>` +
        `<span class="nm">${c.name}</span>`;
      const f = document.createElement('input');
      f.type = 'number'; f.value = c.fade; f.min = 0; f.max = 600; f.step = .5; f.title = 'fundido (s)';
      f.onchange = () => { c.fade = Math.max(0, +f.value || 0); save(); };
      const a2 = document.createElement('input');
      a2.type = 'number'; a2.value = c.auto || 0; a2.min = 0; a2.max = 999; a2.title = 'auto-encadenar (s), 0 = manual';
      a2.onchange = () => { c.auto = Math.max(0, +a2.value || 0); save(); };
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '×';
      x.onclick = () => { S.cues.splice(i, 1); if (S.cueIdx >= S.cues.length) S.cueIdx = S.cues.length - 1; renderCues(); save(); };
      d.onclick = (e) => { if (e.target === d || e.target.className === 'nm') { S.cueIdx = i - 1; go(1); } };
      d.append(f, a2, x); el.appendChild(d);
    });
  }

  let sincronizaMandos = () => { };
  let abrePanel = () => { };
  let cierraPanel = () => { };
  let panelAbierto = () => false;
  let refrescaPanel = () => { };
  let actualizaNow = () => { };

  /* =====================================================================
     Persistencia
     ===================================================================== */
  function save() {
    try {
      localStorage.setItem(LS, JSON.stringify({
        sel: S.sel, fav: S.fav, cues: S.cues, cueIdx: S.cueIdx, presets: S.presets,
        curva: S.curva, fadeDefecto: S.fadeDefecto,
        grupos: S.grupos.map((g) => ({ name: g.name, fxId: g.fxId, p: { ...g.p, audio: undefined } })),
        fps: S.fps, delta: S.delta, driver: BLE.driver && BLE.driver.id,
        tpl: SK.DRIVERS.custom.tpl, asciiTpl: SK.DRIVERS.ascii_tpl.tpl,
        uuids: S.uuids, sokaniCfg: S.sokaniCfg, camFps: S.camFps
      }));
    } catch (e) { }
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(LS) || '{}');

      if (d.fav) S.fav = d.fav;
      if (d.cues) S.cues = d.cues;
      if (typeof d.cueIdx === 'number') S.cueIdx = d.cueIdx;
      if (d.curva) S.curva = d.curva;
      if (typeof d.fadeDefecto === 'number') S.fadeDefecto = d.fadeDefecto;
      if (d.grupos && d.grupos.length) {
        S.grupos = d.grupos.map((gs) => {
          const g = mkGrupo(gs.name || 'Todas');
          g.fxId = SK.FX_BY_ID[gs.fxId] ? gs.fxId : 'solid';
          Object.assign(g.p, gs.p, { audio: AUDIO });
          const fx = SK.FX_BY_ID[g.fxId];
          g.st = fx && fx.init ? fx.init(g.p) : {};
          return g;
        });
        S.sel = Math.min(d.sel || 0, S.grupos.length - 1);
      }
      if (d.presets) S.presets = d.presets;
      if (d.fps) S.fps = d.fps;
      if (typeof d.delta === 'boolean') S.delta = d.delta;
      if (d.tpl) SK.DRIVERS.custom.tpl = d.tpl;
      if (d.uuids) S.uuids = d.uuids;
      if (d.asciiTpl) SK.DRIVERS.ascii_tpl.tpl = d.asciiTpl;
      if (d.sokaniCfg) S.sokaniCfg = d.sokaniCfg;
      if (d.camFps) S.camFps = d.camFps;

    } catch (e) { }
  }
  function renderPresets() {
    const s = $('selPreset'); s.innerHTML = '';
    for (const k of Object.keys(S.presets)) {
      const o = document.createElement('option'); o.value = k; o.textContent = k; s.appendChild(o);
    }
  }

  /* =====================================================================
     Rig de luces
     ===================================================================== */
  function renderRig() {
    const el = $('rigList'); if (!el.innerHTML && !SK.Rig) return;
    const R = SK.Rig;
    $('rigCount').textContent = R.lights.length
      ? `${R.lights.filter((l) => l.connected).length}/${R.lights.length}` : '0';
    $('btnDisconnect').disabled = !R.lights.length;
    if (!R.lights.length) {
      el.innerHTML = navigator.bluetooth
        ? '<div class="empty">Ninguna luz. Pulsa «Añadir luz».</div>'
        : '<div class="empty">Este navegador no tiene Bluetooth.<br>Todo funciona en modo ensayo.</div>';
      return;
    }
    el.innerHTML = '';
    R.lights.forEach((l, i) => {
      const t = l.telemetry;
      const bat = t.bv !== undefined ? (t.bv / 10) : null;
      const temp = t.tempC;
      const d = document.createElement('div');
      d.className = 'lit' + (l.enabled ? '' : ' off') + (l.connected ? '' : ' down');
      const avisoBat = bat !== null && bat < 11.5;
      const avisoTmp = temp !== undefined && temp > 60;
      d.innerHTML =
        `<div class="top">
           <span class="dot2 ${l.connected ? 'on' : 'down'}"></span>
           <span class="bdot" style="background:${SK.brandOf(l).color};width:8px;height:8px;border-radius:2px;flex:none" title="${SK.brandOf(l).name}"></span>
           <span class="nm">${l.name}</span>
           <select data-grp="${i}" style="width:auto;padding:3px 6px;font-size:11px" title="Grupo">
             ${S.grupos.map((g, gi) => `<option value="${gi}" ${(l.group || 0) === gi ? 'selected' : ''}>${g.name}</option>`).join('')}
           </select>
           <label class="sw" style="padding:0"><input type="checkbox" ${l.enabled ? 'checked' : ''} data-en="${i}"></label>
           <button class="x" data-rm="${i}">×</button>
         </div>
         <div class="tele">
           ${bat !== null ? `<span class="${avisoBat ? 'warn' : ''}">🔋 <b>${bat.toFixed(1)} V</b></span>` : ''}
           ${temp !== undefined ? `<span class="${avisoTmp ? 'err' : ''}">🌡 <b>${temp.toFixed(0)}°</b></span>` : ''}
           ${l.connected ? `<span>${l.stats.bps} p/s</span>` : '<span class="err">sin conexión</span>'}
         </div>
         <div class="sliders">
           <span>brillo</span><input type="range" min="0" max="100" value="${Math.round(l.trim * 100)}" data-trim="${i}"><b>${Math.round(l.trim * 100)}%</b>
           <span>desfase</span><input type="range" min="0" max="200" value="${Math.round(l.offset * 100)}" data-off="${i}"><b>${l.offset.toFixed(2)}s</b>
         </div>`;
      el.appendChild(d);
    });
    el.querySelectorAll('[data-grp]').forEach((sel) => {
      sel.onchange = () => {
        const l = R.lights[+sel.dataset.grp];
        l.group = +sel.value; l.forget(); saveRig(); renderGrupos();
      };
    });
    el.querySelectorAll('[data-en]').forEach((c) => {
      c.onchange = () => { R.lights[+c.dataset.en].enabled = c.checked; R.forgetAll(); renderRig(); saveRig(); };
    });
    el.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = () => { R.remove(R.lights[+b.dataset.rm].id); saveRig(); };
    });
    el.querySelectorAll('[data-trim]').forEach((r) => {
      r.oninput = () => {
        const l = R.lights[+r.dataset.trim]; l.trim = +r.value / 100; l.forget();
        r.nextElementSibling.textContent = r.value + '%'; saveRig();
      };
    });
    el.querySelectorAll('[data-off]').forEach((r) => {
      r.oninput = () => {
        const l = R.lights[+r.dataset.off]; l.offset = +r.value / 100; l.forget();
        r.nextElementSibling.textContent = l.offset.toFixed(2) + 's'; saveRig();
      };
    });
  }

  function saveRig() {
    try {
      localStorage.setItem('sokani.rig', JSON.stringify(
        SK.Rig.lights.map((l) => ({ id: l.id, trim: l.trim, offset: l.offset, enabled: l.enabled, group: l.group }))));
    } catch (e) { }
  }
  function loadRigPrefs(l) {
    try {
      const d = JSON.parse(localStorage.getItem('sokani.rig') || '[]');
      const p = d.find((x) => x.id === l.id);
      if (p) { l.trim = p.trim ?? 1; l.offset = p.offset ?? 0; l.enabled = p.enabled !== false; l.group = p.group || 0; }
    } catch (e) { }
  }

  /* --- avisos de set: batería y temperatura, con la telemetría del propio tubo --- */
  const avisado = {};
  function alerta(clave, titulo, texto, grave) {
    if (avisado[clave] && performance.now() - avisado[clave] < 120000) return;
    avisado[clave] = performance.now();
    const box = $('alerts');
    const d = document.createElement('div');
    d.className = 'alert' + (grave ? ' err' : '');
    d.innerHTML = `<b>${titulo}</b>${texto}`;
    d.onclick = () => d.remove();
    box.appendChild(d);
    setTimeout(() => d.remove(), 15000);
  }

  /* =====================================================================
     Bluetooth: UI
     ===================================================================== */
  function renderDrivers() {
    const s = $('selDriver'); s.innerHTML = '';
    for (const id of SK.DRIVER_ORDER) {
      const d = SK.DRIVERS[id];
      const o = document.createElement('option'); o.value = id; o.textContent = d.name; s.appendChild(o);
    }
    s.onchange = () => {
      const d = SK.DRIVERS[s.value];
      BLE.setDriver(d);
      $('driverNote').textContent = d.note;
      const w = BLE.autoPick(d); if (w) { BLE.setTx(w); syncCharSel(); }
      save();
    };
    s.value = 'sokani_rgb'; s.onchange();
  }

  function syncCharSel() {
    const s = $('selChar'); s.innerHTML = '';
    if (!BLE.writables.length) { s.innerHTML = '<option>— sin características escribibles —</option>'; return; }
    BLE.writables.forEach((w, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = `${SK.short(w.uuid)}  [${w.props}]  · svc ${SK.short(w.svc)}`;
      s.appendChild(o);
    });
    const idx = BLE.writables.indexOf(BLE.tx);
    s.value = idx >= 0 ? idx : 0;
    s.onchange = () => { BLE.setTx(BLE.writables[+s.value]); };
  }

  function renderGatt() {
    const el = $('gattTree');
    if (!BLE.services.length) { el.textContent = 'Sin datos GATT.'; return; }
    el.innerHTML = '';
    for (const s of BLE.services) {
      const d = document.createElement('div'); d.className = 's';
      d.textContent = '▸ ' + SK.short(s.uuid) + '   ' + s.uuid;
      el.appendChild(d);
      for (const c of s.chars) {
        const cd = document.createElement('div'); cd.className = 'c';
        cd.innerHTML = `· ${SK.short(c.uuid)} <b>[${c.props || '—'}]</b>`;
        el.appendChild(cd);
      }
    }
  }

  BLE.onState = () => {
    const n = SK.Rig.lights.filter((l) => l.connected).length;
    $('ledConn').className = 'led' + (n ? ' on' : '');
    $('devName').textContent = n === 0 ? 'Sin luces'
      : n === 1 ? (SK.Rig.active.name) : `${n} luces`;
    $('btnDisconnect').disabled = !n;
    $('pProto').textContent = BLE.driver ? BLE.driver.name.replace('★ Sokani X25 · ', '') : '—';
    $('pTx').textContent = BLE.tx ? SK.short(BLE.tx.uuid) : '—';
    if (typeof renderRig === 'function') renderRig();
  };

  /* =====================================================================
     Cableado de la interfaz
     ===================================================================== */
  function bindSlider(id, vId, key, fmt, map) {
    const el = $(id);
    const upd = () => {
      const raw = +el.value;
      const v = map ? map(raw) : raw;
      S.p[key] = v;
      $(vId).textContent = fmt(v);
      refrescaPanel(key);
      save();
    };
    el.oninput = upd;
    return { el, upd };
  }

  function init() {
    load();

    // controles maestros
    const bri = bindSlider('sBri', 'vBri', 'bri', (v) => Math.round(v * 100) + '%', (r) => r / 100);
    const spd = bindSlider('sSpd', 'vSpd', 'speed', (v) => v.toFixed(2) + '×', (r) => r / 100);
    const int = bindSlider('sInt', 'vInt', 'intensity', (v) => Math.round(v * 100) + '%', (r) => r / 100);
    const hue = bindSlider('sHue', 'vHue', 'hue', (v) => Math.round(v) + '°');
    const sat = bindSlider('sSat', 'vSat', 'sat', (v) => Math.round(v * 100) + '%', (r) => r / 100);
    const kel = bindSlider('sKel', 'vKel', 'kelvin', (v) => Math.round(v) + ' K');
    const smo = bindSlider('sSm', 'vSm', 'smooth', (v) => Math.round(v * 100) + '%', (r) => r / 100);
    const gmS = bindSlider('sGm', 'vGm', 'gm', (v) => (v > 0 ? '+' : '') + Math.round(v * 100), (r) => r / 100);
    // reflejar estado cargado
    $('sBri').value = S.p.bri * 100; $('sSpd').value = S.p.speed * 100;
    $('sInt').value = S.p.intensity * 100; $('sHue').value = S.p.hue;
    $('sSat').value = S.p.sat * 100; $('sKel').value = S.p.kelvin; $('sSm').value = S.p.smooth * 100;
    [bri, spd, int, hue, sat, kel, smo, gmS].forEach((s) => s.upd());

    $('sFps').value = S.fps; $('vFps').textContent = S.fps;
    $('sFps').oninput = (e) => { S.fps = +e.target.value; $('vFps').textContent = S.fps; save(); };
    $('chkDelta').checked = S.delta;
    $('chkDelta').onchange = (e) => { S.delta = e.target.checked; SK.Rig.forgetAll(); save(); };
    $('chkPreviewOnly').onchange = (e) => { S.previewOnly = e.target.checked; };
    $('chkDuck').onchange = (e) => { S.duck = e.target.checked; };
    $('chkBeatSync').onchange = (e) => { S.beatSync = e.target.checked; };
    $('sGain').oninput = (e) => { S.gain = +e.target.value / 100; $('vGain').textContent = S.gain.toFixed(1) + '×'; };
    $('bpm').onchange = (e) => { S.p.bpm = U.clamp(+e.target.value, 20, 300); save(); };

    // barras del analizador
    const bars = $('bars'); for (let i = 0; i < 24; i++) bars.appendChild(document.createElement('div'));

    // buscador y rejilla
    $('search').oninput = (e) => { S.q = e.target.value; renderGrid(); };
    $('btnRandom').onclick = () => {
      const l = visibleFx(); if (l.length) setFx(l[Math.floor(Math.random() * l.length)].id);
    };
    $('btnFav').onclick = () => toggleFav(S.fxId);
    $('fxText').value = S.p.text || 'SOS';
    $('fxText').oninput = (e) => { S.p.text = e.target.value || 'SOS'; save(); };
    $('btnAddSeq').onclick = () => $('btnCueRec').click();

    // blackout
    $('btnBlackout').onclick = () => {
      S.blackout = !S.blackout;
      $('btnBlackout').classList.toggle('on', !S.blackout);
      $('btnBlackout').textContent = S.blackout ? '⏻ APAGADO' : '⏻ Blackout';
      if (S.blackout) BLE.sendPower(false); else BLE.sendPower(true);
    };

    // secuenciador


    // presets
    $('btnSavePreset').onclick = () => {
      const n = ($('presetName').value || '').trim(); if (!n) { toast('Ponle un nombre'); return; }
      S.presets[n] = { fxId: S.fxId, p: JSON.parse(JSON.stringify({ ...S.p, audio: undefined })) };
      renderPresets(); save(); toast('Preset guardado: ' + n);
    };
    $('btnLoadPreset').onclick = () => {
      const k = $('selPreset').value; const pr = S.presets[k]; if (!pr) return;
      Object.assign(S.p, pr.p, { audio: S.p.audio });
      $('sBri').value = S.p.bri * 100; $('sSpd').value = S.p.speed * 100;
      $('sInt').value = S.p.intensity * 100; $('sHue').value = S.p.hue;
      $('sSat').value = S.p.sat * 100; $('sKel').value = S.p.kelvin; $('sSm').value = S.p.smooth * 100;
      [bri, spd, int, hue, sat, kel, smo, gmS].forEach((s) => s.upd());
      setFx(pr.fxId); toast('Preset cargado: ' + k);
    };
    $('btnDelPreset').onclick = () => {
      const k = $('selPreset').value; if (!k) return;
      delete S.presets[k]; renderPresets(); save();
    };

    // tap tempo
    $('btnTap').onclick = tap;
    function tap() {
      const now = performance.now();
      S.taps = S.taps.filter((t) => now - t < 2500); S.taps.push(now);
      if (S.taps.length >= 2) {
        let sum = 0; for (let i = 1; i < S.taps.length; i++) sum += S.taps[i] - S.taps[i - 1];
        const bpm = U.clamp(Math.round(60000 / (sum / (S.taps.length - 1))), 20, 300);
        S.p.bpm = bpm; $('bpm').value = bpm; save();
      }
    }

    // audio
    $('btnMic').onclick = micOn; $('btnMicOff').onclick = micOff;

    /* ---------------- Bluetooth ---------------- */
    if (SK.native) {
      // En la app nativa CoreBluetooth entrega todos los servicios: ni hay que
      // declarar UUID, ni existe el problema de contexto seguro de Chrome.
      $('warnBox').innerHTML = '<b>App nativa iOS.</b> Aquí el Bluetooth va por CoreBluetooth, ' +
        'que expone <b>todos</b> los servicios del tubo, también los propietarios de 128 bits. ' +
        'No hace falta declarar UUID ni usar Chrome.';
      $('cardUuid').style.display = 'none';
      $('chkWide').closest('.sw').style.display = 'none';
      $('chkFilter').closest('.sw').style.display = 'none';
      $('btnConnect').textContent = 'Buscar luces';
    } else if (!BLE.supported()) {
      $('warnBox').innerHTML = '<b>⚠︎ Este navegador no soporta Web Bluetooth.</b> ' +
        'La consola funciona igual en modo ensayo (previsualización en pantalla), pero para controlar ' +
        'el tubo necesitas Chrome o Edge de escritorio, o Chrome en Android.';
      $('btnConnect').disabled = true;
    }
    $('chkFilter').onchange = (e) => { $('namePrefix').style.display = e.target.checked ? 'block' : 'none'; };
    /* --- rig --- */
    SK.Rig.log = log;
    SK.Rig.onChange = () => { renderRig(); BLE.onState(); };
    SK.Rig.onTelemetry = (l) => {
      const t = l.telemetry;
      if (t.bv !== undefined && t.bv / 10 < 11.0)
        alerta('bat' + l.id, `🔋 ${l.name}: batería baja`, `${(t.bv / 10).toFixed(1)} V — cambia o enchufa antes de la próxima toma.`, true);
      else if (t.bv !== undefined && t.bv / 10 < 11.8)
        alerta('bat2' + l.id, `🔋 ${l.name}: batería al límite`, `${(t.bv / 10).toFixed(1)} V.`, false);
      if (t.tempC !== undefined && t.tempC > 70)
        alerta('tmp' + l.id, `🌡 ${l.name}: demasiado caliente`, `${t.tempC.toFixed(0)} °C — puede bajar potencia sola.`, true);
      renderRig();
    };
    $('chkAutoRe').onchange = (e) => { SK.Rig.autoReconnect = e.target.checked; };
    $('btnAddLight').onclick = async () => {
      if (!navigator.bluetooth) {
        const P = SK.pwa ? SK.pwa.plataforma() : {};
        const msg = P.ios
          ? 'En iPhone, Safari no tiene Bluetooth. Usa la app nativa o ábrela en el navegador Bluefy.'
          : !window.isSecureContext
            ? 'El Bluetooth necesita https o localhost. Abre la consola desde http://localhost.'
            : 'Este navegador no tiene Bluetooth. Usa Chrome o Edge (en ordenador o Android).';
        toast(msg); log(msg, 'w');
        return;
      }
      try {
        // En modo Sokani el selector enseña solo tubos Sokani, no todo lo que
        // tenga Bluetooth alrededor. Cualquier otro aparato sigue a mano desde
        // ⚙︎ › Conexión › Buscar luz.
        const opts = SK.CONFIG.soloSokani
          ? { filters: SK.SOKANI_PREFIJOS.map((namePrefix) => ({ namePrefix })), optionalServices: SK.optionalServices(true) }
          : { acceptAllDevices: true, optionalServices: SK.optionalServices(true) };
        const dev = await navigator.bluetooth.requestDevice(opts);
        const l = await SK.Rig.adopt(dev);
        loadRigPrefs(l); renderRig(); saveRig();
        toast(`${l.name} añadida`);
      } catch (e) {
        if (!/cancel/i.test(e.message)) { log('Añadir luz: ' + e.message, 'e'); toast(e.message.slice(0, 70)); }
      }
    };
    $('btnRestore').onclick = async () => {
      const n = await SK.Rig.restore();
      SK.Rig.lights.forEach(loadRigPrefs);
      renderRig();
      toast(n ? `${n} luz/luces recuperadas` : 'Nada que recuperar');
    };
    // Al abrir la consola, recuperar solas las luces ya autorizadas antes.
    // ?norestore=1 lo desactiva (util para depurar sin hardware delante).
    if (!/[?&]norestore/.test(location.search)) setTimeout(async () => {
      try {
        const n = await SK.Rig.restore();
        SK.Rig.lights.forEach(loadRigPrefs);
        renderRig();
        if (n) { log(`${n} luz/luces reconectadas automáticamente.`, 'o'); toast(`${n} luz/luces listas`); }
      } catch (e) { }
    }, 400);

    /* --- pantalla siempre despierta: en un set, que se apague a mitad de
           una toma es inaceptable --- */
    let wake = null;
    const pedirWake = async () => {
      if (!('wakeLock' in navigator)) return;
      try { wake = await navigator.wakeLock.request('screen'); }
      catch (e) { }
    };
    pedirWake();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !wake) pedirWake();
    });

    /* --- bloqueo de pantalla: evita tocar un control sin querer --- */
    let bloq = false;
    $('btnLock').onclick = () => {
      bloq = !bloq;
      document.body.classList.toggle('locked', bloq);
      $('btnLock').textContent = bloq ? '🔒' : '🔓';
      $('btnLock').classList.toggle('on', bloq);
      toast(bloq ? 'Pantalla bloqueada · pulsa el candado para soltar' : 'Desbloqueada');
    };

    /* --- estrobo seguro para cámara ---
       Un estrobo cuya frecuencia no sea múltiplo de los fotogramas por segundo
       produce bandas y parpadeo irregular en el material grabado. */
    const FPS_CAM = [23.976, 24, 25, 29.97, 30, 48, 50, 60];
    $('selCamFps').onchange = () => {
      const f = +$('selCamFps').value;
      S.camFps = f; save();
      if (!f) { toast('Estrobo libre'); return; }
      ajustaEstrobo();
    };
    function ajustaEstrobo() {
      if (!S.camFps) return;
      // La velocidad del motor se redondea al múltiplo entero de fps más cercano.
      const hzActual = 2 + S.p.intensity * 22;
      const mult = Math.max(1, Math.round(hzActual / S.camFps));
      const hz = mult * S.camFps;
      S.p.intensity = U.clamp((hz - 2) / 22, 0, 1);
      $('sInt').value = Math.round(S.p.intensity * 100);
      $('vInt').textContent = Math.round(S.p.intensity * 100) + '%';
      $('camHint').textContent = `${hz.toFixed(2)} Hz · ${mult}× por fotograma`;
      save();
    }
    $('sInt').addEventListener('change', () => { if (S.camFps) ajustaEstrobo(); });
    if (S.camFps) { $('selCamFps').value = S.camFps; }

    /* --- modo avanzado --- */
    const setAdv = (on) => {
      document.body.classList.toggle('adv', on);
      $('btnAdv').classList.toggle('on', on);
      $('btnAdv').title = on ? 'Ocultar herramientas técnicas' : 'Mostrar herramientas técnicas';
      try { localStorage.setItem('sokani.adv', on ? '1' : '0'); } catch (e) { }
    };
    $('btnAdv').onclick = () => setAdv(!document.body.classList.contains('adv'));
    setAdv(localStorage.getItem('sokani.adv') === '1');

    $('btnConnect').onclick = async () => {
      try {
        await BLE.connect({
          wide: $('chkWide').checked,
          namePrefix: $('chkFilter').checked ? $('namePrefix').value.trim() : ''
        });
        renderGatt(); syncCharSel();
        const d = SK.DRIVERS[$('selDriver').value];
        const w = BLE.autoPick(d); if (w) { BLE.setTx(w); syncCharSel(); }
        toast('Conectado. Si no reacciona, usa el escáner de protocolo.');
      } catch (e) { log('Conexión: ' + e.message, 'e'); toast(e.message.slice(0, 70)); }
    };
    $('btnDisconnect').onclick = () => BLE.disconnect();
    $('btnPwrOn').onclick = () => BLE.sendPower(true);
    $('btnPwrOff').onclick = () => BLE.sendPower(false);

    renderDrivers();

    // escáner
    $('btnScan').onclick = async () => {
      if (!BLE.connected || !BLE.writables.length) {
        toast('Conecta la luz primero: no hay nada que escanear');
        log('Escáner: sin conexión o sin características escribibles.', 'w');
        return;
      }
      $('probeBox').style.display = 'block';
      $('btnScan').disabled = true; $('btnScanStop').disabled = false;
      $('protoState').textContent = 'escaneando…';
      await BLE.startScan(SK.DRIVER_ORDER, (i, n, c) => {
        $('probeN').textContent = `${i + 1}/${n}`;
        $('probeCur').textContent = `${c.d.name}  →  ${SK.short(c.w.uuid)} [${c.w.props}]`;
      });
      $('btnScan').disabled = false; $('btnScanStop').disabled = true;
      if ($('protoState').textContent === 'escaneando…') $('protoState').textContent = 'no verificado';
    };
    $('btnScanStop').onclick = () => { BLE.stopScan(); $('protoState').textContent = 'no verificado'; };
    $('btnLock').onclick = () => {
      const c = BLE.lockScan();
      if (c) {
        $('selDriver').value = c.d.id; $('driverNote').textContent = c.d.note;
        syncCharSel(); renderGatt();
        $('probeBox').style.display = 'none'; $('protoState').textContent = '✔ verificado';
        $('btnScan').disabled = false; $('btnScanStop').disabled = true;
        toast('Protocolo fijado: ' + c.d.name); save();
      }
    };

    /* --- diagnostico --- */
    $('btnDiag').onclick = async () => {
      const rows = await BLE.diagnose();
      const el = $('diagOut'); el.innerHTML = '';
      for (const r of rows) {
        const d = document.createElement('div');
        d.className = 'diag ' + (r.info ? 'i' : r.ok ? 'y' : 'n');
        d.innerHTML = `<span class="mk">${r.info ? '!' : r.ok ? '✔' : '✕'}</span>` +
          `<span>${r.t}${r.fix ? `<span class="fx2">→ ${r.fix}</span>` : ''}</span>`;
        el.appendChild(d);
      }
    };

    /* --- UUID propios: sin esto, un servicio de 128 bits es invisible --- */
    $('uuidList').value = (S.uuids || []).join('\n');
    SK.setCustomUUIDs($('uuidList').value);
    $('btnUuid').onclick = async () => {
      const list = SK.setCustomUUIDs($('uuidList').value);
      S.uuids = list; save();
      $('uuidList').value = list.join('\n');
      log(`UUID propios: ${list.length} declarados.`, list.length ? 'o' : 'w');
      if (!list.length) { toast('No se reconoció ningún UUID válido'); return; }
      if (BLE.connected) { await BLE.disconnect(); }
      toast('Guardados. Pulsa «Buscar luz» y vuelve a elegir el tubo.');
    };

    /* --- escopeta y escucha --- */
    $('btnShotgun').onclick = async () => {
      if (!BLE.connected) { toast('Conecta la luz primero'); return; }
      const was = S.previewOnly; S.previewOnly = true;      // que el motor no pise el disparo
      log('Escopeta: disparando rojo por todo…', 'm');
      await BLE.shotgun(255, 0, 0, 1);
      await new Promise((r) => setTimeout(r, 700));
      await BLE.shotgun(0, 0, 255, 1);
      S.previewOnly = was;
      toast('¿Reaccionó? Entonces usa el escáner para saber con qué');
    };
    $('btnListen').onclick = async () => {
      if (!BLE.connected) { toast('Conecta la luz primero'); return; }
      await BLE.listenAll();
    };
    $('btnIdent').onclick = async () => {
      if (!BLE.connected) { toast('Conecta la luz primero'); return; }
      const was = S.previewOnly; S.previewOnly = true;   // que el motor no pise las consultas
      await BLE.listenAll();
      const n = await BLE.identityProbe();
      S.previewOnly = was;
      toast(n ? `El tubo contestó ${n} vez/veces — mira el registro` : 'Sin respuesta; prueba la escopeta');
    };

    /* --- modo de escritura --- */
    $('selWriteMode').onchange = (e) => { BLE.writeMode = e.target.value; log('Modo de escritura: ' + e.target.value, 'm'); };
    $('sGap').oninput = (e) => { BLE.writeGap = +e.target.value; $('vGap').textContent = BLE.writeGap + ' ms'; };

    /* --- calibracion del protocolo Sokani --- */
    const cfgUI = () => {
      const c = SK.SOKANI.cfg;
      c.chk = +$('cfgChk').value; c.adjustType = +$('cfgAT').value;
      c.channel = +$('cfgCh').value; c.group = +$('cfgGr').value;
      SK.DRIVERS.sokani_rgb._last = {}; SK.DRIVERS.sokani_hsi._last = {};
      S.sokaniCfg = { ...c }; save();
    };
    ['cfgChk', 'cfgAT', 'cfgCh', 'cfgGr'].forEach((id) => { $(id).onchange = cfgUI; });
    const pintaCfg = () => {
      const c = SK.SOKANI.cfg;
      $('cfgChk').value = c.chk; $('cfgAT').value = c.adjustType;
      $('cfgCh').value = c.channel; $('cfgGr').value = c.group;
    };
    if (S.sokaniCfg) { Object.assign(SK.SOKANI.cfg, S.sokaniCfg); }
    pintaCfg();

    const disparo = async (r, g, b) => {
      if (!BLE.connected) { toast('Conecta la luz primero'); return; }
      const was = S.previewOnly; S.previewOnly = true;
      await BLE.listenAll();
      await BLE.withRadio(async () => {
        const d = SK.DRIVERS[$('selDriver').value.startsWith('sokani') ? $('selDriver').value : 'sokani_rgb'];
        d._last = {};
        try { await BLE.write(d.rgb(r, g, b, 1)); log(`→ ${SK.hex(d.rgb(r, g, b, 1) || new Uint8Array())}`, 'o'); }
        catch (e) { log('Envío: ' + e.message, 'e'); }
      });
      S.previewOnly = was;
    };
    $('btnCalRed').onclick = () => disparo(255, 0, 0);
    $('btnCalOff').onclick = () => disparo(0, 0, 0);

    $('btnCalReset').onclick = async () => {
      await BLE.resetProtocol();
      $('selDriver').value = 'sokani_rgb'; $('selDriver').onchange();
      pintaCfg(); S.sokaniCfg = { ...SK.SOKANI.cfg }; save();
      toast('Protocolo por defecto restaurado');
    };
    $('btnCal').onclick = async () => {
      if (!BLE.connected) { toast('Conecta la luz primero'); return; }
      BLE._abortCal = false; BLE._calHit = null;
      $('btnCal').disabled = true; $('btnCalStop').disabled = false;
      $('calBox').style.display = 'block';
      const was = S.previewOnly; S.previewOnly = true;
      const hit = await BLE.calibrate((i, n, c) => {
        $('calN').textContent = `${i + 1}/${n}`;
        $('calCur').textContent = `${c.drv.replace('sokani_', '')} · suma=${c.chk} aT=${c.aT} gr=${c.gr}`;
      });
      S.previewOnly = was;
      $('btnCal').disabled = false; $('btnCalStop').disabled = true;
      $('calBox').style.display = 'none';
      pintaCfg(); S.sokaniCfg = { ...SK.SOKANI.cfg }; save();
      if (hit) {
        $('selDriver').value = hit.drv; $('selDriver').onchange();
        $('protoState').textContent = '✔ verificado';
        toast('¡Protocolo fijado!');
      } else toast('Sin acierto · configuración anterior restaurada');
    };
    $('btnCalHit').onclick = () => { BLE.confirmCal(); toast('Fijando…'); };
    $('btnCalStop').onclick = () => { BLE._abortCal = true; };

    /* --- terminal de texto ---
       Candidatos construidos a partir del vocabulario que el propio tubo usa:
       nombre corto + ':' + valores separados por coma o guion. */
    // El tubo dejó escapar «AT+STAT», así que su firmware habla AT.
    // Ese vocabulario es acotado: merece la pena barrerlo entero.
    const AT_SUGERIDOS = [
      'AT', 'AT+STAT', 'AT+HELP', 'AT+VER', 'AT+VERSION', 'AT+INFO',
      'AT+ON', 'AT+OFF', 'AT+PW=1', 'AT+POWER=1',
      'AT+RGB=255,0,0', 'AT+RGB=255-0-0', 'AT+RGB255,0,0', 'AT+RGB=FF0000',
      'AT+COL=255,0,0', 'AT+COLOR=255,0,0', 'AT+LED=255,0,0',
      'AT+HSI=0,100,100', 'AT+HSI=0-100-100', 'AT+HSV=0,100,100',
      'AT+H=0', 'AT+S=100', 'AT+I=100', 'AT+B=100', 'AT+BR=100', 'AT+BRI=100',
      'AT+CCT=5600', 'AT+K=5600', 'AT+MODE=1', 'AT+M=1', 'AT+FX=1'
    ];
    // Ultimo cartucho barato: devolverle al tubo SUS PROPIAS cadenas de tecla.
    // Si su parser de comandos reutiliza el formato de su salida de depuracion,
    // esto equivale a pulsarle los botones por control remoto.
    const ECO_TECLAS = [
      'k:4-3a-', 'k:5-43-', 'k:6-40-', 'k:7-50-', 'k:8-51-', 'k:9-52-', 'k:a-53-',
      'k:4-3a', 'k:7-50', 'k4-3a-', 'AT+STAT', 'ad:', 'chg:'
    ];
    const ASCII_SUGERIDOS = [
      '?', 'help', 'AT', 'info', 'ver', '$',
      'c:255,0,0', 'C:255,0,0', 'rgb:255,0,0', 'RGB:255,0,0',
      'col:255,0,0', 'led:255,0,0', 'set:255,0,0',
      'c:255-0-0-', 'rgb:255-0-0-',
      'h:0-', 'h:0', 'hue:0', 'H:0',
      's:100-', 'i:100-', 'b:100-', 'br:100', 'bright:100',
      'hsi:0,100,100', 'hsv:0,100,100',
      'm:1-', 'mode:1', 'k:1-'
    ];
    $('asciiList').value = AT_SUGERIDOS.join('\n');   // arrancamos por la pista buena
    $('btnAsciiReset').onclick = () => { $('asciiList').value = AT_SUGERIDOS.join('\n'); };
    $('btnAsciiOther').onclick = () => { $('asciiList').value = ASCII_SUGERIDOS.join('\n'); };
    $('btnAsciiKeys').onclick = () => { $('asciiList').value = ECO_TECLAS.join('\n'); };
    $('btnAsciiSend').onclick = async () => {
      if (!BLE.connected) { toast('Conecta la luz primero'); return; }
      const cmd = $('asciiOne').value;
      await BLE.withRadio(async () => {
        try { await BLE.writeLine(cmd); log(`→ «${cmd}»`, 'o'); }
        catch (e) { log('Envío ASCII: ' + e.message, 'e'); }
      });
    };
    $('btnAsciiProbe').onclick = async () => {
      if (!BLE.connected) { toast('Conecta la luz primero'); return; }
      await BLE.listenAll();
      const lines = $('asciiList').value.split('\n').map((x) => x.trim()).filter(Boolean);
      const n = await BLE.asciiProbe(lines);
      toast(n ? `${n} respuesta(s) nueva(s) — mira el registro` : 'Ninguna respuesta nueva');
    };
    $('asciiTpl').value = SK.DRIVERS.ascii_tpl.tpl.rgb;
    $('btnAsciiTpl').onclick = () => {
      SK.DRIVERS.ascii_tpl.tpl.rgb = $('asciiTpl').value;
      const demo = SK.DRIVERS.ascii_tpl.rgb(255, 128, 0, .8);
      log('Plantilla de texto OK · R255 G128 B0 → «' +
        new TextDecoder().decode(demo).replace(/[\r\n]/g, '·') + '»', 'o');
      $('selDriver').value = 'ascii_tpl'; $('selDriver').onchange();
      toast('Plantilla guardada y protocolo activado');
      save();
    };

    // laboratorio de tramas
    $('btnRaw').onclick = async () => {
      try { await BLE.writeRaw(SK.parseHex($('rawHex').value)); }
      catch (e) { log('Envío manual: ' + e.message, 'e'); toast(e.message.slice(0, 70)); }
    };
    $('tplRgb').value = SK.DRIVERS.custom.tpl.rgb;
    $('btnTpl').onclick = () => {
      SK.DRIVERS.custom.tpl.rgb = $('tplRgb').value;
      try {
        const demo = SK.tplBytes($('tplRgb').value, { r: 255, g: 128, b: 0, br: .8 });
        log('Plantilla OK · ejemplo R255 G128 B0 → ' + SK.hex(demo), 'o');
        toast('Plantilla guardada');
      } catch (e) { log('Plantilla inválida: ' + e.message, 'e'); }
      save();
    };
    $('btnClrLog').onclick = () => { $('log').innerHTML = ''; };
    $('btnCopyLog').onclick = async () => {
      try { await navigator.clipboard.writeText($('log').innerText); toast('Registro copiado'); }
      catch (e) { toast('No se pudo copiar; selecciónalo a mano'); }
    };
    $('btnRead').onclick = async () => {
      if (!BLE.connected) { toast('Conecta la luz primero'); return; }
      await BLE.readAll();
    };

    /* ---------------- teclado ---------------- */
    document.addEventListener('keydown', (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (e.code === 'Space') { e.preventDefault(); $('btnBlackout').click(); return; }
      if (k === 's' && !S.strobeHold) { S.strobeHold = S.fxId; setFx('strobe', true); return; }
      if (k === 'r') { $('btnRandom').click(); return; }
      if (k === 'b') { tap(); return; }
      if (k === 'escape') { clearTimeout(S.cueTimer); return; }
      if (k === 'g') { go(1); return; }
      if (k >= '1' && k <= '9') { const id = S.fav[+k - 1]; if (id) setFx(id); return; }
      const nudge = (sl, d) => { sl.el.value = +sl.el.value + d; sl.upd(); };
      if (e.key === 'ArrowUp') { e.preventDefault(); nudge(bri, 5); }
      if (e.key === 'ArrowDown') { e.preventDefault(); nudge(bri, -5); }
      if (e.key === 'ArrowRight') { e.preventDefault(); nudge(spd, 10); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(spd, -10); }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key.toLowerCase() === 's' && S.strobeHold) { setFx(S.strobeHold, true); S.strobeHold = null; }
    });

    /* --- los mandos maestros siguen al grupo seleccionado --- */
    sincronizaMandos = () => {
      const p = S.p;
      $('sBri').value = $('sBri2') ? $('sBri2').value : $('sBri').value;
      $('sBri').value = Math.round(p.bri * 100);
      $('sSpd').value = Math.round(p.speed * 100);
      $('sInt').value = Math.round(p.intensity * 100);
      $('sHue').value = Math.round(p.hue);
      $('sSat').value = Math.round(p.sat * 100);
      $('sKel').value = Math.round(p.kelvin);
      $('sSm').value = Math.round(p.smooth * 100);
      $('sGm').value = Math.round((p.gm || 0) * 100);
      $('bpm').value = Math.round(p.bpm);
      $('fxText').value = p.text || 'SOS';
      [bri, spd, int, hue, sat, kel, smo, gmS].forEach((x) => x.upd());
    };
    actualizaNow = () => {
      const f = SK.FX_BY_ID[S.fxId];
      if (!f) return;
      $('nowIc').textContent = f.i; $('nowName').textContent = f.n; $('nowDesc').textContent = f.d;
      $('fxText').style.display = S.fxId === 'morse' ? 'block' : 'none';
    };

    /* --- curva de dimado --- */
    $('selCurva').value = S.curva;
    $('selCurva').onchange = (e) => { S.curva = e.target.value; SK.Rig.forgetAll(); save(); };

    /* --- cues --- */
    $('sFade').oninput = (e) => { S.fadeDefecto = +e.target.value / 10; $('vFade').textContent = S.fadeDefecto.toFixed(1) + ' s'; save(); };
    $('btnCueRec').onclick = () => {
      const n = prompt('Nombre del cue', 'Cue ' + (S.cues.length + 1));
      if (n === null) return;
      S.cues.push({ name: n || ('Cue ' + (S.cues.length + 1)), snap: snapshot(), fade: S.fadeDefecto || 2, auto: 0 });
      S.cueIdx = S.cues.length - 1;
      renderCues(); save(); toast('Cue grabado');
    };
    $('btnGo').onclick = () => go(1);
    $('btnCuePrev').onclick = () => go(-1);
    $('btnCueClr').onclick = () => { S.cues = []; S.cueIdx = -1; clearTimeout(S.cueTimer); renderCues(); save(); };

    /* --- color desde una imagen de referencia --- */
    const cv = $('imgCv'), cx = cv.getContext('2d', { willReadFrequently: true });
    function cargaImagen(file) {
      if (!file || !/^image\//.test(file.type)) { toast('Eso no es una imagen'); return; }
      const img = new Image();
      img.onload = () => {
        const w = 420, h = Math.max(1, Math.round(img.height * (w / img.width)));
        cv.width = w; cv.height = h;
        cx.drawImage(img, 0, 0, w, h);
        cv.style.display = 'block'; $('imgHint').style.display = 'block';
        extraePaleta();
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => toast('No pude leer la imagen');
      img.src = URL.createObjectURL(file);
    }
    function aplicaColor(r, g, b) {
      const [h, sa] = U.rgb2hsv ? U.rgb2hsv(r, g, b) : SK.U.rgb2hsv(r, g, b);
      S.p.hue = h; S.p.sat = sa;
      $('sHue').value = Math.round(h); $('sSat').value = Math.round(sa * 100);
      hue.upd(); sat.upd();
      if (!['solid', 'breath', 'pulse', 'heartbeat'].includes(S.fxId)) setFx('solid');
      toast(`Color tomado · ${Math.round(h)}° / ${Math.round(sa * 100)}%`);
    }
    cv.onclick = (e) => {
      const r = cv.getBoundingClientRect();
      // Con el panel oculto o a mitad de una transicion el rect puede ser 0 y
      // las coordenadas salen NaN, lo que hace estallar getImageData.
      if (!r.width || !r.height || !cv.width || !cv.height) return;
      const x = U.clamp(Math.floor((e.clientX - r.left) / r.width * cv.width) || 0, 0, cv.width - 1);
      const y = U.clamp(Math.floor((e.clientY - r.top) / r.height * cv.height) || 0, 0, cv.height - 1);
      let d;
      try { d = cx.getImageData(x, y, 1, 1).data; } catch (err) { return; }
      aplicaColor(d[0], d[1], d[2]);
    };
    function extraePaleta() {
      // Agrupamos por celdas de color y nos quedamos con las mas pobladas,
      // ignorando lo casi negro y lo casi blanco: no aportan tono util.
      const d = cx.getImageData(0, 0, cv.width, cv.height).data;
      const cubos = new Map();
      for (let i = 0; i < d.length; i += 16) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx < 40 || (mx > 235 && mx - mn < 25)) continue;
        const k = `${r >> 5},${g >> 5},${b >> 5}`;
        const c = cubos.get(k) || [0, 0, 0, 0];
        c[0] += r; c[1] += g; c[2] += b; c[3]++;
        cubos.set(k, c);
      }
      const top = [...cubos.values()].sort((a, b2) => b2[3] - a[3]).slice(0, 6);
      const el = $('paleta'); el.innerHTML = '';
      for (const c of top) {
        const r = Math.round(c[0] / c[3]), g = Math.round(c[1] / c[3]), b = Math.round(c[2] / c[3]);
        const btn = document.createElement('button');
        btn.style.background = `rgb(${r},${g},${b})`;
        btn.title = `rgb(${r}, ${g}, ${b})`;
        btn.onclick = () => aplicaColor(r, g, b);
        el.appendChild(btn);
      }
    }
    $('dropImg').onclick = () => $('fileImg').click();
    $('fileImg').onchange = (e) => cargaImagen(e.target.files[0]);
    ['dragenter', 'dragover'].forEach((ev) => $('dropImg').addEventListener(ev, (e) => {
      e.preventDefault(); $('dropImg').classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((ev) => $('dropImg').addEventListener(ev, (e) => {
      e.preventDefault(); $('dropImg').classList.remove('over');
      if (ev === 'drop' && e.dataTransfer.files[0]) cargaImagen(e.dataTransfer.files[0]);
    }));

    /* --- exportar / importar --- */
    $('btnExport').onclick = () => {
      const cfg = {
        v: 1, fecha: new Date().toISOString(),
        curva: S.curva, fadeDefecto: S.fadeDefecto, fps: S.fps, camFps: S.camFps,
        fav: S.fav, cues: S.cues, presets: S.presets,
        grupos: S.grupos.map((g) => ({ name: g.name, fxId: g.fxId, p: { ...g.p, audio: undefined } })),
        rig: SK.Rig.lights.map((l) => ({ id: l.id, name: l.name, trim: l.trim, offset: l.offset, group: l.group })),
        sokani: SK.SOKANI ? { ...SK.SOKANI.cfg } : null
      };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }));
      a.download = `sokani-consola-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('Configuración exportada');
    };
    $('btnImport').onclick = () => $('fileCfg').click();
    $('fileCfg').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        if (d.curva) S.curva = d.curva;
        if (d.fav) S.fav = d.fav;
        if (d.cues) S.cues = d.cues;
        if (d.presets) S.presets = d.presets;
        if (typeof d.fadeDefecto === 'number') S.fadeDefecto = d.fadeDefecto;
        if (d.camFps) S.camFps = d.camFps;
        if (d.sokani && SK.SOKANI) Object.assign(SK.SOKANI.cfg, d.sokani);
        if (d.grupos && d.grupos.length) {
          S.grupos = d.grupos.map((gs) => {
            const g = mkGrupo(gs.name || 'Grupo');
            g.fxId = SK.FX_BY_ID[gs.fxId] ? gs.fxId : 'solid';
            Object.assign(g.p, gs.p, { audio: AUDIO });
            const fx = SK.FX_BY_ID[g.fxId];
            g.st = fx && fx.init ? fx.init(g.p) : {};
            return g;
          });
          S.sel = 0;
        }
        // Los ajustes por luz solo se aplican a las que ya estan en el rig.
        if (d.rig) for (const r of d.rig) {
          const l = SK.Rig.lights.find((x) => x.id === r.id);
          if (l) { l.trim = r.trim ?? 1; l.offset = r.offset ?? 0; l.group = r.group || 0; }
        }
        $('selCurva').value = S.curva;
        sincronizaMandos(); renderGrupos(); renderGrid(); actualizaNow();
        renderCues(); renderPresets(); renderTabs(); renderRig(); save();
        toast('Configuración importada');
      } catch (err) { toast('Archivo no válido'); log('Importar: ' + err.message, 'e'); }
      e.target.value = '';
    };

    /* --- modo escenario --- */
    function renderStage() {
      const el = $('sBtns'); el.innerHTML = '';
      const items = S.cues.length
        ? S.cues.map((c, i) => ({ t: c.name, s: `cue ${i + 1} · ${c.fade}s`, act: i === S.cueIdx, go: () => { S.cueIdx = i - 1; go(1); renderStage(); } }))
        : (S.fav.length ? S.fav : SK.FX.slice(0, 12).map((f) => f.id))
            .map((id) => SK.FX_BY_ID[id]).filter(Boolean)
            .map((f) => ({ t: f.i + '  ' + f.n, s: f.d, act: f.id === S.fxId, go: () => { setFx(f.id); renderStage(); } }));
      for (const it of items) {
        const b = document.createElement('button');
        b.className = 'sbtn' + (it.act ? ' act' : '');
        b.innerHTML = `${it.t}<small>${it.s}</small>`;
        b.onclick = it.go;
        el.appendChild(b);
      }
    }
    const setStage = async (on) => {
      document.body.classList.toggle('stage', on);
      if (on) { renderStage(); try { await document.documentElement.requestFullscreen(); } catch (e) { } }
      else if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (e) { } }
    };
    $('btnStage').onclick = () => setStage(true);
    $('sExit').onclick = () => setStage(false);
    $('sGo').onclick = () => { go(1); renderStage(); };
    $('sPrev').onclick = () => { go(-1); renderStage(); };
    $('sBlack').onclick = () => $('btnBlackout').click();
    $('sBri').oninput = (e) => {
      S.p.bri = +e.target.value / 100;
      $('sBri').value = e.target.value; bri.el.value = e.target.value; bri.upd();
    };
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) document.body.classList.remove('stage');
    });

    /* --- catalogos multimarca --- */
    SK.loadData().then((r) => {
      log(`Catálogos: ${r.gels} gelatinas, ${r.fixtures} luces.`, 'o');
      renderGels(); renderBrands();
      $('gelCount').textContent = SK.GELS.length;
    });

    function aplicaColorGel(r, g, b) {
      const [h, sa] = SK.U.rgb2hsv(r, g, b);
      S.p.hue = h; S.p.sat = sa;
      $('sHue').value = Math.round(h); $('sSat').value = Math.round(sa * 100);
      hue.upd(); sat.upd();
      if (!['solid', 'breath', 'pulse'].includes(S.fxId)) setFx('solid');
    }
    let gelFiltro = '';
    function renderGels() {
      const el = $('gelGrid'); if (!el) return;
      // Sin catálogo (versión publicada sin datos de terceros) la tarjeta sobra.
      el.closest('.card').hidden = !SK.GELS.length;
      if (!SK.GELS.length) return;
      const q = gelFiltro.toLowerCase();
      const list = (q ? SK.GELS.filter((x) => (x.n + ' ' + x.num + ' ' + x.s).toLowerCase().includes(q)) : SK.GELS).slice(0, 120);
      el.innerHTML = '';
      for (const x of list) {
        const b = document.createElement('button');
        b.className = 'gelchip';
        b.style.background = `rgb(${x.rgb[0]},${x.rgb[1]},${x.rgb[2]})`;
        b.title = `${x.s}${x.num} · ${x.n}`;
        b.innerHTML = `<span class="num">${x.s}${x.num}</span><span>${x.n}</span>`;
        b.onclick = () => { aplicaColorGel(...x.rgb); toast(`Gel ${x.s}${x.num} · ${x.n}`); };
        el.appendChild(b);
      }
      if (!list.length) el.innerHTML = '<div class="empty">Sin coincidencias</div>';
    }
    $('gelSearch').oninput = (e) => { gelFiltro = e.target.value; renderGels(); };

    function renderBrands() {
      const el = $('brandList'); if (!el) return;
      if (SK.CONFIG.soloSokani) { el.closest('.card').hidden = true; return; }
      el.innerHTML = '';
      for (const id of SK.BRAND_ORDER) {
        const b = SK.BRANDS[id];
        const n = SK.FIXTURES.filter((f) => f.brand.toLowerCase().startsWith(b.name.toLowerCase().split(' ')[0].toLowerCase())).length
          || SK.FIXTURES.filter((f) => id === 'nanlite' ? /nanl/i.test(f.brand) : f.brand.toLowerCase() === b.name.toLowerCase()).length;
        const d = document.createElement('div');
        d.className = 'brand';
        d.innerHTML = `<span class="bdot" style="background:${b.color}"></span>` +
          `<span class="bn">${b.name}</span>` +
          `<span class="bcount">${n} modelos</span>` +
          `<span class="bt ${b.transport}">${b.transport === 'direct' ? '● directo' : '◐ malla'}</span>`;
        d.title = b.note;
        el.appendChild(d);
      }
    }

    /* --- catalogo modal --- */
    let catFiltro = 'all', catQ = '';
    function renderCatalog() {
      const el = $('catBody'); if (!el) return;
      const q = catQ.toLowerCase();
      const list = SK.FIXTURES.filter((f) => {
        if (catFiltro !== 'all' && !(catFiltro === 'Nanlite' ? /nanl/i.test(f.brand) : f.brand === catFiltro)) return false;
        return !q || (f.brand + ' ' + f.model).toLowerCase().includes(q);
      });
      el.innerHTML = '';
      for (const f of list.slice(0, 400)) {
        const br = SK.BRANDS[f.brand.toLowerCase()] || (/nanl/i.test(f.brand) ? SK.BRANDS.nanlite : null);
        const col = br ? br.color : '#888';
        const caps = [f.rgb && 'RGB', f.cct && `${(f.cct[0] / 1000).toFixed(1)}–${(f.cct[1] / 1000).toFixed(0)}K`, f.gm && 'G/M', f.fx && `${f.fx}fx`].filter(Boolean);
        const d = document.createElement('div');
        d.className = 'catrow';
        d.innerHTML = `<span class="cm">${f.model}</span>` +
          `<span class="cb" style="background:${col}22;color:${col}">${f.brand}</span>` +
          `<span class="cap">${caps.join(' · ')}</span>` +
          `<span class="cap">${f.direct ? '<b>directo</b>' : (br && br.transport === 'mesh' ? 'malla' : '')}</span>` +
          `<span></span>`;
        el.appendChild(d);
      }
      $('catBody').scrollTop = 0;
    }
    $('btnCatalog').onclick = () => { renderCatalog(); document.body.classList.add('catalog'); };
    $('catClose').onclick = () => document.body.classList.remove('catalog');
    $('catSearch').oninput = (e) => { catQ = e.target.value; renderCatalog(); };
    document.querySelectorAll('#catalog [data-cf]').forEach((b) => {
      b.onclick = () => {
        catFiltro = b.dataset.cf;
        document.querySelectorAll('#catalog [data-cf]').forEach((x) => x.classList.toggle('act', x === b));
        renderCatalog();
      };
    });

    /* =====================================================================
       Tarjeta flotante del efecto
       Al tocar un efecto aparecen sus mandos al lado, sin cambiar de pestaña.
       Qué mandos salen lo decide el propio efecto: se lee su código y se
       muestran solo los parámetros que usa (tono, intensidad, temperatura,
       tempo…). Así no hay que etiquetar 124 efectos a mano, y un efecto nuevo
       trae su tarjeta correcta sin tocar nada aquí.
       ===================================================================== */
    const MANDO = { bri, speed: spd, intensity: int, hue, sat, kelvin: kel };
    // Nombre y lectura del parámetro «intensidad» donde significa algo concreto.
    // Hz reales: la frecuencia base del efecto por la velocidad del motor.
    const HZ = (a, b) => (r) => ((a + r / 100 * b) * S.p.speed * (S.beatSync ? S.p.bpm / 120 : 1)).toFixed(1) + ' Hz';
    const ETIQ = {
      strobe: ['Frecuencia', HZ(2, 22)], strobe_col: ['Frecuencia', HZ(2, 22)],
      strobe2: ['Frecuencia', HZ(1.6, 5)], burst: ['Ráfagas por segundo', HZ(1.1, 3)],
      panic: ['Frecuencia', HZ(6, 12)], paparazzi: ['Flashes'], lightning: ['Frecuencia de rayos'],
      relampago_calor: ['Frecuencia de destellos'], fireworks: ['Cadencia'], explosion: ['Cadencia'],
      carpass: ['Tráfico'], train: ['Velocidad del tren'], tunel: ['Velocidad'], fire: ['Viveza']
    };
    const COLORES = [[0, 'Rojo'], [28, 'Ámbar'], [55, 'Amarillo'], [120, 'Verde'], [185, 'Cian'], [225, 'Azul'], [270, 'Violeta'], [315, 'Magenta']];
    const KELVIN = [2700, 3200, 4300, 5600, 6500];

    function mandosDe(f) {
      const src = String(f.tick) + (f.init ? String(f.init) : '');
      const usa = (k) => new RegExp('\\bp\\.' + k + '\\b').test(src);
      const cuerpo = String(f.tick).slice(String(f.tick).indexOf(')') + 1);
      return {
        speed: /\bT\b/.test(cuerpo),                 // efectos quietos no tienen velocidad
        intensity: usa('intensity'),
        hue: usa('hue'), sat: usa('sat'),
        kelvin: usa('kelvin'),
        bpm: usa('bpm') || usa('phase') || usa('beatCount'),
        text: usa('text'),
        audio: !!f.audio,
        _hz: !!(ETIQ[f.id] && ETIQ[f.id][1])
      };
    }
    const mandosVisibles = (f) => {
      const m = mandosDe(f);
      // Si la intensidad ya es una frecuencia en Hz, un mando de velocidad aparte
      // haría lo mismo y solo confundiría.
      if (m._hz) m.speed = false;
      for (const k of f.ocultar || []) m[k] = false;
      return m;
    };

    const FMT = {
      bri: (r) => r + '%', speed: (r) => (r / 100).toFixed(2) + '×', intensity: (r) => r + '%',
      hue: (r) => r + '°', sat: (r) => r + '%', kelvin: (r) => r + ' K'
    };
    const RAW = {
      bri: () => Math.round(S.p.bri * 100), speed: () => Math.round(S.p.speed * 100),
      intensity: () => Math.round(S.p.intensity * 100), hue: () => Math.round(S.p.hue),
      sat: () => Math.round(S.p.sat * 100), kelvin: () => Math.round(S.p.kelvin)
    };
    const RANGO = { bri: [0, 100, 1], speed: [5, 400, 1], intensity: [0, 100, 1], hue: [0, 359, 1], sat: [0, 100, 1], kelvin: [1800, 10000, 50] };
    const CLASE = { hue: 'hue', sat: 'sat', kelvin: 'kel' };

    let panelFx = null, panelFmt = {};
    const fila = (k, label, fmt) => {
      panelFmt[k] = fmt || FMT[k];
      const [mn, mx, st] = RANGO[k];
      return `<div class="fp-row"><div class="top"><span>${label}</span><b data-v="${k}">${panelFmt[k](RAW[k]())}</b></div>` +
        `<input type="range" class="${CLASE[k] || ''}" data-k="${k}" min="${mn}" max="${mx}" step="${st}" value="${RAW[k]()}"></div>`;
    };

    function pintaPanel(id) {
      const f = SK.FX_BY_ID[id]; if (!f) return;
      const m = mandosVisibles(f), pop = $('fxPop');
      panelFx = id; panelFmt = {};
      const fav = S.fav.includes(id);
      let h = `<div class="fp-grab"></div>
        <div class="fp-head"><span class="ic">${f.i}</span>
          <div class="t"><b>${f.n}</b><small>${f.d}</small></div>
          <button class="fp-x" data-a="fav" title="Favorito">${fav ? '★' : '☆'}</button>
          <button class="fp-x" data-a="cerrar" title="Cerrar">✕</button></div>`;
      if (S.grupos.length > 1) h += `<div class="fp-grupo">Grupo: <b>${S.g.name}</b></div>`;
      h += fila('bri', 'Brillo');
      if (m.intensity) { const e = ETIQ[id] || ['Intensidad']; h += fila('intensity', e[0], e[1]); }
      if (m.speed) h += fila('speed', 'Velocidad');
      if (m.hue) {
        h += fila('hue', 'Color');
        h += '<div class="fp-sw">' + COLORES.map(([hh, n]) =>
          `<button data-hue="${hh}" title="${n}" style="background:hsl(${hh},100%,50%)"></button>`).join('') + '</div>';
      }
      if (m.sat) h += fila('sat', 'Saturación');
      if (m.kelvin) {
        h += fila('kelvin', 'Temperatura');
        h += '<div class="fp-chips">' + KELVIN.map((k) => `<button data-kel="${k}">${k}</button>`).join('') + '</div>';
      }
      if (m.bpm) {
        h += `<div class="fp-row"><div class="top"><span>Tempo</span><b data-v="bpm">${Math.round(S.p.bpm)} BPM</b></div>
          <div class="fp-bpm"><button data-a="bpm-">−</button><button class="pri" data-a="tap">TAP</button><button data-a="bpm+">+</button></div></div>`;
      }
      if (m.text) {
        h += `<div class="fp-row"><div class="top"><span>Texto en morse</span></div>
          <input type="text" data-a="texto" maxlength="60" value="${(S.p.text || 'SOS').replace(/"/g, '&quot;')}"></div>`;
      }
      if (m.audio) {
        h += `<div class="fp-row"><div class="top"><span>Micrófono</span><b>${audio.on ? 'activo' : 'apagado'}</b></div>
          ${audio.on ? '' : '<button class="btn full sm pri" data-a="mic">Activar micrófono</button>'}</div>`;
      }
      if (f.cat === 'estrobo' && S.camFps) {
        h += `<div class="fp-nota">Sincronizado a ${S.camFps} fps de cámara.</div>`;
      }
      h += `<div class="fp-foot"><button class="btn sm" data-a="cue">● Grabar cue</button>
        <button class="btn sm" data-a="reset">↺ Valores de fábrica</button></div>`;
      pop.innerHTML = h;
      pop.hidden = false;

      pop.querySelectorAll('input[type=range][data-k]').forEach((el) => {
        el.oninput = () => {
          const k = el.dataset.k;
          MANDO[k].el.value = el.value; MANDO[k].upd();
          pop.querySelector(`[data-v="${k}"]`).textContent = panelFmt[k](+el.value);
          if (k === 'intensity' && S.camFps && f.cat === 'estrobo') ajustaEstrobo();
        };
      });
      pop.querySelectorAll('[data-hue]').forEach((b) => {
        b.onclick = () => {
          MANDO.hue.el.value = b.dataset.hue; MANDO.hue.upd();
          MANDO.sat.el.value = 100; MANDO.sat.upd();
          refrescaPanel();
        };
      });
      pop.querySelectorAll('[data-kel]').forEach((b) => {
        b.onclick = () => { MANDO.kelvin.el.value = b.dataset.kel; MANDO.kelvin.upd(); refrescaPanel(); };
      });
      pop.querySelectorAll('[data-a]').forEach((b) => {
        const a = b.dataset.a;
        if (a === 'texto') { b.oninput = () => { S.p.text = b.value || 'SOS'; $('fxText').value = S.p.text; save(); }; return; }
        b.onclick = () => {
          if (a === 'cerrar') cierraPanel();
          else if (a === 'fav') { toggleFav(id); pintaPanel(id); }
          else if (a === 'tap') { tap(); refrescaPanel(); }
          else if (a === 'bpm-' || a === 'bpm+') {
            S.p.bpm = U.clamp(Math.round(S.p.bpm) + (a === 'bpm+' ? 1 : -1), 20, 300);
            $('bpm').value = S.p.bpm; save(); refrescaPanel();
          }
          else if (a === 'mic') micOn().then(() => pintaPanel(id));
          else if (a === 'cue') $('btnCueRec').click();
          else if (a === 'reset') {
            MANDO.speed.el.value = 100; MANDO.speed.upd();
            MANDO.intensity.el.value = 50; MANDO.intensity.upd();
            refrescaPanel(); toast('Velocidad e intensidad de fábrica');
          }
        };
      });
      colocaPanel();
    }

    function colocaPanel() {
      const pop = $('fxPop'); if (pop.hidden) return;
      if (window.innerWidth <= 900) {                 // móvil: hoja desde abajo
        pop.classList.add('sheet'); pop.style.left = pop.style.top = ''; return;
      }
      pop.classList.remove('sheet');
      const card = document.querySelector('.fx.act');
      if (!card) { pop.style.left = (innerWidth - pop.offsetWidth) / 2 + 'px'; pop.style.top = '90px'; return; }
      const r = card.getBoundingClientRect(), w = pop.offsetWidth, hgt = pop.offsetHeight;
      let x = r.right + 10;
      if (x + w > innerWidth - 12) x = r.left - w - 10;
      if (x < 12) x = Math.max(12, Math.min(innerWidth - w - 12, r.left));
      const y = Math.max(66, Math.min(r.top - 8, innerHeight - hgt - 12));
      pop.style.left = x + 'px'; pop.style.top = y + 'px';
    }

    abrePanel = (id) => pintaPanel(id);
    cierraPanel = () => { $('fxPop').hidden = true; panelFx = null; };
    panelAbierto = () => !$('fxPop').hidden;
    refrescaPanel = (key) => {
      if (!panelFx || $('fxPop').hidden) return;
      const pop = $('fxPop');
      for (const k of Object.keys(RAW)) {
        if (key && key !== k) continue;
        const el = pop.querySelector(`input[data-k="${k}"]`);
        if (el && document.activeElement !== el) el.value = RAW[k]();
        const v = pop.querySelector(`[data-v="${k}"]`);
        if (v && panelFmt[k]) v.textContent = panelFmt[k](RAW[k]());
      }
      const vb = pop.querySelector('[data-v="bpm"]');
      if (vb) vb.textContent = Math.round(S.p.bpm) + ' BPM';
    };

    // Cerrar al tocar fuera (tocar otro efecto no cuenta: ese abre el suyo).
    document.addEventListener('pointerdown', (e) => {
      const pop = $('fxPop');
      if (pop.hidden || pop.contains(e.target) || e.target.closest('.fx') || e.target.closest('#nowBox')) return;
      cierraPanel();
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cierraPanel(); });
    window.addEventListener('resize', colocaPanel);
    $('grid').closest('main').addEventListener('scroll', () => {
      if (!panelAbierto() || window.innerWidth <= 900) return;
      const card = document.querySelector('.fx.act');
      const r = card && card.getBoundingClientRect();
      if (!r || r.bottom < 60 || r.top > innerHeight) cierraPanel(); else colocaPanel();
    });
    // Tocar la tarjeta de «efecto actual» también abre sus ajustes.
    $('nowBox').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      panelAbierto() ? cierraPanel() : abrePanel(S.fxId);
    });

    /* ---------------- navegacion movil ---------------- */
    const nav = $('mnav');
    const setPane = (p) => {
      document.body.dataset.pane = p;
      nav.querySelectorAll('button').forEach((b) => b.classList.toggle('act', b.dataset.pane === p));
      window.scrollTo(0, 0);
    };
    nav.querySelectorAll('button').forEach((b) => {
      b.onclick = () => setPane(
        (document.body.dataset.pane === 'right' && b.dataset.pane === 'right') ? 'main' : b.dataset.pane);
    });
    setPane('main');

    /* ---------------- arranque ---------------- */
    renderTabs(); renderGrid(); renderPresets(); renderGrupos(); renderCues();
    $('sFade').value = Math.round(S.fadeDefecto * 10);
    $('vFade').textContent = S.fadeDefecto.toFixed(1) + ' s';
    sincronizaMandos(); actualizaNow();
    BLE.onTelemetry = (t) => {
      if (t.bv === undefined && t.tempC === undefined) return;
      $('pTele').style.display = 'inline-flex';
      if (t.bv !== undefined) $('pBat').textContent = (t.bv / 10).toFixed(1) + ' V';
      if (t.tempC !== undefined) $('pTemp').textContent = t.tempC.toFixed(1) + ' °C';
    };
    BLE.onState();
    startClock();
    // Sonda de diagnostico para la consola del navegador: SK.debug()
    SK.debug = () => ({ efecto: S.fxId, ticks, color: S.g.shown.map(Math.round),
      grupos: S.grupos.map((g) => g.name + ':' + g.fxId), cues: S.cues.length, curva: S.curva,
      fps: S.fps, tx: BLE.tx && BLE.tx.uuid, protocolo: BLE.driver && BLE.driver.id,
      enviados: BLE.stats.sent, errores: BLE.stats.err });
    log(`Consola lista · ${SK.FX.length} efectos cargados.`, 'o');
    log('Sin conexión seguirás viendo todo en la previsualización (modo ensayo).', 'm');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
