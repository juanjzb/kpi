import json
import os
import re
import sys
import tempfile
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, time, date
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import Cookie, Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

import storage

load_dotenv()

CEDULA_RE = re.compile(r"^\d{3}-\d{6}-\d{4}[A-Z]$")

# ---- BI (Power BI / Looker / etc.) ----
BI_API_KEY = os.environ.get("BI_API_KEY", "").strip()


def _check_bi(key: str):
    if not BI_API_KEY:
        raise HTTPException(503, "BI no configurado en el servidor (falta BI_API_KEY)")
    if key != BI_API_KEY:
        raise HTTPException(401, "BI key inválida")


# ---- LLM (Groq) ----
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile").strip() or "llama-3.3-70b-versatile"
_llm_client = None


def get_llm():
    global _llm_client
    if not GROQ_API_KEY:
        return None
    if _llm_client is None:
        from groq import Groq
        _llm_client = Groq(api_key=GROQ_API_KEY)
    return _llm_client


# ---- Whisper ----
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
_whisper_model = None
_whisper_lock = threading.Lock()
_whisper_status = {"loading": False, "ready": False, "error": None}


def _load_whisper():
    global _whisper_model
    with _whisper_lock:
        if _whisper_model is not None:
            return _whisper_model
        _whisper_status["loading"] = True
        try:
            from faster_whisper import WhisperModel
            _whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
            _whisper_status["ready"] = True
        except Exception as e:
            _whisper_status["error"] = str(e)
            raise
        finally:
            _whisper_status["loading"] = False
    return _whisper_model


@asynccontextmanager
async def lifespan(app: FastAPI):
    threading.Thread(
        target=lambda: _load_whisper() if _whisper_model is None else None,
        daemon=True, name="whisper-warmup",
    ).start()
    yield


app = FastAPI(title="BACCITA API", lifespan=lifespan)


# ---- Auth dependencies ----
SESSION_COOKIE = "baccita_session"


def is_https(request: Request) -> bool:
    if request.url.scheme == "https":
        return True
    proto = request.headers.get("x-forwarded-proto", "")
    return "https" in proto.lower()


def set_session_cookie(response: Response, token: str, request: Request):
    response.set_cookie(
        SESSION_COOKIE, token,
        httponly=True,
        samesite="lax",
        secure=is_https(request),
        max_age=86400,
        path="/",
    )


def get_current_user(baccita_session: Optional[str] = Cookie(default=None)) -> Optional[dict]:
    if not baccita_session:
        return None
    return storage.get_session_user(baccita_session)


def require_user(user: Optional[dict] = Depends(get_current_user)) -> dict:
    if not user:
        raise HTTPException(401, "No autenticado")
    return user


def require_role(*roles: str):
    def dep(user: dict = Depends(require_user)) -> dict:
        if user["role"] not in roles:
            raise HTTPException(403, f"Acceso restringido a: {', '.join(roles)}")
        return user
    return dep


def public_user(user: Optional[dict]) -> Optional[dict]:
    if not user:
        return None
    return {k: user[k] for k in ("id", "username", "role", "name", "email", "phone", "cedula", "accesibilidad")}


def public_cita(c: dict) -> dict:
    return c


# ---- Horarios ----
def horarios_disponibles() -> list:
    h = []
    base = datetime.combine(datetime.today(), time(8))
    end = datetime.combine(datetime.today(), time(17))
    t = base
    while t + timedelta(minutes=35) <= end:
        h.append(t.strftime("%H:%M"))
        t += timedelta(minutes=35)
    return h


# ---- Auth endpoints ----
class LoginIn(BaseModel):
    username: str
    password: str


class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=4)
    name: str = Field(min_length=1)
    email: str = ""
    phone: str = ""
    cedula: str = ""
    accesibilidad: bool = False

    @field_validator("cedula")
    @classmethod
    def _cedula_norm(cls, v: str) -> str:
        v = (v or "").strip().upper()
        if v and not CEDULA_RE.match(v):
            raise ValueError("Cédula inválida. Formato esperado: 000-000000-0000L")
        return v


@app.post("/api/auth/register")
def auth_register(req: RegisterIn, response: Response, request: Request):
    if storage.get_user_by_username(req.username):
        raise HTTPException(400, "Usuario ya existe")
    uid = storage.create_user(
        req.username, req.password, "client", req.name,
        email=req.email, phone=req.phone, cedula=req.cedula,
        accesibilidad=req.accesibilidad,
    )
    token = storage.create_session(uid)
    set_session_cookie(response, token, request)
    return {"user": public_user(storage.get_user(uid))}


