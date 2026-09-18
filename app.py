import os
import sys
import time
import uuid
import shutil
import logging
from pathlib import Path
from typing import Optional, List, Dict
from contextlib import asynccontextmanager

import torch
import soundfile as sf
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.concurrency import run_in_threadpool

# Configuración de Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("voiceforge")

# Rutas del proyecto
BASE_DIR = Path(__file__).resolve().parent
VOICES_DIR = BASE_DIR / "voices"
OUTPUTS_DIR = BASE_DIR / "outputs"
TEMPLATES_DIR = BASE_DIR / "templates"

# Asegurar directorios
VOICES_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

# Variables globales para modelos (Singleton)
f5_model = None
xtts_model = None
qwen_06b_model = None
qwen_17b_model = None
device_name = "cpu"
qwen_load_error = None


def free_vram():
    """Libera memoria VRAM y recolecta basura."""
    import gc
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()


def get_device() -> str:
    """Detecta si hay aceleración CUDA o si se debe utilizar CPU."""
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0)
        logger.info(f"🚀 GPU CUDA detectada: {gpu_name}")
        return "cuda"
    logger.info("ℹ️ Sin GPU CUDA. Usando CPU.")
    return "cpu"


def load_qwen_model(variant: str = "0.6b"):
    """Carga en memoria el modelo Qwen3-TTS (0.6B o 1.7B) en GPU con FP32 y gestión de VRAM."""
    global qwen_06b_model, qwen_17b_model, xtts_model, f5_model, device_name
    is_17b = "1.7" in str(variant)
    if is_17b and qwen_17b_model is not None:
        return qwen_17b_model
    elif not is_17b and qwen_06b_model is not None:
        return qwen_06b_model

    # Liberar memoria de otros modelos para que 1.7B entre con holgura en los 11 GB de VRAM
    if is_17b:
        if qwen_06b_model is not None:
            del qwen_06b_model
            qwen_06b_model = None
        if xtts_model is not None:
            del xtts_model
            xtts_model = None
        if f5_model is not None:
            del f5_model
            f5_model = None
        free_vram()
    else:
        if qwen_17b_model is not None:
            del qwen_17b_model
            qwen_17b_model = None
        free_vram()

    device_name = get_device()
    target_device = "cuda:0" if device_name == "cuda" else "cpu"
    # Para 1.7B usamos FP16 (pesa solo 3.5 GB de VRAM y vuela en GPU); para 0.6B usamos FP32
    if is_17b:
        dtype = torch.float16 if device_name == "cuda" else torch.float32
    else:
        dtype = torch.float32

    model_id = "Qwen/Qwen3-TTS-12Hz-1.7B-Base" if is_17b else "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    label = "1.7B (Calidad Pro)" if is_17b else "0.6B (Rápido)"
    logger.info(f"Cargando modelo Qwen3-TTS {label} ({model_id}) en {target_device} ({dtype})...")
    try:
        from qwen_tts import Qwen3TTSModel
        loaded = Qwen3TTSModel.from_pretrained(
            model_id,
            device_map=target_device,
            dtype=dtype
        )
        if is_17b:
            qwen_17b_model = loaded
        else:
            qwen_06b_model = loaded
        logger.info(f"✅ Qwen3-TTS {label} inicializado en GPU (FP32) y listo.")
        return loaded
    except Exception as e:
        global qwen_load_error
        qwen_load_error = str(e)
        logger.error(f"Error al cargar Qwen3-TTS {label}: {e}", exc_info=True)
        return None


def load_f5_model():
    """Carga en memoria el modelo F5-TTS (Flow Matching SOTA)."""
    global f5_model, device_name
    if f5_model is not None:
        return f5_model

    device_name = get_device()
    logger.info(f"Cargando modelo F5-TTS (Flow Matching) en {device_name.upper()}...")
    try:
        from f5_tts.api import F5TTS
        f5_model = F5TTS(
            model="F5TTS_Base",
            device=device_name
        )
        logger.info("✅ F5-TTS inicializado y listo para síntesis.")
        return f5_model
    except Exception as e:
        logger.error(f"❌ Error al cargar F5-TTS: {e}", exc_info=True)
        raise e


