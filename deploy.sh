#!/bin/bash
# ==============================================================================
# Script de Despliegue Automático en VPS Linux (Ubuntu / Debian)
# VoiceForge AI - Coqui XTTS-v2 & FastAPI
# ==============================================================================

set -e

echo "🚀 [1/5] Actualizando paquetes e instalando dependencias del sistema..."
sudo apt-get update -y
sudo apt-get install -y python3 python3-pip python3-venv ffmpeg libsndfile1 build-essential git

echo "📦 [2/5] Configurando entorno virtual de Python..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo "Entorno virtual 'venv' creado."
fi

source venv/bin/activate
pip install --upgrade pip

echo "⚡ [3/5] Instalando PyTorch..."
# Detectar si hay GPU NVIDIA con drivers funcionales en el VPS
if command -v nvidia-smi &> /dev/null && nvidia-smi &> /dev/null; then
    echo "🎮 GPU NVIDIA detectada. Instalando PyTorch con soporte CUDA 12.1..."
    pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
else
    echo "💻 No se detectó GPU NVIDIA o drivers. Instalando PyTorch optimizado para CPU..."
    pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
fi

echo "📚 [4/5] Instalando dependencias de la aplicación..."
pip install -r requirements.txt

echo "📁 [5/5] Creando directorios y muestra inicial..."
mkdir -p voices outputs
if [ ! -f "voices/sample_voice.wav" ]; then
    python3 create_sample_voice.py || true
fi

echo "=============================================================================="
echo "✅ Instalación completada exitosamente."
echo "Para ejecutar en segundo plano con systemd o nohup, consulta el README."
echo "Para iniciar ahora:"
echo "  source venv/bin/activate"
echo "  uvicorn app:app --host 0.0.0.0 --port 28839"
echo "=============================================================================="
