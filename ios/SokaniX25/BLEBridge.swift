import Foundation
import CoreBluetooth
import WebKit

/// Puente CoreBluetooth <-> JavaScript, para varias luces a la vez.
///
/// La web (la misma que corre en Chrome de escritorio) habla con esta clase por
/// `window.webkit.messageHandlers.sokaniBLE`. Del lado JS, `native-bridge.js`
/// envuelve estos mensajes en un `navigator.bluetooth` con la misma forma que
/// Web Bluetooth, así que el rig multi-luz corre igual en Chrome y en iOS.
///
/// Todo va identificado por dispositivo: dos Sokani exponen la misma
/// característica FFE1, y sin el id de por medio las escrituras de una luz
/// acabarían en la otra.
///
/// Ventaja frente a Web Bluetooth: `discoverServices(nil)` devuelve TODOS los
/// servicios, incluidos los propietarios de 128 bits, sin declararlos antes.
final class BLEBridge: NSObject {

    weak var webView: WKWebView?

    private final class Luz {
        let p: CBPeripheral
        var chars: [String: CBCharacteristic] = [:]
        var pendingConnect: Int?
        var servicesLeft = 0
        init(_ p: CBPeripheral) { self.p = p }
    }

    private var central: CBCentralManager!
    private var luces: [UUID: Luz] = [:]          // escaneadas o recuperadas
    private var vistas: [UUID: Int] = [:]         // RSSI del escaneo en curso
    private var pendingWrites: [String: Int] = [:]
    private var pendingReads: [String: Int] = [:]
    private var enEspera: [(Bool) -> Void] = []   // órdenes que esperan a que el Bluetooth arranque
    private var wantScan = false
    private var ultimoPush = Date.distantPast

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    // MARK: - Entrada desde JavaScript

