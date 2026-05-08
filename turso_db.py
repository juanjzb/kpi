"""Cliente HTTP minimal para Turso/libSQL que emula la API de sqlite3.

Usa solo urllib (stdlib) — sin dependencias adicionales. Diseñado para que
storage.py funcione sin cambios cuando TURSO_DATABASE_URL y TURSO_AUTH_TOKEN
estan seteadas como variables de entorno.

Soporta las operaciones que usa storage.py:
  conn.execute(sql, params)         -> TursoCursor
  cursor.fetchone() / fetchall()    -> TursoRow / list[TursoRow]
  cursor.lastrowid                  -> int (AUTOINCREMENT)
  row[index] y row['column']        -> valor
  dict(row)                         -> {col: val}
"""
import base64
import json
import urllib.error
import urllib.request
from typing import Optional


class TursoError(Exception):
    pass


class TursoRow:
    """Comportamiento como sqlite3.Row: indexable por int o nombre, dict-friendly."""
    __slots__ = ("_cols", "_values")

    def __init__(self, cols: list, values: list):
        self._cols = cols
        self._values = values

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        try:
            return self._values[self._cols.index(key)]
        except ValueError:
            raise KeyError(key)

    def keys(self):
        return self._cols

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)

    def __contains__(self, key):
        return key in self._cols

    def get(self, key, default=None):
        try:
            return self[key]
        except (KeyError, IndexError):
            return default


class TursoCursor:
    def __init__(self, cols=None, rows=None, last_id=None, affected=0):
        self._cols = cols or []
        self._rows = [TursoRow(self._cols, r) for r in (rows or [])]
        self.lastrowid = last_id
        self.rowcount = affected
        self._idx = 0

    def fetchone(self) -> Optional[TursoRow]:
        if self._idx < len(self._rows):
            r = self._rows[self._idx]
            self._idx += 1
            return r
        return None

    def fetchall(self) -> list:
        out = self._rows[self._idx:]
        self._idx = len(self._rows)
        return out

    def __iter__(self):
        return iter(self._rows)


def _encode_param(p):
    if p is None:
        return {"type": "null", "value": None}
    if isinstance(p, bool):
        return {"type": "integer", "value": str(int(p))}
    if isinstance(p, int):
        return {"type": "integer", "value": str(p)}
    if isinstance(p, float):
        return {"type": "float", "value": p}
    if isinstance(p, (bytes, bytearray)):
        return {"type": "blob", "base64": base64.b64encode(bytes(p)).decode()}
    return {"type": "text", "value": str(p)}


def _decode_cell(cell):
    if not isinstance(cell, dict):
        return cell
    t = cell.get("type")
    v = cell.get("value")
    if t == "null":
        return None
    if t == "integer":
        return int(v) if v is not None else None
    if t == "float":
        return float(v) if v is not None else None
    if t == "blob":
        return base64.b64decode(cell.get("base64", ""))
    return v  # text or unknown


class TursoConnection:
    def __init__(self, url: str, token: str, timeout: int = 20):
        if url.startswith("libsql://"):
            url = "https://" + url[len("libsql://"):]
        self.endpoint = url.rstrip("/") + "/v2/pipeline"
        self.token = token
        self.timeout = timeout
        self.row_factory = None  # ignorado, siempre devolvemos TursoRow

    def execute(self, sql: str, params=None) -> TursoCursor:
        args = [_encode_param(p) for p in (params or [])]
        body = {
            "requests": [
                {"type": "execute", "stmt": {"sql": sql, "args": args}},
            ]
        }
        req = urllib.request.Request(
            self.endpoint,
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.token}",
            },
        )
        try:
            raw = urllib.request.urlopen(req, timeout=self.timeout).read()
        except urllib.error.HTTPError as e:
            raise TursoError(f"HTTP {e.code}: {e.read().decode(errors='ignore')}")
        except urllib.error.URLError as e:
            raise TursoError(f"Network: {e}")

        try:
            res = json.loads(raw)
        except json.JSONDecodeError:
            raise TursoError(f"Bad JSON response: {raw[:200]}")

        results = res.get("results", [])
        if not results:
            raise TursoError(f"Empty results: {res}")

        r0 = results[0]
        if r0.get("type") != "ok":
            err = r0.get("error", {})
            raise TursoError(f"SQL error: {err.get('message', json.dumps(r0))}")

        result = r0["response"]["result"]
        cols = [c["name"] for c in result.get("cols", [])]
        rows = [[_decode_cell(c) for c in row] for row in result.get("rows", [])]
        last_id = result.get("last_insert_rowid")
        if last_id is not None:
            try:
                last_id = int(last_id)
            except (TypeError, ValueError):
                last_id = None
        affected = result.get("affected_row_count", 0)
        return TursoCursor(cols, rows, last_id, affected)

    def executemany(self, sql: str, seq_of_params):
        last_cursor = None
        for params in seq_of_params:
            last_cursor = self.execute(sql, params)
        return last_cursor

    def commit(self):
        pass  # auto-commit por request

    def rollback(self):
        pass

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False
