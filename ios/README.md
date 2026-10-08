# Sokani en el iPhone — app nativa

La app nativa lleva la consola completa **dentro del teléfono**: funciona siempre sin
internet y controla los tubos por Bluetooth con CoreBluetooth. Es la misma consola que la
web; Xcode la mete en la app cada vez que compilas.

## Lo que necesitas

- Este Mac con **Xcode** (ya lo tienes).
- Un **iPhone con iOS 16 o posterior** y su **cable**.
- Tu **Apple ID**. Una cuenta gratuita basta.

## Instalarla (la primera vez, unos 10 minutos)

**1. Abre el proyecto.** Doble clic en `ios/SokaniX25.xcodeproj`, o en la Terminal:

```bash
open "/Users/macbook/Documents/CLOUDE PROJETS/SOKANI-X25-CONTROLLER/ios/SokaniX25.xcodeproj"
```

Si Xcode ofrece *«Update to recommended settings»*, puedes aceptarlo: está comprobado que
el proyecto compila igual.

**2. Añade tu Apple ID a Xcode.** Menú **Xcode › Settings… › Accounts** → botón **+** →
*Apple ID* → inicia sesión.

**3. Elige con qué cuenta se firma.** En la columna izquierda pulsa el proyecto
**SokaniX25** (icono azul) → target **SokaniX25** → pestaña **Signing & Capabilities** →
en **Team** elige *Tu nombre (Personal Team)*. Deja marcado *Automatically manage signing*.

> Si aparece *«The app identifier "com.darocfilms.sokanix25" cannot be registered»*, cambia
> el **Bundle Identifier** por otro único, por ejemplo `com.darocfilms.sokani`.

**4. Conecta el iPhone por cable**, desbloquéalo y, si pregunta, pulsa **Confiar en este
ordenador**.

**5. Activa el Modo de desarrollador en el iPhone.** Ajustes › **Privacidad y seguridad** ›
**Modo de desarrollador** (al final de la lista) → actívalo → el iPhone se reinicia →
confirma **Activar**. La opción aparece después de haber conectado el iPhone a Xcode.

**6. Instala.** Arriba en Xcode, en el selector de destino (junto a *SokaniX25*), elige tu
iPhone → pulsa **▶** (o `⌘R`). La primera compilación tarda un poco.

**7. Confía en tu certificado (solo la primera vez).** Si el iPhone dice *«Desarrollador no
fiable»*: Ajustes › General › **VPN y gestión de dispositivos** › *Apple Development: tu
correo* › **Confiar**. Vuelve a pulsar ▶ en Xcode.

**8. Úsala.** Abre **Sokani**, permite el **Bluetooth** cuando lo pida, toca **+ Añadir luz**
y elige tu tubo. El selector solo enseña tubos Sokani.

## Lo que hay que saber de la cuenta gratuita

- **Caduca a los 7 días.** La app deja de abrir; conecta el iPhone y pulsa ▶ otra vez en
  Xcode. Tus favoritos, cues y grupos se conservan.
- Máximo **3 apps** instaladas así a la vez.
- Para que dure **un año**, o para pasarla a otros iPhone sin cable con **TestFlight**,
  hace falta el **Apple Developer Program** (99 USD al año).

## Actualizarla

Cuando cambie la consola, conecta el iPhone y pulsa ▶: Xcode copia la última versión de
`index.html`, `css/` y `js/` dentro de la app en cada compilación.

## Qué hace la app nativa que la web no puede

- **Bluetooth en iPhone**: Safari no lo tiene; la app lo da con CoreBluetooth a través de un
  `navigator.bluetooth` compatible (`js/native-bridge.js`).
- **Pantalla siempre encendida** mientras la consola está abierta.
- **Micrófono** para los efectos que reaccionan a la música: iOS pide permiso una vez.
- **Ve todos los servicios Bluetooth** del tubo, incluidos los propietarios de 128 bits.

**Mantén la app delante mientras ruedas.** Los efectos se calculan en la consola, e iOS la
congela cuando la app pasa a segundo plano: el tubo se queda con el último color hasta que
vuelves a abrirla. Por eso la app no deja que la pantalla se apague.

## Problemas frecuentes

| Mensaje | Solución |
|---|---|
| *Signing for "SokaniX25" requires a development team* | Paso 3. |
| *Developer Mode disabled* | Paso 5. |
| *Untrusted Developer* / *Desarrollador no fiable* | Paso 7. |
| El iPhone no aparece en Xcode | Cable de datos (no solo de carga), iPhone desbloqueado, «Confiar». |
| *resource fork, Finder information, or similar detritus not allowed* | Pasa por tener el proyecto en iCloud Drive. La compilación ya limpia esos atributos; si aun así sale, en Xcode › Settings › Locations deja *Derived Data* en su ruta por defecto. |
| El tubo no sale al buscar | Ciérralo en la app SS LED y en los ajustes de Bluetooth del iPhone: un tubo solo acepta una conexión a la vez. |
