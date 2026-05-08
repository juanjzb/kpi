# BACCITA

Sistema de agendamiento de citas bancarias con interfaz por voz, dictado en español, y dashboard de KPIs. Diseñado pensando en accesibilidad para personas no videntes.

## Portales

| Ruta | Quién |
|---|---|
| `/` | Cliente — agendar cita por voz o formulario, "Mi cuenta" con historial, cancelaciones, encuestas de satisfacción |
| `/worker/` | Trabajador — login, dashboard con citas del día, marcar atendidas/no atendidas, observaciones, KPIs propios |
| `/admin/` | Administrador — KPIs globales, comparativo de trabajadores, CRUD de áreas/servicios/trabajadores, configuración de umbrales |

## Credenciales demo

| Rol | Usuario | Contraseña |
|---|---|---|
| Admin | `admin` | `admin1234` |
| Trabajador | `ana` (o `jubelkys`/`adriana`/`eddy`/`stefany`/`badner`) | `3333` (`1111`/`2222`/`4444`/`5555`/`9999`) |
| Cliente con datos | `cliente9` (1 al 15) | `demo1234` |

Login acepta también la cédula como alias del usuario.

## Stack técnico

- **FastAPI** + **uvicorn** — backend async
- **SQLite local / Turso (libSQL en la nube)** — DB con persistencia opcional
- **bcrypt** — hash de contraseñas + sesiones por cookie
- **faster-whisper** (modelo `tiny` o `base` int8, CPU) — transcripción local
- **Groq** + **Llama 3.3 70B** — extracción flexible de campos por LLM
- **Web Speech API** + **MediaRecorder** + **VAD propio** — voz en cliente
- **Chart.js** — gráficos del dashboard admin
- **Vanilla JS** sin frameworks ni build step

## Variables de entorno

Editá `.env` en local o setea como env vars en producción:

```
GROQ_API_KEY=tu_key_de_groq               # obligatorio para extracción LLM
GROQ_MODEL=llama-3.3-70b-versatile        # opcional, default
WHISPER_MODEL=tiny                        # tiny/base/small (default: base)
TURSO_DATABASE_URL=libsql://xxx.turso.io  # opcional, para persistencia en la nube
TURSO_AUTH_TOKEN=eyJxxxxxxxx              # opcional, junto con la URL
```

Si **TURSO_DATABASE_URL y TURSO_AUTH_TOKEN están seteadas** → la DB es Turso (libSQL en la nube). Si no → SQLite local en `data/baccita.db`.

Conseguí la key de Groq gratis en https://console.groq.com/keys
Conseguí Turso gratis en https://app.turso.tech

## Funcionalidades de voz

- TTS narra cada paso (todos los navegadores)
- STT en Chrome desktop/Android via Web Speech API
- iOS/Firefox: MediaRecorder → server-side Whisper con VAD del cliente
- Cédula nicaragüense con máscara, lectura por pares, "triple cero", "doble cero", "cuatro ceros"
- Hora 12h con AM/PM, fecha en lenguaje natural
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

## Correr en local (Windows)

1. Editar `.env` y poner `GROQ_API_KEY`
2. Doble clic en `start.bat`

`start.bat` instala dependencias la primera vez (~5 min), descarga el modelo Whisper, arranca uvicorn y abre un Cloudflare Tunnel para HTTPS público. Las URLs aparecen en el banner.

Para poblar la DB con datos demo (15 clientes + 547 citas + 232 encuestas):

```
python seed_data.py
```

## Correr en Docker

```
docker build -t baccita .
docker run -p 8000:7860 -e GROQ_API_KEY=$GROQ_API_KEY baccita
```

Acceder en `http://localhost:8000/`.

## Deploy en Render.com (gratis)

1. Push del repo a GitHub
2. Cuenta en https://render.com (sign up con GitHub)
3. **New + → Web Service** → conectar tu repo
4. Plan: **Free** | Runtime: **Docker** (auto-detectado)
5. **Environment Variables**:
   - `GROQ_API_KEY` = tu key
   - `WHISPER_MODEL` = `tiny` (recomendado para 512 MB RAM del free tier)
   - `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` (si querés persistencia)
6. **Create Web Service** → ~10 min de build
7. URL: `https://tu-servicio.onrender.com`

### Mantener despierto (evitar cold start)

Render Free pone el container a dormir tras 15 min sin tráfico. Para evitarlo:

- https://uptimerobot.com — monitor HTTP cada 5 min apuntando a `/api/extract/status`
- Free tier de UptimeRobot soporta 50 monitores

### Persistencia con Turso

Render Free no tiene disco persistente. Sin Turso, los datos creados durante uso se reinician en cada redeploy. Con Turso configurado, persisten para siempre.

Para configurar Turso:

1. Cuenta gratis en https://app.turso.tech
2. **Create Database** → nombre `baccita`
3. SQL Console → pegar el contenido de `turso_schema.sql` (ya generado en este repo)
4. Tokens → **Create Token** → permission Full Access → copiar JWT
5. Connect → copiar Database URL
6. Localmente, exportar las env vars y correr `python seed_data.py` para poblar
7. En Render, agregar las dos env vars y restart

## Conexión con Power BI

5 endpoints REST devuelven JSON plano listo para Power BI / Looker / cualquier BI tool con conector Web:

| Endpoint | Devuelve |
|---|---|
| `GET /api/bi/citas?key=...` | Todas las citas con cliente, trabajador, servicio, estado, duración, satisfacción |
| `GET /api/bi/satisfaction?key=...` | Encuestas con detalle del trabajador atendido |
| `GET /api/bi/workers-summary?key=...&fecha_min=YYYY-MM-DD&fecha_max=YYYY-MM-DD` | KPIs agregados por trabajador (default: últimos 30 días) |
| `GET /api/bi/timeseries-daily?key=...&days=30` | Citas por día con métricas (cumplimiento %, satisfacción %, etc.) |
| `GET /api/bi/areas-summary?key=...` | Citas por área (detectar cuellos de botella) |

### Configuración

1. En Render → **Environment** → agregar variable:
   ```
   BI_API_KEY = <una clave aleatoria, ej: una UUID>
   ```
2. Sin `BI_API_KEY` → endpoints devuelven 503. Con `?key=` incorrecta → 401.

### Power BI Desktop

1. **Inicio → Obtener datos → Web**
2. URL: `https://kpi-huc5.onrender.com/api/bi/citas?key=TU_BI_KEY`
3. **Conectar → A tabla → expandir registros → Cargar**
4. Repetir para los otros endpoints (cada uno se vuelve una tabla)
5. Crear relaciones entre `cita_id`, `trabajador_id`, etc. en el **Modelo**
6. **Guardar como `.pbix`**

### Power BI Service (online, gratis)

1. Desde Desktop: **Publicar → Mi área de trabajo**
2. En app.powerbi.com → tu dataset → **Settings → Scheduled refresh**
3. Configurar frecuencia (hasta 8 veces/día en plan gratis)
4. **NO necesita data gateway** porque la URL es HTTPS pública

Los dashboards online se actualizan automáticamente con los datos más recientes de Turso.

## Licencia

MIT