@app.post("/api/auth/login")
def auth_login(req: LoginIn, response: Response, request: Request):
    user = storage.authenticate(req.username, req.password)
    if not user:
        raise HTTPException(401, "Usuario o contraseña incorrectos")
    token = storage.create_session(user["id"])
    set_session_cookie(response, token, request)
    return {"user": public_user(user)}


@app.post("/api/auth/logout")
def auth_logout(response: Response, baccita_session: Optional[str] = Cookie(default=None)):
    if baccita_session:
        storage.delete_session(baccita_session)
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@app.get("/api/auth/me")
def auth_me(user: Optional[dict] = Depends(get_current_user)):
    return {"user": public_user(user)}


# ---- Areas ----
class AreaIn(BaseModel):
    name: str
    color: str = "#1E4DB7"


@app.get("/api/areas")
def get_areas(active_only: bool = True):
    return storage.list_areas(active_only=active_only)


@app.post("/api/areas")
def post_area(req: AreaIn, _admin: dict = Depends(require_role("admin"))):
    return storage.create_area(req.name.strip(), req.color)


@app.patch("/api/areas/{area_id}")
def patch_area(area_id: int, fields: dict, _admin: dict = Depends(require_role("admin"))):
    allowed = {k: v for k, v in fields.items() if k in {"name", "color", "active"}}
    return storage.update_area(area_id, allowed)


@app.delete("/api/areas/{area_id}")
def del_area(area_id: int, _admin: dict = Depends(require_role("admin"))):
    storage.delete_area(area_id)
    return {"ok": True}


# ---- Services ----
class ServiceIn(BaseModel):
    name: str
    area_id: int


@app.get("/api/services")
def get_services(area_id: Optional[int] = None, active_only: bool = True):
    return storage.list_services(active_only=active_only, area_id=area_id)


@app.get("/api/servicios")
def get_servicios_legacy():
    """Compatibilidad con cliente de voz: devuelve {area_name: [servicio,...]}."""
    services = storage.list_services()
    out: dict = {}
    for s in services:
        out.setdefault(s["area_name"], []).append(s["name"])
    return out


@app.get("/api/horarios")
def get_horarios(fecha: Optional[str] = None):
    slots = horarios_disponibles()
    if fecha:
        try:
            d = date.fromisoformat(fecha)
        except ValueError:
            return slots
        wd = d.weekday()
        if wd == 6:
            return []
        if wd == 5:
            return [s for s in slots if s <= SAT_LAST_SLOT]
    return slots


@app.post("/api/services")
def post_service(req: ServiceIn, _admin: dict = Depends(require_role("admin"))):
    return storage.create_service(req.name.strip(), req.area_id)


@app.patch("/api/services/{service_id}")
def patch_service(service_id: int, fields: dict, _admin: dict = Depends(require_role("admin"))):
    allowed = {k: v for k, v in fields.items() if k in {"name", "area_id", "active"}}
    return storage.update_service(service_id, allowed)


@app.delete("/api/services/{service_id}")
def del_service(service_id: int, _admin: dict = Depends(require_role("admin"))):
    storage.delete_service(service_id)
    return {"ok": True}


# ---- Workers ----
class WorkerCreateIn(BaseModel):
    username: str
    password: str
    name: str
    email: str = ""
    phone: str = ""
    accesibilidad: bool = False
    area_ids: list[int] = []


class WorkerAreasIn(BaseModel):
    area_ids: list[int]


@app.get("/api/workers")
def get_workers(_admin: dict = Depends(require_role("admin"))):
    workers = storage.list_workers()
    for w in workers:
        w["areas"] = storage.list_worker_areas(w["id"])
    return workers


@app.post("/api/workers")
def post_worker(req: WorkerCreateIn, _admin: dict = Depends(require_role("admin"))):
    if storage.get_user_by_username(req.username):
        raise HTTPException(400, "Usuario ya existe")
    uid = storage.create_user(req.username, req.password, "worker", req.name,
                              email=req.email, phone=req.phone,
                              accesibilidad=req.accesibilidad)
    if req.area_ids:
        storage.assign_worker_areas(uid, req.area_ids)
    user = storage.get_user(uid)
    user["areas"] = storage.list_worker_areas(uid)
    return user


