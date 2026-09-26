/* =========================================================================
   effects.js — Motor y biblioteca de efectos
   -------------------------------------------------------------------------
   Cada efecto es una funcion pura del tiempo:  tick(T, s, p) -> [r,g,b]
     T = segundos transcurridos (ya multiplicados por velocidad)
     s = estado privado del efecto (persiste mientras esta activo)
     p = parametros globales {speed,intensity,hue,sat,kelvin,bpm,beat,phase,audio,text}
   El motor aplica despues el brillo maestro y el fundido.
   ========================================================================= */
(function () {
  const SK = window.SK || (window.SK = {});
  const U = SK.U || (SK.U = {});

  /* ---------------- utilidades ---------------- */
  const clamp = U.clamp = (v, a = 0, b = 255) => (v < a ? a : v > b ? b : v);
  const lerp = U.lerp = (a, b, t) => a + (b - a) * t;
  const R = Math.random;
  const TAU = Math.PI * 2;
  const sin01 = (x) => (Math.sin(x * TAU) + 1) / 2;          // 0..1, periodo 1
  const tri = (x) => { x = x % 1; if (x < 0) x += 1; return x < .5 ? x * 2 : 2 - x * 2; };
  const saw = (x) => { x = x % 1; return x < 0 ? x + 1 : x; };
  const pulse = (x, d) => (saw(x) < d ? 1 : 0);

  const hsv = U.hsv = function (h, s, v) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 1); v = clamp(v, 0, 1);
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c]; else[r, g, b] = [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  };

  // Cuerpo negro -> RGB (aproximacion de Tanner Helland)
  const kelvin = U.kelvin = function (k) {
    const t = clamp(k, 1000, 40000) / 100;
    let r, g, b;
    r = t <= 66 ? 255 : clamp(329.698727446 * Math.pow(t - 60, -0.1332047592));
    g = t <= 66 ? clamp(99.4708025861 * Math.log(t) - 161.1195681661)
      : clamp(288.1221695283 * Math.pow(t - 60, -0.0755148492));
    b = t >= 66 ? 255 : t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307);
    return [r, g, b];
  };

  const mix = U.mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const sc = U.sc = (c, f) => [clamp(c[0] * f), clamp(c[1] * f), clamp(c[2] * f)];
  const OFF = [0, 0, 0];

  // Ruido de valor 1D suave (para fuego, agua, aurora)
  function mkNoise(seed) {
    const n = 256, tab = new Float32Array(n);
    let x = seed * 9301 + 49297;
    for (let i = 0; i < n; i++) { x = (x * 9301 + 49297) % 233280; tab[i] = x / 233280; }
    return (t) => {
      t = Math.abs(t) % n;
      const i = Math.floor(t), f = t - i, a = tab[i], b = tab[(i + 1) % n];
      const u = f * f * (3 - 2 * f);
      return a + (b - a) * u;
    };
  }
  U.mkNoise = mkNoise;

  // Paletas listas
  const PAL = {
    fire: [[255, 40, 0], [255, 130, 10], [255, 200, 60], [255, 245, 190]],
    ice: [[10, 40, 120], [40, 140, 220], [150, 220, 255], [235, 250, 255]],
    ocean: [[0, 24, 80], [0, 90, 160], [0, 190, 200], [140, 250, 235]],
    forest: [[6, 40, 12], [30, 110, 30], [110, 190, 60], [210, 240, 150]],
    neon: [[255, 0, 140], [140, 0, 255], [0, 220, 255], [0, 255, 170]],
    vapor: [[255, 110, 200], [140, 120, 255], [90, 220, 255], [255, 210, 240]],
    sunset: [[255, 60, 30], [255, 120, 40], [255, 60, 120], [90, 30, 120]],
    aurora: [[0, 255, 140], [40, 200, 255], [140, 80, 255], [0, 180, 120]],
    candy: [[255, 90, 160], [255, 200, 90], [120, 255, 180], [140, 180, 255]]
  };
  const palAt = (p, t) => {
    const n = p.length, x = saw(t) * n, i = Math.floor(x);
    return mix(p[i % n], p[(i + 1) % n], x - i);
  };
  U.PAL = PAL; U.palAt = palAt;

  const MORSE = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..',
    J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
    S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....',
    6: '-....', 7: '--...', 8: '---..', 9: '----.', ' ': '/'
  };

  /* =====================================================================
     BIBLIOTECA DE EFECTOS
     cat: ambiente | club | estrobo | emergencia | cine | natural | glitch | audio
     ===================================================================== */
  const FX = [];
  const add = (o) => { FX.push(o); return o; };

  /* ---------- AMBIENTE ---------- */
  add({
    id: 'solid', n: 'Color fijo', d: 'Tono plano y estable', i: '⬤', cat: 'ambiente',
    tick: (T, s, p) => hsv(p.hue, p.sat, 1)
  });
  add({
    id: 'cct', n: 'Blanco variable', d: 'Bicolor 1800–10000 K', i: '☀︎', cat: 'ambiente',
    tick: (T, s, p) => kelvin(p.kelvin)
  });
  add({
    id: 'breath', n: 'Respiración', d: 'Fundido sinusoidal suave', i: '◍', cat: 'ambiente',
    tick: (T, s, p) => sc(hsv(p.hue, p.sat, 1), .06 + .94 * Math.pow(sin01(T * .18), 2.2))
  });
  add({
    id: 'pulse', n: 'Pulso', d: 'Latido regular de intensidad', i: '◉', cat: 'ambiente',
    tick: (T, s, p) => sc(hsv(p.hue, p.sat, 1), .12 + .88 * Math.pow(sin01(T * .8), 4))
  });
  add({
    id: 'heartbeat', n: 'Latido', d: 'Doble golpe cardiaco (lub-dub)', i: '♥', cat: 'ambiente',
    tick: (T, s, p) => {
      const x = saw(T * (p.bpm / 60) * .5);
      const e = (o, w) => Math.exp(-Math.pow((x - o) / w, 2) * 8);
      return sc(hsv(p.hue, p.sat, 1), clamp(.05 + e(.06, .06) + .72 * e(.24, .07), 0, 1));
    }
  });
  add({
    id: 'colorfade', n: 'Fundido de color', d: 'Deriva lenta por toda la rueda', i: '◈', cat: 'ambiente',
    tick: (T, s, p) => hsv(p.hue + T * 12, p.sat, 1)
  });
  add({
    id: 'pastel', n: 'Deriva pastel', d: 'Tonos lavados, muy suave', i: '❀', cat: 'ambiente',
    tick: (T, s, p) => hsv(p.hue + T * 7, .28 * p.sat + .05, 1)
  });
  add({
    id: 'therapy', n: 'Cromoterapia', d: 'Siete colores, transición larguísima', i: '☯', cat: 'ambiente',
    tick: (T) => palAt([[255, 0, 0], [255, 120, 0], [255, 240, 0], [0, 220, 60], [0, 160, 255], [40, 40, 220], [150, 0, 220]], T * .035)
  });
  add({
    id: 'warmcold', n: 'Cálido ⇄ frío', d: 'Barrido 2000 K ↔ 9000 K', i: '⇄', cat: 'ambiente',
    tick: (T) => kelvin(lerp(2000, 9000, tri(T * .08)))
  });
  add({
    id: 'goldenhour', n: 'Hora dorada', d: 'Ámbar cinematográfico vivo', i: '🌇', cat: 'ambiente',
    init: () => ({ n: mkNoise(3) }),
    tick: (T, s) => sc(kelvin(2450 + s.n(T * .5) * 350), .78 + .22 * s.n(T * 1.3))
  });

  /* ---------- CLUB / FIESTA ---------- */
  add({
    id: 'rainbow', n: 'Arcoíris', d: 'Ciclo cromático continuo', i: '🌈', cat: 'club',
    tick: (T, s, p) => hsv(T * 60, p.sat, 1)
  });
  add({
    id: 'rainbow_fast', n: 'Arcoíris hiper', d: 'Ciclo a toda velocidad', i: '⚡︎', cat: 'club',
    tick: (T, s, p) => hsv(T * 420, p.sat, 1)
  });
  add({
    id: 'colorjump', n: 'Salto de color', d: 'Cambios secos sin fundido', i: '⧉', cat: 'club',
    init: () => ({ k: -1, c: OFF }),
    tick: (T, s, p) => {
      const k = Math.floor(T * 2.2);
      if (k !== s.k) { s.k = k; s.c = hsv(R() * 360, p.sat, 1); }
      return s.c;
    }
  });
  add({
    id: 'disco', n: 'Disco 70s', d: 'Seis colores saturados en rotación', i: '🪩', cat: 'club',
    tick: (T) => [[255, 0, 0], [255, 130, 0], [255, 240, 0], [0, 255, 60], [0, 120, 255], [190, 0, 255]][Math.floor(T * 3) % 6]
  });
  add({
    id: 'neon', n: 'Neón cyberpunk', d: 'Magenta ⇄ cian con núcleo blanco', i: '⌁', cat: 'club',
    tick: (T) => {
      const x = tri(T * .5);
      return sc(mix([255, 0, 150], [0, 220, 255], x), .55 + .45 * sin01(T * 2));
    }
  });
  add({
    id: 'vapor', n: 'Vaporwave', d: 'Rosa, violeta y cian a la deriva', i: '🌐', cat: 'club',
    tick: (T) => palAt(PAL.vapor, T * .13)
  });
  add({
    id: 'rave', n: 'Rave', d: 'Golpes de color aleatorios y secos', i: '🔊', cat: 'club',
    init: () => ({ t: 0, c: OFF }),
    tick: (T, s, p) => {
      if (T > s.t) { s.t = T + .06 + R() * .18; s.c = hsv(R() * 360, 1, 1); }
      return saw(T * 9) < .55 ? s.c : sc(s.c, .06);
    }
  });
  add({
    id: 'bassdrop', n: 'Bass drop', d: 'Carga en rampa y estallido blanco', i: '💥', cat: 'club',
    tick: (T, s, p) => {
      const x = saw(T * .22);
      if (x < .78) { const q = x / .78; return sc(hsv(p.hue + q * 90, 1, 1), .08 + .5 * q * q); }
      const q = (x - .78) / .22;
      return sc([255, 255, 255], Math.max(0, 1 - q * 1.2) * (saw(T * 22) < .5 ? 1 : .25));
    }
  });
  add({
    id: 'sparkle', n: 'Chispas', d: 'Destellos blancos sobre base tenue', i: '✦', cat: 'club',
    tick: (T, s, p) => (R() < .1 ? [255, 255, 255] : sc(hsv(p.hue, p.sat, 1), .1))
  });
  add({
    id: 'chase', n: 'Persecución', d: 'Barrido de brillo estilo marquesina', i: '➤', cat: 'club',
    tick: (T, s, p) => sc(hsv(p.hue + T * 40, p.sat, 1), Math.pow(saw(T * 1.6), 3))
  });
  add({
    id: 'candy', n: 'Caramelo', d: 'Paleta dulce en rotación media', i: '🍬', cat: 'club',
    tick: (T) => palAt(PAL.candy, T * .2)
  });
  add({
    id: 'spectrum', n: 'Barrido espectral', d: 'Rojo → violeta ida y vuelta', i: '▤', cat: 'club',
    tick: (T, s, p) => hsv(tri(T * .25) * 300, p.sat, 1)
  });
  add({
    id: 'bpmflash', n: 'Flash a BPM', d: 'Sincronizado al tempo marcado', i: '♩', cat: 'club',
    tick: (T, s, p) => (p.phase < .16 ? hsv(p.hue + Math.floor(p.beatCount) * 47, p.sat, 1) : OFF)
  });

  /* ---------- ESTROBOS ---------- */
  add({
    id: 'strobe', n: 'Estrobo', d: 'Blanco duro, frecuencia variable', i: '⚡', cat: 'estrobo',
    tick: (T, s, p) => (pulse(T * (2 + p.intensity * 22), .12 + p.intensity * .1) ? [255, 255, 255] : OFF)
  });
  add({
    id: 'strobe_col', n: 'Estrobo de color', d: 'Igual, pero con tu tono', i: '⚡', cat: 'estrobo',
    tick: (T, s, p) => (pulse(T * (2 + p.intensity * 22), .14) ? hsv(p.hue, p.sat, 1) : OFF)
  });
  add({
    id: 'strobe2', n: 'Doble estrobo', d: 'Par de destellos y pausa', i: '⚡⚡', cat: 'estrobo',
    tick: (T, s, p) => {
      const x = saw(T * (1.6 + p.intensity * 5));
      return (x < .05 || (x > .1 && x < .15)) ? [255, 255, 255] : OFF;
    }
  });
  add({
    id: 'burst', n: 'Ráfaga', d: 'Tres disparos rápidos por ciclo', i: '⚡⚡⚡', cat: 'estrobo',
    tick: (T, s, p) => {
      const x = saw(T * (1.1 + p.intensity * 3));
      return (x < .04 || (x > .08 && x < .12) || (x > .16 && x < .2)) ? [255, 255, 255] : OFF;
    }
  });
  add({
    id: 'hyperstrobe', n: 'Estrobo caótico', d: 'Color y ritmo aleatorios', i: '🌀', cat: 'estrobo',
    init: () => ({ t: 0, c: OFF }),
    tick: (T, s, p) => {
      if (T > s.t) { s.t = T + .02 + R() * .1; s.c = R() < .5 ? [255, 255, 255] : hsv(R() * 360, 1, 1); }
      return saw(T * 26) < .45 ? s.c : OFF;
    }
  });
  add({
    id: 'blinder', n: 'Cegador', d: 'Rampa lenta y corte brutal', i: '☀', cat: 'estrobo',
    tick: (T) => { const x = saw(T * .35); return x < .8 ? sc([255, 250, 235], Math.pow(x / .8, 3)) : OFF; }
  });
  add({
    id: 'paparazzi', n: 'Paparazzi', d: 'Flashes de cámara desordenados', i: '📸', cat: 'estrobo',
    init: () => ({ t: 0, on: 0 }),
    tick: (T, s, p) => {
      if (T > s.t) { s.t = T + .04 + R() * (.5 - p.intensity * .38); s.on = T + .028; }
      return T < s.on ? [255, 253, 248] : OFF;
    }
  });
  add({
    id: 'machinegun', n: 'Ametralladora', d: 'Ráfagas cortas con pausas', i: '🔫', cat: 'estrobo',
    init: () => ({ next: 0, until: 0 }),
    tick: (T, s) => {
      if (T > s.until && T > s.next) { s.until = T + .25 + R() * .5; s.next = s.until + .3 + R() * .9; }
      if (T <= s.until) return saw(T * 18) < .4 ? [255, 240, 210] : sc([255, 120, 40], .12);
      return OFF;
    }
  });
  add({
    id: 'panic', n: 'Pánico', d: 'Estrobo rojo de emergencia total', i: '🚨', cat: 'estrobo',
    tick: (T, s, p) => (pulse(T * (6 + p.intensity * 12), .3) ? [255, 0, 0] : sc([120, 0, 0], .18))
  });

  /* ---------- EMERGENCIA ---------- */
  add({
    id: 'police', n: 'Policía', d: 'Rojo y azul alternos', i: '🚔', cat: 'emergencia',
    tick: (T) => {
      const side = saw(T * 1.6) < .5;              // alterna lado rojo / lado azul
      const flick = saw(T * 13) < .55;             // parpadeo rapido dentro de cada lado
      return flick ? (side ? [255, 0, 0] : [0, 40, 255]) : OFF;
    }
  });
  add({
    id: 'police3', n: 'Policía tricolor', d: 'Rojo, azul y blanco intercalados', i: '🚓', cat: 'emergencia',
    tick: (T) => {
      const c = [[255, 0, 0], [0, 40, 255], [255, 255, 255]][Math.floor(T * 2.4) % 3];
      return saw(T * 15) < .5 ? c : OFF;
    }
  });
  add({
    id: 'ambulance', n: 'Ambulancia', d: 'Rojo y blanco a doble golpe', i: '🚑', cat: 'emergencia',
    tick: (T) => {
      const x = saw(T * 1.2);
      const dbl = (o) => { const y = saw((T - o) * 1.2); return y < .06 || (y > .12 && y < .18); };
      return x < .5 ? (dbl(0) ? [255, 20, 20] : OFF) : (dbl(.416) ? [255, 255, 255] : OFF);
    }
  });
  add({
    id: 'firetruck', n: 'Bomberos', d: 'Rojo puro con barrido rotatorio', i: '🚒', cat: 'emergencia',
    tick: (T) => sc([255, 10, 0], Math.pow(sin01(T * 1.1), 6) + (saw(T * 9) < .3 ? .55 : 0))
  });
  add({
    id: 'beacon', n: 'Faro rotativo', d: 'Barrido tipo baliza giratoria', i: '🗼', cat: 'emergencia',
    tick: (T, s, p) => sc(hsv(p.hue, p.sat, 1), Math.pow(sin01(T * .5), 12))
  });
  add({
    id: 'lighthouse', n: 'Faro marítimo', d: 'Destello lento y largo', i: '🌊', cat: 'emergencia',
    tick: (T) => sc([255, 250, 230], Math.pow(sin01(T * .16), 22))
  });
  add({
    id: 'traffic', n: 'Semáforo', d: 'Verde, ámbar, rojo en secuencia', i: '🚦', cat: 'emergencia',
    tick: (T) => {
      const x = saw(T * .12);
      return x < .45 ? [0, 220, 40] : x < .58 ? [255, 150, 0] : [255, 0, 0];
    }
  });
  add({
    id: 'alarm', n: 'Alarma', d: 'Ámbar pulsante de advertencia', i: '⚠', cat: 'emergencia',
    tick: (T) => sc([255, 140, 0], .1 + .9 * Math.pow(sin01(T * 1.3), 3))
  });
  add({
    id: 'radar', n: 'Radar', d: 'Barrido verde con estela', i: '📡', cat: 'emergencia',
    tick: (T) => sc([0, 255, 120], Math.pow(saw(T * .45), 7))
  });
  add({
    id: 'countdown', n: 'Cuenta atrás', d: 'Verde → ámbar → rojo → blanco', i: '⏱', cat: 'emergencia',
    tick: (T) => {
      const x = saw(T * .05), c = x < .5 ? [0, 255, 80] : x < .8 ? [255, 170, 0] : [255, 0, 0];
      const rate = lerp(1.2, 9, x);
      return x > .97 ? [255, 255, 255] : (saw(T * rate) < .5 ? c : sc(c, .05));
    }
  });
  add({
    id: 'morse', n: 'Morse', d: 'Escribe un texto y lo parpadea', i: '📻', cat: 'emergencia',
    init: (p) => ({ seq: buildMorse(p && p.text || 'SOS') , src: p && p.text || 'SOS'}),
    tick: (T, s, p) => {
      if (p.text !== s.src) { s.src = p.text; s.seq = buildMorse(p.text || 'SOS'); }
      const unit = .13, tot = s.seq.length * unit;
      const i = Math.floor((T % tot) / unit);
      return s.seq[i] ? hsv(p.hue, p.sat, 1) : OFF;
    }
  });
  function buildMorse(txt) {
    const out = [];
    for (const ch of String(txt).toUpperCase()) {
      const code = MORSE[ch]; if (!code) continue;
      if (code === '/') { out.push(0, 0, 0, 0, 0, 0, 0); continue; }
      for (const sym of code) { out.push(1); if (sym === '-') out.push(1, 1); out.push(0); }
      out.push(0, 0);
    }
    out.push(0, 0, 0, 0, 0, 0, 0);
    return out;
  }

  /* ---------- CINE / PRÁCTICOS ---------- */
  add({
    id: 'fire', n: 'Fuego', d: 'Llama viva, cálida e irregular', i: '🔥', cat: 'cine',
    init: () => ({ a: mkNoise(1), b: mkNoise(7), c: mkNoise(19) }),
    tick: (T, s, p) => {
      const f = s.a(T * 4.2) * .6 + s.b(T * 9.1) * .3 + s.c(T * 21) * .1;
      // Viveza: poca = brasa que apenas late; mucha = llama que salta y casi se apaga.
      const viv = .35 + p.intensity * .9;
      const v = clamp(.75 - viv * .45 + f * viv, 0, 1);
      const k = lerp(1500, 2300, f);
      return sc(kelvin(k), v);
    }
  });
  add({
    id: 'candle', n: 'Vela', d: 'Titileo mínimo, muy cálido', i: '🕯', cat: 'cine',
    init: () => ({ a: mkNoise(11), b: mkNoise(23) }),
    tick: (T, s) => {
      const f = s.a(T * 2.1) * .75 + s.b(T * 6.5) * .25;
      return sc(kelvin(1750 + f * 220), .62 + f * .38);
    }
  });
  add({
    id: 'torch', n: 'Antorcha', d: 'Llama grande, ráfagas de viento', i: '🔦', cat: 'cine',
    init: () => ({ a: mkNoise(5), b: mkNoise(31), g: mkNoise(3) }),
    tick: (T, s) => {
      const gust = Math.pow(s.g(T * .5), 3);
      const f = s.a(T * 3) * .6 + s.b(T * 12) * .4;
      return sc(kelvin(1600 + f * 500), clamp(.3 + f * .6 + gust * .5, 0, 1));
    }
  });
  add({
    id: 'lightning', n: 'Tormenta', d: 'Relámpagos dobles y resplandor lejano', i: '🌩', cat: 'cine',
    init: () => ({ next: 1, seq: [], glow: 0 }),
    tick: (T, s, p) => {
      if (T > s.next) {
        s.next = T + .6 + R() * (5 - p.intensity * 3.6);
        s.seq = []; const n = 1 + Math.floor(R() * 3); let t = T;
        for (let i = 0; i < n; i++) { const d = .03 + R() * .07; s.seq.push([t, t + d]); t += d + .04 + R() * .16; }
        s.glow = t + .25 + R() * .6;
      }
      for (const [a, b] of s.seq) if (T >= a && T <= b) return [235, 242, 255];
      if (T < s.glow) { const q = (s.glow - T); return sc([120, 150, 220], clamp(q * .28, 0, .3) * R()); }
      return sc([10, 14, 30], .35);
    }
  });
  add({
    id: 'weld', n: 'Soldadura', d: 'Arco eléctrico azul-blanco violento', i: '🔩', cat: 'cine',
    init: () => ({ on: 0, next: 0 }),
    tick: (T, s) => {
      if (T > s.next) { s.next = T + .01 + R() * .05; s.on = R() < .78 ? 1 : 0; }
      if (!s.on) return sc([60, 30, 10], .1);
      return R() < .2 ? [255, 255, 255] : sc([190, 215, 255], .6 + R() * .4);
    }
  });
  add({
    id: 'short', n: 'Cortocircuito', d: 'Chispazos eléctricos y humo', i: '⚡︎', cat: 'cine',
    init: () => ({ b: 0, next: 0 }),
    tick: (T, s) => {
      if (T > s.next) { s.next = T + .02 + R() * .3; s.b = R() < .45 ? 1 : 0; }
      if (s.b && R() < .6) return R() < .3 ? [255, 255, 255] : [170, 200, 255];
      return sc([30, 20, 10], .12 * R());
    }
  });
  add({
    id: 'fluorescent', n: 'Fluorescente', d: 'Arranque fallido de tubo viejo', i: '💡', cat: 'cine',
    init: () => ({ t0: 0, cyc: 0 }),
    tick: (T, s) => {
      const C = 6.5, x = T % C;
      if (x < 1.2) return R() < .3 ? sc(kelvin(6200), .8 + R() * .2) : sc(kelvin(6200), .02);
      if (x < 1.9) return R() < .7 ? sc(kelvin(6200), .5 + R() * .5) : OFF;
      if (x > C - .5) return R() < .5 ? sc(kelvin(6200), .3) : OFF;
      return sc(kelvin(6300), .9 + Math.sin(T * 90) * .04);
    }
  });
  add({
    id: 'dyingbulb', n: 'Bombilla moribunda', d: 'Zumba, cae y revive', i: '🪫', cat: 'cine',
    init: () => ({ a: mkNoise(41) }),
    tick: (T, s) => {
      const n = s.a(T * 3.5);
      const dip = R() < .04 ? R() * .5 : 1;
      return sc(kelvin(2600 + n * 300), clamp((.25 + n * .75) * dip, 0, 1));
    }
  });
  add({
    id: 'tv', n: 'TV', d: 'Parpadeo azulado con cortes de plano', i: '📺', cat: 'cine',
    init: () => ({ next: 0, base: .5, tint: 0 }),
    tick: (T, s) => {
      if (T > s.next) { s.next = T + .3 + R() * 2.6; s.base = .18 + R() * .7; s.tint = R(); }
      const flick = .78 + R() * .22;
      const c = mix([120, 150, 255], [225, 235, 255], s.tint);
      return sc(c, clamp(s.base * flick + (R() < .02 ? .5 : 0), 0, 1));
    }
  });
  add({
    id: 'monitor', n: 'Monitor', d: 'Luz de pantalla fría y estable', i: '🖥', cat: 'cine',
    init: () => ({ a: mkNoise(17) }),
    tick: (T, s) => sc([150, 180, 255], .55 + s.a(T * 1.6) * .18 + (R() < .01 ? .25 : 0))
  });
  add({
    id: 'projector', n: 'Proyector', d: 'Parpadeo de 24 fps y grano', i: '🎞', cat: 'cine',
    tick: (T) => {
      const g = saw(T * 24) < .82 ? 1 : .35;
      return sc(kelvin(4900), (.72 + R() * .1) * g);
    }
  });
  add({
    id: 'carpass', n: 'Coche pasando', d: 'Faros que barren la habitación', i: '🚗', cat: 'cine',
    init: () => ({ next: 0, t0: -9, dur: 1 }),
    tick: (T, s, p) => {
      if (T > s.next) { s.t0 = T; s.dur = .7 + R() * 1.1; s.next = T + s.dur + .8 + R() * (5 - p.intensity * 4); }
      const q = (T - s.t0) / s.dur;
      if (q < 0 || q > 1) return sc([10, 14, 26], .18);
      const env = Math.exp(-Math.pow((q - .5) * 3.2, 2) * 2);
      return sc(kelvin(5200), clamp(env, 0, 1));
    }
  });
  add({
    id: 'train', n: 'Ventana de tren', d: 'Postes de luz que pasan rítmicos', i: '🚆', cat: 'cine',
    tick: (T, s, p) => {
      const x = saw(T * (1.4 + p.intensity * 3));
      const env = Math.exp(-Math.pow((x - .5) * 6, 2));
      return sc(kelvin(3200), clamp(.08 + env, 0, 1));
    }
  });
  add({
    id: 'flare', n: 'Bengala', d: 'Ignición, quemado y extinción', i: '🧨', cat: 'cine',
    init: () => ({ t0: 0, n: mkNoise(13) }),
    tick: (T, s) => {
      const C = 9, x = (T % C) / C;
      let env = x < .04 ? x / .04 : x < .8 ? 1 : Math.max(0, 1 - (x - .8) / .2);
      const f = .7 + s.n(T * 7) * .3;
      return sc(mix([255, 60, 0], [255, 200, 120], f * .5), env * f);
    }
  });
  add({
    id: 'fireworks', n: 'Fuegos artificiales', d: 'Estallidos de color que caen', i: '🎆', cat: 'cine',
    init: () => ({ t0: -9, c: OFF, next: 0 }),
    tick: (T, s, p) => {
      if (T > s.next) { s.next = T + .25 + R() * (2.2 - p.intensity * 1.8); s.t0 = T; s.c = hsv(R() * 360, .85, 1); }
      const q = T - s.t0;
      if (q < .05) return [255, 255, 255];
      const env = Math.exp(-q * 2.2) * (.75 + .25 * R());
      return sc(s.c, clamp(env, 0, 1));
    }
  });
  add({
    id: 'explosion', n: 'Explosión', d: 'Flash blanco, bola de fuego, humo', i: '💣', cat: 'cine',
    init: () => ({ t0: -9, next: 0 }),
    tick: (T, s, p) => {
      if (T > s.next) { s.next = T + 1.5 + R() * (6 - p.intensity * 4.5); s.t0 = T; }
      const q = T - s.t0;
      if (q < 0) return OFF;
      if (q < .06) return [255, 255, 255];
      if (q < .55) return sc(mix([255, 240, 200], [255, 70, 0], (q - .06) / .49), 1 - (q - .06) * .5);
      const d = Math.max(0, 1 - (q - .55) / 1.6);
      return sc([255, 60, 0], d * d * (.7 + .3 * R()));
    }
  });
  add({
    id: 'sunrise', n: 'Amanecer', d: 'De rojo profundo a día pleno', i: '🌅', cat: 'cine',
    tick: (T) => {
      const x = saw(T * .02);
      return sc(kelvin(lerp(1400, 6500, Math.pow(x, .8))), clamp(.04 + x * .96, 0, 1));
    }
  });
  add({
    id: 'sunset', n: 'Atardecer', d: 'De día pleno a brasa nocturna', i: '🌆', cat: 'cine',
    tick: (T) => {
      const x = 1 - saw(T * .02);
      return sc(mix(PAL.sunset[3], kelvin(lerp(1500, 6000, x)), Math.pow(x, .6)), clamp(.05 + x * .95, 0, 1));
    }
  });

  /* ---------- NATURALEZA ---------- */
  add({
    id: 'water', n: 'Agua', d: 'Cáusticas de piscina en cian', i: '💧', cat: 'natural',
    init: () => ({ a: mkNoise(2), b: mkNoise(53) }),
    tick: (T, s) => {
      const f = s.a(T * 1.9) * .6 + s.b(T * 4.3) * .4;
      return sc(mix([0, 120, 190], [160, 250, 255], f), .35 + f * .65);
    }
  });
  add({
    id: 'ocean', n: 'Océano', d: 'Marea azul profunda muy lenta', i: '🌊', cat: 'natural',
    tick: (T) => palAt(PAL.ocean, T * .06)
  });
  add({
    id: 'forest', n: 'Bosque', d: 'Luz filtrada entre hojas', i: '🌲', cat: 'natural',
    init: () => ({ a: mkNoise(29) }),
    tick: (T, s) => sc(palAt(PAL.forest, T * .07), .45 + s.a(T * 1.2) * .55)
  });
  add({
    id: 'aurora', n: 'Aurora boreal', d: 'Cortinas verdes y violetas', i: '🌌', cat: 'natural',
    init: () => ({ a: mkNoise(61), b: mkNoise(67) }),
    tick: (T, s) => {
      const f = s.a(T * .55), g = s.b(T * .31);
      return sc(mix(palAt(PAL.aurora, T * .04 + f * .3), [180, 120, 255], g * .45), .3 + f * .7);
    }
  });
  add({
    id: 'nebula', n: 'Nebulosa', d: 'Nubes cósmicas a la deriva', i: '☄', cat: 'natural',
    init: () => ({ a: mkNoise(71), b: mkNoise(73) }),
    tick: (T, s) => {
      const h = 250 + s.a(T * .22) * 130;
      return sc(hsv(h, .7 + s.b(T * .4) * .3, 1), .25 + s.a(T * .6) * .75);
    }
  });
  add({
    id: 'ice', n: 'Hielo', d: 'Azul glacial con destellos', i: '❄', cat: 'natural',
    init: () => ({ a: mkNoise(83) }),
    tick: (T, s) => (R() < .02 ? [255, 255, 255] : sc(palAt(PAL.ice, T * .05), .5 + s.a(T * 1.1) * .5))
  });
  add({
    id: 'lava', n: 'Lava', d: 'Magma denso que respira', i: '🌋', cat: 'natural',
    init: () => ({ a: mkNoise(89) }),
    tick: (T, s) => { const f = s.a(T * .8); return sc(mix([120, 0, 0], [255, 130, 0], f), .3 + f * .7); }
  });
  add({
    id: 'fog', n: 'Niebla', d: 'Gris azulado que va y viene', i: '🌫', cat: 'natural',
    init: () => ({ a: mkNoise(97) }),
    tick: (T, s) => sc([170, 190, 215], .12 + s.a(T * .35) * .5)
  });

  /* ---------- GLITCH / RETRO ---------- */
  add({
    id: 'glitch', n: 'Glitch', d: 'Canales RGB rotos y saltos', i: '▓', cat: 'glitch',
    init: () => ({ c: [255, 0, 128], next: 0 }),
    tick: (T, s) => {
      if (T > s.next) {
        s.next = T + .02 + R() * .22;
        s.c = R() < .3 ? [255 * R(), 255 * R(), 255 * R()]
          : [[255, 0, 128], [0, 255, 200], [255, 255, 0], [0, 0, 0]][Math.floor(R() * 4)];
      }
      return R() < .06 ? [255, 255, 255] : s.c;
    }
  });
  add({
    id: 'matrix', n: 'Matrix', d: 'Cascada verde de terminal', i: '⌗', cat: 'glitch',
    init: () => ({ a: mkNoise(101) }),
    tick: (T, s) => (R() < .05 ? [180, 255, 200] : sc([0, 255, 70], .08 + Math.pow(s.a(T * 5), 2) * .92))
  });
  add({
    id: 'portal', n: 'Portal', d: 'Vórtice azul-violeta inestable', i: '🌀', cat: 'glitch',
    init: () => ({ a: mkNoise(103) }),
    tick: (T, s) => {
      const f = s.a(T * 2.2);
      return sc(mix([80, 0, 255], [0, 230, 255], sin01(T * .7)), .3 + f * .7 + (R() < .03 ? .4 : 0));
    }
  });
  add({
    id: 'reactor', n: 'Reactor', d: 'Núcleo cian que se sobrecarga', i: '☢', cat: 'glitch',
    tick: (T) => {
      const x = saw(T * .1);
      const rate = lerp(1, 14, x * x);
      const c = mix([0, 220, 255], [255, 240, 180], x);
      return sc(c, .15 + .85 * Math.pow(sin01(T * rate), 2));
    }
  });
  add({
    id: 'noise', n: 'Ruido', d: 'Estática total, sin patrón', i: '⁙', cat: 'glitch',
    tick: () => [R() * 255, R() * 255, R() * 255]
  });
  add({
    id: 'scan', n: 'Escáner', d: 'Barrido cian tipo sci-fi', i: '⌁', cat: 'glitch',
    tick: (T) => sc([0, 240, 255], Math.pow(tri(T * .8), 6) + (saw(T * 20) < .1 ? .2 : 0))
  });
  add({
    id: 'vhs', n: 'VHS', d: 'Cinta gastada con dropouts', i: '📼', cat: 'glitch',
    init: () => ({ a: mkNoise(107) }),
    tick: (T, s) => {
      if (R() < .03) return sc([255, 255, 255], R());
      const w = s.a(T * 3);
      return sc(mix([200, 160, 255], [255, 200, 190], w), .45 + w * .4);
    }
  });
  add({
    id: 'crt', n: 'CRT', d: 'Encendido y apagado de tubo', i: '📼', cat: 'glitch',
    tick: (T) => {
      const x = saw(T * .18);
      if (x < .04) return sc([255, 255, 255], x / .04);
      if (x < .9) return sc([190, 215, 255], .6 + Math.sin(T * 120) * .05);
      const q = (x - .9) / .1;
      return sc([255, 255, 255], Math.max(0, 1 - q) * .9);
    }
  });

  /* ---------- REACTIVOS AL SONIDO ---------- */
  add({
    id: 'a_level', n: 'VU · Nivel', d: 'Brillo pegado al volumen', i: '🎚', cat: 'audio', audio: 1,
    tick: (T, s, p) => sc(hsv(p.hue, p.sat, 1), clamp(p.audio.level, 0, 1))
  });
  add({
    id: 'a_bass', n: 'VU · Graves', d: 'Golpea con el bombo', i: '🥁', cat: 'audio', audio: 1,
    tick: (T, s, p) => sc(hsv(p.hue, p.sat, 1), clamp(Math.pow(p.audio.bass, 1.6), 0, 1))
  });
  add({
    id: 'a_spectrum', n: 'Espectro', d: 'Graves→rojo, agudos→azul', i: '📊', cat: 'audio', audio: 1,
    tick: (T, s, p) => {
      const a = p.audio;
      return [clamp(a.bass * 255 * 1.3), clamp(a.mid * 255 * 1.3), clamp(a.treble * 255 * 1.5)];
    }
  });
  add({
    id: 'a_punch', n: 'Golpe', d: 'Flash blanco en cada pico', i: '👊', cat: 'audio', audio: 1,
    init: () => ({ e: 0 }),
    tick: (T, s, p) => {
      s.e = Math.max(s.e * .86, p.audio.bass > .55 ? 1 : 0);
      return mix(sc(hsv(p.hue, p.sat, 1), .1), [255, 255, 255], s.e);
    }
  });
  add({
    id: 'a_hue', n: 'Tono reactivo', d: 'El color sube con la energía', i: '🎨', cat: 'audio', audio: 1,
    init: () => ({ h: 0 }),
    tick: (T, s, p) => {
      s.h = (s.h + p.audio.level * 9) % 360;
      return sc(hsv(s.h, 1, 1), clamp(.15 + p.audio.level, 0, 1));
    }
  });
  add({
    id: 'a_strobe', n: 'Estrobo reactivo', d: 'Dispara solo cuando hay golpe', i: '⚡', cat: 'audio', audio: 1,
    tick: (T, s, p) => (p.audio.bass > .5 && saw(T * 20) < .5 ? [255, 255, 255] : OFF)
  });

  /* ---------- CINE: más prácticos ---------- */
  add({
    id: 'brasas', n: 'Brasas', d: 'Rescoldo profundo, casi sin llama', i: '🔥', cat: 'cine',
    init: () => ({ a: mkNoise(211), b: mkNoise(223) }),
    tick: (T, s) => {
      const f = s.a(T * .9) * .7 + s.b(T * 2.3) * .3;
      return sc(kelvin(1350 + f * 250), .18 + f * .42);
    }
  });
  add({
    id: 'chimenea', n: 'Chimenea', d: 'Fuego doméstico, más calmado', i: '🪵', cat: 'cine',
    init: () => ({ a: mkNoise(227), b: mkNoise(229), g: mkNoise(233) }),
    tick: (T, s) => {
      const f = s.a(T * 2.2) * .55 + s.b(T * 5.5) * .3 + s.g(T * .7) * .15;
      return sc(kelvin(1700 + f * 400), .45 + f * .55);
    }
  });
  add({
    id: 'relampago_calor', n: 'Relámpago de calor', d: 'Destellos lejanos, sin trueno', i: '🌫', cat: 'cine',
    init: () => ({ next: 2, hasta: 0 }),
    tick: (T, s, p) => {
      if (T > s.next) { s.next = T + 2 + R() * (9 - p.intensity * 6); s.hasta = T + .12 + R() * .25; }
      if (T < s.hasta) return sc([150, 170, 235], .25 + R() * .5);
      return sc([12, 16, 34], .3);
    }
  });
  add({
    id: 'cine_mudo', n: 'Cine mudo', d: 'Parpadeo de 16 fps y virado sepia', i: '🎬', cat: 'cine',
    tick: (T) => {
      const g = saw(T * 16) < .78 ? 1 : .3;
      return sc([255, 226, 178], (.68 + R() * .16) * g);
    }
  });
  add({
    id: 'tunel', n: 'Túnel de carretera', d: 'Farolas de sodio pasando', i: '🛣', cat: 'cine',
    tick: (T, s, p) => {
      const x = saw(T * (1.1 + p.intensity * 3.5));
      const env = Math.exp(-Math.pow((x - .5) * 5, 2));
      return sc([255, 168, 60], clamp(.06 + env * .94, 0, 1));
    }
  });
  add({
    id: 'ascensor', n: 'Ascensor averiado', d: 'Fluorescente que agoniza', i: '🛗', cat: 'cine',
    init: () => ({ next: 0, malo: false }),
    tick: (T, s) => {
      if (T > s.next) { s.next = T + (s.malo ? .1 + R() * .4 : 1 + R() * 3); s.malo = !s.malo; }
      if (!s.malo) return sc(kelvin(5200), .82 + Math.sin(T * 120) * .03);
      return R() < .5 ? sc(kelvin(5200), .1 + R() * .5) : OFF;
    }
  });
  add({
    id: 'interrogatorio', n: 'Interrogatorio', d: 'Foco duro que oscila', i: '🕵', cat: 'cine',
    tick: (T) => sc(kelvin(4200), .62 + .38 * sin01(T * .12))
  });
  add({
    id: 'quirofano', n: 'Quirófano', d: 'Blanco clínico, plano y frío', i: '🏥', cat: 'cine', ocultar: ['speed'],
    tick: (T) => sc(kelvin(5800), .95 + Math.sin(T * 100) * .02)
  });
  add({
    id: 'oficina', n: 'Fluorescente de oficina', d: 'Estable con rizado de red', i: '🏢', cat: 'cine', ocultar: ['speed'],
    tick: (T) => sc(kelvin(4300), .86 + Math.sin(T * 200 * Math.PI) * .035)
  });
  add({
    id: 'movil', n: 'Pantalla de móvil', d: 'Azulada, con desplazamiento', i: '📱', cat: 'cine',
    init: () => ({ a: mkNoise(239), next: 0, base: .5 }),
    tick: (T, s) => {
      if (T > s.next) { s.next = T + .8 + R() * 2.5; s.base = .3 + R() * .55; }
      return sc([170, 200, 255], s.base * (.9 + s.a(T * 3) * .2));
    }
  });
  add({
    id: 'avion', n: 'Cabina de avión', d: 'Penumbra azul de vuelo nocturno', i: '✈️', cat: 'cine',
    init: () => ({ a: mkNoise(241) }),
    tick: (T, s) => sc([70, 110, 190], .12 + s.a(T * .35) * .16)
  });
  add({
    id: 'sparkler', n: 'Bengala de mano', d: 'Chispas doradas crepitando', i: '🎇', cat: 'cine',
    init: () => ({ a: mkNoise(251) }),
    tick: (T, s) => (R() < .22 ? [255, 250, 225] : sc([255, 190, 80], .35 + s.a(T * 9) * .5))
  });
  add({
    id: 'cascada', n: 'Cascada', d: 'Espuma y agua en movimiento', i: '💦', cat: 'natural',
    init: () => ({ a: mkNoise(257), b: mkNoise(263) }),
    tick: (T, s) => {
      const f = s.a(T * 3.1) * .5 + s.b(T * 7.7) * .5;
      return sc(mix([120, 190, 230], [245, 252, 255], f), .55 + f * .45);
    }
  });
  add({
    id: 'tormenta_arena', n: 'Tormenta de arena', d: 'Ocre turbio y turbulento', i: '🏜', cat: 'natural',
    init: () => ({ a: mkNoise(269), b: mkNoise(271) }),
    tick: (T, s) => {
      const f = s.a(T * 1.4) * .6 + s.b(T * 4.1) * .4;
      return sc(mix([120, 80, 30], [225, 180, 110], f), .3 + f * .6);
    }
  });

  /* ---------- EMERGENCIA / SCI-FI ---------- */
  add({
    id: 'alerta_roja', n: 'Alerta roja', d: 'Barrido rojo de puente de mando', i: '🔴', cat: 'emergencia',
    tick: (T) => sc([255, 12, 8], .12 + .88 * Math.pow(sin01(T * .55), 3))
  });
  add({
    id: 'nuclear', n: 'Alerta nuclear', d: 'Ámbar giratorio con destello', i: '☢️', cat: 'emergencia',
    tick: (T) => {
      const g = Math.pow(sin01(T * .7), 8);
      return sc([255, 150, 0], clamp(.15 + g + (saw(T * 3) < .06 ? .5 : 0), 0, 1));
    }
  });
  add({
    id: 'escaner_super', n: 'Escáner de caja', d: 'Línea roja de lector', i: '🛒', cat: 'glitch',
    tick: (T) => sc([255, 20, 20], Math.pow(saw(T * 2.2), 9) + .04)
  });
  add({
    id: 'motor_nave', n: 'Motor de nave', d: 'Cian que respira con el reactor', i: '🚀', cat: 'glitch',
    init: () => ({ a: mkNoise(277) }),
    tick: (T, s) => sc(mix([0, 160, 255], [180, 245, 255], s.a(T * 1.8)), .35 + .5 * sin01(T * .9))
  });
  add({
    id: 'poltergeist', n: 'Poltergeist', d: 'La luz se comporta rarísimo', i: '👻', cat: 'glitch',
    init: () => ({ next: 0, c: [255, 255, 255], v: 1 }),
    tick: (T, s) => {
      if (T > s.next) {
        s.next = T + .05 + R() * .8;
        s.v = R() < .3 ? R() * .15 : .5 + R() * .5;
        s.c = R() < .25 ? hsv(R() * 360, .5, 1) : kelvin(2800 + R() * 3000);
      }
      return sc(s.c, s.v * (R() < .08 ? .2 : 1));
    }
  });

  /* ---------- CLUB ---------- */
  add({
    id: 'bombo', n: 'Golpe de bombo', d: 'Pulso seco al tempo marcado', i: '🥁', cat: 'club',
    tick: (T, s, p) => sc(hsv(p.hue, p.sat, 1), Math.pow(1 - p.phase, 3.5))
  });
  add({
    id: 'hardcore', n: 'Rave hardcore', d: 'Estrobo de colores sin piedad', i: '💊', cat: 'club',
    init: () => ({ c: [255, 255, 255], t: 0 }),
    tick: (T, s) => {
      if (T > s.t) { s.t = T + .05 + R() * .05; s.c = hsv(Math.floor(R() * 6) * 60, 1, 1); }
      return saw(T * 24) < .5 ? s.c : OFF;
    }
  });
  add({
    id: 'lounge', n: 'Lounge', d: 'Deriva cálida de sobremesa', i: '🍸', cat: 'ambiente',
    init: () => ({ a: mkNoise(281) }),
    tick: (T, s) => sc(palAt([[180, 40, 90], [120, 40, 160], [200, 80, 60], [90, 40, 140]], T * .03),
      .45 + s.a(T * .4) * .35)
  });

  /* ---------- GELATINAS ----------
     Equivalencias aproximadas de filtros de cine. Las de temperatura llevan
     usaCCT: el tubo tiene LED blancos dedicados y el resultado es mucho mejor
     que fabricar el blanco mezclando rojo, verde y azul. */
  const gel = (id, n, d, k, rgbFijo) => add({
    id, n, d, i: '🎞', cat: 'gel',
    usaCCT: k ? k : 0,
    tick: () => (rgbFijo ? rgbFijo : kelvin(k))
  });
  gel('g_cto_full', 'CTO entero', '5600 K → 3200 K', 3200);
  gel('g_cto_half', 'CTO 1/2', '5600 K → 3800 K', 3800);
  gel('g_cto_quarter', 'CTO 1/4', '5600 K → 4500 K', 4500);
  gel('g_ctb_full', 'CTB entero', '3200 K → 5600 K', 5600);
  gel('g_ctb_half', 'CTB 1/2', 'Corrección parcial a frío', 4600);
  gel('g_tungsteno', 'Tungsteno', 'Clásico 3200 K', 3200);
  gel('g_luz_dia', 'Luz de día', 'Neutro 5600 K', 5600);
  gel('g_nublado', 'Nublado', 'Frío 7000 K', 7000);
  gel('g_sombra', 'Sombra', 'Muy frío 9000 K', 9000);
  gel('g_vela', 'Vela', 'Cálido extremo 1900 K', 1900);
  gel('g_plusgreen', 'Plus Green', 'Compensa fluorescente', 0, [190, 255, 170]);
  gel('g_minusgreen', 'Minus Green', 'Magenta correctivo', 0, [255, 180, 235]);
  gel('g_bastard', 'Bastard Amber', 'Ámbar sutil favorecedor', 0, [255, 205, 160]);
  gel('g_steel', 'Steel Blue', 'Azul acero de noche', 0, [130, 180, 235]);
  gel('g_congo', 'Congo Blue', 'Azul profundo teatral', 0, [40, 0, 190]);
  gel('g_pink', 'Surprise Pink', 'Rosa de escenario', 0, [255, 105, 190]);
  gel('g_lavanda', 'Lavanda', 'Violeta suave', 0, [200, 160, 255]);
  gel('g_fuego', 'Fire', 'Naranja de llama', 0, [255, 110, 20]);
  gel('g_piel', 'Piel', 'Neutro favorecedor para retrato', 0, [255, 226, 205]);

  SK.FX = FX;
  SK.FX_BY_ID = Object.fromEntries(FX.map((f) => [f.id, f]));
  SK.CATS = [
    ['todos', 'Todos'], ['fav', '★ Favoritos'], ['ambiente', 'Ambiente'], ['club', 'Club'],
    ['estrobo', 'Estrobos'], ['emergencia', 'Emergencia'], ['cine', 'Cine'],
    ['natural', 'Naturaleza'], ['glitch', 'Glitch'], ['gel', 'Gelatinas'], ['audio', 'Audio-reactivos']
  ];
})();
