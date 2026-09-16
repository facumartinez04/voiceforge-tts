"""
VoiceForge - Vast.ai Instance Manager
Prende y apaga instancias GPU on-demand via la API de Vast.ai.

Uso:
    python vastai_manager.py start          # Busca GPU barata y arranca
    python vastai_manager.py stop           # Apaga la instancia
    python vastai_manager.py status         # Estado actual
    python vastai_manager.py build-push     # Buildea y sube imagen a Docker Hub

Requiere: pip install requests python-dotenv
"""

import os
import sys
import json
import time
import subprocess
import requests
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env.vastai")
except ImportError:
    pass

API_KEY = os.environ.get("VASTAI_API_KEY", "")
DOCKER_USER = os.environ.get("DOCKER_USER", "")
DOCKER_IMAGE = os.environ.get("DOCKER_IMAGE", "voiceforge-tts")
CF_TUNNEL_TOKEN = os.environ.get("CLOUDFLARE_TUNNEL_TOKEN", "")
INSTANCE_FILE = Path(__file__).parent / ".vastai_instance_id"
BASE_URL = "https://console.vast.ai/api/v0"


def headers():
    return {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}


def find_cheap_gpu():
    """Busca la GPU mas barata con al menos 11GB VRAM y CUDA 12+."""
    print("Buscando GPU barata con 11+ GB VRAM...")
    params = {
        "verified": {"eq": True},
        "rentable": {"eq": True},
        "gpu_ram": {"gte": 11},
        "cuda_max_good": {"gte": 12.0},
        "disk_space": {"gte": 30},
        "inet_down": {"gte": 100},
        "reliability2": {"gte": 0.9},
        "num_gpus": {"eq": 1},
        "order": [["dph_total", "asc"]],
        "type": "on-demand",
    }
    r = requests.get(
        f"{BASE_URL}/bundles",
        headers=headers(),
        params={"q": json.dumps(params), "limit": "5"},
    )
    r.raise_for_status()
    offers = r.json().get("offers", [])
    if not offers:
        print("No se encontraron GPUs disponibles con esos requisitos.")
        return None

    best = offers[0]
    print(
        f"  Mejor oferta: {best.get('gpu_name', '?')} "
        f"({best.get('gpu_ram', '?')} GB VRAM) "
        f"- ${best.get('dph_total', '?'):.3f}/hr "
        f"- {best.get('inet_down', '?')} Mbps down"
    )
    return best


def start_instance():
    """Crea y arranca una instancia en Vast.ai."""
    if not API_KEY:
        print("ERROR: Falta VASTAI_API_KEY en .env.vastai")
        return
    if not DOCKER_USER:
        print("ERROR: Falta DOCKER_USER en .env.vastai")
        return

    if INSTANCE_FILE.exists():
        inst_id = INSTANCE_FILE.read_text().strip()
        print(f"Ya hay una instancia registrada: {inst_id}")
        print("Usa 'python vastai_manager.py status' para ver su estado")
        print("O 'python vastai_manager.py stop' para apagarla primero")
        return

    offer = find_cheap_gpu()
    if not offer:
        return

    image = f"{DOCKER_USER}/{DOCKER_IMAGE}:latest"
    env_vars = {"-p 29783:29783": "1", "-e PORT=29783": "1"}
    if CF_TUNNEL_TOKEN:
        env_vars[f"-e CLOUDFLARE_TUNNEL_TOKEN={CF_TUNNEL_TOKEN}"] = "1"

    create_body = {
        "client_id": "me",
        "image": image,
        "disk": 40,
        "onstart": None,
        "env": env_vars,
        "args": [],
        "runtype": "args",
    }

    print(f"Creando instancia con {image} en {offer.get('gpu_name')}...")
    r = requests.put(
        f"{BASE_URL}/asks/{offer['id']}/",
        headers=headers(),
        json=create_body,
    )
    r.raise_for_status()
    result = r.json()
    new_contract = result.get("new_contract")
    if not new_contract:
        print(f"Error creando instancia: {result}")
        return

    INSTANCE_FILE.write_text(str(new_contract))
    print(f"Instancia creada: ID {new_contract}")
    print("Esperando que arranque...")

    for i in range(60):
        time.sleep(5)
        info = get_instance_info(new_contract)
        if not info:
            continue
        status = info.get("actual_status", "")
        print(f"  [{i*5}s] Estado: {status}")
        if status == "running":
            ports = info.get("ports", {})
            ssh_port = ""
            app_port = ""
            for port_key, port_info in ports.items():
                if "22" in port_key:
                    ssh_port = f"{port_info[0].get('HostPort', '')}"
                if "29783" in port_key:
                    app_port = f"{port_info[0].get('HostPort', '')}"
            public_ip = info.get("public_ipaddr", "")
            print(f"\n=== INSTANCIA LISTA ===")
            print(f"  IP: {public_ip}")
            if app_port:
                print(f"  TTS: http://{public_ip}:{app_port}")
            if ssh_port:
                print(f"  SSH: ssh root@{public_ip} -p {ssh_port} (pass: vastai)")
            if CF_TUNNEL_TOKEN:
                print(f"  Dominio: conectado via Cloudflare Tunnel")
            print(f"  Costo: ~${info.get('dph_total', '?'):.3f}/hr")
            return
    print("Timeout esperando que arranque. Revisá en vast.ai/instances")