@app.patch("/api/workers/{worker_id}")
def patch_worker(worker_id: int, fields: dict, _admin: dict = Depends(require_role("admin"))):
    allowed = {k: v for k, v in fields.items()
               if k in {"name", "email", "phone", "accesibilidad", "active", "password"}}
    if "accesibilidad" in allowed:
        allowed["accesibilidad"] = int(bool(allowed["accesibilidad"]))
    if "active" in allowed:
        allowed["active"] = int(bool(allowed["active"]))
    return storage.update_user(worker_id, allowed)


@app.put("/api/workers/{worker_id}/areas")
def put_worker_areas(worker_id: int, req: WorkerAreasIn, _admin: dict = Depends(require_role("admin"))):
    storage.assign_worker_areas(worker_id, req.area_ids)
    return storage.list_worker_areas(worker_id)


# ---- Citas ----
class CitaIn(BaseModel):
    nombre: str
    cedula: str
    telefono: str = ""
    correo: str = ""
    servicio: str
    subservicio: str
    fecha: str
    hora: str
    accesibilidad: bool = False

    @field_validator("cedula")
    @classmethod
    def _valid_cedula(cls, v: str) -> str:
        v = v.strip().upper()
        if not CEDULA_RE.match(v):
            raise ValueError("Cédula inválida. Formato esperado: 000-000000-0000L")
        return v


def _assign_worker(area_id: int, accesibilidad: bool) -> Optional[int]:
    workers = storage.workers_for_area(area_id)
    if not workers:
        # fallback: cualquier trabajador activo
        workers = storage.list_workers()
    if not workers:
        return None
    if accesibilidad:
        access = [w for w in workers if w.get("accesibilidad")]
        if access:
            return access[0]["id"]
    today = datetime.now().strftime("%Y-%m-%d")
    counts = {}
    for c in storage.list_citas({"fecha": today}):
        if c["worker_id"] in {w["id"] for w in workers}:
            counts[c["worker_id"]] = counts.get(c["worker_id"], 0) + 1
    workers_sorted = sorted(workers, key=lambda w: (counts.get(w["id"], 0), w["id"]))
    return workers_sorted[0]["id"]


@app.get("/api/citas")
def get_citas(
    fecha: Optional[str] = None,
    estado: Optional[str] = None,
    user: Optional[dict] = Depends(get_current_user),
):
    filters: dict = {}
    if fecha:
        filters["fecha"] = fecha
    if estado:
        filters["estado"] = estado
    if user:
        if user["role"] == "client":
            filters["client_id"] = user["id"]
        elif user["role"] == "worker":
            filters["worker_id"] = user["id"]
    return storage.list_citas(filters)


SAT_LAST_SLOT = "11:30"  # sábados: cierre


def _validate_horario(fecha: str, hora: str):
    try:
        d = date.fromisoformat(fecha)
    except ValueError:
        raise HTTPException(400, "Fecha inválida.")
    wd = d.weekday()  # 0=Lun ... 5=Sab, 6=Dom
    if wd == 6:
        raise HTTPException(400, "No se atienden citas los domingos.")
    if wd == 5 and hora > SAT_LAST_SLOT:
        raise HTTPException(400, f"Los sábados solo atendemos hasta las {SAT_LAST_SLOT}.")


@app.post("/api/citas")
def post_cita(req: CitaIn, user: Optional[dict] = Depends(get_current_user)):
    services = storage.list_services()
    service = next((s for s in services if s["area_name"] == req.servicio and s["name"] == req.subservicio), None)
    if not service:
        raise HTTPException(400, "Servicio o subservicio inválido")

    _validate_horario(req.fecha, req.hora)

    accesibilidad = req.accesibilidad or (user["accesibilidad"] if user else False)
    worker_id = _assign_worker(service["area_id"], bool(accesibilidad))
    cita = storage.create_cita({
        "client_id": user["id"] if user and user["role"] == "client" else None,
        "cliente_nombre": req.nombre.strip(),
        "cliente_cedula": req.cedula.strip(),
        "cliente_telefono": req.telefono.strip(),
        "cliente_correo": req.correo.strip(),
        "accesibilidad": bool(accesibilidad),
        "worker_id": worker_id,
        "service_id": service["id"],
        "servicio_nombre": req.servicio,
        "subservicio_nombre": req.subservicio,
        "fecha": req.fecha,
        "hora": req.hora,
    })
    out = dict(cita)
    out["trabajador"] = cita.get("worker_name", "")
    out["servicio"] = cita["servicio_nombre"]
    out["subservicio"] = cita["subservicio_nombre"]
    out["cliente"] = cita["cliente_nombre"]
    return out


