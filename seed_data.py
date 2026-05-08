"""Pobla la DB con datos ficticios para demo de KPIs.

Genera ~150 citas: 30 dias historicos (atendidas/canceladas/no atendidas),
hoy (mezcla de pendientes/en_proceso/atendidas), 14 dias futuros
(mayormente pendientes). Anade encuestas de satisfaccion y tickets con
tiempos de espera para que los KPIs reflejen datos reales.

Idempotente: agrega registros nuevos pero no duplica los clientes seed.
"""
import random
import uuid
from datetime import date, datetime, timedelta

import storage

random.seed(42)

NOMBRES = [
    "Juan Carlos Zeledón Pérez", "María Elena López Rodríguez", "Pedro Antonio Martínez García",
    "Ana Lucía Hernández Castro", "Luis Fernando Sánchez Mendoza", "Carmen Patricia Ramírez Soto",
    "José Roberto Gutiérrez Cruz", "Lourdes Beatriz Aguilar Reyes", "Carlos Eduardo Morales Vargas",
    "Sofía Isabel Téllez Bonilla", "Francisco Javier Pineda Lacayo", "Rosa María Silva Cortez",
    "Mario Alberto Espinoza Ortiz", "Daniela Gabriela Núñez Solano", "Ricardo Manuel Calero Pavón",
    "Adriana Carolina Báez Mejía", "Eduardo Andrés Briones Talavera", "Yessenia Marisol Membreño Cuadra",
    "Oscar Iván Reyes Bermúdez", "Karla Vanessa Castillo Aragón",
]

OBSERVACIONES_ATENDIDA = [
    "", "", "", "",
    "Atención sin novedades.",
    "Documentación completa, proceso fluido.",
    "Cliente satisfecho con la propuesta.",
    "Se entregó comprobante físico al cliente.",
    "Solicita información adicional por correo.",
    "Cliente preguntó sobre productos relacionados.",
]

MOTIVOS_NO_ATENDIDA = [
    "Cliente no se presentó.",
    "Cliente llegó tarde, se reagendó.",
    "Documentación incompleta.",
    "Cliente canceló presencialmente.",
    "Falla en sistema, se reagenda.",
]

COMENTARIOS_ENCUESTA = [
    "", "", "",
    "Excelente atención.",
    "Muy amable el trabajador.",
    "Tiempo de espera aceptable.",
    "Volveré sin duda.",
    "Algo lento pero buen servicio.",
    "Trato profesional.",
    "Resolvió mi consulta rápidamente.",
]


def random_cedula():
    return f"{random.randint(1, 999):03d}-{random.randint(100000, 999999):06d}-{random.randint(0, 9999):04d}{random.choice('ABCDEFGHJKLMN')}"


def get_or_create_clients() -> list:
    """Crea hasta 15 clientes ficticios si no existen."""
    out = []
    for i, name in enumerate(NOMBRES[:15]):
        username = f"cliente{i+1}"
        existing = storage.get_user_by_username(username)
        if existing:
            out.append(existing)
            continue
        uid = storage.create_user(
            username, "demo1234", "client", name,
            phone=f"8{random.randint(1000000, 9999999)}",
            cedula=random_cedula(),
            email=f"{username}@demo.test",
        )
        out.append(storage.get_user(uid))
    return out


