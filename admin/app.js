(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    user: null,
    settings: {},
    areas: [],
    services: [],
    workers: [],
    tab: 'kpis',
    fechaFiltro: '',
  };

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.detail === 'string' ? err.detail : `HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // ===== Auth =====
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    try {
      const { user } = await api('/api/auth/login', { method: 'POST', body: { username: $('username').value.trim(), password: $('password').value } });
      if (user.role !== 'admin') {
        $('login-error').textContent = 'Solo cuentas admin pueden entrar aquí.';
        await api('/api/auth/logout', { method: 'POST' });
        return;
      }
      state.user = user;
      enterApp();
    } catch (e) { $('login-error').textContent = e.message; }
  });

  $('logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  });

  async function tryAutoLogin() {
    try {
      const { user } = await api('/api/auth/me');
      if (user && user.role === 'admin') { state.user = user; enterApp(); }
    } catch (_) {}
  }

  function enterApp() {
    $('login-screen').hidden = true;
    $('app').hidden = false;
    $('who-name').textContent = state.user.name;
    refreshBase().then(() => switchTab('kpis'));
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((t) => (t.hidden = true));
    $('tab-' + tab).hidden = false;
    const titles = {
      kpis: 'KPIs globales',
      comparativo: 'Comparativo de trabajadores',
      trabajadores: 'Trabajadores',
      areas: 'Áreas',
      servicios: 'Servicios',
      config: 'Configuración',
    };
    $('tab-title').textContent = titles[tab] || '';
    render();
  }

  async function refreshBase() {
    try {
      const [settings, areas, services, workers] = await Promise.all([
        api('/api/settings'),
        api('/api/areas'),
        api('/api/services'),
        api('/api/workers'),
      ]);
      state.settings = settings;
      state.areas = areas;
      state.services = services;
      state.workers = workers;
    } catch (e) { $('status-bar').textContent = 'Error: ' + e.message; }
  }

  function render() {
    if (state.tab === 'kpis') return renderKpis();
    if (state.tab === 'comparativo') return renderComparativo();
    if (state.tab === 'trabajadores') return renderTrabajadores();
    if (state.tab === 'areas') return renderAreas();
    if (state.tab === 'servicios') return renderServicios();
    if (state.tab === 'config') return renderConfig();
  }

  // ===== KPIs globales =====
  function classify(value, target, mode) {
    if (mode === 'min') return value >= target ? 'good' : (value >= target * 0.7 ? 'warn' : 'bad');
    if (mode === 'max') return value <= target ? 'good' : (value <= target * 1.3 ? 'warn' : 'bad');
    return '';
  }

  let chartInstances = {};

  function destroyCharts() {
    Object.values(chartInstances).forEach((c) => { try { c.destroy(); } catch (_) {} });
    chartInstances = {};
  }

  async function renderKpis() {
    const range = state.kpiRange || 7;
    const fecha = state.fechaFiltro || todayISO();
    const target = $('tab-kpis');
    destroyCharts();
    target.innerHTML = `
      <div class="toolbar">
        <strong style="margin-right:0.5rem">Rango:</strong>
        <button class="range-btn" data-range="7">7 días</button>
        <button class="range-btn" data-range="15">15 días</button>
        <button class="range-btn" data-range="30">30 días</button>
        <span style="margin-left:1rem;color:var(--muted)">|</span>
        <label>Día específico <input type="date" id="k-fecha" value="${fecha}"></label>
      </div>

      <h3 style="margin:1.5rem 0 0.5rem">KPIs del día seleccionado</h3>
      <div id="kpi-content"></div>

      <h3 style="margin:1.5rem 0 0.5rem">Tendencia (<span id="range-label">${range}</span> días)</h3>
      <div class="chart-grid">
        <div class="chart-card">
          <h4>Citas por día</h4>
          <canvas id="ch-citas"></canvas>
        </div>
        <div class="chart-card">
          <h4>Cumplimiento y satisfacción (%)</h4>
          <canvas id="ch-pct"></canvas>
        </div>
        <div class="chart-card">
          <h4>Duración promedio (min) y % en rango</h4>
          <canvas id="ch-duracion"></canvas>
        </div>
        <div class="chart-card">
          <h4>Tiempo de espera promedio (min)</h4>
          <canvas id="ch-espera"></canvas>
        </div>
      </div>

      <h3 style="margin:1.5rem 0 0.5rem">Distribución</h3>
      <div class="chart-grid">
        <div class="chart-card">
          <h4>Estado de las citas</h4>
          <canvas id="ch-estado"></canvas>
        </div>
        <div class="chart-card">
          <h4>Por área</h4>
          <canvas id="ch-area"></canvas>
        </div>
        <div class="chart-card">
          <h4>Carga por trabajador</h4>
          <canvas id="ch-worker"></canvas>
        </div>
        <div class="chart-card">
          <h4>Distribución por día de la semana</h4>
          <canvas id="ch-dow"></canvas>
        </div>
      </div>

      <h3 style="margin:1.5rem 0 0.5rem">Resumen por trabajador</h3>
      <div id="worker-summary"></div>
    `;

    target.querySelectorAll('.range-btn').forEach((b) => {
      if (parseInt(b.dataset.range, 10) === range) b.classList.add('active');
      b.addEventListener('click', () => {
        state.kpiRange = parseInt(b.dataset.range, 10);
        renderKpis();
      });
    });
    $('k-fecha').addEventListener('change', (e) => { state.fechaFiltro = e.target.value; renderKpis(); });

    const today = todayISO();
    const fechaMinD = new Date();
    fechaMinD.setDate(fechaMinD.getDate() - (range - 1));
    const fechaMin = fechaMinD.toISOString().slice(0, 10);
    try {
      const [k, series, dist, comp] = await Promise.all([
        api(`/api/kpis?fecha=${fecha}`),
        api(`/api/kpis/timeseries?days=${range}`),
        api(`/api/kpis/distribution?days=${range}`),
        api(`/api/kpis/workers?fecha_min=${fechaMin}&fecha_max=${today}`).catch(() => null),
      ]);
      $('kpi-content').innerHTML = kpiCards(k);
      drawTrendCharts(series);
      drawDistributionCharts(dist);
      renderWorkerSummary(comp || []);
    } catch (e) {
      $('kpi-content').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }

  const PALETTE = {
    primary: '#1E4DB7',
    secondary: '#0EA5A4',
    success: '#15803d',
    warning: '#b45309',
    danger: '#b91c1c',
    purple: '#8B5CF6',
    amber: '#F59E0B',
    border: '#e5e7eb',
  };
  const STATE_COLOR = {
    pendiente: PALETTE.purple,
    en_proceso: PALETTE.amber,
    atendida: PALETTE.success,
    no_atendida: PALETTE.danger,
    cancelada: '#9ca3af',
  };
  const STATE_LABEL = {
    pendiente: 'Pendiente',
    en_proceso: 'En proceso',
    atendida: 'Atendida',
    no_atendida: 'No atendida',
    cancelada: 'Cancelada',
  };
  const DOW_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

  const fmtDate = (iso) => {
    const d = new Date(iso + 'T12:00:00');
    return `${d.getDate()}/${d.getMonth() + 1}`;
  };

  function drawTrendCharts(series) {
    const labels = series.map((s) => fmtDate(s.fecha));

    chartInstances.citas = new Chart($('ch-citas'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Atendidas', data: series.map(s => s.atendidas), backgroundColor: PALETTE.success, stack: 'a' },
          { label: 'Canceladas', data: series.map(s => s.canceladas), backgroundColor: '#9ca3af', stack: 'a' },
          { label: 'No atendidas', data: series.map(s => s.no_atendidas), backgroundColor: PALETTE.danger, stack: 'a' },
          { label: 'Pendientes', data: series.map(s => s.pendientes), backgroundColor: PALETTE.purple, stack: 'a' },
        ],
      },
      options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } },
    });

    chartInstances.pct = new Chart($('ch-pct'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Cumplimiento %', data: series.map(s => s.cumplimiento_pct), borderColor: PALETTE.primary, backgroundColor: PALETTE.primary + '22', tension: 0.3, fill: false },
          { label: 'Satisfacción %', data: series.map(s => s.satisfaccion_pct), borderColor: PALETTE.success, backgroundColor: PALETTE.success + '22', tension: 0.3, fill: false },
          { label: 'Cancelación %', data: series.map(s => s.cancelacion_pct), borderColor: PALETTE.danger, backgroundColor: PALETTE.danger + '22', tension: 0.3, fill: false },
        ],
      },
      options: { responsive: true, scales: { y: { min: 0, max: 100 } } },
    });

    chartInstances.dur = new Chart($('ch-duracion'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Duración prom. (min)', data: series.map(s => s.duracion_promedio_min), borderColor: PALETTE.amber, backgroundColor: PALETTE.amber + '22', tension: 0.3, yAxisID: 'y' },
          { label: '% en rango aceptable', data: series.map(s => s.tiempo_aceptable_pct), borderColor: PALETTE.secondary, backgroundColor: PALETTE.secondary + '22', tension: 0.3, yAxisID: 'y1' },
        ],
      },
      options: {
        responsive: true,
        scales: {
          y: { type: 'linear', position: 'left', beginAtZero: true, title: { display: true, text: 'min' } },
          y1: { type: 'linear', position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: '%' } },
        },
      },
    });

    chartInstances.espera = new Chart($('ch-espera'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Espera (min)', data: series.map(s => s.tiempo_espera_promedio_min), borderColor: PALETTE.purple, backgroundColor: PALETTE.purple + '33', tension: 0.3, fill: true },
        ],
      },
      options: { responsive: true, scales: { y: { beginAtZero: true } } },
    });
  }

  function drawDistributionCharts(dist) {
    const stateLabels = Object.keys(dist.by_state);
    chartInstances.estado = new Chart($('ch-estado'), {
      type: 'doughnut',
      data: {
        labels: stateLabels.map(s => STATE_LABEL[s] || s),
        datasets: [{ data: stateLabels.map(s => dist.by_state[s]), backgroundColor: stateLabels.map(s => STATE_COLOR[s] || PALETTE.primary) }],
      },
      options: { responsive: true, plugins: { legend: { position: 'right' } } },
    });

    const areaLabels = Object.keys(dist.by_area);
    chartInstances.area = new Chart($('ch-area'), {
      type: 'doughnut',
      data: {
        labels: areaLabels,
        datasets: [{ data: areaLabels.map(a => dist.by_area[a]), backgroundColor: [PALETTE.secondary, PALETTE.amber, PALETTE.primary, PALETTE.purple, PALETTE.danger, PALETTE.success] }],
      },
      options: { responsive: true, plugins: { legend: { position: 'right' } } },
    });

    const workerLabels = Object.keys(dist.by_worker).sort((a, b) => dist.by_worker[b] - dist.by_worker[a]);
    chartInstances.worker = new Chart($('ch-worker'), {
      type: 'bar',
      data: {
        labels: workerLabels,
        datasets: [{ label: 'Citas', data: workerLabels.map(w => dist.by_worker[w]), backgroundColor: PALETTE.primary }],
      },
      options: { responsive: true, indexAxis: 'y', scales: { x: { beginAtZero: true } } },
    });

    chartInstances.dow = new Chart($('ch-dow'), {
      type: 'bar',
      data: {
        labels: DOW_LABELS,
        datasets: [{ label: 'Citas', data: DOW_LABELS.map((_, i) => dist.by_dow[i] || 0), backgroundColor: PALETTE.secondary }],
      },
      options: { responsive: true, scales: { y: { beginAtZero: true } } },
    });
  }

  function renderWorkerSummary(comp) {
    const target = $('worker-summary');
    if (!comp || !comp.length) {
      target.innerHTML = '<div class="empty">Sin datos en el rango.</div>';
      return;
    }
    const cumplT = parseFloat(state.settings.cumplimiento_min_pct || '95');
    target.innerHTML = comp.map(({ worker, kpi }) => {
      const cls = classify(kpi.cumplimiento_pct, cumplT, 'min');
      return `
        <details class="worker-collapse">
          <summary>
            <span class="ws-name">${escapeHtml(worker.name)}</span>
            <span class="ws-stats">
              <span class="ws-stat">${kpi.total} citas</span>
              <span class="ws-stat">
                <span class="bar"><div class="${cls}" style="width:${Math.min(100, kpi.cumplimiento_pct)}%"></div></span>
                ${kpi.cumplimiento_pct}%
              </span>
              <span class="ws-stat">😊 ${kpi.satisfaccion_pct}%</span>
            </span>
          </summary>
          <div class="ws-detail">
            <div class="kpi-grid">
              <div class="kpi"><div class="kpi-label">Total</div><div class="kpi-value">${kpi.total}</div></div>
              <div class="kpi"><div class="kpi-label">Atendidas</div><div class="kpi-value">${kpi.atendidas}</div></div>
              <div class="kpi"><div class="kpi-label">Canceladas</div><div class="kpi-value">${kpi.canceladas}</div></div>
              <div class="kpi"><div class="kpi-label">No atendidas</div><div class="kpi-value">${kpi.no_atendidas}</div></div>
              <div class="kpi"><div class="kpi-label">Pendientes</div><div class="kpi-value">${kpi.pendientes}</div></div>
              <div class="kpi"><div class="kpi-label">Cumplimiento</div><div class="kpi-value ${cls}">${kpi.cumplimiento_pct}%</div></div>
              <div class="kpi"><div class="kpi-label">Cancelación</div><div class="kpi-value">${kpi.cancelacion_pct}%</div></div>
              <div class="kpi"><div class="kpi-label">Satisfacción</div><div class="kpi-value">${kpi.satisfaccion_pct}%</div></div>
              <div class="kpi"><div class="kpi-label">Duración prom.</div><div class="kpi-value">${kpi.duracion_promedio_min} min</div></div>
              <div class="kpi"><div class="kpi-label">% en rango</div><div class="kpi-value">${kpi.tiempo_aceptable_pct}%</div></div>
              <div class="kpi"><div class="kpi-label">Espera prom.</div><div class="kpi-value">${kpi.tiempo_espera_promedio_min} min</div></div>
            </div>
          </div>
        </details>
      `;
    }).join('');
  }

  function kpiCards(k) {
    const s = state.settings;
    const cumplT = parseFloat(s.cumplimiento_min_pct || '95');
    const satT = parseFloat(s.satisfaccion_min_pct || '95');
    const cancT = parseFloat(s.cancelacion_max_pct || '5');
    const espT = parseFloat(s.tiempo_espera_max_min || '8');
    return `
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-label">Citas gestionadas</div><div class="kpi-value">${k.total}</div><div class="kpi-target">${k.atendidas} atendidas · ${k.canceladas} canceladas · ${k.no_atendidas} no atendidas</div></div>
        <div class="kpi"><div class="kpi-label">Cumplimiento</div><div class="kpi-value ${classify(k.cumplimiento_pct, cumplT, 'min')}">${k.cumplimiento_pct}%</div><div class="kpi-target">objetivo ≥ ${cumplT}%</div></div>
        <div class="kpi"><div class="kpi-label">Cancelación</div><div class="kpi-value ${classify(k.cancelacion_pct, cancT, 'max')}">${k.cancelacion_pct}%</div><div class="kpi-target">objetivo ≤ ${cancT}%</div></div>
        <div class="kpi"><div class="kpi-label">Satisfacción</div><div class="kpi-value ${classify(k.satisfaccion_pct, satT, 'min')}">${k.satisfaccion_pct}%</div><div class="kpi-target">objetivo ≥ ${satT}%</div></div>
        <div class="kpi"><div class="kpi-label">Duración promedio</div><div class="kpi-value">${k.duracion_promedio_min} min</div><div class="kpi-target">aceptable ${k.umbral_tiempo_aceptable}±${k.umbral_tolerancia} min</div></div>
        <div class="kpi"><div class="kpi-label">En tiempo aceptable</div><div class="kpi-value">${k.tiempo_aceptable_pct}%</div><div class="kpi-target">de citas</div></div>
        <div class="kpi"><div class="kpi-label">Tiempo de espera</div><div class="kpi-value ${classify(k.tiempo_espera_promedio_min, espT, 'max')}">${k.tiempo_espera_promedio_min} min</div><div class="kpi-target">objetivo ≤ ${espT} min</div></div>
      </div>
    `;
  }

  // ===== Comparativo =====
  async function renderComparativo() {
    const fecha = state.fechaFiltro || todayISO();
    const target = $('tab-comparativo');
    target.innerHTML = `
      <div class="toolbar">
        <label>Fecha <input type="date" id="c-fecha" value="${fecha}"></label>
        <span style="color:var(--muted);font-size:0.9rem">Comparativo del día seleccionado.</span>
      </div>
      <div id="comp-content"></div>
    `;
    $('c-fecha').addEventListener('change', (e) => { state.fechaFiltro = e.target.value; renderComparativo(); });
    try {
      const data = await api(`/api/kpis/workers?fecha=${fecha}`);
      const cumplT = parseFloat(state.settings.cumplimiento_min_pct || '95');
      const rows = data.map(({ worker, kpi }) => {
        const cls = classify(kpi.cumplimiento_pct, cumplT, 'min');
        return `<tr>
          <td>${escapeHtml(worker.name)}</td>
          <td>${kpi.total}</td>
          <td>${kpi.atendidas}</td>
          <td>${kpi.canceladas}</td>
          <td>${kpi.duracion_promedio_min} min</td>
          <td>
            <span class="bar"><div class="${cls}" style="width:${Math.min(100, kpi.cumplimiento_pct)}%"></div></span>
            ${kpi.cumplimiento_pct}%
          </td>
          <td>${kpi.satisfaccion_pct}%</td>
        </tr>`;
      }).join('');
      $('comp-content').innerHTML = `
        <div class="tbl-wrap">
          <table>
            <thead><tr>
              <th>Trabajador</th>
              <th>Total</th><th>Atendidas</th><th>Canceladas</th>
              <th>Duración</th><th>Cumplimiento</th><th>Satisfacción</th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="7" class="empty" style="padding:2rem">Sin datos</td></tr>'}</tbody>
          </table>
        </div>
      `;
    } catch (e) {
      $('comp-content').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }

  // ===== Trabajadores =====
  function renderTrabajadores() {
    const target = $('tab-trabajadores');
    const rows = state.workers.map((w) => `
      <tr>
        <td>${escapeHtml(w.name)}</td>
        <td>${escapeHtml(w.username)}</td>
        <td>${w.areas.map(a => `<span class="pill" style="background:${a.color}22;color:${a.color}">${escapeHtml(a.name)}</span>`).join(' ')}</td>
        <td>${w.accesibilidad ? '<span class="pill good">Accesibilidad</span>' : ''}</td>
        <td><span class="pill ${w.active ? 'good' : 'bad'}">${w.active ? 'activo' : 'inactivo'}</span></td>
        <td class="actions">
          <button class="row-btn" data-act="areas" data-id="${w.id}">Áreas</button>
          <button class="row-btn" data-act="edit" data-id="${w.id}">Editar</button>
          <button class="row-btn" data-act="pwd" data-id="${w.id}">Contraseña</button>
        </td>
      </tr>`).join('');
    target.innerHTML = `
      <div class="toolbar">
        <strong>${state.workers.length} trabajadores</strong>
        <button class="btn-add" id="add-worker">+ Nuevo trabajador</button>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Nombre</th><th>Usuario</th><th>Áreas</th><th></th><th>Estado</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="empty" style="padding:2rem">Sin trabajadores</td></tr>'}</tbody>
        </table>
      </div>
    `;
    $('add-worker').addEventListener('click', dialogAddWorker);
    target.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const w = state.workers.find((x) => String(x.id) === btn.dataset.id);
        if (btn.dataset.act === 'areas') dialogWorkerAreas(w);
        if (btn.dataset.act === 'edit') dialogEditWorker(w);
        if (btn.dataset.act === 'pwd') dialogChangePassword(w);
      });
    });
  }

  async function dialogAddWorker() {
    const fields = [
      { id: 'username', label: 'Usuario', type: 'text', required: true },
      { id: 'password', label: 'Contraseña', type: 'password', required: true },
      { id: 'name', label: 'Nombre', type: 'text', required: true },
      { id: 'email', label: 'Email', type: 'email' },
      { id: 'phone', label: 'Teléfono', type: 'text' },
      { id: 'accesibilidad', label: 'Atiende accesibilidad', type: 'checkbox' },
    ];
    const v = await openDialog('Nuevo trabajador', fields);
    if (!v) return;
    try {
      await api('/api/workers', { method: 'POST', body: {
        username: v.username, password: v.password, name: v.name,
        email: v.email || '', phone: v.phone || '',
        accesibilidad: v.accesibilidad === 'true' || v.accesibilidad === true,
        area_ids: state.areas.map(a => a.id),
      }});
      await refreshBase();
      renderTrabajadores();
    } catch (e) { alert(e.message); }
  }

  async function dialogEditWorker(w) {
    const v = await openDialog('Editar trabajador', [
      { id: 'name', label: 'Nombre', type: 'text', value: w.name, required: true },
      { id: 'email', label: 'Email', type: 'email', value: w.email || '' },
      { id: 'phone', label: 'Teléfono', type: 'text', value: w.phone || '' },
      { id: 'accesibilidad', label: 'Atiende accesibilidad', type: 'checkbox', value: w.accesibilidad },
      { id: 'active', label: 'Activo', type: 'checkbox', value: w.active },
    ]);
    if (!v) return;
    try {
      await api(`/api/workers/${w.id}`, { method: 'PATCH', body: {
        name: v.name, email: v.email, phone: v.phone,
        accesibilidad: v.accesibilidad === 'true' || v.accesibilidad === true,
        active: v.active === 'true' || v.active === true,
      }});
      await refreshBase();
      renderTrabajadores();
    } catch (e) { alert(e.message); }
  }

  async function dialogChangePassword(w) {
    const v = await openDialog('Nueva contraseña', [
      { id: 'password', label: 'Contraseña', type: 'password', required: true },
    ]);
    if (!v) return;
    try {
      await api(`/api/workers/${w.id}`, { method: 'PATCH', body: { password: v.password } });
      alert('Contraseña actualizada');
    } catch (e) { alert(e.message); }
  }

  async function dialogWorkerAreas(w) {
    const dlg = $('dlg');
    $('dlg-title').textContent = `Áreas de ${w.name}`;
    const checked = new Set(w.areas.map(a => a.id));
    $('dlg-fields').innerHTML = state.areas.map(a => `
      <label style="display:flex;align-items:center;gap:0.5rem;font-weight:500">
        <input type="checkbox" value="${a.id}" ${checked.has(a.id) ? 'checked' : ''}>
        <span class="color-dot" style="background:${a.color}"></span>${escapeHtml(a.name)}
      </label>
    `).join('');
    return new Promise((resolve) => {
      const onCancel = () => { dlg.close(); cleanup(); resolve(null); };
      const onSubmit = async (e) => {
        e.preventDefault();
        const ids = Array.from(dlg.querySelectorAll('input[type="checkbox"]:checked')).map(i => parseInt(i.value, 10));
        try {
          await api(`/api/workers/${w.id}/areas`, { method: 'PUT', body: { area_ids: ids } });
          dlg.close(); cleanup();
          await refreshBase();
          renderTrabajadores();
          resolve(true);
        } catch (e) { alert(e.message); }
      };
      const cleanup = () => {
        $('dlg-cancel').removeEventListener('click', onCancel);
        $('dlg-form').removeEventListener('submit', onSubmit);
      };
      $('dlg-cancel').addEventListener('click', onCancel);
      $('dlg-form').addEventListener('submit', onSubmit);
      dlg.showModal();
    });
  }

  // ===== Áreas =====
  function renderAreas() {
    const target = $('tab-areas');
    const rows = state.areas.map((a) => `
      <tr>
        <td><span class="color-dot" style="background:${a.color}"></span>${escapeHtml(a.name)}</td>
        <td><code>${a.color}</code></td>
        <td><span class="pill ${a.active ? 'good' : 'bad'}">${a.active ? 'activa' : 'inactiva'}</span></td>
        <td class="actions">
          <button class="row-btn" data-id="${a.id}" data-act="edit">Editar</button>
          <button class="row-btn danger" data-id="${a.id}" data-act="del">Desactivar</button>
        </td>
      </tr>`).join('');
    target.innerHTML = `
      <div class="toolbar">
        <strong>${state.areas.length} áreas</strong>
        <button class="btn-add" id="add-area">+ Nueva área</button>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Nombre</th><th>Color</th><th>Estado</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    $('add-area').addEventListener('click', async () => {
      const v = await openDialog('Nueva área', [
        { id: 'name', label: 'Nombre', type: 'text', required: true },
        { id: 'color', label: 'Color (hex)', type: 'text', value: '#1E4DB7' },
      ]);
      if (!v) return;
      try { await api('/api/areas', { method: 'POST', body: { name: v.name, color: v.color || '#1E4DB7' } }); await refreshBase(); renderAreas(); }
      catch (e) { alert(e.message); }
    });
    target.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const a = state.areas.find(x => String(x.id) === btn.dataset.id);
        if (btn.dataset.act === 'del') {
          if (confirm(`¿Desactivar área "${a.name}"?`)) {
            await api(`/api/areas/${a.id}`, { method: 'DELETE' });
            await refreshBase(); renderAreas();
          }
        } else if (btn.dataset.act === 'edit') {
          const v = await openDialog('Editar área', [
            { id: 'name', label: 'Nombre', type: 'text', value: a.name, required: true },
            { id: 'color', label: 'Color', type: 'text', value: a.color },
          ]);
          if (!v) return;
          await api(`/api/areas/${a.id}`, { method: 'PATCH', body: { name: v.name, color: v.color } });
          await refreshBase(); renderAreas();
        }
      });
    });
  }

  // ===== Servicios =====
  function renderServicios() {
    const target = $('tab-servicios');
    const rows = state.services.map((s) => `
      <tr>
        <td><span class="color-dot" style="background:${s.area_color || '#999'}"></span>${escapeHtml(s.area_name)}</td>
        <td>${escapeHtml(s.name)}</td>
        <td><span class="pill ${s.active ? 'good' : 'bad'}">${s.active ? 'activo' : 'inactivo'}</span></td>
        <td class="actions">
          <button class="row-btn" data-id="${s.id}" data-act="edit">Editar</button>
          <button class="row-btn danger" data-id="${s.id}" data-act="del">Desactivar</button>
        </td>
      </tr>`).join('');
    target.innerHTML = `
      <div class="toolbar">
        <strong>${state.services.length} servicios</strong>
        <button class="btn-add" id="add-service">+ Nuevo servicio</button>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Área</th><th>Servicio</th><th>Estado</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    $('add-service').addEventListener('click', async () => {
      const v = await openDialog('Nuevo servicio', [
        { id: 'name', label: 'Nombre', type: 'text', required: true },
        { id: 'area_id', label: 'Área', type: 'select', options: state.areas.map(a => ({ value: a.id, label: a.name })), required: true },
      ]);
      if (!v) return;
      try { await api('/api/services', { method: 'POST', body: { name: v.name, area_id: parseInt(v.area_id, 10) } }); await refreshBase(); renderServicios(); }
      catch (e) { alert(e.message); }
    });
    target.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const s = state.services.find(x => String(x.id) === btn.dataset.id);
        if (btn.dataset.act === 'del') {
          if (confirm(`¿Desactivar servicio "${s.name}"?`)) {
            await api(`/api/services/${s.id}`, { method: 'DELETE' });
            await refreshBase(); renderServicios();
          }
        } else if (btn.dataset.act === 'edit') {
          const v = await openDialog('Editar servicio', [
            { id: 'name', label: 'Nombre', type: 'text', value: s.name, required: true },
            { id: 'area_id', label: 'Área', type: 'select', value: s.area_id, options: state.areas.map(a => ({ value: a.id, label: a.name })) },
          ]);
          if (!v) return;
          await api(`/api/services/${s.id}`, { method: 'PATCH', body: { name: v.name, area_id: parseInt(v.area_id, 10) } });
          await refreshBase(); renderServicios();
        }
      });
    });
  }

  // ===== Configuración =====
  function renderConfig() {
    const target = $('tab-config');
    const labels = {
      tiempo_aceptable_min: 'Tiempo aceptable de cita (min)',
      tiempo_aceptable_tolerancia_min: 'Tolerancia ± (min)',
      tiempo_minimo_min: 'Tiempo mínimo (min)',
      tiempo_espera_max_min: 'Espera máxima objetivo (min)',
      satisfaccion_min_pct: 'Satisfacción mínima objetivo (%)',
      cumplimiento_min_pct: 'Cumplimiento mínimo objetivo (%)',
      cancelacion_max_pct: 'Cancelación máxima objetivo (%)',
    };
    const rows = Object.entries(state.settings).map(([k, v]) => `
      <tr>
        <td>${escapeHtml(labels[k] || k)}<br><code style="font-size:0.8rem;color:var(--muted)">${k}</code></td>
        <td><input type="number" step="0.1" value="${v}" data-key="${k}" style="width:120px"></td>
        <td class="actions"><button class="row-btn" data-save="${k}">Guardar</button></td>
      </tr>`).join('');
    target.innerHTML = `
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Parámetro</th><th>Valor</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    target.querySelectorAll('button[data-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.save;
        const input = target.querySelector(`input[data-key="${key}"]`);
        try {
          await api(`/api/settings/${key}`, { method: 'PATCH', body: { value: input.value } });
          await refreshBase();
          $('status-bar').textContent = `Guardado ${key} = ${input.value}`;
        } catch (e) { alert(e.message); }
      });
    });
  }

  // ===== Generic dialog =====
  function openDialog(title, fields) {
    return new Promise((resolve) => {
      const dlg = $('dlg');
      $('dlg-title').textContent = title;
      $('dlg-fields').innerHTML = fields.map((f) => {
        if (f.type === 'select') {
          return `<div><label for="f-${f.id}">${escapeHtml(f.label)}</label>
            <select id="f-${f.id}" ${f.required ? 'required' : ''}>
              ${f.options.map(o => `<option value="${o.value}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
            </select></div>`;
        }
        if (f.type === 'checkbox') {
          return `<div><label style="display:flex;gap:0.5rem;align-items:center">
            <input type="checkbox" id="f-${f.id}" ${f.value ? 'checked' : ''}>${escapeHtml(f.label)}</label></div>`;
        }
        return `<div><label for="f-${f.id}">${escapeHtml(f.label)}</label>
          <input type="${f.type || 'text'}" id="f-${f.id}" value="${f.value !== undefined ? String(f.value).replace(/"/g, '&quot;') : ''}" ${f.required ? 'required' : ''}></div>`;
      }).join('');
      const onCancel = () => { dlg.close(); cleanup(); resolve(null); };
      const onSubmit = (e) => {
        e.preventDefault();
        const out = {};
        fields.forEach((f) => {
          const el = $('f-' + f.id);
          if (f.type === 'checkbox') out[f.id] = el.checked;
          else out[f.id] = el.value;
        });
        dlg.close(); cleanup(); resolve(out);
      };
      const cleanup = () => {
        $('dlg-cancel').removeEventListener('click', onCancel);
        $('dlg-form').removeEventListener('submit', onSubmit);
      };
      $('dlg-cancel').addEventListener('click', onCancel);
      $('dlg-form').addEventListener('submit', onSubmit);
      dlg.showModal();
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  tryAutoLogin();
})();
