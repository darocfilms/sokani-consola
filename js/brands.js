/* =========================================================================
   brands.js — Registro multimarca
   -------------------------------------------------------------------------
   Un "brand" describe una familia de luces: como se llama, como se reconoce
   en el anuncio BLE, que sabe hacer, y —lo mas importante— si su transporte
   esta IMPLEMENTADO (enciende luces hoy) o solo DOCUMENTADO (se conoce el
   formato pero falta el puente).

   Honestidad de diseno: solo Sokani es 'direct' porque su modulo BLE es un
   HM-10 transparente sin cifrado. Godox y Nanlite van sobre BLE Mesh cifrado
   con provisioning; su protocolo esta documentado a partir de sus apps, pero
   encenderlas exige implementar el mesh, que no es este proyecto. Se registran
   igual para que la arquitectura sea de verdad multimarca y ampliable.
   ========================================================================= */
(function () {
  const SK = window.SK || (window.SK = {});

  const BRANDS = {
    sokani: {
      id: 'sokani', name: 'Sokani', color: '#7c5cff',
      transport: 'direct',                 // enciende luces hoy
      driver: 'sokani_rgb',
      nameMatch: [/^stx/i, /sokani/i, /x25/i],
      caps: { rgb: true, cct: [1800, 10000], hsi: true, gm: false },
      note: 'Control directo por BLE (HM-10 transparente). Verificado con el X25 RGB.'
    },
    godox: {
      id: 'godox', name: 'Godox', color: '#ff8c1a',
      transport: 'mesh',                   // documentado, requiere puente mesh
      mesh: 'SIG Mesh (Bluetooth SIG) · Vendor Model',
      nameMatch: [/godox/i, /^gd/i, /^tl\d/i, /^sl\d/i, /^ml\d/i, /^kn/i, /^ litemons/i],
      caps: { rgb: true, cct: [2500, 10000], hsi: true, gm: true },
      note: 'Malla SIG Mesh cifrada. Protocolo GodoxCommandApi identificado; el control ' +
            'directo exige implementar provisioning + AES-CCM (no incluido).'
    },
    nanlite: {
      id: 'nanlite', name: 'Nanlite / Nanlux', color: '#22e07a',
      transport: 'mesh',
      mesh: 'FeasyMesh (Feasycom) · cifrado',
      nameMatch: [/nanlite/i, /nanlux/i, /pavo/i, /forza/i, /^fs\d/i],
      caps: { rgb: true, cct: [2700, 7500], hsi: true, gm: true },
      note: 'Malla FeasyMesh cifrada. Estructura de comandos FLM documentada ' +
            '(ver data/nanlite-protocol.json); el transporte no está implementado.'
    }
  };

  /* Por ahora la consola trabaja solo con tubos Sokani: es la única marca con
     control directo verificado. Poner soloSokani a false vuelve a mostrar las
     demás marcas, el catálogo y los drivers experimentales. */
  SK.CONFIG = Object.assign({ soloSokani: true }, SK.CONFIG || {});
  // Prefijos con los que se anuncian los tubos Sokani (el X25 RGB sale como STX25RGB-XXXXXX).
  SK.SOKANI_PREFIJOS = ['STX', 'Sokani', 'SOKANI'];

  SK.BRANDS = BRANDS;
  SK.BRAND_ORDER = SK.CONFIG.soloSokani ? ['sokani'] : ['sokani', 'godox', 'nanlite'];

  /* Adivina la marca por el nombre anunciado del dispositivo. */
  SK.guessBrand = function (name) {
    if (!name) return null;
    for (const id of SK.BRAND_ORDER) {
      for (const rx of BRANDS[id].nameMatch) if (rx.test(name)) return id;
    }
    return null;
  };

  SK.brandOf = function (light) {
    return (light && light.brand && BRANDS[light.brand]) || BRANDS.sokani;
  };

  /* ---------------- catalogos cargados de /data ---------------- */
  SK.GELS = SK.GELS || []; SK.FIXTURES = SK.FIXTURES || []; SK.NANPROTO = SK.NANPROTO || null;
  // Los catalogos llegan incrustados en data.js (cargado antes que este modulo).
  SK.loadData = function () {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sokaniLog)
        window.webkit.messageHandlers.sokaniLog.postMessage('DATA: ' + SK.GELS.length + ' gels, ' + SK.FIXTURES.length + ' fixtures');
    } catch (e) { }
    return Promise.resolve({ gels: SK.GELS.length, fixtures: SK.FIXTURES.length });
  };
})();
