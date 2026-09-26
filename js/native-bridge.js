/* =========================================================================
   native-bridge.js — Web Bluetooth sobre CoreBluetooth (app iOS nativa)
   -------------------------------------------------------------------------
   Safari en iOS/iPadOS no implementa Web Bluetooth. La app nativa de ios/
   carga ESTA MISMA web en un WKWebView y expone CoreBluetooth por mensajes.

   Este archivo convierte esos mensajes en un `navigator.bluetooth` con la
   misma forma que el de Chrome: requestDevice, getDevices, gatt.connect,
   getPrimaryServices, getCharacteristics, writeValue, startNotifications y
   los eventos characteristicvaluechanged / gattserverdisconnected.

   Por eso el rig multi-luz (lights.js) corre en iOS sin una línea especial:
   no sabe si habla con Chrome o con CoreBluetooth. Cada mensaje lleva el id
   del dispositivo, así que varias luces con la misma característica FFE1 no
   se pisan.
   ========================================================================= */
(function () {
  const SK = window.SK || (window.SK = {});
  const host = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sokaniBLE;
  if (!host) return;                       // navegador normal: no hay puente

  /* ---------------- llamadas a Swift ---------------- */
  let seq = 0;
  const waiting = new Map();
  function call(cmd, args) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      host.postMessage(Object.assign({ id, cmd }, args || {}));
    });
  }
  window.__sokaniReply = (id, ok, payload) => {
    const w = waiting.get(id); if (!w) return;
    waiting.delete(id);
    ok ? w.resolve(payload) : w.reject(new Error(String(payload || 'error nativo')));
  };

  const hex = (u8) => Array.from(u8).map((v) => v.toString(16).padStart(2, '0')).join('');
  const unhex = (s) => new Uint8Array((String(s).match(/../g) || []).map((h) => parseInt(h, 16)));
  const aBytes = (b) => (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b));
  const full = (u) => {
    u = String(u).toLowerCase();
    if (/^[0-9a-f]{4}$/.test(u)) return `0000${u}-0000-1000-8000-00805f9b34fb`;
    if (/^[0-9a-f]{8}$/.test(u)) return `${u}-0000-1000-8000-00805f9b34fb`;
    return u;
  };

  /* ---------------- objetos con forma de Web Bluetooth ---------------- */
  class Emisor {
    constructor() { this._l = {}; }
    addEventListener(t, cb) { (this._l[t] || (this._l[t] = [])).push(cb); }
    removeEventListener(t, cb) { this._l[t] = (this._l[t] || []).filter((x) => x !== cb); }
    _emit(t, ev) { for (const cb of (this._l[t] || [])) { try { cb(ev); } catch (e) { } } }
  }

  class Caracteristica extends Emisor {
    constructor(dev, svc, c) {
      super();
      this.service = svc; this._dev = dev;
      this.uuid = full(c.uuid);
      this.properties = {
        read: !!c.read, write: !!c.write, writeWithoutResponse: !!c.writeNoResp,
        notify: !!c.notify, indicate: !!c.indicate
      };
      this.value = null;
    }
    _w(b, resp) { return call('write', { device: this._dev.id, chr: this.uuid, data: hex(aBytes(b)), resp }); }
    writeValue(b) { return this._w(b, true); }
    writeValueWithResponse(b) { return this._w(b, true); }
    writeValueWithoutResponse(b) { return this._w(b, false); }
    async readValue() {
      const h = await call('read', { device: this._dev.id, chr: this.uuid });
      this.value = new DataView(unhex(h).buffer);
      return this.value;
    }
    async startNotifications() { await call('notify', { device: this._dev.id, chr: this.uuid, on: true }); return this; }
    async stopNotifications() { await call('notify', { device: this._dev.id, chr: this.uuid, on: false }); return this; }
  }

  class Servicio {
    constructor(dev, s) {
      this.device = dev; this.uuid = full(s.uuid); this.isPrimary = true;
      this._chars = s.chars.map((c) => new Caracteristica(dev, this, c));
    }
    async getCharacteristics(u) { return u ? this._chars.filter((c) => c.uuid === full(u)) : this._chars.slice(); }
    async getCharacteristic(u) {
      const c = this._chars.find((x) => x.uuid === full(u));
      if (!c) throw new Error('No existe la característica ' + u);
      return c;
    }
  }

  class Gatt {
    constructor(dev) { this.device = dev; this.connected = false; this._svcs = []; }
    async connect() {
      const tree = JSON.parse(await call('connect', { device: this.device.id }));
      if (tree.name && !this.device.name) this.device.name = tree.name;
      this._svcs = tree.services.map((s) => new Servicio(this.device, s));
      this.connected = true;
      recuerda(this.device.id);
      return this;
    }
    disconnect() { this.connected = false; call('disconnect', { device: this.device.id }).catch(() => { }); }
    async getPrimaryServices(u) { return u ? this._svcs.filter((s) => s.uuid === full(u)) : this._svcs.slice(); }
    async getPrimaryService(u) {
      const s = this._svcs.find((x) => x.uuid === full(u));
      if (!s) throw new Error('No existe el servicio ' + u);
      return s;
    }
    _buscar(uuid) {
      uuid = full(uuid);
      for (const s of this._svcs) for (const c of s._chars) if (c.uuid === uuid) return c;
      return null;
    }
  }

  const dispositivos = new Map();          // id -> Dispositivo
  class Dispositivo extends Emisor {
    constructor(id, name) { super(); this.id = id; this.name = name || ''; this.gatt = new Gatt(this); }
  }
  const dispositivo = (id, name) => {
    let d = dispositivos.get(id);
    if (!d) { d = new Dispositivo(id, name); dispositivos.set(id, d); }
    else if (name && !d.name) d.name = name;
    return d;
  };

  /* ---------------- eventos que llegan desde Swift ---------------- */
  window.__sokaniNotify = (devId, uuid, hexData) => {
    const d = dispositivos.get(devId); if (!d) return;
    const c = d.gatt._buscar(uuid); if (!c) return;
    c.value = new DataView(unhex(hexData).buffer);
    c._emit('characteristicvaluechanged', { target: c });
  };
  window.__sokaniDisconnected = (devId) => {
    const d = dispositivos.get(devId); if (!d) return;
    d.gatt.connected = false;
    d._emit('gattserverdisconnected', { target: d });
  };
  let estadoBT = 'unknown';
  window.__sokaniState = (s) => { estadoBT = s; };
  window.__sokaniDevices = (json) => { if (SK.native.onDevices) SK.native.onDevices(JSON.parse(json)); };

  /* Las luces ya usadas se recuerdan para reconectarlas solas al abrir. */
  const K = 'sokani.nativeKnown';
  const conocidas = () => { try { return JSON.parse(localStorage.getItem(K) || '[]'); } catch (e) { return []; } };
  function recuerda(id) {
    try {
      const l = conocidas();
      if (!l.includes(id)) { l.push(id); localStorage.setItem(K, JSON.stringify(l.slice(-24))); }
    } catch (e) { }
  }

  /* ---------------- selector de luces (iOS no tiene el de Chrome) ---------------- */
  function selector(filtro) {
    return new Promise((resolve, reject) => {
      let box = document.getElementById('nativePick');
      if (!box) {
        box = document.createElement('div');
        box.id = 'nativePick';
        box.innerHTML = '<div class="np-in"><div class="np-grab"></div><h4>Buscando luces…</h4>' +
          '<div class="np-list"></div><button class="btn full" id="npCancel">Cancelar</button></div>';
        document.body.appendChild(box);
      }
      box.style.display = 'flex';
      const list = box.querySelector('.np-list');
      list.innerHTML = '<div class="empty">Enciende la luz y acércala.<br>Si no aparece, ciérrala en la app de su marca.</div>';
      const cerrar = () => { box.style.display = 'none'; SK.native.onDevices = null; call('stopScan').catch(() => { }); };
      box.querySelector('#npCancel').onclick = () => {
        cerrar();
        const e = new Error('User cancelled the requestDevice() chooser.'); e.name = 'NotFoundError';
        reject(e);
      };
      SK.native.onDevices = (devs) => {
        const vis = devs.filter((d) => !filtro || filtro(d.name || ''));
        if (!vis.length) return;
        // Primero las marcas que la consola conoce: suelen ser lo que buscas.
        vis.sort((a, b) => (!!SK.guessBrand(b.name) - !!SK.guessBrand(a.name)) || (b.rssi - a.rssi));
        list.innerHTML = '';
        for (const d of vis) {
          const marca = SK.guessBrand && SK.guessBrand(d.name);
          const col = marca && SK.BRANDS[marca] ? SK.BRANDS[marca].color : '#4a4f6b';
          const barras = d.rssi > -60 ? 4 : d.rssi > -70 ? 3 : d.rssi > -80 ? 2 : 1;
          const b = document.createElement('button');
          b.className = 'np-row';
          b.innerHTML = `<i style="background:${col}"></i><b>${d.name || '(sin nombre)'}</b>` +
            `<em>${marca ? SK.BRANDS[marca].name : ''}</em>` +
            `<span class="np-sig">${'▮'.repeat(barras)}<s>${'▮'.repeat(4 - barras)}</s></span>`;
          b.onclick = () => { cerrar(); resolve(dispositivo(d.id, d.name)); };
          list.appendChild(b);
        }
      };
      call('scan').catch((e) => { cerrar(); reject(e); });
    });
  }

  /* ---------------- navigator.bluetooth ---------------- */
  const bluetooth = {
    async getAvailability() {
      try { estadoBT = await call('state'); } catch (e) { }
      return estadoBT !== 'unsupported';
    },
    requestDevice(opts) {
      const pref = [];
      for (const f of (opts && opts.filters) || []) {
        if (f.namePrefix) pref.push(f.namePrefix.toLowerCase());
        if (f.name) pref.push(f.name.toLowerCase());
      }
      const filtro = pref.length ? (n) => pref.some((p) => n.toLowerCase().startsWith(p)) : null;
      return selector(filtro);
    },
    async getDevices() {
      const ids = conocidas();
      if (!ids.length) return [];
      const lista = JSON.parse(await call('known', { ids }));
      return lista.map((d) => dispositivo(d.id, d.name));
    }
  };
  try { Object.defineProperty(navigator, 'bluetooth', { value: bluetooth, configurable: true }); }
  catch (e) { navigator.bluetooth = bluetooth; }

  SK.native = {
    kind: 'ios-corebluetooth',
    onDevices: null,
    estado: () => call('state').then((s) => (estadoBT = s)).catch(() => estadoBT)
  };
})();
