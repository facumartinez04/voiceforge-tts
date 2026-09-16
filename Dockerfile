# Imagen base optimizada de PyTorch con soporte CUDA 12.1
FROM pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PORT=29783

WORKDIR /app

# Instalar dependencias del sistema de audio y compilación
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    git \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Instalar librerías de Python
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copiar el código del proyecto
COPY . .

# Asegurar directorios de persistencia
RUN mkdir -p voices outputs templates

EXPOSE 29783

# Comando para iniciar la aplicación en el puerto asignado
CMD ["python", "app.py"]
