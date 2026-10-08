# Sokani · Consola de luz

Consola para controlar tubos LED **Sokani X25 RGB** por Bluetooth: 124 efectos, varias luces
a la vez, grupos, cues con fundido, 383 gelatinas y **funciona sin internet**.

**Abrir la consola → https://darocfilms.github.io/sokani-consola/**

## En el iPhone

Safari no tiene Bluetooth (es una limitación de Apple, no de la consola), así que en el
iPhone hay dos maneras de mover los tubos:

**Con el navegador Bluefy** — gratis en la App Store, sin instalar nada más:

1. Instala **Bluefy – Web BLE Browser**.
2. Ábrela y entra en **https://darocfilms.github.io/sokani-consola/** con wifi o datos.
3. Toca **+ Añadir luz** y elige tu tubo (el selector solo enseña tubos Sokani).

La primera vez que la abras con internet queda guardada en el teléfono. Para comprobar que
te sirve en un set sin cobertura: ábrela una vez, pon el iPhone en **modo avión**, cierra
Bluefy y vuelve a entrar. Si carga, ya la tienes para rodar sin red. Bluefy es un navegador
de terceros y no puedo garantizar desde aquí cómo guarda las webs; si en tu iPhone no
carga en modo avión, usa la app nativa.

**Con la app nativa** (`ios/`) — va dentro del teléfono, así que funciona siempre sin
internet. Se instala desde Xcode con un cable: guía paso a paso en
[ios/README.md](ios/README.md).

**Instalada desde Safari** (Compartir → Añadir a pantalla de inicio) sirve para preparar
looks, grupos y cues en modo ensayo, también sin internet, pero no mueve las luces.

## En el ordenador

Abre **https://darocfilms.github.io/sokani-consola/** en **Chrome** o **Edge** y toca **+ Añadir luz**. Con el botón
**⤓ Instalar** de la cabecera queda como una app más, con su icono, y funciona sin internet.

Para trabajar con una copia local:

```bash
./serve.sh
```

y abre **http://localhost:8799**. Web Bluetooth exige `https` o `localhost`: abrir el archivo
con doble clic (`file://`) no vale. Safari y Firefox no tienen Web Bluetooth.

## El protocolo del Sokani X25 (STX25RGB)

Resuelto por ingeniería inversa del APK oficial. No está publicado en ningún otro sitio.

**Transporte:** módulo BLE tipo HM-10.

| | |
|---|---|
| Servicio | `0000ffe0-0000-1000-8000-00805f9b34fb` |
| Característica | `0000ffe1-0000-1000-8000-00805f9b34fb` (`[RWwN]`) |

**Trama:**

```
FA │ cmd │ adjustType │ channel │ group │ …datos… │ SUMA │ 8A
```

- `FA` cabecera, `8A` cierre.
- `SUMA` = suma de todos los bytes entre cabecera y cierre, enmascarada a 8 bits.
- `adjustType`, `channel`, `group` = 0 en un tubo suelto sin agrupar.

**Comandos** (el propio `cmd` selecciona el modo — no hay que dejar el tubo en ningún menú):

| cmd | modo | datos | total |
|---|---|---|---|
| `0x06` | CCT | temp 16 bits BE, brillo %, compensación | 12 B |
| `0x07` | HSI | tono 16 bits BE, saturación %, intensidad % | 12 B |
| `0x08` | RGBCW | R, G, B, W1, W2 (0-255 cada uno) | 13 B |
| `0x09` | FX | efecto, brillo, frecuencia | 11 B |

**Ejemplos reales:**

```
rojo pleno       FA 08 00 00 00 FF 00 00 00 00 07 8A
verde pleno      FA 08 00 00 00 00 FF 00 00 00 07 8A
naranja          FA 08 00 00 00 FF 80 00 00 00 87 8A
3200 K al 100 %  FA 06 00 00 00 0C 80 64 00 F6 8A
rojo en HSI      FA 07 00 00 00 00 00 64 64 CF 8A
```

**Canal de depuración.** El mismo FFE1 escupe telemetría en texto plano que el firmware
del fabricante dejó activada. No sirve para controlar, pero sí para diagnosticar:

