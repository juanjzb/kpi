"""SQLite storage para BACCITA: usuarios, citas, servicios, áreas, satisfacción, settings, sesiones."""
import json
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import bcrypt

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "baccita.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('client','worker','admin')),
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    cedula TEXT DEFAULT '',
    accesibilidad INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS areas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL DEFAULT '#1E4DB7',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    area_id INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(name, area_id)
);

CREATE TABLE IF NOT EXISTS worker_areas (
    worker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    area_id INTEGER NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    PRIMARY KEY (worker_id, area_id)
);

CREATE TABLE IF NOT EXISTS citas (
    id TEXT PRIMARY KEY,
    client_id INTEGER REFERENCES users(id),
    cliente_nombre TEXT NOT NULL,
    cliente_cedula TEXT NOT NULL DEFAULT '',
    cliente_telefono TEXT DEFAULT '',
    cliente_correo TEXT DEFAULT '',
    accesibilidad INTEGER NOT NULL DEFAULT 0,
    worker_id INTEGER REFERENCES users(id),
    service_id INTEGER REFERENCES services(id),
    servicio_nombre TEXT NOT NULL,
    subservicio_nombre TEXT DEFAULT '',
    fecha TEXT NOT NULL,
    hora TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente'
        CHECK(estado IN ('pendiente','en_proceso','atendida','no_atendida','cancelada')),
    inicio TEXT,
    fin TEXT,
    duracion REAL,
    motivo_no_atencion TEXT,
    observaciones TEXT,
    hora_llegada TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_citas_worker_fecha ON citas(worker_id, fecha);
CREATE INDEX IF NOT EXISTS idx_citas_client ON citas(client_id);
CREATE INDEX IF NOT EXISTS idx_citas_fecha ON citas(fecha);

CREATE TABLE IF NOT EXISTS satisfaction (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cita_id TEXT NOT NULL UNIQUE REFERENCES citas(id) ON DELETE CASCADE,
    puntaje REAL NOT NULL,
    comentario TEXT DEFAULT '',
    respuestas TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
"""

DEFAULT_SETTINGS = {
    "tiempo_aceptable_min": "30",
    "tiempo_aceptable_tolerancia_min": "5",
    "tiempo_minimo_min": "5",
    "tiempo_espera_max_min": "8",
    "satisfaccion_min_pct": "95",
    "cumplimiento_min_pct": "95",
    "cancelacion_max_pct": "5",
}

DEFAULT_AREAS = [
    ("Apertura de cuentas", "#0EA5A4"),
    ("Créditos", "#F59E0B"),
    ("Consultas", "#1E4DB7"),
    ("Asesoría", "#8B5CF6"),
    ("Actualización", "#EF4444"),
]

DEFAULT_SERVICES = {
    "Apertura de cuentas": ["Ahorro", "Corriente", "Empresarial", "Estudiantil"],
    "Créditos": ["Personal", "Hipotecario", "Vehículo", "Empresarial"],
    "Consultas": ["Tarjetas", "Transferencias", "Intereses", "Banca digital"],
    "Asesoría": ["Plan ahorro", "Estado cuenta", "Créditos", "Hipotecas"],
    "Actualización": ["Cambio cuenta", "Clausura"],
}

DEFAULT_WORKERS = [
    ("jubelkys", "1111", "Jubelkys Morales"),
    ("adriana", "2222", "Adriana Navarro"),
    ("ana", "3333", "Ana Sandoval"),
    ("eddy", "4444", "Eddy Cardoza"),
    ("stefany", "5555", "Stefany Matamoros"),
    ("badner", "9999", "Badner Mendiola"),
]


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


# ===== Auth =====
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False


def create_user(username: str, password: str, role: str, name: str,
                email: str = "", phone: str = "", cedula: str = "",
                accesibilidad: bool = False) -> int:
    with get_db() as db:
        cur = db.execute(
            """INSERT INTO users (username, password_hash, role, name, email, phone, cedula, accesibilidad)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (username, hash_password(password), role, name, email, phone, cedula, int(bool(accesibilidad))),
        )
        return cur.lastrowid


def get_user(user_id: int) -> Optional[dict]:
    with get_db() as db:
        r = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        return dict(r) if r else None


def get_user_by_username(username: str) -> Optional[dict]:
    with get_db() as db:
        r = db.execute("SELECT * FROM users WHERE LOWER(username)=LOWER(?)", (username,)).fetchone()
        return dict(r) if r else None


def get_user_by_cedula(cedula: str) -> Optional[dict]:
    with get_db() as db:
        r = db.execute("SELECT * FROM users WHERE cedula=?", (cedula.strip().upper(),)).fetchone()
        return dict(r) if r else None


def authenticate(login: str, password: str) -> Optional[dict]:
    user = get_user_by_username(login) or get_user_by_cedula(login)
    if not user or not user["active"]:
        return None
    if not verify_password(password, user["password_hash"]):
        return None
    return user


def update_user(user_id: int, fields: dict) -> Optional[dict]:
    if not fields:
        return get_user(user_id)
    if "password" in fields:
        fields["password_hash"] = hash_password(fields.pop("password"))
    sets = ", ".join(f"{k}=?" for k in fields.keys())
    params = list(fields.values()) + [user_id]
    with get_db() as db:
        db.execute(f"UPDATE users SET {sets} WHERE id=?", params)
    return get_user(user_id)


# ===== Sessions =====
def create_session(user_id: int, hours: int = 24) -> str:
    token = secrets.token_urlsafe(32)
    expires = (datetime.utcnow() + timedelta(hours=hours)).isoformat() + "Z"
    with get_db() as db:
        db.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
                   (token, user_id, expires))
    return token