def load_xtts_model():
    """Carga en memoria el modelo XTTS-v2 con compatibilidad para transformers modernos."""
    global xtts_model, device_name
    if xtts_model is not None:
        return xtts_model

    device_name = get_device()
    logger.info(f"Cargando modelo XTTS-v2 (Español Multilingüe) en {device_name.upper()}...")
    try:
        os.environ["COQUI_TOS_AGREED"] = "1"
        # Monkeypatch para compatibilidad de Coqui con transformers modernos
        import transformers
        if not hasattr(transformers, "BeamSearchScorer"):
            try:
                from transformers.generation import BeamSearchScorer
                transformers.BeamSearchScorer = BeamSearchScorer
            except Exception:
                pass
                
        from TTS.api import TTS
        xtts_model = TTS(
            model_name="tts_models/multilingual/multi-dataset/xtts_v2",
            progress_bar=False,
            gpu=(device_name == "cuda")
        )
        logger.info("✅ XTTS-v2 inicializado y listo para síntesis en Español.")
        return xtts_model
    except Exception as e:
        logger.error(f"Error al cargar XTTS-v2: {e}", exc_info=True)
        return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Ciclo de vida de FastAPI: precarga Qwen3-TTS 0.6B en GPU al arrancar para que las peticiones sean instantáneas."""
    logger.info("Iniciando servicio VoiceForge AI (Precargando Qwen3-TTS 0.6B en GPU)...")
    try:
        model = await run_in_threadpool(load_qwen_model)
        if model is not None:
            logger.info("⚡ Ejecutando warmup de Qwen3-TTS en GPU...")
            sample_voice = list(VOICES_DIR.glob("*.*"))
            if sample_voice:
                ref_sample = str(sample_voice[0])
                try:
                    await run_in_threadpool(
                        model.generate_voice_clone,
                        text="Hola",
                        ref_audio=ref_sample
                    )
                except Exception:
                    pass
            logger.info("🚀 Qwen3-TTS 0.6B 100% precargado en VRAM y listo para inferencias ultra rápidas.")
    except Exception as e:
        logger.warning(f"Aviso durante precarga inicial de Qwen: {e}")
    yield
    logger.info("Deteniendo servidor...")


app = FastAPI(
    title="VoiceForge AI - SOTA Voice Cloning & TTS",
    description="API y Web UI moderna para clonación de voz con F5-TTS y XTTS-v2",
    version="2.0.0",
    lifespan=lifespan
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


# -------------------------------------------------------------
# Endpoints Frontend
# -------------------------------------------------------------

@app.get("/", summary="Interfaz Web UI")
async def render_index(request: Request):
    """Renderiza la interfaz gráfica del usuario con compatibilidad Starlette moderna."""
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "default_engine": "f5"
        }
    )


# -------------------------------------------------------------
# Endpoints de la API
# -------------------------------------------------------------

@app.get("/api/health", summary="Estado del sistema")
async def health_check():
    """Retorna información sobre el estado del servidor, hardware y modelos cargados."""
    gpu_available = torch.cuda.is_available()
    gpu_info = torch.cuda.get_device_name(0) if gpu_available else None
    
    return {
        "status": "online",
        "qwen_06b_loaded": qwen_06b_model is not None,
        "f5_loaded": f5_model is not None,
        "xtts_loaded": xtts_model is not None,
        "device": device_name,
        "gpu_available": gpu_available,
        "gpu_name": gpu_info,
        "gpu_ram_mb": round(torch.cuda.get_device_properties(0).total_mem / 1024**2) if gpu_available else 0,
        "qwen_error": qwen_load_error,
        "default_engine": "F5-TTS (Flow Matching)"
    }


@app.get("/api/voices", summary="Listar voces de referencia guardadas")
async def list_voices():
    """Retorna los archivos de audio disponibles en la carpeta voices/."""
    valid_extensions = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}
    voices = []
    
    for file_path in sorted(VOICES_DIR.glob("*")):
        if file_path.is_file() and file_path.suffix.lower() in valid_extensions:
            file_stat = file_path.stat()
            voices.append({
                "filename": file_path.name,
                "name": file_path.stem.replace("_", " ").title(),
                "size_kb": round(file_stat.st_size / 1024, 1),
                "extension": file_path.suffix.lower()
            })
            
    return {"voices": voices, "count": len(voices)}


@app.get("/api/voices/{filename}", summary="Reproducir voz de referencia")
async def get_voice_audio(filename: str):
    """Permite reproducir y previsualizar una muestra de voz existente."""
    safe_filename = Path(filename).name
    voice_path = VOICES_DIR / safe_filename
    
    if not voice_path.exists() or not voice_path.is_file():
        raise HTTPException(status_code=404, detail="La voz especificada no existe.")
        
    media_type = "audio/wav"
    if voice_path.suffix.lower() == ".mp3":
        media_type = "audio/mpeg"
    elif voice_path.suffix.lower() == ".ogg":
        media_type = "audio/ogg"
        
    return FileResponse(path=voice_path, media_type=media_type, filename=safe_filename)


@app.post("/api/voices/upload", summary="Subir nueva muestra de voz a la biblioteca")
async def upload_voice(
    file: UploadFile = File(...),
    custom_name: Optional[str] = Form(None)
):
    """Guarda un archivo de audio directamente en voices/ con nombre amigable."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Archivo inválido.")
        
    extension = Path(file.filename).suffix.lower()
    if extension not in {".wav", ".mp3", ".flac", ".ogg", ".m4a"}:
        raise HTTPException(status_code=400, detail="Formato no soportado. Usa WAV, MP3 u OGG.")
        
    if custom_name and custom_name.strip():
        safe_custom = "".join(c for c in custom_name.strip() if c.isalnum() or c in (" ", "_", "-")).strip().replace(" ", "_")
        clean_name = f"{safe_custom}{extension}"
    else:
        clean_name = Path(file.filename).name.replace(" ", "_")
        
    target_path = VOICES_DIR / clean_name
    
    try:
        with open(target_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        logger.info(f"Voz guardada en biblioteca: {clean_name}")
        return {
            "message": "Voz guardada exitosamente.",
            "filename": clean_name,
            "name": target_path.stem.replace("_", " ").title()
        }
    except Exception as e:
        logger.error(f"Error al guardar voz: {e}")
        raise HTTPException(status_code=500, detail=f"No se pudo guardar el archivo: {e}")


def synthesize_qwen_task(model, ref_audio: str, text: str, output_path: str, ref_text: str = "", language: str = "es"):
    """Ejecuta inferencia con Qwen3-TTS Base con protección de final de frase."""
    text = text.strip()
    if not text.endswith(('.', '!', '?', '...', '…')):
        text = text + "."

    lang_param = "Spanish" if str(language).lower().startswith("es") or "ar" in str(language).lower() else "English"
    has_ref_text = bool(ref_text and ref_text.strip())
    use_xvector = not has_ref_text

    try:
        audio_output = model.generate_voice_clone(
            text=text,
            ref_audio=ref_audio,
            ref_text=ref_text.strip() if has_ref_text else None,
            x_vector_only_mode=use_xvector,
            language=lang_param
        )
    except Exception:
        try:
            prompt_items = model.create_voice_clone_prompt(
                ref_audio=ref_audio,
                ref_text=ref_text.strip() if has_ref_text else None,
                x_vector_only_mode=use_xvector
            )
            audio_output = model.generate_voice_clone(
                text=text,
                language=lang_param,
                voice_clone_prompt=prompt_items
            )
        except Exception:
            audio_output = model.generate_voice_clone(
                text=text,
                ref_audio=ref_audio,
                ref_text=ref_text.strip() if has_ref_text else None
            )

    if isinstance(audio_output, tuple) and len(audio_output) == 2:
        wavs, sr = audio_output
        if isinstance(wavs, (list, tuple)) and len(wavs) > 0:
            audio_data = wavs[0]
        else:
            audio_data = wavs
    elif isinstance(audio_output, (list, tuple)) and len(audio_output) > 0:
        audio_data = audio_output[0]
        sr = 24000
    else:
        audio_data = audio_output
        sr = 24000

    if hasattr(audio_data, "cpu"):
        audio_data = audio_data.cpu().numpy()
    import numpy as np
    audio_data = np.asarray(audio_data, dtype=np.float32).squeeze()
    
    # Agregar 0.25 segundos de silencio al final para que nunca se corte la cola de la última palabra
    pad_samples = int(int(sr) * 0.25)
    audio_data = np.pad(audio_data, (0, pad_samples), mode='constant')
    
    sf.write(output_path, audio_data, int(sr))


def synthesize_f5_task(model, ref_audio: str, text: str, output_path: str, ref_text: str = ""):
    """Ejecuta inferencia F5-TTS en un hilo de trabajo separado."""
    try:
        res = model.infer(
            ref_file=ref_audio,
            ref_text=ref_text or "",
            gen_text=text
        )
    except TypeError:
        try:
            res = model.infer(
                ref_audio=ref_audio,
                ref_text=ref_text or "",
                gen_text=text
            )
        except TypeError:
            res = model.infer(ref_audio, ref_text or "", text)
            
    if isinstance(res, (tuple, list)):
        audio_data = res[0]
        sample_rate = res[1]
    else:
        audio_data, sample_rate = res
        
    sf.write(output_path, audio_data, sample_rate)


def synthesize_xtts_task(model, ref_audio: str, text: str, language: str, output_path: str):
    """Ejecuta inferencia XTTS-v2 con padding de seguridad final."""
    if not text.endswith(('.', '!', '?', '...', '…')):
        text = text + "."
    model.tts_to_file(
        text=text,
        speaker_wav=ref_audio,
        language=language,
        file_path=output_path
    )
    try:
        data, sr = sf.read(output_path)
        import numpy as np
        pad_samples = int(sr * 0.2)
        data = np.pad(data, (0, pad_samples), mode='constant')
        sf.write(output_path, data, sr)
    except Exception:
        pass


@app.post("/api/tts", summary="Generar audio con Qwen3-TTS, XTTS, Edge o F5")
async def text_to_speech(
    text: str = Form(..., description="Texto a sintetizar"),
    engine: str = Form("qwen", description="Motor TTS: 'qwen', 'xtts', 'edge', 'f5'"),
    language: str = Form("es", description="Idioma"),
    ref_text: Optional[str] = Form("", description="Transcripción opcional del audio de referencia"),
    voice_name: Optional[str] = Form(None, description="Nombre de archivo en voices/"),
    voice_file: Optional[UploadFile] = File(None, description="Audio subido al vuelo"),
    save_voice: Optional[bool] = Form(False, description="Guardar en biblioteca voices/"),
    custom_voice_name: Optional[str] = Form(None, description="Nombre personalizado para la voz guardada")
):
    """Sintetiza texto clonando la voz con F5-TTS (Flow Matching) o Coqui XTTS-v2."""
    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="El texto a sintetizar no puede estar vacío.")

    # Asegurar puntuación final para que la IA complete la fonética de la última palabra
    if not text.endswith(('.', '!', '?', '...', '…')):
        text = text + "."

    temp_speaker_path = None
    speaker_wav_path = None

    try:
        if voice_file is not None and voice_file.filename:
            ext = Path(voice_file.filename).suffix.lower() or ".wav"
            file_id = f"speaker_{uuid.uuid4().hex[:8]}{ext}"
            
            if save_voice:
                if custom_voice_name and custom_voice_name.strip():
                    safe_custom = "".join(c for c in custom_voice_name.strip() if c.isalnum() or c in (" ", "_", "-")).strip().replace(" ", "_")
                    clean_name = f"{safe_custom}{ext}"
                else:
                    clean_name = Path(voice_file.filename).name.replace(" ", "_")
                speaker_wav_path = str(VOICES_DIR / clean_name)
            else:
                temp_speaker_path = OUTPUTS_DIR / file_id
                speaker_wav_path = str(temp_speaker_path)
                
            with open(speaker_wav_path, "wb") as buffer:
                shutil.copyfileobj(voice_file.file, buffer)
                
        elif voice_name:
            safe_voice = Path(voice_name).name
            candidate_path = VOICES_DIR / safe_voice
            if not candidate_path.exists():
                raise HTTPException(status_code=404, detail=f"Voz '{safe_voice}' no encontrada.")
            speaker_wav_path = str(candidate_path)
        else:
            raise HTTPException(status_code=400, detail="Debes seleccionar o subir una voz de referencia.")

        output_filename = f"tts_{uuid.uuid4().hex[:12]}.wav"
        output_path = str(OUTPUTS_DIR / output_filename)

        start_time = time.time()
        if "qwen" in engine.lower() or engine.lower() in ("0.6b", "1.7b"):
            is_17b = "1.7" in engine.lower()
            engine_label = "Qwen3-TTS 1.7B Pro" if is_17b else "Qwen3-TTS 0.6B"
            variant_key = "1.7b" if is_17b else "0.6b"
            current_model = qwen_17b_model if is_17b else qwen_06b_model
            model = current_model or await run_in_threadpool(load_qwen_model, variant=variant_key)
            if model is None:
                raise HTTPException(
                    status_code=500,
                    detail=f"Qwen3-TTS {variant_key} no pudo inicializarse en GPU."
                )
            logger.info(f"🎙️ Generando con {engine_label} en GPU (Español SOTA)...")
            await run_in_threadpool(
                synthesize_qwen_task,
                model=model,
                ref_audio=speaker_wav_path,
                text=text,
                output_path=output_path,
                ref_text=ref_text or "",
                language=language
            )

        elif engine.lower() == "edge":
            engine_label = "Edge-TTS Neural"
            edge_voice = "es-AR-TomasNeural"
            if "mx" in language.lower():
                edge_voice = "es-MX-JorgeNeural"
            elif "es-es" in language.lower() or "spain" in language.lower():
                edge_voice = "es-ES-AlvaroNeural"
            elif "elena" in language.lower() or "fem" in language.lower():
                edge_voice = "es-AR-ElenaNeural"
            elif "dalia" in language.lower():
                edge_voice = "es-MX-DaliaNeural"
                
            logger.info(f"🎙️ Generando con Microsoft Edge-TTS ({edge_voice})...")
            try:
                import edge_tts
            except ImportError:
                raise HTTPException(status_code=500, detail="edge-tts no está instalado. Ejecuta: pip install edge-tts")
            communicate = edge_tts.Communicate(text, edge_voice)
            await communicate.save(output_path)

        elif engine.lower() == "xtts":
            engine_label = "Coqui XTTS-v2"
            model = xtts_model or await run_in_threadpool(load_xtts_model)
            if model is None:
                raise HTTPException(
                    status_code=500,
                    detail="Coqui TTS no está instalado en el contenedor. Ejecuta: pip install TTS"
                )
            logger.info(f"🎙️ Generando con XTTS-v2 en Español...")
            await run_in_threadpool(
                synthesize_xtts_task,
                model=model,
                ref_audio=speaker_wav_path,
                text=text,
                language="es" if language not in ("es", "en", "fr", "de", "it", "pt") else language,
                output_path=output_path
            )
        else:
            # F5-TTS (Por defecto)
            model = f5_model or await run_in_threadpool(load_f5_model)
            logger.info(f"🎙️ Generando con F5-TTS (Flow Matching)...")
            await run_in_threadpool(
                synthesize_f5_task,
                model=model,
                ref_audio=speaker_wav_path,
                text=text,
                output_path=output_path,
                ref_text=ref_text or ""
            )

        elapsed_time = round(time.time() - start_time, 2)
        logger.info(f"✨ Audio generado en {elapsed_time}s con {engine_label} -> {output_filename}")

        return FileResponse(
            path=output_path,
            media_type="audio/wav",
            filename="speech_cloned.wav",
            headers={
                "X-Inference-Time": f"{elapsed_time}s",
                "X-Device": device_name,
                "X-Engine": engine_label,
                "X-Generated-Filename": output_filename
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ Error durante síntesis: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error en la generación: {str(e)}")
    finally:
        if temp_speaker_path and temp_speaker_path.exists():
            try:
                temp_speaker_path.unlink()
            except Exception:
                pass


@app.delete("/api/voices/{filename}", summary="Eliminar una muestra de voz")
async def delete_voice(filename: str):
    """Elimina una muestra de audio de la carpeta voices/."""
    safe_filename = Path(filename).name
    target_path = VOICES_DIR / safe_filename
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="La voz especificada no existe.")
    try:
        target_path.unlink()
        return {"message": f"Voz '{safe_filename}' eliminada correctamente."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudo eliminar: {e}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 29783))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