```
ad:K3959,D2,T2102,bat2108--vcc141
chg:0-bv134/141-vn0-AI416-CI0-SI0-pw0-qi461-T:227c
k:7-50-
```

`T` es temperatura (centésimas en `ad:`, décimas en `chg:`), `bv` la batería en décimas de
voltio, `chg` si está cargando, y `pw`/`CI`/`SI` la potencia y corriente del LED — **valen 0
con la luz apagada**, así que la consola los usa como detector automático de encendido.
Las líneas `k:` son pulsaciones de sus botones físicos: índice de tecla y lectura del ADC
de una escalera de resistencias.

### Cómo se sacó

1. El mapa GATT dio FFE0/FFE1, típico de un puente serie HM-10.
2. Escuchar las notificaciones reveló la telemetría en ASCII — que resultó ser una pista
   falsa: es depuración de salida, no el canal de comandos. 45 formatos probados a ciegas
   (14 familias binarias conocidas + 31 comandos AT) no dieron nada.
3. `chrome://bluetooth-internals` confirmó que solo hay dos servicios, así que no había
   ningún canal propietario escondido: FFE1 era el único camino.
4. La app oficial (`com.zzcyi.sutudengjv`) resultó no estar ofuscada. Las tramas no
   aparecían en el pool de cadenas del DEX porque se construyen en código, pero
   desensamblando `SetDeviceActivity.rgbWrite()` se ve el array montándose `aput` a `aput`,
   y `HexUtil.sumCheck` da el algoritmo de la suma.

Las herramientas de ese proceso siguen en la consola (mapa GATT, escáner, escopeta,
terminal, laboratorio hex) por si sirven para otra luz.

## Si no conecta

La causa número uno: **el tubo emparejado en los ajustes de Bluetooth del sistema.** Un
periférico BLE solo acepta **una** conexión a la vez. Si macOS —o la app SS LED del móvil—
ya lo tiene cogido, deja de anunciarse y Chrome ni lo enseña en el selector.

1. Ajustes del sistema → Bluetooth → el tubo → **Olvidar este dispositivo**.
2. Cierra **SS LED** en el móvil del todo.
3. Apaga y enciende el tubo.
4. macOS: Ajustes → Privacidad y seguridad → **Bluetooth** → permiso para **Chrome**.

El panel **🩺 Diagnóstico** comprueba contexto seguro, navegador, adaptador y permisos.

Si conecta pero no reacciona, **🎯 Calibrar protocolo** barre las variantes de la trama y se
autoconfigura usando la telemetría del tubo como confirmación.

## Otras marcas

Por ahora la consola trabaja **solo con tubos Sokani**: es la única marca con control directo
verificado. Su módulo Bluetooth es un HM-10 transparente, sin cifrado, y por eso se pudo leer
su protocolo.

Godox y Nanlite se analizaron, pero sus luces van sobre **Bluetooth Mesh cifrado con
provisioning** (intercambio de claves y AES-CCM por mensaje). Encenderlas exige implementar
toda esa capa, que es un proyecto aparte y no se puede verificar sin las luces delante. El
código para varias marcas sigue en `js/brands.js`, desactivado con `SK.CONFIG.soloSokani`.

La biblioteca de gelatinas (series Rosco y Lee, con sus RGB) procede del catálogo de la app de
Godox y funciona con cualquier tubo RGB.

## En el set

La consola arranca en **modo simple**: luces, previsualización, efectos, cues y maestros.
Todo lo técnico (protocolo, GATT, escáner, terminal, registro) vive detrás del **⚙︎** de la
cabecera y no estorba mientras se rueda.

### Ajustes del efecto, sin cambiar de pantalla

Al tocar un efecto se aplica al momento y aparece su tarjeta con **solo los mandos que ese
efecto usa**: brillo siempre; y según el efecto, color con ocho tonos de un toque, saturación,
temperatura con botones de 2700 a 6500 K, frecuencia en hercios para los estrobos, tempo con
TAP, el texto del morse o el micrófono. En el ordenador sale junto al efecto; en el móvil,
como hoja desde abajo, al alcance del pulgar. Tocar fuera la cierra; tocar la tarjeta del
efecto actual la vuelve a abrir.