def get_session_user(token: Optional[str]) -> Optional[dict]:
    if not token:
        return None
    with get_db() as db:
        r = db.execute(
            """SELECT u.* FROM sessions s
               JOIN users u ON u.id = s.user_id
               WHERE s.id=? AND s.expires_at > datetime('now') AND u.active=1""",
            (token,),
        ).fetchone()
        return dict(r) if r else None


def delete_session(token: str):
    with get_db() as db:
        db.execute("DELETE FROM sessions WHERE id=?", (token,))


# ===== Settings =====
def get_setting(key: str, default: str = "") -> str:
    with get_db() as db:
        r = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return r["value"] if r else default


def get_all_settings() -> dict:
    with get_db() as db:
        rows = db.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}


def set_setting(key: str, value: str):
    with get_db() as db:
        db.execute(
            """INSERT INTO settings (key, value) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
            (key, value),
        )


# ===== Areas / Services =====
def list_areas(active_only: bool = True) -> list:
    sql = "SELECT * FROM areas"
    if active_only:
        sql += " WHERE active=1"
    sql += " ORDER BY name"
    with get_db() as db:
        return [dict(r) for r in db.execute(sql).fetchall()]


def create_area(name: str, color: str = "#1E4DB7") -> dict:
    with get_db() as db:
        cur = db.execute("INSERT INTO areas (name, color) VALUES (?, ?)", (name, color))
        return dict(db.execute("SELECT * FROM areas WHERE id=?", (cur.lastrowid,)).fetchone())


def update_area(area_id: int, fields: dict) -> Optional[dict]:
    if not fields:
        return None
    sets = ", ".join(f"{k}=?" for k in fields.keys())
    params = list(fields.values()) + [area_id]
    with get_db() as db:
        db.execute(f"UPDATE areas SET {sets} WHERE id=?", params)
        r = db.execute("SELECT * FROM areas WHERE id=?", (area_id,)).fetchone()
        return dict(r) if r else None


def delete_area(area_id: int):
    with get_db() as db:
        db.execute("UPDATE areas SET active=0 WHERE id=?", (area_id,))


def list_services(active_only: bool = True, area_id: Optional[int] = None) -> list:
    sql = """SELECT s.*, a.name AS area_name, a.color AS area_color FROM services s
             JOIN areas a ON a.id = s.area_id"""
    where = []
    params = []
    if active_only:
        where.append("s.active=1 AND a.active=1")
    if area_id is not None:
        where.append("s.area_id=?")
        params.append(area_id)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY a.name, s.name"
    with get_db() as db:
        return [dict(r) for r in db.execute(sql, params).fetchall()]


def create_service(name: str, area_id: int) -> dict:
    with get_db() as db:
        cur = db.execute("INSERT INTO services (name, area_id) VALUES (?, ?)", (name, area_id))
        return dict(db.execute(
            "SELECT s.*, a.name AS area_name FROM services s JOIN areas a ON a.id=s.area_id WHERE s.id=?",
            (cur.lastrowid,),
        ).fetchone())


def update_service(service_id: int, fields: dict) -> Optional[dict]:
    if not fields:
        return None
    sets = ", ".join(f"{k}=?" for k in fields.keys())
    params = list(fields.values()) + [service_id]
    with get_db() as db:
        db.execute(f"UPDATE services SET {sets} WHERE id=?", params)
        r = db.execute(
            "SELECT s.*, a.name AS area_name FROM services s JOIN areas a ON a.id=s.area_id WHERE s.id=?",
            (service_id,),
        ).fetchone()
        return dict(r) if r else None


def delete_service(service_id: int):
    with get_db() as db:
        db.execute("UPDATE services SET active=0 WHERE id=?", (service_id,))


# ===== Workers =====
def list_workers(active_only: bool = True) -> list:
    sql = "SELECT id, username, name, email, phone, accesibilidad, active FROM users WHERE role='worker'"
    if active_only:
        sql += " AND active=1"
    sql += " ORDER BY name"
    with get_db() as db:
        return [dict(r) for r in db.execute(sql).fetchall()]


def assign_worker_areas(worker_id: int, area_ids: list):
    with get_db() as db:
        db.execute("DELETE FROM worker_areas WHERE worker_id=?", (worker_id,))
        for aid in area_ids:
            db.execute("INSERT OR IGNORE INTO worker_areas (worker_id, area_id) VALUES (?, ?)",
                       (worker_id, aid))


def list_worker_areas(worker_id: int) -> list:
    with get_db() as db:
        return [dict(r) for r in db.execute(
            "SELECT a.* FROM worker_areas wa JOIN areas a ON a.id=wa.area_id WHERE wa.worker_id=? AND a.active=1",
            (worker_id,),
        ).fetchall()]


def workers_for_area(area_id: int) -> list:
    with get_db() as db:
        return [dict(r) for r in db.execute(
            """SELECT u.id, u.name, u.username, u.accesibilidad FROM worker_areas wa
               JOIN users u ON u.id=wa.worker_id
               WHERE wa.area_id=? AND u.active=1 AND u.role='worker'""",
            (area_id,),
        ).fetchall()]


# ===== Citas =====
def create_cita(data: dict) -> dict:
    cita_id = data.get("id") or uuid.uuid4().hex
    with get_db() as db:
        db.execute(
            """INSERT INTO citas (id, client_id, cliente_nombre, cliente_cedula, cliente_telefono,
                cliente_correo, accesibilidad, worker_id, service_id, servicio_nombre,
                subservicio_nombre, fecha, hora, estado)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                cita_id,
                data.get("client_id"),
                data["cliente_nombre"],
                data.get("cliente_cedula", ""),
                data.get("cliente_telefono", ""),
                data.get("cliente_correo", ""),
                int(bool(data.get("accesibilidad"))),
                data.get("worker_id"),
                data.get("service_id"),
                data["servicio_nombre"],
                data.get("subservicio_nombre", ""),
                data["fecha"],
                data["hora"],
                data.get("estado", "pendiente"),
            ),
        )
    return get_cita(cita_id)


