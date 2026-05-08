# syntax=docker/dockerfile:1.4
FROM python:3.11-slim

# Dependencias del sistema (ffmpeg para faster-whisper, build-essential por si acaso)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cachear deps Python (capa separada del codigo para builds rapidos)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Pre-descargar modelo Whisper base para que la primera transcripcion no espere
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"

# Copiar el resto del codigo
COPY . .

# Sembrar datos demo (idempotente; usuarios y citas ficticias)
RUN python seed_data.py

# Puerto: respeta $PORT inyectado (Render, Railway) o usa 7860 default (HF Spaces)
ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "python -m uvicorn api:app --host 0.0.0.0 --port ${PORT:-7860} --proxy-headers"]
