#!/bin/bash
set -e

echo "=========================================="
echo " VoiceForge AI - Vast.ai Startup"
echo "=========================================="

# SSH para acceso remoto
service ssh start 2>/dev/null || true

mkdir -p /workspace/hf_cache voices outputs

# Cloudflare Tunnel (si hay token configurado)
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
    echo "[TUNNEL] Conectando dominio via Cloudflare Tunnel..."
    cloudflared tunnel --no-autoupdate run --token "$CLOUDFLARE_TUNNEL_TOKEN" &
    sleep 2
    echo "[TUNNEL] Tunnel activo -> tu dominio apunta aca"
else
    echo "[TUNNEL] Sin CLOUDFLARE_TUNNEL_TOKEN, acceso solo por IP:puerto"
fi

APP_PORT="${PORT:-29783}"

echo "[GPU] $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo 'No detectada')"
echo "[START] Puerto $APP_PORT"
echo "=========================================="

exec python app.py
