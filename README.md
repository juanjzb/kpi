---
title: BACCITA Sistema de Citas
emoji: 📅
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Sistema bancario de citas con voz para personas no videntes
---

# BACCITA

Sistema de agendamiento de citas bancarias con interfaz por voz, dictado en español, y dashboard de KPIs. Diseñado pensando en accesibilidad para personas no videntes.

## Portales

| Ruta | Quién |
|---|---|
| `/` | Cliente — agendar cita por voz o formulario, "Mi cuenta" con historial, cancelaciones, encuestas de satisfacción |
| `/worker/` | Trabajador — login, dashboard con citas del día, marcar atendidas/no atendidas, observaciones, KPIs propios |
| `/admin/` | Administrador — KPIs globales, comparativo de trabajadores, CRUD de áreas/servicios/trabajadores, configuración de umbrales |

## Credenciales demo (incluidas en seed)

| Rol | Usuario | Contraseña |
|---|---|---|
| Admin | `admin` | `admin1234` |
| Trabajador | `ana` (o `jubelkys`/`adriana`/`eddy`/`stefany`/`badner`) | `3333` (`1111`/`2222`/`4444`/`5555`/`9999`) |
| Cliente con datos | `cliente9` (1 al 15) | `demo1234` |

Login acepta también la cédula como alias del usuario.

## Stack técnico

- **FastAPI** + **uvicorn** — backend async
- **SQLite** + **bcrypt** — DB y auth con sesiones por cookie
- **faster-whisper** (modelo `base` int8, CPU) — transcripción local
- **Groq** + **Llama 3.3 70B** — extracción flexible de campos por LLM
- **Web Speech API** + **MediaRecorder** + **VAD propio** — voz en cliente
- **Chart.js** — gráficos del dashboard admin
- **Vanilla JS** sin frameworks ni build step

## Funcionalidades de voz

- TTS narra cada paso (todos los navegadores)
- STT en Chrome desktop/Android via Web Speech API
- iOS/Firefox: MediaRecorder → server-side Whisper con VAD del cliente (hands-free después del gesto inicial)
- Cédula nicaragüense con máscara, lectura por pares, "triple cero", "doble cero", "cuatro ceros"
- Hora 12h con AM/PM, fecha en lenguaje natural ("el quince de mayo")
- Confirmación punto a punto antes de enviar

## KPIs evaluados

Configurables en `/admin/` → Configuración:

- Cumplimiento de citas (default ≥ 95 %)
- Cancelación (default ≤ 5 %)
- Satisfacción del cliente (default ≥ 95 %)
- Tiempo de espera promedio (default ≤ 8 min)
- Duración promedio + % en rango aceptable (default 30 ± 5 min)
- Citas gestionadas

Dashboard admin con tendencia de 7/15/30 días y comparativo por trabajador.

## Reglas de negocio

- **Domingos cerrados** — no se aceptan citas
- **Sábados** — solo hasta 11:30 AM
- Días laborales 8:00 a 17:00 en bloques de 35 minutos
- Asignación automática del trabajador por área del servicio (round-robin con balance)
- Trabajador `Badner Mendiola` reservado para clientes con accesibilidad

## Configuración

Variables de entorno (Hugging Face Spaces: pegar como **Secrets**):

```
GROQ_API_KEY=tu_key_de_groq    (obligatorio para extracción LLM, sin esto solo parsers locales)
GROQ_MODEL=llama-3.3-70b-versatile   (opcional, este es el default)
WHISPER_MODEL=base   (opcional; tiny/base/small/medium)
```

Conseguí tu key gratis en https://console.groq.com/keys

## Persistencia

**En este Space (free)**: la base SQLite es ephemeral. Los datos creados durante el uso se preservan mientras el container esté vivo, pero **se reinician al rebuild del Space** y vuelve al estado seed.

Para persistencia real, las opciones son:
- **Hugging Face Persistent Storage** (paga, $5/mes 50 GB)
- **Turso** (libSQL en la nube, free tier generoso, drop-in para SQLite — agregar `libsql-experimental` y modificar `storage.get_db()`)
- **Supabase Postgres** (free 500 MB, requiere migrar SQL)

## Correr en local (Windows)

```
git clone <este-repo>
cd baccita
# editar .env y poner GROQ_API_KEY
start.bat
```

`start.bat` instala dependencias la primera vez (~5 min), descarga el modelo Whisper, arranca uvicorn y abre un Cloudflare Tunnel para HTTPS público. Las URLs aparecen en el banner.

## Correr en Docker (cualquier OS)

```
docker build -t baccita .
docker run -p 8000:7860 -e GROQ_API_KEY=$GROQ_API_KEY baccita
```

Acceder en `http://localhost:8000/`.

## Deploy en Hugging Face Spaces

1. Cuenta gratis en https://huggingface.co/join
2. **New Space** → SDK `Docker` → nombre `baccita` (o el que quieras)
3. Push del repo:
   ```
   git remote add space https://huggingface.co/spaces/TU_USUARIO/baccita
   git push space main
   ```
4. **Settings → Variables and secrets** → **New secret**:
   - Name: `GROQ_API_KEY`
   - Value: tu key de Groq
5. Esperar build (~10-15 min: instala deps + descarga Whisper + corre seed)
6. Abrir `https://huggingface.co/spaces/TU_USUARIO/baccita`

## Licencia

MIT