Los mandos no se etiquetan a mano: la consola lee el código de cada efecto y enseña los
parámetros que consume de verdad, así que un efecto nuevo trae su tarjeta correcta.

### Luces y grupos

Cada Sokani X25 se añade una vez con «+ Añadir luz». A partir de ahí **vuelven solas** al
abrir la consola y **se reconectan solas** si se caen.

| | |
|---|---|
| **Grupos** | Hasta seis, cada uno con su propio efecto y sus propios mandos corriendo a la vez. El contraluz puede llevar fuego mientras el principal se queda en un blanco fijo. Doble clic en la pestaña para renombrar. |
| **Brillo por luz** | Un *trim* independiente para equilibrar el rig sin tocar el maestro. |
| **Desfase por luz** | De 0 a 2 s. Un efecto recorre el rig de una punta a la otra en vez de dispararse a la vez. |
| **Aviso de batería** | A 11,8 V, y en rojo a 11,0 V, con el voltaje real de cada tubo. |
| **Aviso de temperatura** | A 70 °C, antes de que la luz baje potencia sola. |

### Cues

Una pila de looks al estilo de una mesa de luces. **Grabar** guarda el efecto y los mandos
de *todos* los grupos; **GO** (o la tecla `G`) pasa al siguiente con su tiempo de fundido.
Cada cue tiene dos números: el **fundido** y el **auto-encadenado** (0 = manual).

El fundido congela el color que sonaba y lo mezcla con el efecto nuevo ya vivo. Es la
aproximación que usan las mesas y evita tener dos motores por grupo corriendo a la vez.

### Otras herramientas

| | |
|---|---|
| **🎨 Color desde imagen** | Suelta un fotograma de referencia, pulsa para tomar un color, o usa la paleta que extrae sola. Para igualar una práctica que ya está en cuadro. |
| **Curva de dimado** | Lineal, cuadrática, en S o cúbica. En lineal la zona baja —donde se trabaja de noche— se queda sin resolución. |
| **🎥 Estrobo seguro** | Redondea la frecuencia al múltiplo exacto de los fps de cámara. Fuera de esos múltiplos aparecen bandas y parpadeo irregular en el material grabado. |
| **Verde ⇄ Magenta** | Corrección de tinte, como en las luces pro. Positivo verde, negativo magenta. |
| **🎞 Gelatinas** | 383 filtros Rosco/Lee buscables; se aplican como color. |
| **⛶ Modo escenario** | Pantalla completa con previsualización enorme y botones gigantes de cue. Para operar de lejos o a oscuras. |
| **🔓 Bloqueo** | Congela la interfaz para no tocar un control sin querer. |
| **Pantalla despierta** | Mantiene el equipo encendido durante la toma (Wake Lock). |
| **⤓ Exportar / ⤒ Importar** | Grupos, cues, presets, favoritos y ajustes del rig en un archivo, para llevar el mismo montaje a otro equipo. |

## Efectos

**124**, en once familias:

- **Ambiente** — color fijo, blanco variable, respiración, pulso, latido, fundido, pastel,
  cromoterapia, cálido⇄frío, hora dorada, lounge.
- **Club** — arcoíris normal e hiper, salto de color, disco, neón cyberpunk, vaporwave, rave,
  bass drop, chispas, persecución, caramelo, barrido espectral, flash a BPM, golpe de bombo,
  rave hardcore.
- **Estrobos** — blanco y de color, doble, ráfaga, caótico, cegador, paparazzi, ametralladora, pánico.
- **Emergencia** — policía, tricolor, ambulancia, bomberos, faro rotativo, faro marítimo,
  semáforo, alarma, radar, cuenta atrás, alerta roja, alerta nuclear y **morse** con tu texto.