class CitaUpdateIn(BaseModel):
    estado: Optional[str] = None
    motivo_no_atencion: Optional[str] = None
    observaciones: Optional[str] = None
    inicio: Optional[str] = None
    fin: Optional[str] = None


@app.patch("/api/citas/{cita_id}")
def patch_cita(cita_id: str, req: CitaUpdateIn, user: dict = Depends(require_user)):
    cita = storage.get_cita(cita_id)
    if not cita:
        raise HTTPException(404, "Cita no encontrada")

    fields: dict = {}
    if user["role"] == "client":
        if cita["client_id"] != user["id"]:
            raise HTTPException(403, "No es su cita")
        if req.estado not in (None, "cancelada"):
            raise HTTPException(403, "Cliente solo puede cancelar")
        if req.estado == "cancelada":
            fields["estado"] = "cancelada"
    elif user["role"] in ("worker", "admin"):
        if user["role"] == "worker" and cita["worker_id"] != user["id"]:
            raise HTTPException(403, "No es su cita asignada")
        if req.estado in {"pendiente", "en_proceso", "atendida", "no_atendida", "cancelada"}:
            fields["estado"] = req.estado
            if req.estado == "en_proceso":
                fields["inicio"] = req.inicio or datetime.now().isoformat()
            elif req.estado in ("atendida", "no_atendida"):
                fields["fin"] = req.fin or datetime.now().isoformat()
                if cita.get("inicio") and not cita.get("duracion"):
                    try:
                        ini = datetime.fromisoformat(cita["inicio"])
                        fin = datetime.fromisoformat(fields["fin"])
                        fields["duracion"] = (fin - ini).total_seconds() / 60
                    except Exception:
                        pass
        if req.observaciones is not None:
            fields["observaciones"] = req.observaciones
        if req.motivo_no_atencion is not None:
            fields["motivo_no_atencion"] = req.motivo_no_atencion

    if not fields:
        return cita
    return storage.update_cita(cita_id, fields)


# ---- Settings ----
@app.get("/api/settings")
def get_settings():
    return storage.get_all_settings()


class SettingIn(BaseModel):
    value: str


@app.patch("/api/settings/{key}")
def patch_setting(key: str, req: SettingIn, _admin: dict = Depends(require_role("admin"))):
    storage.set_setting(key, req.value)
    return {"key": key, "value": req.value}


# ---- Satisfacción ----
class SatisfactionIn(BaseModel):
    respuestas: list[bool]
    comentario: str = ""


@app.post("/api/citas/{cita_id}/satisfaction")
def post_satisfaction(cita_id: str, req: SatisfactionIn, user: dict = Depends(require_user)):
    cita = storage.get_cita(cita_id)
    if not cita:
        raise HTTPException(404, "Cita no encontrada")
    if user["role"] == "client" and cita["client_id"] != user["id"]:
        raise HTTPException(403, "No es su cita")
    if cita["estado"] not in ("atendida", "no_atendida"):
        raise HTTPException(400, "La cita aún no fue atendida")
    if not req.respuestas:
        raise HTTPException(400, "Sin respuestas")
    puntaje = sum(1 for r in req.respuestas if r) / len(req.respuestas) * 100
    storage.submit_satisfaction(cita_id, puntaje, req.comentario, req.respuestas)
    return {"cita_id": cita_id, "puntaje": puntaje}


@app.get("/api/citas/{cita_id}/satisfaction")
def get_satisfaction(cita_id: str, user: dict = Depends(require_user)):
    return storage.get_satisfaction(cita_id) or {}


# ---- KPIs ----
def _to_float(v: str, default: float) -> float:
    try:
        return float(v)
    except Exception:
        return default


