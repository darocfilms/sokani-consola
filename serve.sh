#!/usr/bin/env bash
# Sirve la consola.
#   ./serve.sh        → solo este Mac (http://localhost:8799). Web Bluetooth
#                       exige contexto seguro y localhost cuenta como tal.
#   ./serve.sh red    → también para el móvil en la misma wifi. Útil para
#                       instalarla en la pantalla de inicio y preparar looks;
#                       por http en la red local el móvil NO tendrá Bluetooth
#                       ni modo sin conexión (ambos exigen https).
cd "$(dirname "$0")"
PORT=8799
MODO="${1:-local}"
if [ "$MODO" = "red" ]; then
  IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
  echo ""
  echo "  Consola Sokani"
  echo "    en este Mac  →  http://localhost:$PORT"
  echo "    en el móvil  →  http://$IP:$PORT   (misma wifi)"
  echo ""
  echo "  Ctrl+C para parar."
  echo ""
  command -v open >/dev/null && (sleep 1; open "http://localhost:$PORT") &
  exec python3 -m http.server "$PORT" --bind 0.0.0.0
else
  echo ""
  echo "  Consola Sokani  →  http://localhost:$PORT"
  echo "  Ábrela en Chrome o Edge. Ctrl+C para parar."
  echo "  (Para abrirla también desde el móvil: ./serve.sh red)"
  echo ""
  command -v open >/dev/null && (sleep 1; open "http://localhost:$PORT") &
  exec python3 -m http.server "$PORT" --bind 127.0.0.1
fi