def main():
    today = date.today()
    clients = get_or_create_clients()
    print(f"Clientes disponibles: {len(clients)}")

    with storage.get_db() as db:
        workers = [dict(r) for r in db.execute(
            "SELECT * FROM users WHERE role='worker' AND active=1"
        ).fetchall()]
        services = [dict(r) for r in db.execute(
            """SELECT s.*, a.name AS area_name FROM services s
               JOIN areas a ON a.id=s.area_id WHERE s.active=1 AND a.active=1"""
        ).fetchall()]
    print(f"Trabajadores: {len(workers)}, Servicios: {len(services)}")

    slots = [f"{h:02d}:{m:02d}" for h in range(8, 17)
             for m in (0, 35) if h * 60 + m + 35 <= 17 * 60][:15]

    citas_creadas = 0
    encuestas = 0

    for delta in range(-30, 15):
        d = today + timedelta(days=delta)
        if d.weekday() >= 5:  # sin sabados/domingos
            continue
        fecha = d.isoformat()

        # 12-22 citas por dia laboral
        n_citas = random.randint(12, 22)
        used_by_worker: dict = {w["id"]: set() for w in workers}

        for _ in range(n_citas):
            client = random.choice(clients)
            service = random.choice(services)

            # Workers que pueden atender este servicio (todos los activos por simplicidad,
            # ya que Badner solo atiende accesibilidad lo respetamos al final)
            accesibilidad = random.random() < 0.08
            if accesibilidad:
                cands = [w for w in workers if w.get("accesibilidad")]
                if not cands:
                    cands = workers
            else:
                cands = [w for w in workers if not w.get("accesibilidad") or w["username"] != "badner"]

            random.shuffle(cands)
            worker = None
            slot = None
            for w in cands:
                avail = [s for s in slots if s not in used_by_worker[w["id"]]]
                if avail:
                    worker = w
                    slot = random.choice(avail)
                    used_by_worker[w["id"]].add(slot)
                    break
            if not worker:
                continue

            # Estado segun la fecha
            r = random.random()
            if delta < 0:
                if r < 0.05: estado = "cancelada"
                elif r < 0.12: estado = "no_atendida"
                else: estado = "atendida"
            elif delta == 0:
                if r < 0.35: estado = "atendida"
                elif r < 0.45: estado = "en_proceso"
                elif r < 0.95: estado = "pendiente"
                else: estado = "cancelada"
            else:
                if r < 0.05: estado = "cancelada"
                else: estado = "pendiente"

            cita_id = uuid.uuid4().hex
            with storage.get_db() as db:
                db.execute(
                    """INSERT INTO citas (id, client_id, cliente_nombre, cliente_cedula,
                       cliente_telefono, cliente_correo, accesibilidad, worker_id, service_id,
                       servicio_nombre, subservicio_nombre, fecha, hora, estado)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (cita_id, client["id"], client["name"], client["cedula"],
                     client.get("phone", ""), client.get("email", ""),
                     1 if accesibilidad else 0, worker["id"], service["id"],
                     service["area_name"], service["name"], fecha, slot, estado),
                )

                # Timing: tiempo de espera = diferencia entre hora programada y inicio real.
                # Sesgo a ligeros retrasos (0-15 min con media ~5).
                hh, mm = map(int, slot.split(":"))
                inicio_dt = datetime.combine(d, datetime.min.time().replace(hour=hh, minute=mm))
                espera_min = max(0, min(20, int(round(random.gauss(5.5, 4.0)))))
                inicio_dt += timedelta(minutes=espera_min)

                if estado == "atendida":
                    duracion = max(6.0, min(60.0, random.gauss(29.0, 9.0)))
                    fin_dt = inicio_dt + timedelta(minutes=duracion)
                    obs = random.choice(OBSERVACIONES_ATENDIDA)
                    db.execute(
                        """UPDATE citas SET inicio=?, fin=?, duracion=?, observaciones=?
                           WHERE id=?""",
                        (inicio_dt.isoformat(), fin_dt.isoformat(), duracion, obs, cita_id),
                    )
                elif estado == "no_atendida":
                    motivo = random.choice(MOTIVOS_NO_ATENDIDA)
                    db.execute(
                        "UPDATE citas SET inicio=?, motivo_no_atencion=? WHERE id=?",
                        (inicio_dt.isoformat(), motivo, cita_id),
                    )
                elif estado == "en_proceso":
                    db.execute(
                        "UPDATE citas SET inicio=? WHERE id=?",
                        (inicio_dt.isoformat(), cita_id),
                    )

            citas_creadas += 1

            # Encuestas (~70% de las atendidas)
            if estado == "atendida" and random.random() < 0.70:
                # Sesgo positivo: la mayoría 5/7 - 7/7
                n_yes = max(0, min(7, int(round(random.gauss(6.0, 1.1)))))
                respuestas = [True] * n_yes + [False] * (7 - n_yes)
                random.shuffle(respuestas)
                puntaje = (n_yes / 7) * 100
                storage.submit_satisfaction(
                    cita_id, puntaje, random.choice(COMENTARIOS_ENCUESTA), respuestas
                )
                encuestas += 1

    print(f"Citas creadas: {citas_creadas}")
    print(f"Encuestas:     {encuestas}")


if __name__ == "__main__":
    main()