def _kpi_for(citas: list, settings: dict) -> dict:
    aceptable = _to_float(settings.get("tiempo_aceptable_min", "30"), 30)
    tolerancia = _to_float(settings.get("tiempo_aceptable_tolerancia_min", "5"), 5)
    minimo = _to_float(settings.get("tiempo_minimo_min", "5"), 5)

    total = len(citas)
    atendidas = [c for c in citas if c["estado"] == "atendida"]
    no_atendidas = [c for c in citas if c["estado"] == "no_atendida"]
    canceladas = [c for c in citas if c["estado"] == "cancelada"]
    en_proceso = [c for c in citas if c["estado"] == "en_proceso"]
    pendientes = [c for c in citas if c["estado"] == "pendiente"]

    cumplimiento = (len(atendidas) / total * 100) if total else 0.0
    cancelacion = (len(canceladas) / total * 100) if total else 0.0

    durations = [c["duracion"] for c in atendidas if c.get("duracion")]
    duracion_promedio = sum(durations) / len(durations) if durations else 0.0
    en_rango = [d for d in durations if abs(d - aceptable) <= tolerancia]
    tiempo_aceptable_pct = (len(en_rango) / len(durations) * 100) if durations else 0.0

    sats = []
    for c in atendidas:
        s = storage.get_satisfaction(c["id"])
        if s:
            sats.append(s["puntaje"])
    satisfaccion = sum(sats) / len(sats) if sats else 0.0

    waits = []
    for c in atendidas:
        if not c.get("inicio") or not c.get("fecha") or not c.get("hora"):
            continue
        try:
            programada = datetime.fromisoformat(f"{c['fecha']}T{c['hora']}:00")
            inicio = datetime.fromisoformat(c["inicio"])
            w = (inicio - programada).total_seconds() / 60
            if w >= 0:
                waits.append(w)
        except Exception:
            pass
    tiempo_espera_promedio = sum(waits) / len(waits) if waits else 0.0

    return {
        "total": total,
        "atendidas": len(atendidas),
        "no_atendidas": len(no_atendidas),
        "canceladas": len(canceladas),
        "en_proceso": len(en_proceso),
        "pendientes": len(pendientes),
        "cumplimiento_pct": round(cumplimiento, 1),
        "cancelacion_pct": round(cancelacion, 1),
        "duracion_promedio_min": round(duracion_promedio, 1),
        "tiempo_aceptable_pct": round(tiempo_aceptable_pct, 1),
        "satisfaccion_pct": round(satisfaccion, 1),
        "tiempo_espera_promedio_min": round(tiempo_espera_promedio, 1),
        "umbral_tiempo_aceptable": aceptable,
        "umbral_tolerancia": tolerancia,
    }


@app.get("/api/kpis")
def get_kpis(
    fecha: Optional[str] = None,
    fecha_min: Optional[str] = None,
    fecha_max: Optional[str] = None,
    worker_id: Optional[int] = None,
    user: dict = Depends(require_user),
):
    filters: dict = {}
    if fecha:
        filters["fecha"] = fecha
    if fecha_min:
        filters["fecha_min"] = fecha_min
    if fecha_max:
        filters["fecha_max"] = fecha_max
    if user["role"] == "worker":
        filters["worker_id"] = user["id"]
    elif worker_id is not None and user["role"] == "admin":
        filters["worker_id"] = worker_id

    citas = storage.list_citas(filters)
    settings = storage.get_all_settings()
    return _kpi_for(citas, settings)


@app.get("/api/kpis/timeseries")
def get_kpis_timeseries(days: int = 7, _admin: dict = Depends(require_role("admin"))):
    days = max(1, min(60, days))
    today = date.today()
    settings = storage.get_all_settings()
    out = []
    for i in range(days - 1, -1, -1):
        d = today - timedelta(days=i)
        fecha_str = d.isoformat()
        citas = storage.list_citas({"fecha": fecha_str})
        kpi = _kpi_for(citas, settings)
        kpi["fecha"] = fecha_str
        out.append(kpi)
    return out


@app.get("/api/kpis/distribution")
def get_kpis_distribution(
    days: int = 7,
    _admin: dict = Depends(require_role("admin")),
):
    days = max(1, min(60, days))
    today = date.today()
    fecha_min = (today - timedelta(days=days - 1)).isoformat()
    fecha_max = today.isoformat()
    citas = storage.list_citas({"fecha_min": fecha_min, "fecha_max": fecha_max})

    by_state: dict = {}
    by_area: dict = {}
    by_worker: dict = {}
    by_dow: dict = {0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0}
    for c in citas:
        by_state[c["estado"]] = by_state.get(c["estado"], 0) + 1
        by_area[c["servicio_nombre"]] = by_area.get(c["servicio_nombre"], 0) + 1
        wname = c.get("worker_name") or "Sin asignar"
        by_worker[wname] = by_worker.get(wname, 0) + 1
        try:
            d = date.fromisoformat(c["fecha"])
            by_dow[d.weekday()] = by_dow.get(d.weekday(), 0) + 1
        except Exception:
            pass

    return {
        "by_state": by_state,
        "by_area": by_area,
        "by_worker": by_worker,
        "by_dow": by_dow,
        "fecha_min": fecha_min,
        "fecha_max": fecha_max,
        "total": len(citas),
    }