- **Cine** — fuego, brasas, chimenea, vela, antorcha, tormenta, relámpago de calor, soldadura,
  cortocircuito, fluorescente, bombilla moribunda, TV, monitor, proyector, cine mudo, coche
  pasando, túnel de carretera, ventana de tren, ascensor averiado, interrogatorio, quirófano,
  fluorescente de oficina, pantalla de móvil, cabina de avión, bengala de mano, fuegos
  artificiales, explosión, amanecer, atardecer.
- **Naturaleza** — agua, cascada, océano, bosque, aurora boreal, nebulosa, hielo, lava, niebla,
  tormenta de arena.
- **Glitch** — glitch, matrix, portal, motor de nave, reactor, poltergeist, escáner de caja,
  ruido, escáner, VHS, CRT.
- **Gelatinas** — 19 equivalencias de filtro: CTO entero/½/¼, CTB entero/½, tungsteno, luz de
  día, nublado, sombra, vela, Plus Green, Minus Green, Bastard Amber, Steel Blue, Congo Blue,
  Surprise Pink, lavanda, Fire y un neutro favorecedor para piel.
- **Audio-reactivos** — VU de nivel y de graves, espectro, golpe, tono reactivo, estrobo reactivo.

Las gelatinas de temperatura y el blanco variable salen por el comando **CCT nativo** del
tubo, usando sus LED blancos dedicados en vez de fabricar el blanco mezclando RGB — bastante
mejor reproducción cromática.

## Controles

| | |
|---|---|
| Brillo / Velocidad / Intensidad | maestros globales |
| Tono / Saturación / Temperatura | color base de los efectos que lo usan |
| Suavizado | interpola entre tramas (quita escalones; resta mordiente al estrobo) |
| Tap tempo | marca el ritmo; opcional atar la velocidad al BPM |
| Cues | pila de looks con fundido y GO |
| Presets | guarda y recupera estados completos |
| Tramas/s | 18 por defecto; muchos controladores BLE se atragantan por encima de 20 |
| Modo ensayo | trabaja sin transmitir, solo previsualización |

**Atajos:** `Espacio` blackout · `G` GO al siguiente cue · `S` estrobo mientras se mantiene ·
`1`–`9` favoritos · `R` aleatorio · `↑↓` brillo · `←→` velocidad · `B` tap tempo ·
`Esc` cortar el auto-encadenado.
Clic derecho (o `Alt`+clic) sobre un efecto lo marca como favorito.

## Como app: web instalable e iOS nativa

La consola se instala como app de dos maneras. Lo que decide cuál usar es el Bluetooth:

| Dónde | Cómo se instala | Bluetooth | Sin conexión |
|---|---|---|---|
| Mac / PC con Chrome o Edge | Botón **⤓ Instalar** en la cabecera | ✅ | ✅ |
| Android con Chrome | Botón **⤓ Instalar** o «Añadir a pantalla de inicio» | ✅ (con https) | ✅ (con https) |
| iPhone / iPad — Safari | Compartir → **Añadir a pantalla de inicio** | ❌ | ✅ (con https) |
| iPhone / iPad — navegador Bluefy | Abriendo la URL en Bluefy | ✅ (con https) | — |
| iPhone / iPad — **app nativa** (`ios/`) | Xcode → ▶ con el iPhone conectado | ✅ | ✅ |

**Por qué Safari no enciende luces:** WebKit, el motor de Safari, no implementa Web Bluetooth,
y eso incluye las webs añadidas a la pantalla de inicio. No es una limitación de esta app.
Instalada desde Safari sirve para preparar looks, cues y grupos en modo ensayo.

**Web app instalable (PWA).** `manifest.webmanifest`, iconos, pantallas de arranque para los
iPhone actuales y un service worker (`sw.js`) que guarda la consola en el dispositivo: una vez
abierta con red, **funciona sin internet**, algo que en un set se agradece. Cuando hay versión
nueva, aparece un aviso para recargar — sin cortarte a mitad de una toma. El acceso directo
«Modo escenario» del icono abre directamente la vista de pantalla completa.

Para abrirla desde el móvil en la misma wifi:

```bash
./serve.sh red
```

