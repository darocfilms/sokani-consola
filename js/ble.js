/* =========================================================================
   ble.js — Transporte Web Bluetooth
   Conexion, descubrimiento GATT, cola de escritura con "el ultimo gana"
   y escaner automatico de protocolo.
   ========================================================================= */
(function () {
  const SK = window.SK || (window.SK = {});

  const BLE = SK.BLE = {
    /* Fachada sobre SK.Rig: todas las herramientas de diagnostico siguen
       hablando en singular («la luz») mientras por debajo hay un rig. */
    get rig() { return SK.Rig; },
    get lights() { return SK.Rig.lights; },
    get active() { return SK.Rig.active; },
    get device() { return SK.Rig.active && SK.Rig.active.device; },
    get connected() { return SK.Rig.anyConnected; },
    get services() { return SK.Rig.active ? SK.Rig.active.services : []; },
    get writables() { return SK.Rig.active ? SK.Rig.active.writables : []; },
    get tx() { return SK.Rig.active ? SK.Rig.active.tx : null; },
    set tx(v) { if (SK.Rig.active) SK.Rig.active.tx = v; },
    get stats() { return SK.Rig.active ? SK.Rig.active.stats : { sent: 0, err: 0, bps: 0 }; },
    get driver() { return SK.DRIVERS[SK.Rig.driverId]; },
    set driver(d) { if (d) SK.Rig.driverId = d.id; },
    get writeMode() { return SK.Rig.writeMode; },
    set writeMode(v) { SK.Rig.writeMode = v; },
    get telemetry() { return SK.Rig.active ? SK.Rig.active.telemetry : {}; },
    writeGap: 0,
    ledOnAt: 0,
    onLog: () => { }, onState: () => { },

    log(msg, cls) { this.onLog(msg, cls); },


    supported() {
      return !!SK.native || (typeof navigator !== 'undefined' && !!navigator.bluetooth);
    },

    /* Diagnostico: la mayoria de los "no conecta" no son bugs de la app sino
       del entorno. Esto los separa antes de que el usuario pierda una hora. */
    async diagnose() {
      const out = [];
      const ok = (t) => out.push({ ok: true, t });
      const no = (t, fix) => out.push({ ok: false, t, fix });

      if (window.isSecureContext) ok('Contexto seguro (https o localhost)');
      else no('La pagina NO esta en contexto seguro',
        'Abrela por http://localhost, no con doble clic (file://). Ejecuta ./serve.sh');

      const ua = navigator.userAgent;
      const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const chromium = !!window.chrome && /Chrome|Chromium|Edg/.test(ua);

      if (SK.native) {
        ok('App nativa iOS: Bluetooth por CoreBluetooth, todos los servicios visibles');
        const st = await SK.native.estado();
        if (st === 'unauthorized') no('La app no tiene permiso de Bluetooth',
          'Ajustes del iPhone › Privacidad y seguridad › Bluetooth › activa Sokani.');
        else if (st === 'poweredOff') no('El Bluetooth del iPhone está apagado', 'Actívalo en el Centro de control.');
        else if (st === 'unsupported') no('Este dispositivo no tiene Bluetooth LE (¿simulador?)', 'Prueba en un iPhone real.');
        else if (st === 'poweredOn') ok('Bluetooth del iPhone encendido y autorizado');
      }
      else if (navigator.bluetooth) ok('El navegador expone navigator.bluetooth');
      else if (iOS) no('iOS/iPadOS: Safari no implementa Web Bluetooth y nunca lo hara',
        'Usa el navegador Bluefy (App Store) o la app nativa de la carpeta ios/');
      else if (!chromium) no('Este navegador no soporta Web Bluetooth',
        'Safari y Firefox no lo implementan. Usa Chrome o Edge.');
      else no('navigator.bluetooth no disponible',
        'Revisa que Web Bluetooth no este desactivado en chrome://flags');

      if (!SK.native && navigator.bluetooth && navigator.bluetooth.getAvailability) {
        try {
          const av = await navigator.bluetooth.getAvailability();
          if (av) ok('Hay adaptador Bluetooth disponible');
          else no('El navegador no ve ningun adaptador Bluetooth',
            'Enciende el Bluetooth del sistema. En macOS: Ajustes > Privacidad y seguridad > Bluetooth, y activa el permiso para Chrome.');
        } catch (e) { }
      }

      out.push({ info: true, t: 'Aviso: si emparejaste el tubo en los ajustes de Bluetooth del sistema, o si la app del movil sigue conectada, el tubo deja de anunciarse y Chrome NO lo vera. Debe estar desemparejado y libre.' });
      return out;
    },

    /* ---------------- conexion ----------------
       En la app iOS, native-bridge.js instala un navigator.bluetooth sobre
       CoreBluetooth, así que este mismo camino sirve en los dos mundos. */
    async connect({ wide = false, namePrefix = '' } = {}) {
      if (!this.supported()) throw new Error(
        'Web Bluetooth no disponible. Usa Chrome o Edge de escritorio (o Android) y sirve la página por http://localhost. ' +
        'En iPhone/iPad usa el navegador Bluefy o la app nativa de la carpeta ios/.'
      );
      const opts = { optionalServices: SK.optionalServices(wide) };
      if (namePrefix) opts.filters = [{ namePrefix }];
      else opts.acceptAllDevices = true;

      this.log('Abriendo selector de dispositivos…', 'm');
      const dev = await navigator.bluetooth.requestDevice(opts);
      this.log(`Conectando a "${dev.name || '(sin nombre)'}"…`);
      await SK.Rig.adopt(dev);
      this.onState();
      return dev;
    },

    async disconnect() {
      SK.Rig.autoReconnect = false;
      for (const l of SK.Rig.lights) await l.disconnect();
      SK.Rig.lights.length = 0;
      SK.Rig.autoReconnect = true;
      this.onState();
      this.log('Desconectado.', 'w');
    },

    /* ---------------- descubrimiento GATT ---------------- */
    async discover() {
      if (SK.Rig.active) await SK.Rig.active.discover();
      return;
      /* eslint-disable no-unreachable */
      this.services = []; this.writables = [];
      let svcs = [];
      try { svcs = await this.server.getPrimaryServices(); }
      catch (e) { this.log('No se pudieron listar servicios: ' + e.message, 'e'); return; }

      for (const s of svcs) {
        let chars = [];
        try { chars = await s.getCharacteristics(); } catch (e) { }
        const entry = { uuid: s.uuid, chars: [] };
        for (const c of chars) {
          const p = c.properties;
          const props = [
            p.read && 'R', p.write && 'W', p.writeWithoutResponse && 'w', p.notify && 'N', p.indicate && 'I'
          ].filter(Boolean).join('');
          entry.chars.push({ uuid: c.uuid, props, obj: c });
          if (p.write || p.writeWithoutResponse) this.writables.push({ svc: s.uuid, uuid: c.uuid, props, obj: c });
        }
        this.services.push(entry);
      }
      this.log(`GATT: ${this.services.length} servicios, ${this.writables.length} características escribibles.`, 'o');
      if (!this.writables.length) {
        this.log('No hay características escribibles VISIBLES. Ojo: Web Bluetooth solo muestra ' +
          'los servicios declarados de antemano, así que un UUID propietario de 128 bits queda ' +
          'invisible. Abre chrome://bluetooth-internals → Devices → Inspect, copia los UUID reales ' +
          'y pégalos en «UUID propios» antes de reconectar.', 'e');
      }
    },

    /* Elige automaticamente la mejor caracteristica para un driver */
    autoPick(driver) {
      if (!this.writables.length) return null;
      if (driver && driver.chr) {
        const exact = this.writables.find((w) => w.uuid === driver.chr);
        if (exact) return exact;
        const bySvc = this.writables.find((w) => w.svc === driver.svc);
        if (bySvc) return bySvc;
      }
      // preferencia: escritura sin respuesta (mas rapida)
      return this.writables.find((w) => w.props.includes('w')) || this.writables[0];
    },

    setTx(w) { this.tx = w; this.log(`TX → ${short(w.uuid)} (${w.props}) en ${short(w.svc)}`, 'm'); this.onState(); },
    setDriver(d) { this.driver = d; this.log(`Protocolo → ${d.name}`, 'm'); this.onState(); },

    /* ---------------- cola de escritura ---------------- */
    _pending: null, _busy: false,

    // "El ultimo gana": si llega una trama nueva mientras se envia otra,
    // se descarta la anterior. Evita que la cola BLE se sature con efectos rapidos.
    queue(frames) { if (SK.Rig.active) SK.Rig.active.queue(frames); },

    async _drain() {
      this._busy = true;
      while (this._pending) {
        const frames = this._pending; this._pending = null;
        const list = Array.isArray(frames) ? frames : [frames];
        for (const f of list) {
          if (!f) continue;
          try { await this.write(f); }
          catch (e) {
            this.stats.err++;
            if (this.stats.err % 12 === 1) this.log('Error de escritura: ' + e.message, 'e');
            await sleep(60);
          }
        }
      }
      this._busy = false;
    },

    /* Mientras una herramienta de diagnostico tiene la radio, el motor de
       efectos NO debe transmitir: BLE admite una sola operacion GATT a la vez
       y la segunda muere con "GATT operation already in progress". */
    exclusive: false,
    async withRadio(fn) {
      this.exclusive = true; this._pending = null;
      try { return await fn(); } finally { this.exclusive = false; }
    },

    // 'auto' | 'noresp' | 'resp'. Algunos controladores solo aceptan uno de los dos.
    writeMode: 'auto',
    writeGap: 0,          // ms de espera tras cada trama (algunos drivers lo necesitan)

    async write(bytes, target) {
      const w = target || this.tx;
      if (!w) throw new Error('Sin característica TX seleccionada');
      SK.Rig.forgetAll();          // el motor no debe creerse su cache tras un envio manual
      const c = w.obj;
      const canNo = c.properties.writeWithoutResponse && c.writeValueWithoutResponse;
      const canYes = c.properties.write;
      const mode = this.writeMode;
      if (mode === 'noresp' || (mode === 'auto' && canNo)) {
        if (!canNo) throw new Error('Esta característica no admite escritura sin respuesta');
        await c.writeValueWithoutResponse(bytes);
      } else {
        if (!canYes && !canNo) throw new Error('Característica no escribible');
        await (c.writeValue ? c.writeValue(bytes) : c.writeValueWithoutResponse(bytes));
      }
      if (this.writeGap) await sleep(this.writeGap);
      this.stats.sent++; this.stats.acc++;
      const now = performance.now();
      if (now - this.stats.lastT > 1000) {
        this.stats.bps = this.stats.acc; this.stats.acc = 0; this.stats.lastT = now;
      }
    },

    /* =====================================================================
       MODO ESCOPETA
       Dispara el mismo color por TODAS las caracteristicas escribibles con
       TODOS los formatos de trama a la vez. No sirve para trabajar, pero
       responde en dos segundos a la unica pregunta que importa al principio:
       "¿este tubo reacciona a algo de lo que se mandarle?"
       ===================================================================== */
    async shotgun(r, g, b, br = 1) { return this.withRadio(async () => {
      if (!this.writables.length) { this.log('Escopeta: no hay características escribibles.', 'e'); return 0; }
      this._pending = null;
      if (SK.DRIVERS.sokani_fa) SK.DRIVERS.sokani_fa._last = {};   // sin cache al diagnosticar
      let n = 0, errs = 0;
      for (const w of this.writables) {
        for (const id of SK.DRIVER_ORDER) {
          const d = SK.DRIVERS[id]; if (!d || id === 'custom') continue;
          let f; try { f = d.rgb(r, g, b, br); } catch (e) { continue; }
          try { await this.write(Array.isArray(f) ? f[0] : f, w); n++; }
          catch (e) { errs++; }
        }
      }
      this.log(`Escopeta: ${n} tramas enviadas, ${errs} rechazadas.`, n ? 'o' : 'e');
      return n;
    }); },

    /* Escuchar lo que el tubo devuelve: muchos controladores confirman los
       comandos por notificacion, y eso delata la caracteristica correcta. */
    async listenAll() {
      let n = 0;
      for (const l of SK.Rig.lights) { if (l.connected) { await l.listen(); n++; } }
      if (!n) this.log('Ninguna luz conectada.', 'w');
      return n;
    },

    /* Marca de tiempo del ultimo encendido detectado por telemetria.
       Es lo que permite calibrar sin que nadie mire el tubo. */
    ledOnAt: 0,

    /* Barre las variantes de la trama. OJO: la telemetria del tubo llega solo
       cada ~10 s, asi que NO sirve como confirmacion automatica por paso —
       intentarlo fue un error. Cada combinacion se mantiene puesta el tiempo
       suficiente para que una persona la vea, y se confirma a mano.
       Y si no hay acierto se restaura la configuracion previa: dejar el driver
       en la ultima combinacion probada deja el tubo mudo. */
    async calibrate(onStep, stepMs = 2500) {
      const S = SK.SOKANI;
      const previo = { ...S.cfg };
      const combos = [];
      for (const drv of ['sokani_rgb', 'sokani_hsi'])
        for (let chk = 0; chk < 4; chk++)
          for (const aT of [0, 1])
            for (const gr of [0, 1])
              combos.push({ drv, chk, aT, gr });
      this._calHit = null;
      return this.withRadio(async () => {
        this.log(`Calibrando ${combos.length} combinaciones · mira el tubo y pulsa «¡Es esta!»`, 'm');
        for (let i = 0; i < combos.length && !this._abortCal && !this._calHit; i++) {
          const c = combos[i];
          Object.assign(S.cfg, { chk: c.chk, adjustType: c.aT, group: c.gr, channel: 0 });
          const d = SK.DRIVERS[c.drv];
          this._calCur = c;
          if (onStep) onStep(i, combos.length, c);
          try {
            d._last = {}; await this.write(d.rgb(255, 0, 0, 1));
            await sleep(stepMs);
          } catch (e) { /* combinacion invalida */ }
        }
        if (this._calHit) {
          Object.assign(S.cfg, {
            chk: this._calHit.chk, adjustType: this._calHit.aT,
            group: this._calHit.gr, channel: 0
          });
          this.log(`✔ Fijado: ${this._calHit.drv} suma=${this._calHit.chk} aT=${this._calHit.aT} gr=${this._calHit.gr}`, 'o');
          return this._calHit;
        }
        Object.assign(S.cfg, previo);         // devolver el tubo a como estaba
        SK.DRIVERS.sokani_rgb._last = {}; SK.DRIVERS.sokani_hsi._last = {};
        this.log('Sin acierto. Configuración anterior restaurada.', 'w');
        return null;
      });
    },
    _abortCal: false, _calHit: null, _calCur: null,
    confirmCal() { this._calHit = this._calCur; },

    /* Vuelve a lo que trae el protocolo de fabrica y manda rojo. */
    async resetProtocol() {
      Object.assign(SK.SOKANI.cfg, { adjustType: 0, channel: 0, group: 0, chk: 0 });
      SK.DRIVERS.sokani_rgb._last = {}; SK.DRIVERS.sokani_hsi._last = {};
      this.driver = SK.DRIVERS.sokani_rgb;
      this.log('Protocolo restaurado: RGBCW, suma=payload, aT=0 ch=0 gr=0', 'o');
      if (this.connected && this.tx) {
        try { await this.withRadio(async () => this.write(SK.DRIVERS.sokani_rgb.rgb(255, 0, 0, 1))); }
        catch (e) { }
      }
      this.onState();
    },

    /* Este tubo habla lineas de texto terminadas en CR+LF. */
    async writeLine(str, eol = '\r\n') {
      await this.write(new TextEncoder().encode(str + eol));
    },

    /* Manda una lista de comandos de texto y anota quien contesta.
       Igual que la sonda binaria, pero para un protocolo de lineas. */
    async asciiProbe(lines, gapMs = 700, eol = '\r\n') {
      return this.withRadio(async () => {
        const before = this._rxNovel;
        this.log(`── Explorando ${lines.length} comandos de texto ──`, 'm');
        for (const cmd of lines) {
          if (!cmd.trim()) continue;
          const mark = this._rxNovel;
          this.log(`→ «${cmd}»`);
          try { await this.writeLine(cmd, eol); }
          catch (e) { this.log('   (rechazado: ' + e.message + ')', 'e'); continue; }
          await sleep(gapMs);
          if (this._rxNovel === mark) this.log('   sin respuesta nueva');
          else this.log(`   ⬆︎ ¡RESPUESTA A «${cmd}»!`, 'o');
        }
        const got = this._rxNovel - before;
        this.log(`── Exploración terminada: ${got} respuesta(s) nueva(s) ──`, got ? 'o' : 'w');
        return got;
      });
    },

    /* Leer lo que la caracteristica devuelva. Algunos firmwares HM-10
       contestan con su estado actual, y eso ya delata el formato. */
    async readAll() { return this.withRadio(async () => {
      let n = 0;
      for (const sv of this.services) {
        for (const c of sv.chars) {
          if (!/R/.test(c.props) || !c.obj.readValue) continue;
          try {
            const dv = await c.obj.readValue();
            const v = new Uint8Array(dv.buffer);
            const txt = v.length && Array.from(v).every((x) => x >= 32 && x < 127)
              ? '  «' + new TextDecoder().decode(v) + '»' : '';
            this.log(`READ ${short(c.uuid)} = ${v.length ? SK.hex(v) : '(vacío)'}${txt}`, 'o');
            n++;
          } catch (e) { this.log(`READ ${short(c.uuid)} falló: ${e.message}`, 'w'); }
        }
      }
      if (!n) this.log('Ninguna característica legible respondió.', 'w');
      return n;
    }); },

    /* Envio directo sin cola (para pruebas manuales) */
    async writeRaw(bytes) { await this.write(bytes); this.log('TX ' + SK.hex(bytes), 'o'); },

    /* ---------------- alto nivel ---------------- */
    // Devuelve las tramas realmente encoladas para que la interfaz muestre
    // lo que se envio, sin volver a llamar al driver (que llevaria su delta
    // por delante y corromperia el estado).
    sendColor(r, g, b, br) { return SK.Rig.broadcast([r, g, b], br, false, 0); },
    sendCCT(k, br) { return SK.Rig.broadcast([0, 0, 0], br, true, k); },
    async sendPower(on) {
      const d = this.driver; if (!d || !this.tx || !d.power) return;
      const f = d.power(on); if (f) { try { await this.write(f); this.log(`Power ${on ? 'ON' : 'OFF'}: ${SK.hex(f)}`, 'o'); } catch (e) { this.log('Power: ' + e.message, 'e'); } }
    },

    /* =====================================================================
       ESCANER DE PROTOCOLO
       Recorre  (caracteristica escribible) x (driver)  enviando una secuencia
       inconfundible  ROJO → VERDE → AZUL → BLANCO.  El usuario mira el tubo y
       pulsa "¡Es este!" cuando reacciona.  Es la forma practica de resolver un
       protocolo no documentado sin sniffer.
       ===================================================================== */
    scan: { running: false, i: 0, combos: [], cur: null, onStep: () => { } },

    buildCombos(driverIds) {
      const combos = [];
      for (const w of this.writables) {
        for (const id of driverIds) {
          const d = SK.DRIVERS[id]; if (!d || id === 'custom') continue;
          combos.push({ w, d });
        }
      }
      // prioriza coincidencias exactas de UUID (mucho mas probable que acierten)
      combos.sort((a, b) => score(b) - score(a));
      function score(c) {
        let s = 0;
        if (c.d.chr && c.w.uuid === c.d.chr) s += 10;
        if (c.d.svc && c.w.svc === c.d.svc) s += 6;
        if (c.w.props.includes('w')) s += 1;
        return s;
      }
      return combos;
    },

    async startScan(driverIds, onStep, stepMs = 1400) { return this.withRadio(async () => {
      if (!this.writables.length) { this.log('Nada que escanear: sin características escribibles.', 'e'); return; }
      const S = this.scan;
      S.combos = this.buildCombos(driverIds);
      S.i = 0; S.running = true; S.onStep = onStep || (() => { });
      this.log(`Escaneando ${S.combos.length} combinaciones (característica × protocolo)…`, 'm');

      const seq = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
      while (S.running && S.i < S.combos.length) {
        const c = S.combos[S.i]; S.cur = c;
        this.tx = c.w; this.driver = c.d;
        S.onStep(S.i, S.combos.length, c);
        try {
          if (SK.DRIVERS.sokani_fa) SK.DRIVERS.sokani_fa._last = {};
          if (c.d.power) { const f = c.d.power(true); if (f) await this.write(f); }
          for (const [r, g, b] of seq) {
            if (!S.running) break;
            await this.write(c.d.rgb(r, g, b, 1));
            await sleep(stepMs / seq.length);
          }
        } catch (e) { /* combinacion invalida, seguimos */ }
        S.i++;
      }
      if (S.running) this.log('Escaneo terminado sin confirmación. Prueba el modo amplio o la plantilla propia.', 'w');
      S.running = false;
    }); },

    stopScan() { this.scan.running = false; },
    lockScan() {
      const c = this.scan.cur; this.scan.running = false;
      if (!c) return null;
      this.setTx(c.w); this.setDriver(c.d);
      this.log(`✔ Protocolo fijado: ${c.d.name} → ${short(c.w.uuid)}`, 'o');
      return c;
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const short = SK.short = (u) => (u && u.length === 36 && u.endsWith('-0000-1000-8000-00805f9b34fb'))
    ? '0x' + u.slice(4, 8).toUpperCase() : String(u).slice(0, 8) + '…';
})();