def get_cita(cita_id: str) -> Optional[dict]:
    with get_db() as db:
        r = db.execute(
            """SELECT c.*, u.name AS worker_name, cu.name AS client_full_name
               FROM citas c
               LEFT JOIN users u ON u.id=c.worker_id
               LEFT JOIN users cu ON cu.id=c.client_id
               WHERE c.id=?""",
            (cita_id,),
        ).fetchone()
        return dict(r) if r else None


def list_citas(filters: Optional[dict] = None) -> list:
    filters = filters or {}
    where = []
    params = []
    if "worker_id" in filters:
        where.append("c.worker_id=?")
        params.append(filters["worker_id"])
    if "client_id" in filters:
        where.append("c.client_id=?")
        params.append(filters["client_id"])
    if "fecha" in filters:
        where.append("c.fecha=?")
        params.append(filters["fecha"])
    if "estado" in filters:
        where.append("c.estado=?")
        params.append(filters["estado"])
    if "fecha_min" in filters:
        where.append("c.fecha >= ?")
        params.append(filters["fecha_min"])
    if "fecha_max" in filters:
        where.append("c.fecha <= ?")
        params.append(filters["fecha_max"])
    sql = """SELECT c.*, u.name AS worker_name, cu.name AS client_full_name,
             s.puntaje AS satisfaction_puntaje,
             CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS has_satisfaction
             FROM citas c
             LEFT JOIN users u ON u.id=c.worker_id
             LEFT JOIN users cu ON cu.id=c.client_id
             LEFT JOIN satisfaction s ON s.cita_id=c.id"""
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY c.fecha, c.hora"
    with get_db() as db:
        return [dict(r) for r in db.execute(sql, params).fetchall()]


