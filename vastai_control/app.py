"""
Mini API para Coolify - Controla instancias Vast.ai on-demand.
Endpoints:
  POST /tts/start   -> Prende GPU en Vast.ai
  POST /tts/stop    -> Apaga GPU (deja de cobrar)
  GET  /tts/status  -> Estado actual
"""

import os
import json
import time
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="VoiceForge Vast.ai Controller")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

API_KEY = os.environ.get("VASTAI_API_KEY", "")
DOCKER_IMAGE = os.environ.get("DOCKER_IMAGE", "")
CF_TUNNEL_TOKEN = os.environ.get("CLOUDFLARE_TUNNEL_TOKEN", "")
CONTROL_SECRET = os.environ.get("CONTROL_SECRET", "changeme")

BASE_URL = "https://console.vast.ai/api/v0"

current_instance_id = None


def vast_headers():
    return {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}


def verify_secret(secret: str):
    if secret != CONTROL_SECRET:
        raise HTTPException(status_code=403, detail="Secret invalido")


def search_gpu_offers():
    """Busca GPUs disponibles usando POST /bundles/ de Vast.ai."""
    search_params = {
        "verified": {"eq": True},
        "rentable": {"eq": True},
        "gpu_ram": {"gte": 12},
        "cuda_max_good": {"gte": 12.0},
        "disk_space": {"gte": 30},
        "num_gpus": {"eq": 1},
        "order": [["dph_total", "asc"]],
        "type": "on-demand",
        "limit": 10,
    }
    try:
        r = requests.post(
            f"{BASE_URL}/bundles/",
            headers=vast_headers(),
            json=search_params,
        )
        if r.status_code == 200:
            data = r.json()
            offers = data.get("offers", [])
            if offers:
                return offers
    except Exception:
        pass

    try:
        query = "rentable=true gpu_ram>=12 cuda_max_good>=12.0 disk_space>=30 num_gpus=1"
        r = requests.get(
            f"{BASE_URL}/search/offers/",
            headers=vast_headers(),
            params={"q": query, "order": "dph_total", "type": "on-demand", "limit": "5"},
        )
        if r.status_code == 200:
            data = r.json()
            offers = data.get("offers", data.get("results", []))
            if isinstance(offers, list) and offers:
                return offers
    except Exception:
        pass

    return None


@app.get("/tts/status")
async def tts_status(secret: str = ""):
    verify_secret(secret)
    global current_instance_id

    if not current_instance_id:
        return {"status": "off", "instance_id": None, "url": None, "cost_per_hour": 0}

    r = requests.get(f"{BASE_URL}/instances/{current_instance_id}/", headers=vast_headers())
    if r.status_code != 200:
        current_instance_id = None
        return {"status": "off", "instance_id": None, "url": None, "cost_per_hour": 0}

    data = r.json()
    inst = data.get("instances", data)
    if isinstance(inst, list):
        inst = inst[0] if inst else {}

    actual = inst.get("actual_status", "unknown")
    public_ip = inst.get("public_ipaddr", "")
    ports = inst.get("ports", {})
    app_port = ""
    for k, v in ports.items():
        if "29783" in k and v:
            app_port = v[0].get("HostPort", "")

    url = f"http://{public_ip}:{app_port}" if public_ip and app_port else None

    return {
        "status": actual,
        "instance_id": current_instance_id,
        "url": url,
        "gpu": inst.get("gpu_name", ""),
        "cost_per_hour": round(inst.get("dph_total", 0), 3),
    }


@app.post("/tts/start")
async def tts_start(secret: str = ""):
    verify_secret(secret)
    global current_instance_id

    if current_instance_id:
        st = await tts_status(secret=CONTROL_SECRET)
        if st["status"] in ("running", "loading"):
            return {"message": "Ya hay una instancia corriendo", **st}
        current_instance_id = None

    if not DOCKER_IMAGE:
        raise HTTPException(status_code=500, detail="Falta DOCKER_IMAGE en env")

    offers = search_gpu_offers()
    if not offers:
        raise HTTPException(status_code=503, detail="No hay GPUs disponibles en Vast.ai o la API key es inválida")

    env_vars = {"PORT": "29783"}
    if CF_TUNNEL_TOKEN:
        env_vars["CLOUDFLARE_TUNNEL_TOKEN"] = CF_TUNNEL_TOKEN

    create_body = {
        "client_id": "me",
        "image": DOCKER_IMAGE,
        "disk": 40,
        "env": env_vars,
        "onstart": None,
        "args": [],
        "runtype": "args",
    }

    last_error = ""
    for offer in offers:
        r = requests.put(
            f"{BASE_URL}/asks/{offer['id']}/",
            headers=vast_headers(),
            json=create_body,
        )
        if r.status_code in (200, 201):
            result = r.json()
            new_contract = result.get("new_contract")
            if new_contract:
                current_instance_id = str(new_contract)
                return {
                    "message": "Instancia creada, arrancando...",
                    "instance_id": current_instance_id,
                    "gpu": offer.get("gpu_name", ""),
                    "cost_per_hour": round(offer.get("dph_total", 0), 3),
                }
        last_error = f"{r.status_code} {r.text[:200]}"

    raise HTTPException(status_code=503, detail=f"No se pudo crear instancia en ninguna oferta: {last_error}")


@app.post("/tts/stop")
async def tts_stop(secret: str = ""):
    verify_secret(secret)
    global current_instance_id

    if not current_instance_id:
        return {"message": "No hay instancia activa"}

    r = requests.delete(f"{BASE_URL}/instances/{current_instance_id}/", headers=vast_headers())
    old_id = current_instance_id
    current_instance_id = None

    if r.status_code in (200, 204):
        return {"message": f"Instancia {old_id} destruida, ya no cobra"}
    else:
        return {"message": f"Posible error al destruir {old_id}: {r.status_code}"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("CONTROL_PORT", 29784))
    uvicorn.run("app:app", host="0.0.0.0", port=port)
