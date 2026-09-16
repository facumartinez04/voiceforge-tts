# 🎙️ VoiceForge AI - Zero-Shot Voice Cloning & TTS Local

Sistema completo de **Clonación de Voz Instantánea (Zero-Shot Voice Cloning)** y **Text-to-Speech (TTS)** local, privado y 100% gratuito basado en el modelo **Coqui XTTS-v2** y **FastAPI**.

Incluye:
- 🚀 **Backend FastAPI** optimizado con detección automática de GPU NVIDIA (`CUDA`) o fallback suave a `CPU`.
- 🌐 **Web UI integrada** Single-Page moderna con diseño oscuro, selección de voces, subida por Drag & Drop, preview de audio en vivo y reproductor HTML5.
- 📁 **Gestión de biblioteca de voces** en la carpeta `voices/` y soporte para muestras al vuelo.
- 🌍 **Soporte multilingüe**: 17 idiomas soportados (Español, Inglés, Francés, Alemán, Italiano, Portugués, etc.).

---

## 📋 Requisitos Previos

- **Python 3.10 o 3.11** (Recomendado para máxima compatibilidad con Coqui TTS y PyTorch).
- *(Opcional)* GPU NVIDIA con soporte CUDA para generación ultra rápida en tiempo real. Si no dispones de GPU dedicada, funcionará automáticamente en modo CPU.
- **Git** y **Microsoft C++ Build Tools** (en Windows, necesario para compilar ciertas extensiones de audio si no están en wheels).

---

## ⚡ Instalación Rápida

### 1. Clonar o acceder a la carpeta del proyecto

```bash
cd c:\Users\Facu\Documents\Proyectos\CarreraPoints\Tts
```

### 2. Crear y activar el entorno virtual

En **Windows (PowerShell)**:
```powershell
# Usando el lanzador de Python con versión 3.10
py -3.10 -m venv venv

# Activar el entorno virtual
.\venv\Scripts\Activate.ps1
```
*(Si PowerShell bloquea scripts, ejecuta antes: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process`)*

En **Linux / macOS**:
```bash
python3.10 -m venv venv
source venv/bin/activate
```

---

### 3. Instalar PyTorch

#### Opción A: Con Aceleración GPU NVIDIA (CUDA 12.1 - Recomendado)
```bash
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
```

#### Opción B: Modo Solo CPU (sin tarjeta NVIDIA)
```bash
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
```

---

### 4. Instalar el resto de dependencias

```bash
pip install -r requirements.txt
```

> **Nota:** La primera vez que sintetices un audio, Coqui TTS descargará automáticamente los pesos del modelo `xtts_v2` (~1.8 GB). La aceptación de términos de uso está automatizada con `COQUI_TOS_AGREED=1`.

---

## 🚀 Puesta en Marcha

Para iniciar el servidor web y la API:

```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```
o directamente:
```bash
python app.py
```

Abre tu navegador en:
👉 **[http://localhost:8000](http://localhost:8000)**

---

## 📂 Organización de Voces

- La carpeta `voices/` contiene las voces de referencia que aparecerán en el selector de la web UI.
- Puedes arrastrar cualquier archivo de audio `.wav`, `.mp3` u `.ogg` directamente a la carpeta `voices/`.
- Para generar una muestra de prueba sintética inicial:
  ```bash
  python create_sample_voice.py
  ```

### 💡 Consejos para una Clonación de Voz Perfecta
1. **Duración:** Utiliza muestras de entre **3 y 10 segundos**. Muestras muy largas no mejoran el resultado y consumen más memoria.
2. **Claridad:** El audio de referencia no debe tener música de fondo, eco ni ruidos molestos.
3. **Naturalidad:** Una muestra con entonación natural y continua producirá la voz más realista.

---

## 📡 Documentación de la API REST

La documentación Swagger interactiva está disponible en: **`http://localhost:8000/docs`**

### 1. Listar voces disponibles
- **`GET /api/voices`**
```bash
curl -X GET "http://localhost:8000/api/voices"
```
**Respuesta:**
```json
{
  "voices": [
    {
      "filename": "sample_voice.wav",
      "name": "Sample Voice",
      "size_kb": 172.3,
      "extension": ".wav"
    }
  ],
  "count": 1
}
```

### 2. Sintetizar Audio (TTS con Clonación Zero-Shot)
- **`POST /api/tts`** (Formato `multipart/form-data`)

**Parámetros:**
- `text` *(obligatorio)*: Texto a sintetizar.
- `language` *(opcional, default: "es")*: Código de idioma (`es`, `en`, `fr`, `de`, `it`, `pt`, etc.).
- `voice_name` *(opcional)*: Nombre del archivo de voz en la carpeta `voices/` (ej: `sample_voice.wav`).
- `voice_file` *(opcional)*: Archivo de audio nuevo subido al vuelo.
- `save_voice` *(opcional)*: `true` para guardar permanentemente el archivo subido en `voices/`.

**Ejemplo usando una voz existente:**
```bash
curl -X POST "http://localhost:8000/api/tts" \
  -F "text=Hola, este es un audio generado con mi voz clonada localmente." \
  -F "language=es" \
  -F "voice_name=sample_voice.wav" \
  --output resultado.wav
```

**Ejemplo subiendo una muestra de audio nueva al vuelo:**
```bash
curl -X POST "http://localhost:8000/api/tts" \
  -F "text=Hello! This is voice cloning on the fly." \
  -F "language=en" \
  -F "voice_file=@mi_voz.wav" \
  --output resultado.wav
```

### 3. Verificar estado del hardware y modelo
- **`GET /api/health`**
```bash
curl -X GET "http://localhost:8000/api/health"
```
**Respuesta:**
```json
{
  "status": "online",
  "model_loaded": true,
  "device": "cuda",
  "gpu_available": true,
  "gpu_name": "NVIDIA GeForce RTX 3080",
  "supported_languages": { "es": "Español", "en": "English", ... }
}
```

---

## 🛠️ Estructura del Proyecto

```
Tts/
├── app.py                     # Servidor FastAPI y lógica de inferencia XTTS-v2
├── requirements.txt           # Dependencias de Python
├── create_sample_voice.py     # Generador de audio de prueba inicial
├── README.md                  # Manual completo de uso
├── templates/
│   └── index.html             # Interfaz web responsiva en modo oscuro
├── voices/                    # Biblioteca de muestras de referencia (.wav, .mp3)
│   └── sample_voice.wav
└── outputs/                   # Audios sintetizados temporales
```

---

## 🔒 Privacidad y Licencia
Este proyecto se ejecuta **100% en tu máquina local**. Ningún texto ni archivo de audio es enviado a servidores externos o APIs de terceros.
El motor Coqui XTTS-v2 se distribuye bajo la licencia Coqui Public Model License (CPML).