@app.get("/api/kpis/workers")
def get_kpis_workers(
    fecha: Optional[str] = None,
    fecha_min: Optional[str] = None,
    fecha_max: Optional[str] = None,
    _admin: dict = Depends(require_role("admin")),
):
    settings = storage.get_all_settings()
    workers = storage.list_workers()
    out = []
    for w in workers:
        f: dict = {"worker_id": w["id"]}
        if fecha:
            f["fecha"] = fecha
        if fecha_min:
            f["fecha_min"] = fecha_min
        if fecha_max:
            f["fecha_max"] = fecha_max
        citas = storage.list_citas(f)
        kpi = _kpi_for(citas, settings)
        out.append({"worker": w, "kpi": kpi})
    return out


# ---- Transcribe (igual que antes) ----
@app.get("/api/transcribe/status")
def transcribe_status():
    return {
        "model": WHISPER_MODEL_SIZE,
        "loading": _whisper_status["loading"],
        "ready": _whisper_status["ready"],
        "error": _whisper_status["error"],
    }


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    if not _whisper_status["ready"] and not _whisper_status["loading"]:
        threading.Thread(target=_load_whisper, daemon=True).start()
    try:
        model = _load_whisper()
    except Exception as e:
        raise HTTPException(503, f"Modelo de voz no disponible: {e}")

    suffix = os.path.splitext(audio.filename or "audio.webm")[1] or ".webm"
    data = await audio.read()
    if not data:
        raise HTTPException(400, "Audio vacío")

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        segments, _info = model.transcribe(
            tmp_path, language="es", beam_size=1, vad_filter=False,
            condition_on_previous_text=False, without_timestamps=True,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        return {"transcript": text}
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ---- Extract (Groq) ----
PROMPT_TEMPLATES = {
    "nombre": (
        "Extrae el nombre completo de la persona del siguiente texto en español. "
        'Devuelve solo JSON con la forma {{"value": "Nombre Apellido"}} o {{"value": null}}.\n'
        'Texto: "{transcript}"'
    ),
    "cedula": (
        "Extrae una cédula nicaragüense del siguiente texto en español. "
        "Formato exacto: 3 dígitos, guión, 6 dígitos, guión, 4 dígitos, una letra mayúscula "
        "(ej: 161-120586-0002L). "
        "Reglas: dígitos como palabras (cero, uno, ...), pares (treinta y uno = 31), "
        "'doble X' = XX, 'triple X' = XXX, 'cuádruple X' = XXXX, 'N ceros' = N veces 0. "
        "Letra final: a→A, be→B, ce→C, de→D, e→E, efe→F, ge→G, hache→H, i→I, jota→J, ka→K, "
        "ELE→L (ele=L NUNCA E), eme→M, ene→N, eñe→Ñ, o→O, pe→P, cu→Q, ere→R, erre→R, "
        "ese→S, te→T, u→U, uve→V, equis→X, ye→Y, zeta→Z. "
        'Si no es válida devuelve null. JSON: {{"value": "161-120586-0002L"}} o {{"value": null}}.\n'
        'Texto: "{transcript}"'
    ),
    "telefono": (
        "Extrae 8 dígitos del texto (teléfono nicaragüense). Sin espacios ni guiones. "
        'Si no hay 8 dígitos claros devuelve null. JSON: {{"value": "88881234"}} o {{"value": null}}.\n'
        'Texto: "{transcript}"'
    ),
    "servicio": (
        "Identifica el servicio de esta lista exacta: {options}. "
        'Devuelve EXACTAMENTE uno o null. JSON: {{"value": "Créditos"}} o {{"value": null}}.\n'
        'Texto: "{transcript}"'
    ),
    "subservicio": (
        "Identifica el tipo de servicio de esta lista exacta: {options}. "
        'Devuelve EXACTAMENTE uno o null. JSON: {{"value": "Personal"}} o {{"value": null}}.\n'
        'Texto: "{transcript}"'
    ),
    "fecha": (
        "Hoy es {today}. Extrae la fecha en formato ISO YYYY-MM-DD. "
        'Frases: hoy, mañana, pasado mañana, "el quince de mayo", "el próximo lunes". '
        'Si no hay fecha clara null. JSON: {{"value": "2026-04-30"}} o {{"value": null}}.\n'
        'Texto: "{transcript}"'
    ),
    "hora": (
        "Identifica el slot HH:MM más cercano de esta lista exacta (24h): {options}. "
        "El usuario habla en 12h con AM/PM: 'nueve de la mañana'=09:00, 'dos de la tarde'=14:00. "
        "Sin AM/PM: 7-11 mañana, 1-6 tarde. 'y media'=:30, 'y cuarto'=:15. "
        'Devuelve EXACTAMENTE uno de la lista o null. JSON: {{"value": "09:45"}} o {{"value": null}}.\n'
        'Texto: "{transcript}"'
    ),
    "yesno": (
        "¿Sí o no en español? Afirmativos: claro, correcto, perfecto, está bien, ok, exacto. "
        "Negativos: negativo, incorrecto, repetir, cancelar, mal. "
        'JSON: {{"value": "yes"}} o {{"value": "no"}} o {{"value": null}}.\n'
        'Texto: "{transcript}"'
    ),
}


class ExtractIn(BaseModel):
    field: str
    transcript: str
    context: Optional[dict[str, Any]] = None


@app.get("/api/extract/status")
def extract_status():
    return {
        "configured": bool(GROQ_API_KEY),
        "model": GROQ_MODEL if GROQ_API_KEY else None,
        "provider": "groq",
    }


@app.post("/api/extract")
def extract(req: ExtractIn):
    client = get_llm()
    if not client:
        raise HTTPException(503, "LLM no configurado")
    template = PROMPT_TEMPLATES.get(req.field)
    if not template:
        raise HTTPException(400, f"Campo desconocido: {req.field}")
    if not req.transcript or not req.transcript.strip():
        return {"value": None}
    options_list = (req.context or {}).get("options") or []
    prompt = template.format(
        transcript=req.transcript.replace('"', "'"),
        today=datetime.now().strftime("%Y-%m-%d"),
        options=", ".join(repr(o) for o in options_list),
    )
    try:
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=200,
        )
        raw = (response.choices[0].message.content or "").strip()
        data = json.loads(raw)
        if not isinstance(data, dict) or "value" not in data:
            return {"value": None}
        return {"value": data["value"]}
    except json.JSONDecodeError:
        return {"value": None}
    except Exception as e:
        print(f"[groq] {req.field}: {type(e).__name__}: {e}", file=sys.stderr)
        return {"value": None}


