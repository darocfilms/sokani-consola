/* =========================================================================
   pwa.js — Instalación como app y funcionamiento sin conexión
   -------------------------------------------------------------------------
   · Detecta dónde corre: app nativa iOS, app instalada (standalone) o web.
   · Registra el service worker (solo en http/https; en la app nativa los
     archivos ya van dentro del paquete y no hace falta).
   · Chrome/Edge/Android: botón «Instalar».
   · iPhone/iPad en Safari: explica cómo añadirla a la pantalla de inicio y
     avisa, sin rodeos, de que ahí Safari no tiene Bluetooth.
   ========================================================================= */
(function () {
  const SK = window.SK || (window.SK = {});
  const $ = (id) => document.getElementById(id);
  const html = document.documentElement;

  const plataforma = () => {
    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    return {
      ios, standalone,
      nativa: !!SK.native,
      android: /Android/.test(ua),
      bluefy: /Bluefy/i.test(ua),
      bluetooth: !!navigator.bluetooth,
      http: /^https?:$/.test(location.protocol)
    };
  };
  SK.pwa = { plataforma };

  const P = plataforma();
  if (P.standalone) html.classList.add('standalone');
  if (P.ios) html.classList.add('ios');
  if (P.nativa) html.classList.add('nativa');

  /* ---------------- aviso flotante reutilizable ---------------- */
  function aviso(id, htmlTxt, acciones) {
    if ($(id)) return $(id);
    const d = document.createElement('div');
    d.id = id; d.className = 'pwa-banner';
    d.innerHTML = `<div class="pb-txt">${htmlTxt}</div><div class="pb-act"></div>`;
    for (const [txt, fn, cls] of acciones) {
      const b = document.createElement('button');
      b.className = 'btn sm ' + (cls || '');
      b.textContent = txt;
      b.onclick = () => fn(d);
      d.querySelector('.pb-act').appendChild(b);
    }
    document.body.appendChild(d);
    requestAnimationFrame(() => d.classList.add('in'));
    return d;
  }
  const cerrar = (d) => { d.classList.remove('in'); setTimeout(() => d.remove(), 300); };
  const recordar = (k) => { try { localStorage.setItem(k, '1'); } catch (e) { } };
  const recordado = (k) => { try { return localStorage.getItem(k) === '1'; } catch (e) { return false; } };

  /* ---------------- service worker ---------------- */
  if ('serviceWorker' in navigator && P.http && !P.nativa) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        // Versión nueva descargada y esperando: ofrecer recargar.
        const ofrecer = (w) => aviso('pwaUpdate',
          '<b>Hay una versión nueva de la consola.</b> Recarga cuando no estés en mitad de una toma.',
          [['Luego', cerrar], ['Recargar', () => { w.postMessage('activar'); }, 'pri']]);
        if (reg.waiting && navigator.serviceWorker.controller) ofrecer(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          if (!w) return;
          w.addEventListener('statechange', () => {
            if (w.state === 'installed' && navigator.serviceWorker.controller) ofrecer(w);
          });
        });
      }).catch(() => { });
      let recargando = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (recargando) return;
        recargando = true; location.reload();
      });
    });
  }

  /* ---------------- instalar en Chrome / Edge / Android ---------------- */
  let promptInstalar = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    promptInstalar = e;
    const b = $('btnInstall');
    if (b) b.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    const b = $('btnInstall'); if (b) b.hidden = true;
    promptInstalar = null;
  });
  document.addEventListener('DOMContentLoaded', () => {
    const b = $('btnInstall');
    if (!b) return;
    b.onclick = async () => {
      if (!promptInstalar) return;
      promptInstalar.prompt();
      try { await promptInstalar.userChoice; } catch (e) { }
      promptInstalar = null; b.hidden = true;
    };
  });

  /* ---------------- iPhone / iPad en Safari ---------------- */
  function avisoIOS() {
    if (!P.ios || P.standalone || P.nativa || P.bluefy || recordado('sokani.iosHint')) return;
    aviso('pwaIOS',
      '<b>Instálala en tu iPhone:</b> pulsa <span class="ico-share"></span> Compartir y luego ' +
      '<b>«Añadir a pantalla de inicio»</b>.<br><span class="pb-sub">En iPhone, Safari no tiene ' +
      'Bluetooth: la app instalada sirve para preparar looks y cues. Para mover las luces usa la ' +
      'app nativa o el navegador Bluefy.</span>',
      [['Entendido', (d) => { recordar('sokani.iosHint'); cerrar(d); }, 'pri']]);
  }

  /* ---------------- accesos directos del icono ---------------- */
  function accion() {
    const a = new URLSearchParams(location.search).get('action');
    if (a === 'stage' && $('btnStage')) $('btnStage').click();
  }

  window.addEventListener('load', () => { setTimeout(avisoIOS, 1200); accion(); });
})();