Por la red local va por `http`, así que el móvil no tendrá Bluetooth ni modo sin conexión
(ambos exigen `https`). Para tenerlo todo en el móvil hay que publicarla con `https`
(GitHub Pages, Netlify…).

**App nativa iOS** (`ios/SokaniX25.xcodeproj`). Carga esta misma consola en un `WKWebView` y le
da Bluetooth con **CoreBluetooth**. El puente (`js/native-bridge.js`) instala un
`navigator.bluetooth` con la misma forma que el de Chrome — `requestDevice`, `getDevices`,
`gatt.connect`, notificaciones — así que el rig multi-luz, los grupos y la reconexión automática
corren igual que en escritorio. Cada mensaje lleva el id del dispositivo: varias luces con la
misma característica `FFE1` no se pisan. Trae su icono, pantalla de arranque y **mantiene la
pantalla encendida** mientras está abierta.

Para instalarla en tu iPhone: abre el proyecto en Xcode → target **SokaniX25** → *Signing &
Capabilities* → marca *Automatically manage signing* y elige tu Apple ID en **Team** → elige tu
iPhone como destino → ▶. Con cuenta gratuita, el certificado caduca a los 7 días y se renueva
volviendo a darle a ▶.

```bash
open ios/SokaniX25.xcodeproj
```

> Si el proyecto vive en una carpeta sincronizada (iCloud Drive, Dropbox) y `codesign` protesta
> con *«resource fork, Finder information, or similar detritus not allowed»*, la fase de
> compilación ya limpia los atributos; si aun así falla, compila con `-derivedDataPath` fuera de
> la carpeta sincronizada.

## Estructura

```
index.html          interfaz
css/style.css       estilos
js/protocols.js     catálogo de protocolos + motor de plantillas
js/effects.js       motor y biblioteca de efectos
js/ble.js           transporte Web Bluetooth, GATT, escáner
js/app.js           UI, motor de reproducción, secuenciador, presets
js/pwa.js           instalación como app, modo sin conexión y avisos de iPhone
js/brands.js        registro multimarca y autodetección
js/catalogos.js     biblioteca de gelatinas incrustada
js/native-bridge.js puente hacia CoreBluetooth (solo en la app iOS)
serve.sh            servidor local (./serve.sh red para abrirla desde el móvil)
manifest.webmanifest, sw.js, icons/   web app instalable y modo sin conexión

ios/SokaniX25.xcodeproj
ios/SokaniX25/BLEBridge.swift    CoreBluetooth <-> JavaScript
ios/SokaniX25/ConsoleView.swift  WKWebView que aloja la consola
ios/SokaniX25/SokaniX25App.swift punto de entrada SwiftUI
```

La app iOS **no duplica** la web: una fase de compilación copia `index.html`, `css/` y
`js/` dentro del bundle. Editas la consola una vez y sirve para escritorio y para iPhone.

## Detalles de implementación

- **El reloj del motor vive en un Web Worker.** Los navegadores estrangulan `setInterval`
  y congelan `requestAnimationFrame` en pestañas de fondo; con el reloj en el hilo principal,
  cambiar de pestaña dejaría la luz clavada en el último color a mitad de show. Los timers
  de un worker no se estrangulan, así que el espectáculo continúa aunque minimices la ventana.
- **Cola de escritura «el último gana».** Si llega una trama nueva mientras se está enviando
  otra, la anterior se descarta en vez de encolarse. Evita que la cola BLE se sature y que la
  luz se quede segundos por detrás de la interfaz.
- **Diagnóstico.** En la consola del navegador, `SK.debug()` devuelve efecto activo, color
  actual, ticks del motor, protocolo, característica TX, paquetes enviados y errores.

## Problemas frecuentes

- **El tubo no sale en el selector** — ciérralo en la app oficial del móvil. Una luz ya
  conectada a otro dispositivo no acepta una segunda conexión.
- **Conecta pero no reacciona** — protocolo equivocado: usa el escáner.
- **Va a tirones o se cuelga** — baja las tramas/s a 10–12 y sube el suavizado.
- **`GATT operation not permitted`** — esa característica no acepta escritura; elige otra
  en el desplegable TX.