# ---- BI endpoints (Power BI, Looker, etc.) ----
# JSON plano sin auth de sesion - usa ?key=<BI_API_KEY> en el query string.

@app.get("/api/bi/citas")
def bi_citas(key: str = ""):
    """Todas las citas con campos planos para tabla pivote."""
    _check_bi(key)
    citas = storage.list_citas()
    out = []
    for c in citas:
        d = c.get("duracion") or 0.0
        out.append({
            "cita_id": c["id"],
            "cliente_id": c["client_id"],
            "cliente_nombre": c["cliente_nombre"],
            "cliente_cedula": c["cliente_cedula"],
            "cliente_telefono": c["cliente_telefono"],
            "cliente_correo": c["cliente_correo"],
            "accesibilidad": bool(c["accesibilidad"]),
            "trabajador_id": c["worker_id"],
            "trabajador_nombre": c.get("worker_name") or "",
            "servicio": c["servicio_nombre"],
            "subservicio": c["subservicio_nombre"] or "",
            "fecha": c["fecha"],
            "hora": c["hora"],
            "fecha_hora": f"{c['fecha']} {c['hora']}",
            "estado": c["estado"],
            "inicio": c.get("inicio"),
            "fin": c.get("fin"),
            "duracion_min": float(d),
            "motivo_no_atencion": c.get("motivo_no_atencion") or "",
            "observaciones": c.get("observaciones") or "",
            "satisfaccion_pct": c.get("satisfaction_puntaje"),
            "tiene_encuesta": bool(c.get("has_satisfaction")),
            "creada": c["created_at"],
        })
    return out