def get_instance_info(instance_id):
    r = requests.get(f"{BASE_URL}/instances/{instance_id}/", headers=headers())
    if r.status_code == 200:
        return r.json().get("instances", r.json())
    return None


def stop_instance():
    """Destruye la instancia de Vast.ai."""
    if not INSTANCE_FILE.exists():
        print("No hay instancia registrada para apagar.")
        return
    inst_id = INSTANCE_FILE.read_text().strip()
    print(f"Destruyendo instancia {inst_id}...")
    r = requests.delete(f"{BASE_URL}/instances/{inst_id}/", headers=headers())
    if r.status_code in (200, 204):
        INSTANCE_FILE.unlink(missing_ok=True)
        print("Instancia destruida. Ya no genera costos.")
    else:
        print(f"Error: {r.status_code} - {r.text}")


def show_status():
    """Muestra el estado de la instancia."""
    if not INSTANCE_FILE.exists():
        print("No hay instancia activa.")
        return
    inst_id = INSTANCE_FILE.read_text().strip()
    print(f"Instancia ID: {inst_id}")
    info = get_instance_info(inst_id)
    if info:
        instances = info if isinstance(info, list) else [info]
        for inst in instances:
            print(f"  Estado: {inst.get('actual_status', '?')}")
            print(f"  GPU: {inst.get('gpu_name', '?')}")
            print(f"  Costo: ${inst.get('dph_total', 0):.3f}/hr")
            print(f"  IP: {inst.get('public_ipaddr', '?')}")
    else:
        print("  No se pudo obtener info (quizas fue destruida)")
        INSTANCE_FILE.unlink(missing_ok=True)


def build_and_push():
    """Buildea la imagen Docker y la pushea a Docker Hub."""
    if not DOCKER_USER:
        print("ERROR: Falta DOCKER_USER en .env.vastai")
        return
    image = f"{DOCKER_USER}/{DOCKER_IMAGE}:latest"
    project_dir = str(Path(__file__).parent)

    print(f"Buildeando {image}...")
    subprocess.run(
        ["docker", "build", "-f", "Dockerfile.vastai", "-t", image, "."],
        cwd=project_dir,
        check=True,
    )
    print(f"Pusheando {image} a Docker Hub...")
    subprocess.run(["docker", "push", image], cwd=project_dir, check=True)
    print(f"Imagen lista: {image}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python vastai_manager.py [start|stop|status|build-push]")
        sys.exit(1)

    cmd = sys.argv[1].lower()
    if cmd == "start":
        start_instance()
    elif cmd == "stop":
        stop_instance()
    elif cmd == "status":
        show_status()
    elif cmd in ("build-push", "build", "push"):
        build_and_push()
    else:
        print(f"Comando desconocido: {cmd}")
