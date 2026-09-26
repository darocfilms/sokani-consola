import SwiftUI
import WebKit

/// Aloja la consola web dentro de un WKWebView y le engancha CoreBluetooth.
/// La web es exactamente la misma que corre en escritorio: un solo motor de
/// efectos, una sola interfaz, dos transportes distintos.
struct ConsoleView: UIViewRepresentable {

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []

        let ucc = WKUserContentController()
        ucc.add(context.coordinator, name: "sokaniBLE")
        ucc.add(context.coordinator, name: "sokaniLog")

        // Sin esto, un error de JavaScript dentro del WKWebView es una pantalla
        // negra muda: no hay consola donde mirar. Lo reenviamos al log del sistema.
        let tap = """
        (function(){
          const send = (kind, msg) => { try {
            window.webkit.messageHandlers.sokaniLog.postMessage(kind + ': ' + msg);
          } catch(e){} };
          window.addEventListener('error', e => send('ERROR',
            (e.message||'') + ' @ ' + (e.filename||'?') + ':' + (e.lineno||0)));
          window.addEventListener('unhandledrejection', e => send('REJECT', String(e.reason)));
          const ce = console.error.bind(console);
          console.error = (...a) => { send('console.error', a.join(' ')); ce(...a); };
          send('INFO', 'documento cargado');
        })();
        """
        ucc.addUserScript(WKUserScript(source: tap,
                                       injectionTime: .atDocumentStart,
                                       forMainFrameOnly: true))
        cfg.userContentController = ucc

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.bounces = false
        #if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }   // Safari > Desarrollo
        #endif

        context.coordinator.bridge.webView = web
        // En un set, que el iPhone se bloquee a mitad de una toma deja las luces
        // sin mando. Mientras la consola está abierta, la pantalla no se apaga.
        UIApplication.shared.isIdleTimerDisabled = true

        guard let root = Bundle.main.url(forResource: "web", withExtension: nil) else {
            web.loadHTMLString(missingAssetsPage, baseURL: nil)
            return web
        }
        let index = root.appendingPathComponent("index.html")
        web.loadFileURL(index, allowingReadAccessTo: root)
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) { }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let bridge = BLEBridge()
        func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
            if m.name == "sokaniLog" {
                NSLog("[SokaniWeb] %@", String(describing: m.body))
                return
            }
            guard let body = m.body as? [String: Any] else { return }
            bridge.handle(body)
        }
    }

    private var missingAssetsPage: String {
        """
        <meta name=viewport content="width=device-width,initial-scale=1">
        <body style="background:#07070b;color:#e8eaf6;font:15px -apple-system;padding:28px;line-height:1.6">
        <h2>Faltan los archivos web</h2>
        <p>El bundle no contiene la carpeta <code>web/</code>. La fase de compilación
        «Copiar consola web» debería copiarla desde la raíz del proyecto.</p>
        <p>En Xcode: target SokaniX25 → Build Phases → Run Script «Copiar consola web».</p>
        </body>
        """
    }
}