def update_cita(cita_id: str, fields: dict) -> Optional[dict]:
    if not fields:
        return get_cita(cita_id)
    sets = ", ".join(f"{k}=?" for k in fields.keys())
    params = list(fields.values()) + [cita_id]
    with get_db() as db:
        db.execute(f"UPDATE citas SET {sets} WHERE id=?", params)
    return get_cita(cita_id)


# ===== Satisfaction =====
def submit_satisfaction(cita_id: str, puntaje: float, comentario: str, respuestas: list):
    with get_db() as db:
        db.execute(
            """INSERT INTO satisfaction (cita_id, puntaje, comentario, respuestas)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(cita_id) DO UPDATE SET
                 puntaje=excluded.puntaje,
                 comentario=excluded.comentario,
                 respuestas=excluded.respuestas""",
            (cita_id, puntaje, comentario, json.dumps(respuestas)),
        )


def get_satisfaction(cita_id: str) -> Optional[dict]:
    with get_db() as db:
        r = db.execute("SELECT * FROM satisfaction WHERE cita_id=?", (cita_id,)).fetchone()
        return dict(r) if r else None


# ===== Init =====
def init_db():
    with get_db() as db:
        for stmt in SCHEMA.strip().split(";"):
            if stmt.strip():
                db.execute(stmt)
        for k, v in DEFAULT_SETTINGS.items():
            db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v))
        for name, color in DEFAULT_AREAS:
            db.execute("INSERT OR IGNORE INTO areas (name, color) VALUES (?, ?)", (name, color))
        for area_name, subs in DEFAULT_SERVICES.items():
            row = db.execute("SELECT id FROM areas WHERE name=?", (area_name,)).fetchone()
            if row:
                for sub in subs:
                    db.execute("INSERT OR IGNORE INTO services (name, area_id) VALUES (?, ?)",
                               (sub, row["id"]))

    # Default users (no creo en el bloque anterior porque create_user usa su propia conexión)
    if not get_user_by_username("admin"):
        create_user("admin", "admin1234", "admin", "Administrador BACCITA")
    for username, pwd, name in DEFAULT_WORKERS:
        if not get_user_by_username(username):
            uid = create_user(username, pwd, "worker", name,
                              accesibilidad=(username == "badner"))
            with get_db() as db:
                areas = [dict(r) for r in db.execute("SELECT id FROM areas").fetchall()]
                if username == "badner":
                    pass
                else:
                    for a in areas:
                        db.execute("INSERT OR IGNORE INTO worker_areas (worker_id, area_id) VALUES (?, ?)",
                                   (uid, a["id"]))


init_db()