@app.get("/api/bi/satisfaction")
def bi_satisfaction(key: str = ""):
    """Encuestas con detalle del trabajador y servicio."""
    _check_bi(key)
    citas = storage.list_citas()
    out = []
    for c in citas:
        if not c.get("has_satisfaction"):
            continue
        s = storage.get_satisfaction(c["id"]) or {}
        out.append({
            "cita_id": c["id"],
            "fecha": c["fecha"],
            "hora": c["hora"],
            "trabajador_id": c["worker_id"],
            "trabajador_nombre": c.get("worker_name") or "",
            "servicio": c["servicio_nombre"],
            "subservicio": c["subservicio_nombre"] or "",
            "cliente_nombre": c["cliente_nombre"],
            "puntaje_pct": s.get("puntaje"),
            "comentario": s.get("comentario") or "",
            "respuestas": s.get("respuestas") or "",
            "creada": s.get("created_at"),
        })
    return out


@app.get("/api/bi/workers-summary")
def bi_workers_summary(key: str = "",
                       fecha_min: Optional[str] = None,
                       fecha_max: Optional[str] = None):
    """KPIs por trabajador para el rango (default: ultimos 30 dias)."""
    _check_bi(key)
    if not fecha_max:
        fecha_max = date.today().isoformat()
    if not fecha_min:
        fecha_min = (date.today() - timedelta(days=29)).isoformat()
    settings = storage.get_all_settings()
    workers = storage.list_workers()
    out = []
    for w in workers:
        citas = storage.list_citas({
            "worker_id": w["id"],
            "fecha_min": fecha_min,
            "fecha_max": fecha_max,
        })
        kpi = _kpi_for(citas, settings)
        out.append({
            "trabajador_id": w["id"],
            "trabajador_nombre": w["name"],
            "username": w["username"],
            "accesibilidad": bool(w.get("accesibilidad")),
            "fecha_min": fecha_min,
            "fecha_max": fecha_max,
            **kpi,
        })
    return out


@app.get("/api/bi/timeseries-daily")
def bi_timeseries_daily(key: str = "", days: int = 30):
    """Citas por dia con metricas, para line/bar charts en Power BI."""
    _check_bi(key)
    days = max(1, min(180, days))
    today = date.today()
    settings = storage.get_all_settings()
    out = []
    for i in range(days - 1, -1, -1):
        d = today - timedelta(days=i)
        fecha_str = d.isoformat()
        citas = storage.list_citas({"fecha": fecha_str})
        kpi = _kpi_for(citas, settings)
        out.append({
            "fecha": fecha_str,
            "dia_semana": d.strftime("%A"),
            "es_fin_semana": d.weekday() >= 5,
            **kpi,
        })
    return out


@app.get("/api/bi/areas-summary")
def bi_areas_summary(key: str = "",
                     fecha_min: Optional[str] = None,
                     fecha_max: Optional[str] = None):
    """Citas por area para identificar cuellos de botella."""
    _check_bi(key)
    if not fecha_max:
        fecha_max = date.today().isoformat()
    if not fecha_min:
        fecha_min = (date.today() - timedelta(days=29)).isoformat()
    citas = storage.list_citas({"fecha_min": fecha_min, "fecha_max": fecha_max})
    by_area: dict = {}
    for c in citas:
        area = c["servicio_nombre"]
        if area not in by_area:
            by_area[area] = {
                "area": area,
                "total": 0, "atendidas": 0, "canceladas": 0,
                "no_atendidas": 0, "pendientes": 0, "en_proceso": 0,
                "duracion_total_min": 0.0,
            }
        by_area[area]["total"] += 1
        by_area[area][c["estado"] + "s" if c["estado"] != "en_proceso" else "en_proceso"] = \
            by_area[area].get(c["estado"] + "s" if c["estado"] != "en_proceso" else "en_proceso", 0) + 1
        if c["estado"] == "atendida" and c.get("duracion"):
            by_area[area]["duracion_total_min"] += float(c["duracion"])
    return [{**v, "fecha_min": fecha_min, "fecha_max": fecha_max} for v in by_area.values()]


# ---- Static portals ----
ROOT = Path(__file__).parent
WORKER_DIR = ROOT / "worker"
ADMIN_DIR = ROOT / "admin"
CLIENT_DIR = ROOT / "client"

if WORKER_DIR.exists():
    app.mount("/worker", StaticFiles(directory=str(WORKER_DIR), html=True), name="worker")
if ADMIN_DIR.exists():
    app.mount("/admin", StaticFiles(directory=str(ADMIN_DIR), html=True), name="admin")
app.mount("/", StaticFiles(directory=str(CLIENT_DIR), html=True), name="client")
