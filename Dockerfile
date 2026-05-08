# syntax=docker/dockerfile:1.4
FROM python:3.11-slim

# ffmpeg para faster-whisper (decode de audio del cliente)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cachear deps (capa separada para builds rapidos)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Pre-descargar modelo Whisper para que la primera transcripcion no espere
ARG WHISPER_PRELOAD=tiny
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_PRELOAD}', device='cpu', compute_type='int8')"

# Copiar el resto del codigo
COPY . .

# Puerto: respeta $PORT inyectado (Render) o usa 7860 default (local)
ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "python -m uvicorn api:app --host 0.0.0.0 --port ${PORT:-7860} --proxy-headers"]
