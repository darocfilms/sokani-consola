/* =========================================================================
   protocols.js — Capa de protocolo intercambiable
   -------------------------------------------------------------------------
   El protocolo BLE del Sokani X25 RGB no es publico. En vez de adivinar una
   sola trama, aqui hay un catalogo de los formatos usados por practicamente
   todos los controladores LED BLE chinos + un constructor de tramas propio +
   un escaner que los prueba en vivo hasta que el tubo reacciona.
   ========================================================================= */
(function () {
  const SK = window.SK || (window.SK = {});

  const u16 = (x) => `0000${x.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
  const sum8 = (a) => a.reduce((s, v) => (s + v) & 0xff, 0);
  const xor8 = (a) => a.reduce((s, v) => s ^ v, 0);
  const pct = (v) => Math.max(0, Math.min(100, Math.round(v * 100)));
  const b255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

  /* ---- UUIDs candidatos para descubrimiento -------------------------- */
  const KNOWN = [
    'ffe0', 'ffe5', 'ffd5', 'ffd0', 'fff0', 'ff00', 'ffb0', 'ffa0', 'fee7',
    'fe59', 'ffc0', 'ff10', 'ff90', 'ffe1', 'ffd9', 'ae00', 'ae30', 'd0ff',
    '1800', '1801', '180a', '180f', 'fef0', 'fd00', 'f000'
  ].map(u16);

  const VENDOR = [
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',              // Nordic UART
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',              // Microchip transparent
    'f000ffc0-0451-4000-b000-000000000000',              // TI OAD
    '0783b03e-8535-b5a0-7140-a304d2495cb7'               // Telink
  ];

  // Rango completo 0xFF00-0xFFFF: cubre casi cualquier servicio propietario de 16 bits.
  function wideList() {
    const out = [];
    for (let i = 0xff00; i <= 0xffff; i++) out.push(u16(i));
    for (let i = 0xfe00; i <= 0xfeff; i += 1) out.push(u16(i));
    // El modo amplio tiene que ser un superconjunto del normal: si no, barre
    // los propietarios pero pierde los estandar (0x180F bateria, 0x180A info).
    return out.concat(KNOWN, VENDOR);
  }

  /* UUIDs de 128 bits anadidos por el usuario.
     IMPORTANTE: Web Bluetooth solo deja ver los servicios que declaras de
     antemano en optionalServices. No existe un "dame todos los servicios".
     Si la luz usa un UUID propietario de 128 bits (habitual en luces de
     video), getPrimaryServices() no devolvera NADA y parecera que el
     dispositivo no tiene caracteristicas escribibles. Por eso hace falta
     poder pegar los UUID reales, sacados de chrome://bluetooth-internals. */
  SK.customUUIDs = [];
  SK.normUUID = function (x) {
    x = String(x).trim().toLowerCase().replace(/[{}]/g, '');
    if (!x) return null;
    if (/^0x[0-9a-f]{1,4}$/.test(x)) return u16(parseInt(x, 16));
    if (/^[0-9a-f]{1,4}$/.test(x)) return u16(parseInt(x, 16));
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x)) return x;
    return null;
  };
  SK.setCustomUUIDs = function (text) {
    const list = String(text || '').split(/[\s,;]+/).map(SK.normUUID).filter(Boolean);
    SK.customUUIDs = Array.from(new Set(list));
    return SK.customUUIDs;
  };
  SK.optionalServices = (wide) =>
    Array.from(new Set((wide ? wideList() : KNOWN.concat(VENDOR)).concat(SK.customUUIDs)));

  /* =====================================================================
     Un "driver" define:
       svc / chr : UUIDs sugeridos (null = usar la caracteristica elegida)
       power(on) : trama de encendido/apagado  (null si no aplica)
       rgb(r,g,b,br) : trama de color, br = 0..1
       bright(br)    : trama de brillo separada (opcional)
       cct(k,br)     : trama de blanco variable (opcional; si no, se convierte a RGB)
     Todas devuelven Uint8Array o array de Uint8Array (se envian en orden).
     ===================================================================== */
  const D = {};

  /* --- 1. ELK-BLEDOM / SP110E-like ----------------------------------- */
  D.elk = {
    id: 'elk', name: 'ELK-BLEDOM (7E…EF)',
    note: 'El mas comun en tiras y tubos LED baratos. Servicio FFF0 / car. FFF3.',
    svc: u16(0xfff0), chr: u16(0xfff3),
    power: (on) => new Uint8Array(on
      ? [0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef]
      : [0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef]),
    rgb: (r, g, b) => new Uint8Array([0x7e, 0x00, 0x05, 0x03, b255(r), b255(g), b255(b), 0x00, 0xef]),
    bright: (br) => new Uint8Array([0x7e, 0x00, 0x01, pct(br), 0x00, 0x00, 0x00, 0x00, 0xef])
  };

  /* --- 2. Triones / Zengge ------------------------------------------- */
  D.triones = {
    id: 'triones', name: 'Triones / Zengge (56…AA)',
    note: 'Servicio FFD5 / car. FFD9. Brillo va escalado dentro del RGB.',
    svc: u16(0xffd5), chr: u16(0xffd9),
    power: (on) => new Uint8Array(on ? [0xcc, 0x23, 0x33] : [0xcc, 0x24, 0x33]),
    rgb: (r, g, b, br) => new Uint8Array([0x56, b255(r * br), b255(g * br), b255(b * br), 0x00, 0xf0, 0xaa]),
    cct: (k, br) => { const w = b255(255 * br); return new Uint8Array([0x56, 0, 0, 0, w, 0x0f, 0xaa]); }
  };

  /* --- 3. Magic Home / LEDnet ---------------------------------------- */
  D.magic = {
    id: 'magic', name: 'Magic Home / LEDnet (31…)',
    note: 'Servicio FFE5 / car. FFE9. Checksum = suma & 0xFF.',
    svc: u16(0xffe5), chr: u16(0xffe9),
    power: (on) => { const f = [0x71, on ? 0x23 : 0x24, 0x0f]; return new Uint8Array(f.concat(sum8(f))); },
    rgb: (r, g, b, br) => {
      const f = [0x31, b255(r * br), b255(g * br), b255(b * br), 0x00, 0xf0, 0x0f];
      return new Uint8Array(f.concat(sum8(f)));
    },
    cct: (k, br) => { const f = [0x31, 0, 0, 0, b255(255 * br), 0x0f, 0x0f]; return new Uint8Array(f.concat(sum8(f))); }
  };

  /* --- 4. HM-10 / transparente: triplete RGB crudo -------------------- */
  D.raw3 = {
    id: 'raw3', name: 'UART crudo — R G B',
    note: 'Modulos HM-10/JDY (FFE0/FFE1). Solo 3 bytes, sin cabecera.',
    svc: u16(0xffe0), chr: u16(0xffe1),
    power: null,
    rgb: (r, g, b, br) => new Uint8Array([b255(r * br), b255(g * br), b255(b * br)])
  };

  /* --- 5. UART ASCII -------------------------------------------------- */
  D.ascii = {
    id: 'ascii', name: 'UART ASCII — "R,G,B\\n"',
    note: 'Firmwares tipo Arduino/ESP. Texto plano terminado en salto de linea.',
    svc: u16(0xffe0), chr: u16(0xffe1),
    power: (on) => new TextEncoder().encode(on ? 'ON\n' : 'OFF\n'),
    rgb: (r, g, b, br) => new TextEncoder().encode(`${b255(r * br)},${b255(g * br)},${b255(b * br)}\n`)
  };

  /* --- 6. Nordic UART ------------------------------------------------- */
  D.nus = {
    id: 'nus', name: 'Nordic UART (NUS)',
    note: 'Servicio 6E400001… / TX 6E400002. Payload tipo ELK por defecto.',
    svc: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    chr: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    power: (on) => new Uint8Array(on
      ? [0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef]
      : [0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef]),
    rgb: (r, g, b) => new Uint8Array([0x7e, 0x00, 0x05, 0x03, b255(r), b255(g), b255(b), 0x00, 0xef])
  };

  /* --- 7-9. Candidatos "luz de video" (Sokani / Godox / Nanlite like) --
     Estas luces suelen usar una trama [cabecera, cmd, len, payload, chk].
     Tres variantes plausibles; el escaner las prueba junto al resto.     */
  D.video_aa = {
    id: 'video_aa', name: 'Luz de video AA (AA…SUM)',
    note: 'Candidato Sokani/Godox: AA 01 04 BR R G B + suma.',
    svc: null, chr: null,
    power: (on) => { const f = [0xaa, 0x02, 0x01, on ? 0x01 : 0x00]; return new Uint8Array(f.concat(sum8(f))); },
    rgb: (r, g, b, br) => {
      const f = [0xaa, 0x01, 0x04, pct(br), b255(r), b255(g), b255(b)];
      return new Uint8Array(f.concat(sum8(f)));
    },
    cct: (k, br) => {
      const kk = Math.round(k / 100);
      const f = [0xaa, 0x03, 0x02, pct(br), kk];
      return new Uint8Array(f.concat(sum8(f)));
    }
  };

  D.video_hsi = {
    id: 'video_hsi', name: 'Luz de video HSI (5A…XOR)',
    note: 'Candidato HSI: 5A 01 H_hi H_lo S I + XOR. Tipico en luces RGB pro.',
    svc: null, chr: null,
    power: (on) => { const f = [0x5a, 0x00, on ? 0x01 : 0x00]; return new Uint8Array(f.concat(xor8(f))); },
    rgb: (r, g, b, br) => {
      const [h, s] = SK.U.rgb2hs(r, g, b);
      const f = [0x5a, 0x01, (h >> 8) & 0xff, h & 0xff, pct(s), pct(br)];
      return new Uint8Array(f.concat(xor8(f)));
    }
  };

  D.video_fe = {
    id: 'video_fe', name: 'Luz de video FE (FE…FF)',
    note: 'Candidato: FE 05 R G B BR FF, sin checksum.',
    svc: null, chr: null,
    power: (on) => new Uint8Array([0xfe, 0x01, on ? 0x01 : 0x00, 0xff]),
    rgb: (r, g, b, br) => new Uint8Array([0xfe, 0x05, b255(r), b255(g), b255(b), pct(br), 0xff])
  };

  /* --- 10-14. Candidatos HSI de un byte -------------------------------
     La app oficial del X25 ("SS LED") es RGBCW y controla en HSI. La
     convencion mas extendida en estas luces es meter el tono en UN byte
     como H/2 (0-179) y S/I como porcentajes 0-100. Estos son candidatos
     razonados, no protocolo confirmado: el escaner los prueba junto al resto. */
  const h2 = (r, g, b) => { const [h] = SK.U.rgb2hsv(r, g, b); return Math.round(h / 2) & 0xff; };
  const sPct = (r, g, b) => { const [, s] = SK.U.rgb2hsv(r, g, b); return pct(s); };

  D.hsi_raw = {
    id: 'hsi_raw', name: 'HSI crudo — H/2 S I',
    note: 'Tres bytes pelados: tono/2, saturacion %, intensidad %.',
    svc: null, chr: null, power: null,
    rgb: (r, g, b, br) => new Uint8Array([h2(r, g, b), sPct(r, g, b), pct(br)])
  };

  D.hsi_aa = {
    id: 'hsi_aa', name: 'HSI · AA 04 (…SUM)',
    note: 'Candidato SS LED: AA 04 H/2 S I + suma.',
    svc: null, chr: null,
    power: (on) => { const f = [0xaa, 0x02, on ? 0x01 : 0x00]; return new Uint8Array(f.concat(sum8(f))); },
    rgb: (r, g, b, br) => {
      const f = [0xaa, 0x04, h2(r, g, b), sPct(r, g, b), pct(br)];
      return new Uint8Array(f.concat(sum8(f)));
    },
    cct: (k, br) => { const f = [0xaa, 0x05, Math.round(k / 100), pct(br)]; return new Uint8Array(f.concat(sum8(f))); }
  };

  D.hsi_7b = {
    id: 'hsi_7b', name: 'HSI · 7B…7D',
    note: 'Candidato con marco 7B … 7D (frecuente en drivers chinos).',
    svc: null, chr: null,
    power: (on) => new Uint8Array([0x7b, 0x02, on ? 0x01 : 0x00, 0x00, 0x7d]),
    rgb: (r, g, b, br) => new Uint8Array([0x7b, 0x04, h2(r, g, b), sPct(r, g, b), pct(br), 0x7d])
  };

  D.rgbcw = {
    id: 'rgbcw', name: 'RGBCW crudo — R G B C W',
    note: 'Cinco canales pelados. El X25 es RGBCW, asi que entra en la quiniela.',
    svc: null, chr: null, power: null,
    rgb: (r, g, b, br) => new Uint8Array([b255(r * br), b255(g * br), b255(b * br), 0, 0])
  };

  D.rgbcw_aa = {
    id: 'rgbcw_aa', name: 'RGBCW · AA 05 (…SUM)',
    note: 'Candidato: AA 05 R G B C W + suma.',
    svc: null, chr: null,
    power: (on) => { const f = [0xaa, 0x02, on ? 0x01 : 0x00]; return new Uint8Array(f.concat(sum8(f))); },
    rgb: (r, g, b, br) => {
      const f = [0xaa, 0x05, b255(r * br), b255(g * br), b255(b * br), 0, 0];
      return new Uint8Array(f.concat(sum8(f)));
    }
  };

  /* --- SOKANI STX25RGB -------------------------------------------------
     Extraido del APK de SS LED (com.zzcyi.sutudengjv) leyendo el bytecode de
     SetDeviceActivity.rgbWrite/hsiWrite/cctWrite/fxWrite:

        FA | cmd | adjustType | channel | group | ...datos... | SUMA | 8A

     cmd:  0x06 CCT   0x07 HSI   0x08 RGBCW   0x09 FX
     Como el cmd viaja en la trama, el propio comando cambia el modo del tubo:
     no hay que dejarlo en ningun menu concreto.
     La suma es HexUtil.sumCheck: suma de bytes enmascarada a 8 bits. Lo que no
     se deduce del bytecode es que rango cubre, asi que hay cuatro variantes y
     se calibran solas contra la telemetria del tubo. */
  const SOKANI = {
    svc: u16(0xffe0), chr: u16(0xffe1),
    cfg: { adjustType: 0, channel: 0, group: 0, chk: 0 },
    _sum(a) { return a.reduce((x, y) => (x + y) & 0xff, 0); },
    wrap(payload) {
      const p = payload.map((v) => v & 0xff);
      const f = new Uint8Array(p.length + 3);
      f[0] = 0xfa; f.set(p, 1); f[f.length - 1] = 0x8a;
      const s = this._sum(p);
      f[f.length - 2] = [
        s,                                   // 0: suma del payload
        (s + 0xfa) & 0xff,                   // 1: incluyendo la cabecera
        (~s + 1) & 0xff,                     // 2: complemento a dos
        p.reduce((x, y) => x ^ y, 0)         // 3: XOR
      ][this.cfg.chk] & 0xff;
      return f;
    },
    head() { const c = this.cfg; return [c.adjustType, c.channel, c.group]; },
    /* Sin estado aqui: el delta lo lleva cada Light, porque con varias luces
       el driver es compartido y unas se comerian las tramas de otras. */
  };

  D.sokani_rgb = Object.assign({
    id: 'sokani_rgb', name: '★ Sokani X25 · RGBCW',
    note: 'FA 08 aT ch gr R G B W1 W2 SUMA 8A — sacado del APK de SS LED.',
    power: null,
    rgb(r, g, b, br) {
      return this.wrap([0x08, ...this.head(), b255(r * br), b255(g * br), b255(b * br), 0, 0]);
    },
    /* Blanco por el comando nativo (0x06): usa los LED blancos reales del
       tubo en vez de mezclarlo con los RGB, que da mucho peor reproduccion
       cromatica en una luz de video. */
    cct(k, br) {
      const kk = Math.max(2700, Math.min(6500, Math.round(k)));
      return this.wrap([0x06, ...this.head(), (kk >> 8) & 0xff, kk & 0xff, pct(br), 0]);
    }
  }, SOKANI);

  D.sokani_hsi = Object.assign({
    id: 'sokani_hsi', name: '★ Sokani X25 · HSI',
    note: 'FA 07 aT ch gr Hhi Hlo S I SUMA 8A — tono de 16 bits.',
    power: null,
    rgb(r, g, b, br) {
      const [h, sa] = SK.U.rgb2hsv(b255(r), b255(g), b255(b));
      const hh = Math.round(h) & 0xffff;
      return this.wrap([0x07, ...this.head(), (hh >> 8) & 0xff, hh & 0xff, pct(sa), pct(br)]);
    }
  }, SOKANI);

  SK.SOKANI = SOKANI;

  /* --- 15. Plantilla de texto ------------------------------------------
     El STX25RGB habla lineas de texto terminadas en CR+LF (lo delatan sus
     propios mensajes: "ad:...", "chg:...", "k:7-50-"). Cuando sepamos el
     comando exacto, se escribe aqui una vez y quedan andando los 83 efectos. */
  D.ascii_tpl = {
    id: 'ascii_tpl', name: '⌨︎ Plantilla de texto (ASCII)',
    note: 'Línea de texto + CR/LF. Tokens: {R} {G} {B} {BR} {H} {H2} {S} {V} {K}',
    svc: u16(0xffe0), chr: u16(0xffe1),
    tpl: { on: '', off: '', rgb: 'c:{R},{G},{B}' },
    eol: '\r\n',
    _fill(t, r, g, b, br) {
      const [h, sa, v] = SK.U.rgb2hsv(b255(r), b255(g), b255(b));
      const map = {
        R: b255(r), G: b255(g), B: b255(b),
        BR: pct(br), H: Math.round(h), H2: Math.round(h / 2),
        S: pct(sa), V: pct(v), K: 5600
      };
      return String(t).replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
    },
    power(on) {
      const t = on ? this.tpl.on : this.tpl.off;
      return t ? new TextEncoder().encode(this._fill(t, 255, 255, 255, 1) + this.eol) : null;
    },
    rgb(r, g, b, br) {
      return new TextEncoder().encode(this._fill(this.tpl.rgb, r, g, b, br) + this.eol);
    }
  };

  /* --- NANLITE / NANLUX: payload FLM (EXPERIMENTAL) --------------------
     Formato del contenido de comando sacado del catalogo de NANLINK
     (data/nanlite-protocol.json). En la app oficial este payload viaja DENTRO
     de un mensaje FeasyMesh CIFRADO; aqui se manda CRUDO a la caracteristica,
     por si el modulo Feasycom del tubo tiene un modo transparente que lo
     acepte sin cifrar. Es un intento, no protocolo verificado: si la luz no
     reacciona, es que exige la malla completa (no implementada). */
  let _nanSeq = 0;
  const nanDim = (br) => { const d = Math.round(pct(br) * 10); return [(d >> 8) & 0xff, d & 0xff]; }; // 0..1000
  const nanFrame = (payload) => new Uint8Array([(_nanSeq++) & 0xff, ...payload]);

  D.nanlite_rgbw = {
    id: 'nanlite_rgbw', name: '◐ Nanlite RGBW (FLM, experimental)',
    note: 'Payload FLM_RGBW crudo a FFF1. Solo funciona si el tubo tiene modo transparente.',
    svc: u16(0xfff0), chr: u16(0xfff1),
    power: null,
    rgb(r, g, b, br) {
      const [dh, dl] = nanDim(br);
      // seq | dimHi dimLo | 05(FLM_RGBW) | 01(SLM_NONE) | R G B W
      return nanFrame([dh, dl, 0x05, 0x01, b255(r), b255(g), b255(b), 0]);
    }
  };
  D.nanlite_hsi = {
    id: 'nanlite_hsi', name: '◐ Nanlite HSI (FLM, experimental)',
    note: 'Payload FLM_HSI crudo a FFF1.',
    svc: u16(0xfff0), chr: u16(0xfff1),
    power: null,
    rgb(r, g, b, br) {
      const [h, sa] = SK.U.rgb2hsv(b255(r), b255(g), b255(b));
      const hh = Math.round(h) & 0xffff;
      const [dh, dl] = nanDim(br);
      // seq | dimHi dimLo | 03(FLM_HSI) | 01(SLM_NONE) | hueHi hueLo | sat
      return nanFrame([dh, dl, 0x03, 0x01, (hh >> 8) & 0xff, hh & 0xff, pct(sa)]);
    }
  };
  D.nanlite_cct = {
    id: 'nanlite_cct', name: '◐ Nanlite CCT (FLM, experimental)',
    note: 'Payload FLM_CCT crudo a FFF1.',
    svc: u16(0xfff0), chr: u16(0xfff1),
    power: null,
    rgb(r, g, b, br) {
      const k = 5600, [dh, dl] = nanDim(br);
      return nanFrame([dh, dl, 0x02, 0x02, 0x01, (k >> 8) & 0xff, k & 0xff, 0, 0, 0x01]);
    },
    cct(k, br) {
      k = Math.max(2700, Math.min(7500, Math.round(k)));
      const [dh, dl] = nanDim(br);
      return nanFrame([dh, dl, 0x02, 0x02, 0x01, (k >> 8) & 0xff, k & 0xff, 0, 0, 0x01]);
    }
  };

  /* --- 16. Plantilla propia (hex) ------------------------------------- */
  D.custom = {
    id: 'custom', name: '⚙︎ Plantilla propia (hex)',
    note: 'Escribe tu trama con tokens: {R} {G} {B} {BR} {BR255} {H} {HI} {LO} {S} {V} {K} {SUM} {XOR}',
    svc: null, chr: null,
    tpl: { on: '', off: '', rgb: '7E 00 05 03 {R} {G} {B} 00 EF' },
    power(on) { const t = on ? this.tpl.on : this.tpl.off; return t ? SK.tplBytes(t, { r: 255, g: 255, b: 255, br: 1 }) : null; },
    rgb(r, g, b, br) { return SK.tplBytes(this.tpl.rgb, { r, g, b, br }); }
  };

  SK.DRIVERS = D;
  SK.DRIVER_ORDER = ['sokani_rgb', 'sokani_hsi', 'elk', 'triones', 'magic', 'raw3', 'ascii', 'nus',
    'video_aa', 'video_hsi', 'video_fe',
    'hsi_raw', 'hsi_aa', 'hsi_7b', 'rgbcw', 'rgbcw_aa',
    'nanlite_rgbw', 'nanlite_hsi', 'nanlite_cct', 'ascii_tpl', 'custom'];

  /* ---- Motor de plantillas ------------------------------------------ */
  SK.tplBytes = function (tpl, { r, g, b, br, k }) {
    r = b255(r); g = b255(g); b = b255(b);
    const [h, s, v] = SK.U.rgb2hsv(r, g, b);
    const map = {
      R: r, G: g, B: b,
      BR: pct(br), BR255: b255(255 * br),
      H: Math.round(h) & 0xff, HI: (Math.round(h) >> 8) & 0xff, LO: Math.round(h) & 0xff,
      S: pct(s), V: pct(v), K: Math.round((k || 5600) / 100)
    };
    const toks = tpl.trim().split(/[\s,]+/).filter(Boolean);
    const out = [];
    let sumIdx = -1, xorIdx = -1;
    for (const t of toks) {
      const T = t.toUpperCase().replace(/[{}]/g, '');
      if (T === 'SUM') { sumIdx = out.length; out.push(0); }
      else if (T === 'XOR') { xorIdx = out.length; out.push(0); }
      else if (T in map) out.push(map[T] & 0xff);
      else out.push(parseInt(t.replace(/^0[xX]/, ''), 16) & 0xff);
    }
    if (sumIdx >= 0) out[sumIdx] = sum8(out.filter((_, i) => i !== sumIdx));
    if (xorIdx >= 0) out[xorIdx] = xor8(out.filter((_, i) => i !== xorIdx));
    return new Uint8Array(out);
  };

  /* ---- Utilidades de color compartidas ------------------------------- */
  SK.U = SK.U || {};
  SK.U.rgb2hsv = function (r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, mx ? d / mx : 0, mx];
  };
  SK.U.rgb2hs = function (r, g, b) { const [h, s] = SK.U.rgb2hsv(r, g, b); return [Math.round(h), s]; };
  // Tolera null: los drivers con delta devuelven null cuando no hay cambio.
  SK.hex = (u8) => (u8 ? Array.from(u8).map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join(' ') : '');
  SK.parseHex = (s) => new Uint8Array(
    s.trim().split(/[\s,]+/).filter(Boolean).map((x) => parseInt(x.replace(/^0[xX]/, ''), 16) & 0xff)
  );
  if (SK.CONFIG && SK.CONFIG.soloSokani) {
    SK.DRIVER_ORDER = SK.DRIVER_ORDER.filter((id) => !id.startsWith('nanlite'));
  }
})();