    func handle(_ msg: [String: Any]) {
        guard let id = msg["id"] as? Int, let cmd = msg["cmd"] as? String else { return }
        let dev = (msg["device"] as? String).flatMap(UUID.init(uuidString:))
        let chr = (msg["chr"] as? String).map(fullUUID)

        switch cmd {
        case "state":
            reply(id, true, estado())

        case "scan":
            vistas.removeAll()
            wantScan = true
            cuandoListo { [weak self] ok in
                guard let self, ok, self.wantScan else { return }
                self.central.scanForPeripherals(withServices: nil,
                                                options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
            }
            reply(id, true, "")

        case "stopScan":
            wantScan = false
            if central.state == .poweredOn { central.stopScan() }
            reply(id, true, "")

        case "known":
            // Equivalente a navigator.bluetooth.getDevices(): iOS recuerda las
            // luces ya usadas y las devuelve por su identificador.
            let ids = ((msg["ids"] as? [String]) ?? []).compactMap(UUID.init(uuidString:))
            cuandoListo { [weak self] ok in
                guard let self else { return }
                guard ok else { self.reply(id, false, "Bluetooth no disponible: \(self.estado())"); return }
                let ps = self.central.retrievePeripherals(withIdentifiers: ids)
                for p in ps where self.luces[p.identifier] == nil { self.luces[p.identifier] = Luz(p) }
                let lista = ps.map { ["id": $0.identifier.uuidString, "name": $0.name ?? ""] }
                self.reply(id, true, self.json(lista))
            }

        case "connect":
            guard let dev, let luz = luces[dev] else { reply(id, false, "dispositivo no encontrado"); return }
            cuandoListo { [weak self] ok in
                guard let self else { return }
                guard ok else { self.reply(id, false, "Bluetooth no disponible: \(self.estado())"); return }
                luz.pendingConnect = id
                luz.p.delegate = self
                self.central.connect(luz.p, options: nil)
            }

        case "disconnect":
            if let dev, let luz = luces[dev] { central.cancelPeripheralConnection(luz.p) }
            reply(id, true, "")

        case "write":
            guard let dev, let chr, let luz = luces[dev], let c = luz.chars[chr],
                  let hex = msg["data"] as? String else {
                reply(id, false, "característica desconocida"); return
            }
            let data = Data(hexString: hex)
            let wantResp = (msg["resp"] as? Bool) ?? true
            // Respetamos lo que declara la característica: pedir un modo que no
            // soporta hace que CoreBluetooth tire la escritura en silencio.
            let canNo = c.properties.contains(.writeWithoutResponse)
            let canYes = c.properties.contains(.write)
            if (wantResp && canYes) || (!canNo && canYes) {
                pendingWrites[clave(dev, chr)] = id
                luz.p.writeValue(data, for: c, type: .withResponse)
            } else if canNo {
                luz.p.writeValue(data, for: c, type: .withoutResponse)
                reply(id, true, "")
            } else {
                reply(id, false, "característica no escribible")
            }

        case "read":
            guard let dev, let chr, let luz = luces[dev], let c = luz.chars[chr] else {
                reply(id, false, "característica desconocida"); return
            }
            pendingReads[clave(dev, chr)] = id
            luz.p.readValue(for: c)

        case "notify":
            guard let dev, let chr, let luz = luces[dev], let c = luz.chars[chr] else {
                reply(id, false, "característica desconocida"); return
            }
            luz.p.setNotifyValue((msg["on"] as? Bool) ?? true, for: c)
            reply(id, true, "")

        default:
            reply(id, false, "comando desconocido: \(cmd)")
        }
    }

    // MARK: - Utilidades

    /// Ejecuta ya si el Bluetooth está encendido; si aún arranca, espera.
    private func cuandoListo(_ f: @escaping (Bool) -> Void) {
        switch central.state {
        case .poweredOn: f(true)
        case .unknown, .resetting: enEspera.append(f)
        default: f(false)
        }
    }

    private func estado() -> String {
        switch central.state {
        case .poweredOn: return "poweredOn"
        case .poweredOff: return "poweredOff"
        case .unauthorized: return "unauthorized"
        case .unsupported: return "unsupported"
        case .resetting: return "resetting"
        default: return "unknown"
        }
    }

    /// CoreBluetooth abrevia los UUID de 16 bits ("FFE1"). Web Bluetooth los da
    /// completos; normalizamos para que ambos lados hablen igual.
    private func fullUUID(_ s: String) -> String {
        let u = s.lowercased()
        if u.count == 4 { return "0000\(u)-0000-1000-8000-00805f9b34fb" }
        if u.count == 8 { return "\(u)-0000-1000-8000-00805f9b34fb" }
        return u
    }
    private func fullUUID(_ c: CBUUID) -> String { fullUUID(c.uuidString) }
    private func clave(_ d: UUID, _ c: String) -> String { d.uuidString + "|" + c }

    private func json(_ o: Any) -> String {
        guard let d = try? JSONSerialization.data(withJSONObject: o),
              let s = String(data: d, encoding: .utf8) else { return "[]" }
        return s
    }

    // MARK: - Salida hacia JavaScript

    private func reply(_ id: Int, _ ok: Bool, _ payload: String) {
        run("window.__sokaniReply(\(id), \(ok), \(payload.jsQuoted))")
    }

    private func run(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func pushDevices() {
        let lista = vistas
            .compactMap { (uid, rssi) -> [String: Any]? in
                guard let luz = luces[uid] else { return nil }
                return ["id": uid.uuidString, "name": luz.p.name ?? "", "rssi": rssi]
            }
            .sorted { ($0["rssi"] as? Int ?? -200) > ($1["rssi"] as? Int ?? -200) }
        run("window.__sokaniDevices(\(json(lista).jsQuoted))")
    }

    private func pushGattTree(_ luz: Luz) {
        guard let id = luz.pendingConnect else { return }
        luz.pendingConnect = nil
        luz.chars.removeAll()
        var services: [[String: Any]] = []
        for s in luz.p.services ?? [] {
            var cs: [[String: Any]] = []
            for c in s.characteristics ?? [] {
                let key = fullUUID(c.uuid)
                luz.chars[key] = c
                cs.append([
                    "uuid": key,
                    "read": c.properties.contains(.read),
                    "write": c.properties.contains(.write),
                    "writeNoResp": c.properties.contains(.writeWithoutResponse),
                    "notify": c.properties.contains(.notify),
                    "indicate": c.properties.contains(.indicate)
                ])
            }
            services.append(["uuid": fullUUID(s.uuid), "chars": cs])
        }
        let tree: [String: Any] = ["name": luz.p.name ?? "", "services": services]
        reply(id, true, json(tree))
    }
}

// MARK: - CBCentralManagerDelegate

extension BLEBridge: CBCentralManagerDelegate {

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        let listos = enEspera
        if c.state != .unknown && c.state != .resetting {
            enEspera.removeAll()
            listos.forEach { $0(c.state == .poweredOn) }
        }
        run("window.__sokaniState && window.__sokaniState(\(estado().jsQuoted))")
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        // Sin nombre casi siempre es ruido de fondo (auriculares, relojes, balizas).
        let nombre = p.name ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
        guard let nombre, !nombre.isEmpty else { return }
        if luces[p.identifier] == nil { luces[p.identifier] = Luz(p) }
        let nueva = vistas[p.identifier] == nil
        vistas[p.identifier] = RSSI.intValue
        // Con duplicados activados esto llega muchas veces por segundo; basta con
        // refrescar la lista al aparecer una luz nueva o cada medio segundo.
        if nueva || Date().timeIntervalSince(ultimoPush) > 0.5 {
            ultimoPush = Date()
            pushDevices()
        }
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        guard let luz = luces[p.identifier] else { return }
        luz.chars.removeAll()
        p.discoverServices(nil)          // nil = TODOS, incluidos los de 128 bits
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        guard let luz = luces[p.identifier], let id = luz.pendingConnect else { return }
        luz.pendingConnect = nil
        reply(id, false, error?.localizedDescription ?? "fallo al conectar")
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        guard let luz = luces[p.identifier] else { return }
        luz.chars.removeAll()
        if let id = luz.pendingConnect {
            luz.pendingConnect = nil
            reply(id, false, error?.localizedDescription ?? "desconectado al conectar")
        }
        run("window.__sokaniDisconnected(\(p.identifier.uuidString.jsQuoted))")
    }
}

// MARK: - CBPeripheralDelegate

extension BLEBridge: CBPeripheralDelegate {

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let luz = luces[p.identifier] else { return }
        guard let svcs = p.services, !svcs.isEmpty else {
            if let id = luz.pendingConnect { luz.pendingConnect = nil; reply(id, false, "el dispositivo no expone servicios") }
            return
        }
        luz.servicesLeft = svcs.count
        for s in svcs { p.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        guard let luz = luces[p.identifier] else { return }
        luz.servicesLeft -= 1
        if luz.servicesLeft <= 0 { pushGattTree(luz) }
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor c: CBCharacteristic, error: Error?) {
        guard let id = pendingWrites.removeValue(forKey: clave(p.identifier, fullUUID(c.uuid))) else { return }
        if let e = error { reply(id, false, e.localizedDescription) } else { reply(id, true, "") }
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
        let key = clave(p.identifier, fullUUID(c.uuid))
        if let id = pendingReads.removeValue(forKey: key) {
            if let e = error { reply(id, false, e.localizedDescription) }
            else { reply(id, true, (c.value ?? Data()).hexString) }
            return
        }
        guard let d = c.value else { return }
        run("window.__sokaniNotify(\(p.identifier.uuidString.jsQuoted), \(fullUUID(c.uuid).jsQuoted), \(d.hexString.jsQuoted))")
    }
}

// MARK: - Utilidades

extension Data {
    init(hexString: String) {
        var out = [UInt8]()
        var i = hexString.startIndex
        while let j = hexString.index(i, offsetBy: 2, limitedBy: hexString.endIndex) {
            out.append(UInt8(hexString[i..<j], radix: 16) ?? 0)
            i = j
        }
        self.init(out)
    }
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}

extension String {
    /// Literal JS seguro: evita romper el evaluateJavaScript con comillas o saltos.
    var jsQuoted: String {
        var s = self
        s = s.replacingOccurrences(of: "\\", with: "\\\\")
        s = s.replacingOccurrences(of: "'", with: "\\'")
        s = s.replacingOccurrences(of: "\n", with: "\\n")
        s = s.replacingOccurrences(of: "\r", with: "")
        s = s.replacingOccurrences(of: "\u{2028}", with: "\\u2028")
        s = s.replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return "'\(s)'"
    }
}
