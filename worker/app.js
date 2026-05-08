(() => {
  const $ = (id) => document.getElementById(id);

  const ESTADO_LABEL = {
    pendiente: 'Pendiente',
    en_proceso: 'En proceso',
    atendida: 'Atendida',
    no_atendida: 'No atendida',
    cancelada: 'Cancelada',
  };

  const state = {
    user: null,
    citas: [],
    settings: {},
    tab: 'hoy',
  };

  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function tomorrowISO() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
      body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.detail === 'string' ? err.detail : `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ===== Auth =====
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('username').value.trim();
    const password = $('password').value;
    $('login-error').textContent = '';
    try {
      const { user } = await api('/api/auth/login', { method: 'POST', body: { username, password } });
      if (user.role !== 'worker' && user.role !== 'admin') {
        $('login-error').textContent = 'Esta cuenta no es de trabajador.';
        await api('/api/auth/logout', { method: 'POST' });
        return;
      }
      state.user = user;
      enterApp();
    } catch (e) {
      $('login-error').textContent = e.message;
    }
  });

  $('logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  async function tryAutoLogin() {
    try {
      const { user } = await api('/api/auth/me');
      if (user && (user.role === 'worker' || user.role === 'admin')) {
        state.user = user;
        enterApp();
      }
    } catch (_) {}
  }

  function enterApp() {
    $('login-screen').hidden = true;
    $('app').hidden = false;
    $('who-name').textContent = state.user.name;
    $('who-role').textContent = state.user.role === 'admin' ? 'Administrador' : 'Trabajador';
    refreshAll();
  }

  // ===== Nav =====
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => (t.hidden = true));
      $('tab-' + state.tab).hidden = false;
      const titles = {
        hoy: 'Citas de hoy',
        manana: 'Citas de mañana',
        proximas: 'Próximas citas',
        kpis: 'KPIs del día',
      };
      $('tab-title').textContent = titles[state.tab] || '';
      render();
    });
  });

  // ===== Refresh =====
  async function refreshAll() {
    try {
      const [citas, settings] = await Promise.all([
        api('/api/citas'),
        api('/api/settings'),
      ]);
      state.citas = citas;
      state.settings = settings;
      updateBadges();
      render();
    } catch (e) {
      $('status-bar').textContent = 'Error: ' + e.message;
    }
  }

  function updateBadges() {
    const today = todayISO();
    const tomorrow = tomorrowISO();
    const hoy = state.citas.filter((c) => c.fecha === today && c.estado !== 'cancelada');
    const manana = state.citas.filter((c) => c.fecha === tomorrow && c.estado !== 'cancelada');
    const proximas = state.citas.filter((c) => c.fecha > tomorrow && c.estado !== 'cancelada');
    $('badge-hoy').textContent = hoy.length;
    $('badge-manana').textContent = manana.length;
    $('badge-proximas').textContent = proximas.length;
  }

  // ===== Render =====
  function render() {
    if (state.tab === 'hoy') renderCitas('tab-hoy', state.citas.filter((c) => c.fecha === todayISO()));
    else if (state.tab === 'manana') renderCitas('tab-manana', state.citas.filter((c) => c.fecha === tomorrowISO()));
    else if (state.tab === 'proximas') renderCitas('tab-proximas', state.citas.filter((c) => c.fecha > tomorrowISO()));
    else if (state.tab === 'kpis') renderKpis();
  }

  function renderCitas(targetId, citas) {
    const target = $(targetId);
    if (!citas.length) {
      target.innerHTML = '<div class="empty">No hay citas para mostrar.</div>';
      return;
    }
    citas.sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
    target.innerHTML = citas.map(citaCard).join('');
    citas.forEach((c) => bindCitaActions(c));
  }

  function citaCard(c) {
    const obs = c.observaciones ? `<div class="obs"><strong>Observaciones:</strong> ${escapeHtml(c.observaciones)}</div>` : '';
    const motivo = c.motivo_no_atencion ? `<div class="obs"><strong>Motivo no atención:</strong> ${escapeHtml(c.motivo_no_atencion)}</div>` : '';
    const dur = c.duracion ? ` · ${Math.round(c.duracion)} min` : '';
    return `
      <article class="cita-card" data-estado="${c.estado}" data-id="${c.id}">
        <div class="cita-head">
          <div>
            <div class="cita-cliente">${escapeHtml(c.cliente_nombre)}</div>
            <div class="cita-meta">
              <span class="cita-cedula">${escapeHtml(c.cliente_cedula || '')}</span>
              ${c.cliente_telefono ? `<span>📞 ${escapeHtml(c.cliente_telefono)}</span>` : ''}
              ${c.accesibilidad ? '<span>♿ Accesibilidad</span>' : ''}
            </div>
          </div>
          <div class="cita-hora">${c.hora}</div>
        </div>
        <div class="cita-meta">
          <span class="cita-servicio">${escapeHtml(c.servicio_nombre)}${c.subservicio_nombre ? ' · ' + escapeHtml(c.subservicio_nombre) : ''}</span>
          <span class="estado-tag" data-estado="${c.estado}">${ESTADO_LABEL[c.estado] || c.estado}${dur}</span>
        </div>
        ${obs}
        ${motivo}
        ${actionButtons(c)}
      </article>
    `;
  }

  function actionButtons(c) {
    const btns = [];
    if (c.estado === 'pendiente') {
      btns.push(`<button class="start" data-action="start">▶ Iniciar</button>`);
      btns.push(`<button class="ok" data-action="atendida">✓ Atendida</button>`);
      btns.push(`<button class="ko" data-action="no_atendida">✗ No atendida</button>`);
    } else if (c.estado === 'en_proceso') {
      btns.push(`<button class="ok" data-action="atendida">✓ Finalizar atención</button>`);
      btns.push(`<button class="ko" data-action="no_atendida">✗ No atendida</button>`);
    }
    if (c.estado !== 'cancelada') {
      btns.push(`<button data-action="obs">📝 Observaciones</button>`);
    }
    return `<div class="cita-actions">${btns.join('')}</div>`;
  }

  function bindCitaActions(c) {
    const card = document.querySelector(`.cita-card[data-id="${c.id}"]`);
    if (!card) return;
    card.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => onCitaAction(c, btn.dataset.action));
    });
  }

  async function onCitaAction(c, action) {
    if (action === 'start') {
      await patchCita(c.id, { estado: 'en_proceso' });
    } else if (action === 'atendida') {
      const obs = await openDialog({
        title: 'Marcar como atendida',
        context: `${c.cliente_nombre} · ${c.hora} · ${c.servicio_nombre}`,
        label: 'Observaciones (opcional)',
        value: c.observaciones || '',
      });
      if (obs === null) return;
      await patchCita(c.id, { estado: 'atendida', observaciones: obs });
    } else if (action === 'no_atendida') {
      const motivo = await openDialog({
        title: 'Marcar como NO atendida',
        context: `${c.cliente_nombre} · ${c.hora}`,
        label: 'Motivo (requerido)',
        value: c.motivo_no_atencion || '',
      });
      if (motivo === null) return;
      if (!motivo.trim()) { alert('El motivo es obligatorio'); return; }
      await patchCita(c.id, { estado: 'no_atendida', motivo_no_atencion: motivo });
    } else if (action === 'obs') {
      const obs = await openDialog({
        title: 'Observaciones',
        context: `${c.cliente_nombre} · ${c.hora}`,
        label: 'Observaciones',
        value: c.observaciones || '',
      });
      if (obs === null) return;
      await patchCita(c.id, { observaciones: obs });
    }
  }

  async function patchCita(id, body) {
    try {
      $('status-bar').textContent = 'Guardando...';
      await api(`/api/citas/${id}`, { method: 'PATCH', body });
      $('status-bar').textContent = 'Actualizado.';
      await refreshAll();
    } catch (e) {
      $('status-bar').textContent = 'Error: ' + e.message;
    }
  }

  // ===== KPIs =====
  async function renderKpis() {
    try {
      const k = await api(`/api/kpis?fecha=${todayISO()}`);
      const target = $('tab-kpis');
      target.innerHTML = renderKpiCards(k);
    } catch (e) {
      $('tab-kpis').innerHTML = '<div class="empty">Error: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function classify(value, target, mode) {
    if (mode === 'min') return value >= target ? 'good' : (value >= target * 0.7 ? 'warn' : 'bad');
    if (mode === 'max') return value <= target ? 'good' : (value <= target * 1.3 ? 'warn' : 'bad');
    return '';
  }

  function renderKpiCards(k) {
    const s = state.settings;
    const cumplT = parseFloat(s.cumplimiento_min_pct || '95');
    const satT = parseFloat(s.satisfaccion_min_pct || '95');
    const cancT = parseFloat(s.cancelacion_max_pct || '5');
    const espT = parseFloat(s.tiempo_espera_max_min || '8');
    const acept = k.umbral_tiempo_aceptable;
    const tol = k.umbral_tolerancia;
    return `
      <div class="kpi-grid">
        <div class="kpi">
          <div class="kpi-label">Citas gestionadas</div>
          <div class="kpi-value">${k.total}</div>
          <div class="kpi-target">${k.atendidas} atendidas · ${k.pendientes} pendientes</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Cumplimiento</div>
          <div class="kpi-value ${classify(k.cumplimiento_pct, cumplT, 'min')}">${k.cumplimiento_pct}%</div>
          <div class="kpi-target">objetivo ≥ ${cumplT}%</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Cancelación</div>
          <div class="kpi-value ${classify(k.cancelacion_pct, cancT, 'max')}">${k.cancelacion_pct}%</div>
          <div class="kpi-target">objetivo ≤ ${cancT}%</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Satisfacción</div>
          <div class="kpi-value ${classify(k.satisfaccion_pct, satT, 'min')}">${k.satisfaccion_pct}%</div>
          <div class="kpi-target">objetivo ≥ ${satT}%</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Duración promedio</div>
          <div class="kpi-value">${k.duracion_promedio_min} min</div>
          <div class="kpi-target">aceptable ${acept}±${tol} min</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Tiempo en rango</div>
          <div class="kpi-value">${k.tiempo_aceptable_pct}%</div>
          <div class="kpi-target">de citas dentro de ${acept}±${tol} min</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Tiempo de espera</div>
          <div class="kpi-value ${classify(k.tiempo_espera_promedio_min, espT, 'max')}">${k.tiempo_espera_promedio_min} min</div>
          <div class="kpi-target">objetivo ≤ ${espT} min</div>
        </div>
      </div>
    `;
  }

  // ===== Dialog helper =====
  function openDialog({ title, context, label, value = '' }) {
    return new Promise((resolve) => {
      const dlg = $('action-dialog');
      $('dialog-title').textContent = title;
      $('dialog-context').textContent = context || '';
      $('dialog-label').textContent = label || 'Detalles';
      $('dialog-input').value = value;

      const onCancel = () => {
        dlg.close();
        cleanup();
        resolve(null);
      };
      const onSubmit = (e) => {
        e.preventDefault();
        const v = $('dialog-input').value;
        dlg.close();
        cleanup();
        resolve(v);
      };
      const cleanup = () => {
        $('dialog-cancel').removeEventListener('click', onCancel);
        $('action-form').removeEventListener('submit', onSubmit);
      };

      $('dialog-cancel').addEventListener('click', onCancel);
      $('action-form').addEventListener('submit', onSubmit);

      dlg.showModal();
      $('dialog-input').focus();
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  tryAutoLogin();
  setInterval(() => { if (state.user) refreshAll(); }, 30000);
})();
