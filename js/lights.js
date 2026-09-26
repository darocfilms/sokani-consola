/* =========================================================================
   lights.js — Rig de varias luces
   -------------------------------------------------------------------------
   Cada Sokani X25 es un objeto Light con su propia conexion, su cola de
   escritura y su estado de delta. El Rig los agrupa y reparte el color.

   Dos decisiones que merecen explicacion:

   · El delta (no repetir una trama identica) vive en la LUZ, no en el driver.
     Con el driver guardando ese estado, dos luces se pisaban: la segunda creia
     que ya habia mandado lo que en realidad mando la primera.

   · El desfase entre luces se resuelve con un historial de color, no
     recalculando el efecto con otro tiempo. Muchos efectos llevan estado
     interno (fuego, tormenta, glitch) y preguntarles por dos instantes
     distintos los rompe. Guardando los ultimos segundos de color, una luz
     desfasada simplemente reproduce lo que sono hace un momento.
   ========================================================================= */
(function () {
  const SK = window.SK || (window.SK = {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /* gatt.connect() no tiene tiempo limite: si la luz esta apagada o fuera de
     alcance se queda esperando para siempre y bloquea el arranque. */
  const conTope = (prom, ms, que) => Promise.race([
    prom, new Promise((_, rej) => setTimeout(() => rej(new Error(que + ': sin respuesta')), ms))
  ]);

  /* ---------------- historial de color por grupo ----------------
     Un efecto con estado interno (fuego, tormenta, glitch) no se puede
     "preguntar por otro instante": hay que guardar lo que ya sono. Cada grupo
     conserva unos segundos de color para que sus luces desfasadas lo repitan. */
  const HIST_HZ = 60, HIST_N = 4 * HIST_HZ;
  SK.mkHist = () => ({ buf: new Array(HIST_N), i: 0 });
  SK.pushHist = (h, rgb) => { h.i = (h.i + 1) % HIST_N; h.buf[h.i] = [rgb[0], rgb[1], rgb[2]]; };
  SK.histAt = (h, delaySec) => {
    if (!delaySec) return h.buf[h.i] || [0, 0, 0];
    const back = Math.min(HIST_N - 1, Math.round(delaySec * HIST_HZ));
    return h.buf[(h.i - back + HIST_N * 2) % HIST_N] || h.buf[h.i] || [0, 0, 0];
  };

  /* ============================== Light ============================== */
  class Light {
    constructor(device) {
      this.device = device;
      this.id = device.id;
      this.name = device.name || 'Sokani X25';
      this.brand = SK.guessBrand(this.name) || 'sokani';
      this.server = null; this.tx = null;
      this.services = []; this.writables = [];
      this.connected = false;
      this.enabled = true;          // participa en el efecto
      this.trim = 1;                // brillo relativo de esta luz
      this.offset = 0;              // desfase en segundos
      this.group = 0;               // indice de grupo al que pertenece
      this.telemetry = {};
      this.stats = { sent: 0, err: 0, bps: 0, acc: 0, lastT: 0 };
      this._pending = null; this._busy = false;
      this._lastHex = ''; this._fullAt = 0;
      this._rxBuf = ''; this._subscribed = new Set();
      this._retry = 0;
      device.addEventListener('gattserverdisconnected', () => {
        this.connected = false; this.tx = null;
        this._subscribed.clear(); this._rxBuf = '';
        SK.Rig.log(`⚠︎ ${this.name} desconectada`, 'w');
        SK.Rig.onChange();
        this._autoReconnect();
      });
    }

    async connect() {
      if (this._connecting) return this;
      this._connecting = true;
      try { this.server = await conTope(this.device.gatt.connect(), 12000, this.name); }
      finally { this._connecting = false; }
      this.connected = true; this._retry = 0;
      await this.discover();
      this.tx = this.pickTx();
      await this.listen();
      SK.Rig.log(`✔ ${this.name} conectada`, 'o');
      SK.Rig.onChange();
      return this;
    }

    /* Reconexion sola: en un set, una luz que se cae y no vuelve es un
       problema; que vuelva sin que nadie toque nada es lo esperable. */
    async _autoReconnect() {
      if (!SK.Rig.autoReconnect || this._reconnecting) return;
      this._reconnecting = true;
      for (let i = 0; i < 30 && !this.connected; i++) {
        const espera = Math.min(15000, 1000 * Math.pow(1.6, i));
        await sleep(espera);
        if (this.connected || !SK.Rig.autoReconnect) break;
        try {
          SK.Rig.log(`Reintentando ${this.name}…`, 'm');
          await this.connect();
        } catch (e) { /* sigue intentando */ }
      }
      this._reconnecting = false;
    }

    async discover() {
      this.services = []; this.writables = [];
      let svcs = [];
      try { svcs = await this.server.getPrimaryServices(); } catch (e) { return; }
      for (const s of svcs) {
        let chars = [];
        try { chars = await s.getCharacteristics(); } catch (e) { }
        const entry = { uuid: s.uuid, chars: [] };
        for (const c of chars) {
          const p = c.properties;
          const props = [p.read && 'R', p.write && 'W', p.writeWithoutResponse && 'w',
                         p.notify && 'N', p.indicate && 'I'].filter(Boolean).join('');
          entry.chars.push({ uuid: c.uuid, props, obj: c });
          if (p.write || p.writeWithoutResponse) this.writables.push({ svc: s.uuid, uuid: c.uuid, props, obj: c });
        }
        this.services.push(entry);
      }
    }

    pickTx() {
      const d = SK.DRIVERS[SK.Rig.driverId];
      if (d && d.chr) {
        const ex = this.writables.find((w) => w.uuid === d.chr);
        if (ex) return ex;
      }
      return this.writables.find((w) => w.props.includes('w')) || this.writables[0] || null;
    }

    async listen() {
      for (const s of this.services) {
        for (const c of s.chars) {
          if (!/[NI]/.test(c.props) || this._subscribed.has(c.uuid)) continue;
          try {
            await c.obj.startNotifications();
            c.obj.addEventListener('characteristicvaluechanged', (e) =>
              this._feed(new Uint8Array(e.target.value.buffer)));
            this._subscribed.add(c.uuid);
          } catch (e) { }
        }
      }
    }

    _feed(bytes) {
      const ok = Array.from(bytes).every((x) => (x >= 32 && x < 127) || x === 13 || x === 10);
      if (!ok) return;
      this._rxBuf += new TextDecoder().decode(bytes);
      let i;
      while ((i = this._rxBuf.search(/\r\n|\n|\r/)) >= 0) {
        const line = this._rxBuf.slice(0, i);
        this._rxBuf = this._rxBuf.slice(i + (this._rxBuf.substr(i, 2) === '\r\n' ? 2 : 1));
        if (/^(ad:|chg:)/.test(line)) this._telemetry(line);
      }
      if (this._rxBuf.length > 400) this._rxBuf = '';
    }

    _telemetry(line) {
      const m = {};
      for (const [, k, v] of line.matchAll(/([A-Za-z]+):?(\d+)/g)) m[k] = +v;
      const mc = line.match(/T:(\d+)c/), ma = line.match(/[,-]T(\d{3,4})[,-]/);
      delete m.T;
      if (mc) m.tempC = +mc[1] / 10; else if (ma) m.tempC = +ma[1] / 100;
      Object.assign(this.telemetry, m);
      SK.Rig.onTelemetry(this);
    }

    /* -------- envio con delta propio -------- */
    async write(bytes) {
      if (!this.tx) throw new Error('sin TX');
      const c = this.tx.obj;
      const mode = SK.Rig.writeMode;
      const canNo = c.properties.writeWithoutResponse && c.writeValueWithoutResponse;
      if (mode === 'noresp' || (mode === 'auto' && canNo)) await c.writeValueWithoutResponse(bytes);
      else await c.writeValue(bytes);
      this.stats.sent++; this.stats.acc++;
      const now = performance.now();
      if (now - this.stats.lastT > 1000) { this.stats.bps = this.stats.acc; this.stats.acc = 0; this.stats.lastT = now; }
    }

    queue(frames) { this._pending = frames; if (!this._busy) this._drain(); }

    async _drain() {
      this._busy = true;
      while (this._pending) {
        const fr = this._pending; this._pending = null;
        for (const f of (Array.isArray(fr) ? fr : [fr])) {
          if (!f) continue;
          try { await this.write(f); }
          catch (e) { this.stats.err++; await sleep(60); }
        }
      }
      this._busy = false;
    }

    sendColor(r, g, b, br) {
      if (!this.connected || !this.tx || !this.enabled) return null;
      const d = SK.DRIVERS[SK.Rig.driverId]; if (!d) return null;
      let f;
      try { f = d.rgb(r, g, b, br * this.trim); } catch (e) { return null; }
      return this._dedupe(f);
    }

    sendCCT(k, br) {
      if (!this.connected || !this.tx || !this.enabled) return null;
      const d = SK.DRIVERS[SK.Rig.driverId];
      if (!d || !d.cct) return null;
      let f;
      try { f = d.cct(k, br * this.trim); } catch (e) { return null; }
      return this._dedupe(f);
    }

    _dedupe(f) {
      if (!f) return null;
      const arr = Array.isArray(f) ? f : [f];
      const h = arr.map((x) => SK.hex(x)).join('|');
      const now = performance.now();
      if (now - this._fullAt > 2000) { this._fullAt = now; this._lastHex = ''; }
      if (h === this._lastHex) return null;
      this._lastHex = h;
      this.queue(arr);
      return arr;
    }

    forget() { this._lastHex = ''; }

    async disconnect() {
      try { if (this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { }
      this.connected = false; this.tx = null;
    }
  }

  /* =============================== Rig =============================== */
  SK.Rig = {
    lights: [],
    driverId: 'sokani_rgb',
    writeMode: 'auto',
    autoReconnect: true,
    log: () => { }, onChange: () => { }, onTelemetry: () => { },

    get active() { return this.lights.find((l) => l.connected) || this.lights[0] || null; },
    get anyConnected() { return this.lights.some((l) => l.connected); },
    get activos() { return this.lights.filter((l) => l.connected && l.enabled); },

    has(id) { return this.lights.some((l) => l.id === id); },

    async adopt(device) {
      if (this.has(device.id)) {
        const ya = this.lights.find((l) => l.id === device.id);
        if (!ya.connected) await ya.connect();
        return ya;
      }
      const l = new Light(device);
      this.lights.push(l);
      this.onChange();
      try { await l.connect(); } catch (e) { this.log(`${l.name}: ${e.message}`, 'e'); }
      return l;
    },

    remove(id) {
      const i = this.lights.findIndex((l) => l.id === id);
      if (i < 0) return;
      this.lights[i].disconnect();
      this.lights.splice(i, 1);
      this.onChange();
    },

    /* Reparte el color. El resolutor decide que le toca a cada luz segun su
       grupo y su desfase, asi una persecucion recorre el rig de punta a punta
       y cada grupo puede llevar un efecto distinto. */
    broadcast(resolver) {
      let primera = null;
      for (const l of this.activos) {
        const o = resolver(l);
        if (!o) continue;
        const f = o.cct ? l.sendCCT(o.kelvin, o.br) : l.sendColor(o.rgb[0], o.rgb[1], o.rgb[2], o.br);
        if (f && !primera) primera = f;
      }
      return primera;
    },

    forgetAll() { for (const l of this.lights) l.forget(); },

    /* Reconecta sin intervencion a las luces ya autorizadas antes. */
    async restore() {
      if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return 0;
      let devs = [];
      try { devs = await conTope(navigator.bluetooth.getDevices(), 5000, 'getDevices'); }
      catch (e) { return 0; }
      let n = 0;
      for (const d of devs) {
        if (this.has(d.id)) continue;
        const l = new Light(d);
        this.lights.push(l);
        this.onChange();
        try { await l.connect(); n++; }
        catch (e) { this.log(`${l.name}: fuera de alcance`, 'w'); }
      }
      return n;
    }
  };

  SK.LightClass = Light;
})();
