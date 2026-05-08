(() => {
  const $ = (id) => document.getElementById(id);

  const statusEl = $('status');
  const form = $('cita-form');
  const confirmation = $('confirmation');
  const voiceBtn = $('voice-toggle');

  const synth = window.speechSynthesis || null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  let voiceMode = false;
  let serviciosData = {};
  let horariosData = [];
  let currentRecognition = null;

  // ===== Cédula: máscara y lectura por pares =====
  const DIG_WORDS = ['cero','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve'];

  const NUM_WORDS = {
    cero:0, uno:1, una:1, un:1, dos:2, tres:3, cuatro:4, cinco:5, seis:6, siete:7,
    ocho:8, nueve:9, diez:10, once:11, doce:12, trece:13, catorce:14, quince:15,
    dieciseis:16, 'dieciséis':16, diecisiete:17, dieciocho:18, diecinueve:19,
    veinte:20, veintiuno:21, veintiuna:21, veintidos:22, 'veintidós':22,
    veintitres:23, 'veintitrés':23, veinticuatro:24, veinticinco:25,
    veintiseis:26, 'veintiséis':26, veintisiete:27, veintiocho:28, veintinueve:29,
    treinta:30, cuarenta:40, cincuenta:50, sesenta:60, setenta:70, ochenta:80, noventa:90,
  };

  function maskCedula(value) {
    let digits = '', letter = '';
    for (const ch of value) {
      if (digits.length < 13 && /[0-9]/.test(ch)) digits += ch;
      else if (digits.length === 13 && !letter && /[A-Za-z]/.test(ch)) letter = ch.toUpperCase();
    }
    let out = digits.slice(0, 3);
    if (digits.length > 3) out += '-' + digits.slice(3, 9);
    if (digits.length > 9) out += '-' + digits.slice(9, 13);
    if (letter) out += letter;
    return out;
  }

  function applyCedulaMask(input) {
    const before = input.value;
    const cursorBefore = input.selectionStart || 0;
    const alnumBefore = before.slice(0, cursorBefore).replace(/[^0-9a-zA-Z]/g, '').length;
    const masked = maskCedula(before);
    if (masked === before) return;
    input.value = masked;
    let count = 0, newPos = masked.length;
    for (let i = 0; i < masked.length; i++) {
      if (/[0-9A-Za-z]/.test(masked[i])) {
        count++;
        if (count === alnumBefore) { newPos = i + 1; break; }
      }
    }
    try { input.setSelectionRange(newPos, newPos); } catch (_) {}
    const digitsCount = masked.replace(/[^0-9]/g, '').length;
    input.inputMode = digitsCount >= 13 ? 'text' : 'numeric';
  }

  const LETTER_WORDS = {
    a:'A', be:'B', ce:'C', de:'D', e:'E', efe:'F', ge:'G', hache:'H',
    i:'I', jota:'J', ka:'K', ele:'L', eme:'M', ene:'N', 'eñe':'Ñ',
    o:'O', pe:'P', cu:'Q', ere:'R', erre:'R', ese:'S', te:'T',
    u:'U', uve:'V', equis:'X', ye:'Y', zeta:'Z',
  };

  const REPEAT_SCALE = { doble: 2, triple: 3, cuadruple: 4, 'cuádruple': 4, quintuple: 5, 'quíntuple': 5 };
  const PLURAL_DIGITS = {
    ceros: 'cero', unos: 'uno', treses: 'tres', cuatros: 'cuatro',
    cincos: 'cinco', seises: 'seis', sietes: 'siete', ochos: 'ocho', nueves: 'nueve',
  };
  function expandRepeats(text) {
    text = text.replace(/\b(doble|triple|cu[aá]druple|qu[ií]ntuple)\s+([a-záéíóúñ]+)/gi, (m, scale, word) => {
      const n = REPEAT_SCALE[scale.toLowerCase()] || 0;
      const w = word.toLowerCase().normalize('NFC');
      if (n && NUM_WORDS[w] !== undefined && NUM_WORDS[w] < 10) {
        return Array(n).fill(w).join(' ');
      }
      return m;
    });
    const pluralRe = /\b([a-záéíóúñ]+|\d+)\s+(ceros|unos|treses|cuatros|cincos|seises|sietes|ochos|nueves)\b/gi;
    text = text.replace(pluralRe, (m, count, plural) => {
      const singular = PLURAL_DIGITS[plural.toLowerCase()];
      if (!singular) return m;
      const c = count.toLowerCase().normalize('NFC');
      let n;
      if (NUM_WORDS[c] !== undefined && NUM_WORDS[c] >= 2 && NUM_WORDS[c] <= 9) n = NUM_WORDS[c];
      else { const x = parseInt(count, 10); if (Number.isFinite(x) && x >= 2 && x <= 9) n = x; }
      if (!n) return m;
      return Array(n).fill(singular).join(' ');
    });
    return text;
  }

  function transcriptToCedula(text) {
    text = expandRepeats(text);
    const tokens = text.toLowerCase().normalize('NFC').split(/[\s,.\-]+/).filter(Boolean);
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const v = NUM_WORDS[t];
      if (v !== undefined && [30,40,50,60,70,80,90].includes(v) &&
          tokens[i+1] === 'y' && NUM_WORDS[tokens[i+2]] !== undefined && NUM_WORDS[tokens[i+2]] < 10) {
        out += String(v + NUM_WORDS[tokens[i+2]]);
        i += 2;
        continue;
      }
      if (v !== undefined) { out += String(v); continue; }
      if (LETTER_WORDS[t]) { out += LETTER_WORDS[t]; continue; }
      if (/^\d+$/.test(t)) { out += t; continue; }
      const dl = t.match(/^(\d+)([a-z])$/);
      if (dl) { out += dl[1] + dl[2].toUpperCase(); continue; }
      if (/^[a-z]$/.test(t)) { out += t.toUpperCase(); continue; }
    }
    return out;
  }

  function spellPair(p) {
    if (p.length === 1) return DIG_WORDS[+p];
    if (p === '00') return 'cero cero';
    if (p[0] === '0') return 'cero ' + DIG_WORDS[+p[1]];
    return p; // TTS lo pronuncia natural ("23" → veintitrés)
  }

  function chunkFromEnd(digits) {
    const out = [];
    for (let i = digits.length; i > 0; i -= 2) {
      out.unshift(digits.slice(Math.max(0, i - 2), i));
    }
    return out;
  }

  function spellCedula(masked) {
    return masked.split('-').map((grp) => {
      const digits = grp.replace(/[^0-9]/g, '');
      const letters = grp.replace(/[0-9]/g, '');
      const pairs = chunkFromEnd(digits).map(spellPair).join(', ');
      const lettersWords = letters.split('').join(' ');
      return [pairs, lettersWords].filter(Boolean).join(', ');
    }).join('. ');
  }
  // ===============================================

  function announce(msg, type) {
    statusEl.className = 'status' + (type ? ' ' + type : '');
    statusEl.textContent = msg;
  }

  function speak(text) {
    if (!voiceMode || !synth) return;
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-ES';
      u.rate = 1;
      synth.speak(u);
    } catch (_) { /* ignore */ }
  }

  async function loadConfig() {
    try {
      const [serv, hor] = await Promise.all([
        fetch('/api/servicios').then((r) => r.json()),
        fetch('/api/horarios').then((r) => r.json()),
      ]);
      serviciosData = serv;
      horariosData = hor;

      const servSelect = $('servicio');
      servSelect.innerHTML =
        '<option value="">-- Selecciona --</option>' +
        Object.keys(serv)
          .map((s) => `<option value="${s}">${s}</option>`)
          .join('');

      const horaSelect = $('hora');
      horaSelect.innerHTML =
        '<option value="">-- Selecciona --</option>' +
        hor.map((h) => `<option value="${h}">${h}</option>`).join('');

      const today = new Date().toISOString().slice(0, 10);
      const fechaInput = $('fecha');
      fechaInput.value = today;
      fechaInput.min = today;

      servSelect.addEventListener('change', updateSubservicios);
      fechaInput.addEventListener('change', () => updateHorariosForFecha(fechaInput.value));
      updateHorariosForFecha(today);

      const cedulaInput = $('cedula');
      cedulaInput.addEventListener('input', () => applyCedulaMask(cedulaInput));
      cedulaInput.addEventListener('blur', () => {
        if (voiceMode && cedulaInput.value) {
          speak('Cédula capturada: ' + spellCedula(cedulaInput.value));
        }
      });
    } catch (e) {
      announce('No se pudo cargar la configuración del servicio. Recarga la página.', 'error');
    }
  }

  function isoToDow(iso) {
    return new Date(iso + 'T12:00:00').getDay(); // 0=Dom, 6=Sab
  }

  function filterHorariosByFecha(horarios, iso) {
    const dow = isoToDow(iso);
    if (dow === 0) return [];
    if (dow === 6) return horarios.filter((h) => h <= '11:30');
    return horarios;
  }

  async function updateHorariosForFecha(iso) {
    if (!iso) return;
    let slots;
    try {
      slots = await fetch('/api/horarios?fecha=' + iso).then((r) => r.json());
    } catch (_) {
      slots = filterHorariosByFecha(horariosData, iso);
    }
    const horaSelect = $('hora');
    if (!slots.length) {
      horaSelect.innerHTML = '<option value="">-- No atendemos este día --</option>';
      announce('Los domingos no se atienden citas. Elija otro día.', 'error');
    } else {
      horaSelect.innerHTML =
        '<option value="">-- Selecciona --</option>' +
        slots.map((h) => `<option value="${h}">${h}</option>`).join('');
      const dow = isoToDow(iso);
      if (dow === 6) {
        announce('Sábados solo atendemos hasta las 11:30 AM.');
      } else {
        announce('');
      }
    }
  }

  function updateSubservicios() {
    const s = $('servicio').value;
    const subs = serviciosData[s] || [];
    $('subservicio').innerHTML =
      subs.length
        ? '<option value="">-- Selecciona --</option>' +
          subs.map((x) => `<option value="${x}">${x}</option>`).join('')
        : '<option value="">-- Selecciona primero el servicio --</option>';
  }

  const hasMediaRecorder =
    typeof MediaRecorder !== 'undefined' &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const hasDictation = !!SR || hasMediaRecorder;

  voiceBtn.addEventListener('click', () => {
    voiceMode = !voiceMode;
    voiceBtn.setAttribute('aria-pressed', String(voiceMode));
    voiceBtn.textContent = voiceMode ? 'Desactivar modo voz' : 'Activar modo voz';

    document.querySelectorAll('.dictate-btn').forEach((b) => {
      b.hidden = !(voiceMode && hasDictation);
    });

    if (voiceMode) {
      const tip = hasDictation
        ? (SR
            ? 'Modo voz activado. Pulsa Dictar junto a cada campo y habla.'
            : 'Modo voz activado. Pulsa Dictar para grabar; pulsa de nuevo para detener.')
        : 'Modo voz activado. Tu navegador no permite dictado; usa el micrófono del teclado.';
      announce(tip);
      speak(tip);
    } else {
      announce('Modo voz desactivado.');
    }
  });

  document.addEventListener('focusin', (e) => {
    if (!voiceMode) return;
    const t = e.target;
    if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'SELECT' && t.tagName !== 'TEXTAREA')) return;
    const lbl = document.querySelector(`label[for="${t.id}"]`);
    if (lbl) speak(lbl.textContent.replace('*', '').trim());
  });

  function applyTranscript(targetId, target, labelTxt, transcript) {
    if (targetId === 'cedula') {
      target.value = maskCedula(transcriptToCedula(transcript));
      target.dispatchEvent(new Event('input', { bubbles: true }));
      announce(`Capturado en ${labelTxt}: ${target.value}`, 'success');
      speak(`Capturado: ${spellCedula(target.value)}`);
    } else {
      target.value = transcript;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      announce(`Capturado en ${labelTxt}: ${transcript}`, 'success');
      speak(`Capturado: ${transcript}`);
    }
  }

  function dictateWebSpeech(btn, target, targetId, labelTxt) {
    if (currentRecognition) {
      try { currentRecognition.abort(); } catch (_) {}
    }
    const rec = new SR();
    currentRecognition = rec;
    rec.lang = 'es-ES';
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    btn.disabled = true;
    btn.classList.add('listening');
    btn.textContent = 'Escuchando...';
    announce(`Escuchando para ${labelTxt}.`);
    speak(`Diga su ${labelTxt}.`);

    rec.onresult = (ev) => applyTranscript(targetId, target, labelTxt, ev.results[0][0].transcript);
    rec.onerror = (ev) => announce(`Error en reconocimiento: ${ev.error || 'desconocido'}.`, 'error');
    rec.onend = () => {
      btn.disabled = false;
      btn.classList.remove('listening');
      btn.textContent = 'Dictar';
      currentRecognition = null;
    };

    try {
      rec.start();
    } catch (e) {
      announce('No se pudo iniciar el dictado.', 'error');
      btn.disabled = false;
      btn.classList.remove('listening');
      btn.textContent = 'Dictar';
    }
  }

  let activeRecording = null; // { recorder, stream, btn, stopFn }

  async function dictateMediaRecorder(btn, target, targetId, labelTxt) {
    if (activeRecording && activeRecording.btn === btn) {
      activeRecording.stopFn();
      return;
    }
    if (activeRecording) {
      activeRecording.stopFn();
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      announce('No se pudo acceder al micrófono. Revisa los permisos.', 'error');
      return;
    }

    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg'];
    const mimeType = candidates.find((m) => {
      try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; }
    }) || '';

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    let stopped = false;
    let safetyTimeout = null;

    const finish = async () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove('listening');
      btn.textContent = 'Transcribiendo...';
      btn.disabled = true;
      announce(`Transcribiendo ${labelTxt}...`);

      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const ext = (recorder.mimeType || 'audio/webm').includes('mp4') ? 'mp4'
                : (recorder.mimeType || '').includes('mpeg') ? 'mp3'
                : 'webm';
      const fd = new FormData();
      fd.append('audio', blob, `audio.${ext}`);

      try {
        const r = await fetch('/api/transcribe', { method: 'POST', body: fd });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${r.status}`);
        }
        const { transcript } = await r.json();
        if (!transcript) {
          announce('No se detectó voz. Intenta de nuevo.', 'error');
          speak('No se detectó voz.');
        } else {
          applyTranscript(targetId, target, labelTxt, transcript);
        }
      } catch (e) {
        announce(`Error en transcripción: ${e.message}.`, 'error');
        speak('Error en transcripción.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Dictar';
        activeRecording = null;
      }
    };

    const stopFn = () => {
      if (stopped) return;
      stopped = true;
      if (safetyTimeout) clearTimeout(safetyTimeout);
      if (recorder.state !== 'inactive') recorder.stop();
    };

    recorder.onstop = finish;
    recorder.onerror = () => {
      announce('Error de grabación.', 'error');
      stopFn();
    };

    activeRecording = { recorder, stream, btn, stopFn };
    btn.classList.add('listening');
    btn.textContent = 'Detener';
    announce(`Grabando para ${labelTxt}. Pulsa Detener cuando termines.`);
    speak(`Grabando ${labelTxt}.`);

    recorder.start();
    safetyTimeout = setTimeout(stopFn, 15000);
  }

  document.querySelectorAll('.dictate-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const target = $(targetId);
      const labelEl = document.querySelector(`label[for="${targetId}"]`);
      const labelTxt = labelEl ? labelEl.textContent.replace('*', '').trim() : targetId;

      if (SR) {
        dictateWebSpeech(btn, target, targetId, labelTxt);
      } else if (hasMediaRecorder) {
        dictateMediaRecorder(btn, target, targetId, labelTxt);
      } else {
        announce('Tu navegador no soporta dictado. Usa el botón de micrófono del teclado.', 'error');
      }
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const data = {
      nombre: $('nombre').value.trim(),
      cedula: $('cedula').value.trim(),
      telefono: $('telefono').value.trim(),
      correo: $('correo').value.trim(),
      servicio: $('servicio').value,
      subservicio: $('subservicio').value,
      fecha: $('fecha').value,
      hora: $('hora').value,
      accesibilidad: $('accesibilidad').checked,
    };

    const missing = [];
    if (!data.nombre) missing.push('nombre');
    if (!data.cedula) missing.push('cédula');
    if (!data.servicio) missing.push('servicio');
    if (!data.subservicio) missing.push('tipo de servicio');
    if (!data.fecha) missing.push('fecha');
    if (!data.hora) missing.push('hora');

    if (missing.length) {
      const msg = `Faltan datos: ${missing.join(', ')}.`;
      announce(msg, 'error');
      speak(msg);
      const firstMissing = ['nombre', 'cedula', 'servicio', 'subservicio', 'fecha', 'hora'].find(
        (id) => !$(id).value
      );
      if (firstMissing) $(firstMissing).focus();
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    announce('Enviando cita...');

    try {
      const r = await fetch('/api/citas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        const detail = Array.isArray(errBody.detail)
          ? errBody.detail.map((d) => d.msg || JSON.stringify(d)).join('; ')
          : (errBody.detail || 'Error del servidor');
        throw new Error(detail);
      }
      const cita = await r.json();
      showConfirmation(cita);
    } catch (err) {
      announce(`No se pudo agendar la cita: ${err.message}`, 'error');
      speak('No se pudo agendar la cita. Intenta de nuevo.');
    } finally {
      submitBtn.disabled = false;
    }
  });

  function showConfirmation(cita) {
    form.hidden = true;
    confirmation.hidden = false;
    const detail = `Cita asignada a ${cita.trabajador} el ${cita.fecha} a las ${cita.hora}. Servicio: ${cita.servicio} – ${cita.subservicio}.`;
    $('confirmation-detail').textContent = detail;
    announce('Cita agendada correctamente. ' + detail, 'success');
    speak('Cita agendada correctamente. ' + detail);
    confirmation.focus();
  }

  $('new-cita').addEventListener('click', () => {
    form.reset();
    form.hidden = false;
    confirmation.hidden = true;
    statusEl.textContent = '';
    statusEl.className = 'status';
    $('servicio').dispatchEvent(new Event('change'));
    const today = new Date().toISOString().slice(0, 10);
    $('fecha').value = today;
    voiceData = {};
    updateVoiceData();
    showScreen('intro');
  });

  // ===== PANTALLAS =====
  const intro = $('intro-card');
  const voiceFlow = $('voice-flow');
  const manualMode = $('manual-mode');

  function showScreen(name) {
    intro.hidden = name !== 'intro';
    voiceFlow.hidden = name !== 'voice';
    manualMode.hidden = name !== 'manual';
    confirmation.hidden = name !== 'confirmation';
    const acc = $('account');
    if (acc) acc.hidden = name !== 'account';
    if (name === 'intro') $('start-voice').focus();
    if (name === 'manual') $('nombre').focus();
    if (name === 'account') refreshAccount();
  }

  $('start-manual').addEventListener('click', async () => {
    await refreshAuth();
    if (!currentUser) {
      showScreen('account');
      return;
    }
    showScreen('manual');
  });
  $('start-voice').addEventListener('click', () => startVoiceFlow());
  $('btn-exit-voice').addEventListener('click', () => exitVoiceFlow('manual'));
  $('account-btn').addEventListener('click', () => showScreen('account'));
  $('account-back').addEventListener('click', () => showScreen('intro'));

  // ===== FLUJO CONVERSACIONAL =====
  const promptEl = $('voice-prompt');
  const vStatusEl = $('voice-status');
  const vDataEl = $('voice-data');

  let activeListen = null;
  let persistentStream = null;
  let voiceData = {};

  function vSetStatus(text, kind) {
    vStatusEl.className = 'voice-status' + (kind ? ' ' + kind : '');
    vStatusEl.textContent = text || '';
  }

  function updateVoiceData() {
    const items = [
      ['Nombre', voiceData.nombre],
      ['Cédula', voiceData.cedula],
      ['Teléfono', voiceData.telefono],
      ['Servicio', voiceData.servicio && (voiceData.subservicio ? `${voiceData.servicio} – ${voiceData.subservicio}` : voiceData.servicio)],
      ['Fecha', voiceData.fecha],
      ['Hora', voiceData.hora],
    ].filter(([, v]) => v);
    vDataEl.innerHTML = items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  function speakAsync(text) {
    promptEl.textContent = text;
    return new Promise((resolve) => {
      if (!synth) { resolve(); return; }
      try { synth.cancel(); } catch (_) {}
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-ES';
      u.rate = 1;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      u.onend = finish;
      u.onerror = finish;
      synth.speak(u);
      setTimeout(finish, Math.min(20000, 1500 + text.length * 90));
    });
  }

  async function ensureStream() {
    if (persistentStream && persistentStream.active) return persistentStream;
    persistentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return persistentStream;
  }

  function pickMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg'];
    for (const m of candidates) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
    }
    return '';
  }

  const btnSpeak = $('btn-speak');
  const isAppleMobile =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const useWebSpeech = !!SR && !isAppleMobile;

  // ===== VAD (Voice Activity Detection) =====
  let vadStream = null;
  let vadCtx = null;
  let vadAnalyser = null;
  let vadEnabled = false;

  async function setupVAD() {
    if (vadEnabled) return true;
    try {
      vadStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      vadCtx = new Ctx();
      if (vadCtx.state === 'suspended') {
        try { await vadCtx.resume(); } catch (_) {}
      }
      const source = vadCtx.createMediaStreamSource(vadStream);
      vadAnalyser = vadCtx.createAnalyser();
      vadAnalyser.fftSize = 1024;
      vadAnalyser.smoothingTimeConstant = 0.3;
      source.connect(vadAnalyser);

      try {
        const warmRec = new MediaRecorder(vadStream);
        warmRec.start();
        await new Promise((r) => setTimeout(r, 600));
        if (warmRec.state === 'recording') warmRec.stop();
        await new Promise((r) => setTimeout(r, 200));
      } catch (_) {}

      vadEnabled = true;
      return true;
    } catch (e) {
      vadEnabled = false;
      vadStream = null;
      vadCtx = null;
      return false;
    }
  }

  function teardownVAD() {
    try { if (vadStream) vadStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { if (vadCtx) vadCtx.close(); } catch (_) {}
    vadStream = null;
    vadCtx = null;
    vadAnalyser = null;
    vadEnabled = false;
  }

  function getRMS() {
    if (!vadAnalyser) return 0;
    const buf = new Uint8Array(vadAnalyser.fftSize);
    vadAnalyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  function resetSpeakBtn() {
    btnSpeak.hidden = true;
    btnSpeak.classList.remove('recording');
    btnSpeak.textContent = 'Hablar';
    btnSpeak.disabled = false;
    btnSpeak.onclick = null;
  }

  function startWebSpeech(session, cleanups) {
    vSetStatus('Escuchando...', 'listening');
    const tid = setTimeout(() => session.finish(''), 12000);
    cleanups.push(() => clearTimeout(tid));
    const rec = new SR();
    rec.lang = 'es-ES';
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => session.finish(ev.results[0][0].transcript);
    rec.onerror = () => session.finish('');
    rec.onend = () => session.finish('');
    cleanups.push(() => { try { rec.abort(); } catch (_) {} });
    try { rec.start(); }
    catch (e) { session.finish(''); }
  }

  async function startVAD(session, cleanups) {
    if (vadCtx && vadCtx.state === 'suspended') {
      try { await vadCtx.resume(); } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, 200));

    if (!vadStream || !vadStream.active) {
      session.finish('');
      return;
    }

    const mimeType = pickMime();
    const recorder = new MediaRecorder(vadStream, mimeType ? { mimeType } : {});
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    let voiceDetected = false;
    let lastVoice = 0;
    const start = Date.now();
    const SILENCE_MS = 800;
    const VOICE_THRESHOLD = 0.025;
    const MAX_MS = 12000;
    const PREROLL_MS = 3000;

    recorder.onstop = async () => {
      vSetStatus('Transcribiendo...');
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const ext = (recorder.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
      const fd = new FormData();
      fd.append('audio', blob, `audio.${ext}`);
      try {
        const r = await fetch('/api/transcribe', { method: 'POST', body: fd });
        if (!r.ok) throw new Error('http ' + r.status);
        const { transcript } = await r.json();
        session.finish(transcript || '');
      } catch (e) {
        session.finish('');
      }
    };

    const stopRec = () => {
      if (recorder.state === 'recording') recorder.stop();
    };
    cleanups.push(stopRec);

    const interval = setInterval(() => {
      const rms = getRMS();
      const now = Date.now();
      if (rms > VOICE_THRESHOLD) {
        voiceDetected = true;
        lastVoice = now;
      }
      if (voiceDetected && now - lastVoice > SILENCE_MS) stopRec();
      else if (!voiceDetected && now - start > PREROLL_MS) stopRec();
      else if (now - start > MAX_MS) stopRec();
    }, 80);
    cleanups.push(() => clearInterval(interval));

    vSetStatus('Escuchando...', 'listening');
    recorder.start();
  }

  function startPushToTalk(session, cleanups, timeout) {
    vSetStatus('Pulse Hablar para responder o use los botones.', '');
    btnSpeak.hidden = false;
    btnSpeak.disabled = false;
    btnSpeak.textContent = 'Hablar';
    btnSpeak.classList.remove('recording');

    const tidWait = setTimeout(() => session.finish(''), timeout);
    cleanups.push(() => clearTimeout(tidWait));

    btnSpeak.onclick = async () => {
      clearTimeout(tidWait);
      btnSpeak.disabled = true;
      vSetStatus('Pidiendo permiso de micrófono...', 'listening');

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        vSetStatus('No se pudo acceder al micrófono. Conceda permiso o use los botones.', 'error');
        btnSpeak.disabled = false;
        return;
      }
      cleanups.push(() => { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} });

      const mimeType = pickMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = async () => {
        vSetStatus('Transcribiendo...');
        btnSpeak.disabled = true;
        btnSpeak.textContent = 'Procesando...';
        btnSpeak.classList.remove('recording');
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const ext = (recorder.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
        const fd = new FormData();
        fd.append('audio', blob, `audio.${ext}`);
        try {
          const r = await fetch('/api/transcribe', { method: 'POST', body: fd });
          if (!r.ok) throw new Error('http ' + r.status);
          const { transcript } = await r.json();
          session.finish(transcript || '');
        } catch (e) {
          session.finish('');
        }
      };

      cleanups.push(() => { if (recorder.state === 'recording') recorder.stop(); });

      btnSpeak.onclick = () => {
        if (recorder.state === 'recording') recorder.stop();
      };
      btnSpeak.disabled = false;
      btnSpeak.classList.add('recording');
      btnSpeak.textContent = 'Detener';
      vSetStatus('Grabando. Pulse Detener cuando termine.', 'listening');

      const stopTimer = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 15000);
      cleanups.push(() => clearTimeout(stopTimer));

      recorder.start();
    };
  }

  function listenAsync({ timeout = 60000 } = {}) {
    return new Promise(async (resolve) => {
      let finished = false;
      const cleanups = [];
      const session = {
        finish: (transcript) => {
          if (finished) return;
          finished = true;
          cleanups.forEach((c) => { try { c(); } catch (_) {} });
          if (activeListen === session) activeListen = null;
          resetSpeakBtn();
          resolve((transcript || '').toString());
        },
      };
      activeListen = session;

      if (useWebSpeech) return startWebSpeech(session, cleanups);
      if (vadEnabled) return startVAD(session, cleanups);

      if (!hasMediaRecorder && !window.isSecureContext) {
        vSetStatus('Para usar el micrófono abra la app por HTTPS. Use los botones.', 'error');
        const tid = setTimeout(() => session.finish(''), timeout);
        cleanups.push(() => clearTimeout(tid));
        return;
      }
      if (!hasMediaRecorder) {
        vSetStatus('Su navegador no soporta dictado. Use los botones.', 'error');
        const tid = setTimeout(() => session.finish(''), timeout);
        cleanups.push(() => clearTimeout(tid));
        return;
      }

      startPushToTalk(session, cleanups, timeout);
    });
  }

  $('btn-yes').addEventListener('click', () => activeListen && activeListen.finish('sí'));
  $('btn-no').addEventListener('click', () => activeListen && activeListen.finish('no'));
  $('btn-repeat').addEventListener('click', () => activeListen && activeListen.finish('repetir'));

  // ===== PARSERS =====
  function strip(text) {
    return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function parseYesNo(text) {
    const t = strip(text).trim().replace(/[.,!?]+$/, '');
    if (!t) return null;
    if (/^(si|si senor|claro|correcto|correcta|confirmo|confirmar|exacto|perfecto|de acuerdo|afirmativo|positivo|adelante|asi es|esta bien|ok|okey)$/.test(t)) return 'yes';
    if (/^(no|negativo|incorrecto|incorrecta|cancelar|cancelado|equivocado|equivocada|repetir|otra vez|de nuevo|cambiar|mal)$/.test(t)) return 'no';
    if (/\bsi\b/.test(t) && !/\bno\b/.test(t)) return 'yes';
    if (/\bno\b/.test(t) && !/\bsi\b/.test(t)) return 'no';
    return null;
  }

  function matchChoice(text, options) {
    const t = strip(text).trim();
    if (!t) return null;
    const tokens = t.split(/\s+/);

    for (const tok of tokens) {
      const v = NUM_WORDS[tok];
      if (v !== undefined && v >= 1 && v <= options.length) return options[v - 1];
      const num = parseInt(tok, 10);
      if (Number.isFinite(num) && num >= 1 && num <= options.length) return options[num - 1];
    }
    for (const opt of options) {
      const ot = strip(opt);
      if (t === ot || t.includes(ot) || ot.includes(t)) return opt;
    }
    const tWords = new Set(tokens);
    let best = null, bestScore = 0;
    for (const opt of options) {
      const oWords = strip(opt).split(/\s+/);
      const score = oWords.filter((w) => tWords.has(w)).length;
      if (score > bestScore) { best = opt; bestScore = score; }
    }
    return bestScore > 0 ? best : null;
  }

  function isoDay(d) { return d.toISOString().slice(0, 10); }

  function parseFecha(text) {
    const t = strip(text).trim();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (/\bhoy\b/.test(t)) return isoDay(today);
    if (/pasado\s+manana/.test(t)) {
      const d = new Date(today); d.setDate(d.getDate() + 2); return isoDay(d);
    }
    if (/manana/.test(t)) {
      const d = new Date(today); d.setDate(d.getDate() + 1); return isoDay(d);
    }
    return null;
  }

  function parseTelefono(text) {
    const digits = transcriptToCedula(text).replace(/[^0-9]/g, '');
    if (digits.length >= 8) return digits.slice(0, 8);
    return null;
  }

  function spellPhone(digits) {
    return chunkFromEnd(digits).map(spellPair).join(', ');
  }

  let geminiAvailable = null;
  async function checkGeminiOnce() {
    if (geminiAvailable !== null) return geminiAvailable;
    try {
      const r = await fetch('/api/extract/status');
      const data = await r.json();
      geminiAvailable = !!data.configured;
    } catch (e) {
      geminiAvailable = false;
    }
    return geminiAvailable;
  }

  async function extractWithGemini(field, transcript, context) {
    if (!(await checkGeminiOnce())) return undefined;
    try {
      const r = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, transcript, context: context || null }),
      });
      if (r.status === 503) { geminiAvailable = false; return undefined; }
      if (!r.ok) return undefined;
      const data = await r.json();
      return data.value === undefined ? undefined : data.value;
    } catch (e) {
      return undefined;
    }
  }

  function findClosestHora(targetMinutes, maxDiff = 30) {
    let best = null, bestDiff = Infinity;
    for (const slot of horariosData) {
      const [h, mi] = slot.split(':').map(Number);
      const diff = Math.abs(h * 60 + mi - targetMinutes);
      if (diff < bestDiff) { bestDiff = diff; best = slot; }
    }
    return best && bestDiff <= maxDiff ? best : null;
  }

  function detectPeriodo(t) {
    if (/\b(de la tarde|p\.?m\.?|pm)\b/.test(t)) return 'pm';
    if (/\b(de la noche|de la madrugada)\b/.test(t)) return /madrugada/.test(t) ? 'am' : 'pm';
    if (/\b(de la manana|del mediodia|a\.?m\.?|am)\b/.test(t)) return /mediodia/.test(t) ? 'noon' : 'am';
    return null;
  }

  function applyPeriodo(hh, periodo) {
    if (periodo === 'pm' && hh < 12) hh += 12;
    else if (periodo === 'am' && hh === 12) hh = 0;
    else if (periodo === null && hh >= 1 && hh <= 6) hh += 12;
    return hh;
  }

  function matchHora(text) {
    const t = strip(text).trim();
    const tokens = t.split(/\s+/);
    const periodo = detectPeriodo(t);
    let hh = null, mm = 0;

    let m = t.match(/(\d{1,2})\s*[:.]\s*(\d{1,2})/);
    if (m) { hh = +m[1]; mm = +m[2]; }
    if (hh === null) {
      m = t.match(/(\d{1,2})\s+(?:y\s+)?(\d{1,2})/);
      if (m) { hh = +m[1]; mm = +m[2]; }
    }
    if (hh === null) {
      for (let i = 0; i + 2 < tokens.length; i++) {
        if (tokens[i + 1] === 'y') {
          const h = NUM_WORDS[tokens[i]];
          let m2;
          if (tokens[i + 2] === 'media') m2 = 30;
          else if (tokens[i + 2] === 'cuarto') m2 = 15;
          else m2 = NUM_WORDS[tokens[i + 2]];
          if (h !== undefined && m2 !== undefined && h <= 23) {
            hh = h; mm = m2; break;
          }
        }
      }
    }
    if (hh === null) {
      for (const tok of tokens) {
        const v = NUM_WORDS[tok];
        if (v !== undefined && v >= 1 && v <= 12) { hh = v; break; }
        const n = parseInt(tok, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 12) { hh = n; break; }
      }
    }
    if (hh === null) return null;

    hh = applyPeriodo(hh, periodo);
    return findClosestHora(hh * 60 + mm);
  }

  function fechaToWords(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    const d = new Date(iso + 'T12:00:00');
    const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    return `${dias[d.getDay()]} ${d.getDate()} de ${meses[d.getMonth()]}`;
  }

  function horaToWords(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!m) return hhmm;
    const h = +m[1], mi = +m[2];
    const periodo = h >= 12 ? 'de la tarde' : 'de la mañana';
    const h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
    if (mi === 0) return `${h12} en punto ${periodo}`;
    if (mi === 30) return `${h12} y media ${periodo}`;
    if (mi === 15) return `${h12} y cuarto ${periodo}`;
    return `${h12} y ${mi} ${periodo}`;
  }

  // ===== STEPS =====
  async function ask(prompt) {
    await speakAsync(prompt);
    const transcript = await listenAsync();
    vSetStatus(transcript ? `Entendí: "${transcript}"` : 'No se escuchó nada.');
    return transcript;
  }

  async function askYesNo(prompt) {
    while (true) {
      const t = await ask(prompt);
      let yn = parseYesNo(t);
      if (!yn) {
        const g = await extractWithGemini('yesno', t);
        if (g === 'yes' || g === 'no') yn = g;
      }
      if (yn) return yn === 'yes';
      await speakAsync('No le entendí. Por favor responda sí o no.');
    }
  }

  async function askValue({ prompt, field, parse, formatTTS, confirmPrompt, postProcess, context, missingPrompt = 'No le entendí. Vamos a intentarlo de nuevo.' }) {
    while (true) {
      const t = await ask(prompt);
      if (!t) {
        const tryAgain = await askYesNo('No le escuché. ¿Quiere intentarlo de nuevo? Sí o no.');
        if (!tryAgain) throw new Error('cancelled');
        continue;
      }
      let value = null;
      if (field) {
        const g = await extractWithGemini(field, t, context);
        if (g !== undefined && g !== null && g !== '') value = g;
      }
      if (!value && parse) value = parse(t);
      if (!value && !field && !parse) value = t.trim();

      if (value && postProcess) value = postProcess(value);

      if (!value) {
        await speakAsync(missingPrompt);
        continue;
      }
      const ttsVal = formatTTS ? formatTTS(value) : value;
      const confirmMsg = confirmPrompt ? confirmPrompt(value, ttsVal) : `Capturé: ${ttsVal}. ¿Es correcto?`;
      const ok = await askYesNo(confirmMsg);
      if (ok) return value;
    }
  }

  function exitVoiceFlow(target = 'intro') {
    if (synth) try { synth.cancel(); } catch (_) {}
    if (activeListen) activeListen.finish('');
    if (persistentStream) {
      try { persistentStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      persistentStream = null;
    }
    teardownVAD();
    voiceData = {};
    updateVoiceData();
    promptEl.textContent = '';
    vSetStatus('');
    resetSpeakBtn();
    showScreen(target);
  }

  async function startVoiceFlow() {
    showScreen('voice');
    voiceData = {};
    updateVoiceData();

    await speakAsync('Hola, bienvenido.');
    await speakAsync('Soy el sistema de citas BACCITA. Le voy a pedir permiso para usar el micrófono.');

    if (!useWebSpeech && hasMediaRecorder) {
      vSetStatus('Pidiendo permiso de micrófono...');
      const ok = await setupVAD();
      if (!ok) {
        await speakAsync('No pude acceder al micrófono. Tendrá que pulsar el botón Hablar después de cada pregunta.');
      } else {
        await speakAsync('Listo, ya puedo escucharle.');
      }
    }

    try {
      const wantsVoice = await askYesNo('Bienvenido a BACCITA. ¿Desea agendar su cita por voz? Diga sí o no, o pulse uno de los botones.');
      if (!wantsVoice) {
        await speakAsync('De acuerdo. Pasamos al formulario manual.');
        exitVoiceFlow('manual');
        return;
      }

      const authed = await ensureVoiceAuth();
      if (!authed) {
        await speakAsync('No pudimos identificarlo. Saliendo del modo voz.');
        exitVoiceFlow('intro');
        return;
      }

      voiceData.nombre = currentUser.name;
      voiceData.cedula = currentUser.cedula || '';
      voiceData.telefono = currentUser.phone || '';
      updateVoiceData();

      if (!voiceData.cedula) {
        voiceData.cedula = await askVoiceCedula('No tiene cédula registrada. Dígamela ahora.');
        updateVoiceData();
      }

      if (!voiceData.telefono) {
        voiceData.telefono = await askValue({
          prompt: 'Dígame su teléfono. Son ocho dígitos. Puede decir cada dígito o leerlos en pares.',
          field: 'telefono',
          parse: parseTelefono,
          formatTTS: (v) => spellPhone(v),
          missingPrompt: 'No reconocí un teléfono de ocho dígitos. Vuelva a intentar.',
        });
        updateVoiceData();
      }

      const servicios = Object.keys(serviciosData);
      voiceData.servicio = await askValue({
        prompt: `¿Qué servicio necesita? Las opciones son: ${servicios.map((s, i) => `${i + 1}. ${s}`).join('. ')}. Puede decir el número, el nombre, o describirlo.`,
        field: 'servicio',
        context: { options: servicios },
        parse: (t) => matchChoice(t, servicios),
      });
      updateVoiceData();

      const subs = serviciosData[voiceData.servicio];
      voiceData.subservicio = await askValue({
        prompt: `¿Qué tipo de ${voiceData.servicio.toLowerCase()}? Las opciones son: ${subs.map((s, i) => `${i + 1}. ${s}`).join('. ')}.`,
        field: 'subservicio',
        context: { options: subs },
        parse: (t) => matchChoice(t, subs),
      });
      updateVoiceData();

      while (true) {
        voiceData.fecha = await askValue({
          prompt: '¿Para qué día quiere la cita? Puede decir hoy, mañana, pasado mañana, o una fecha específica como "el quince de mayo".',
          field: 'fecha',
          parse: parseFecha,
          formatTTS: fechaToWords,
          missingPrompt: 'No entendí la fecha. Vuelva a intentar.',
        });
        const dow = isoToDow(voiceData.fecha);
        if (dow === 0) {
          await speakAsync('Los domingos no se atienden citas. Elija otro día.');
          continue;
        }
        break;
      }
      updateVoiceData();

      const horariosFecha = filterHorariosByFecha(horariosData, voiceData.fecha);
      const horaSabadoNote = isoToDow(voiceData.fecha) === 6
        ? ' Como es sábado, solo atendemos hasta las once y media de la mañana.'
        : '';
      voiceData.hora = await askValue({
        prompt: `¿A qué hora le conviene?${horaSabadoNote} Diga la hora aproximada, por ejemplo "a las nueve y media de la mañana".`,
        field: 'hora',
        context: { options: horariosFecha },
        parse: matchHora,
        postProcess: (v) => {
          if (horariosFecha.includes(v)) return v;
          const m = /^(\d{1,2}):(\d{2})$/.exec(v);
          if (!m) return null;
          const target = +m[1] * 60 + +m[2];
          let best = null, bestDiff = Infinity;
          for (const slot of horariosFecha) {
            const [h, mi] = slot.split(':').map(Number);
            const diff = Math.abs(h * 60 + mi - target);
            if (diff < bestDiff) { bestDiff = diff; best = slot; }
          }
          return best && bestDiff <= 120 ? best : null;
        },
        formatTTS: horaToWords,
        confirmPrompt: (_v, tts) => `Según su solicitud, el bloque disponible es a las ${tts}. ¿Le sirve?`,
        missingPrompt: 'No reconocí esa hora dentro del horario disponible. Vuelva a intentar.',
      });
      updateVoiceData();

      voiceData.accesibilidad = await askYesNo('¿Es usted persona con capacidades diferentes? Sí o no.');

      const review =
        `Voy a agendar: ${voiceData.nombre}, cédula ${spellCedula(voiceData.cedula)}, ` +
        `teléfono ${spellPhone(voiceData.telefono)}, ` +
        `${voiceData.servicio} – ${voiceData.subservicio}, ` +
        `para el ${fechaToWords(voiceData.fecha)} a las ${horaToWords(voiceData.hora)}. ¿Confirma?`;
      const ok = await askYesNo(review);
      if (!ok) {
        await speakAsync('Entendido, cita cancelada. Puede empezar de nuevo o usar el formulario manual.');
        exitVoiceFlow('intro');
        return;
      }

      vSetStatus('Enviando cita...');
      promptEl.textContent = 'Enviando su cita.';
      const r = await fetch('/api/citas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: voiceData.nombre,
          cedula: voiceData.cedula,
          telefono: voiceData.telefono || '',
          correo: '',
          servicio: voiceData.servicio,
          subservicio: voiceData.subservicio,
          fecha: voiceData.fecha,
          hora: voiceData.hora,
          accesibilidad: !!voiceData.accesibilidad,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const detail = Array.isArray(err.detail) ? err.detail.map((d) => d.msg).join('; ') : (err.detail || 'Error del servidor');
        throw new Error(detail);
      }
      const cita = await r.json();
      const successMsg = `Cita agendada. Asignada a ${cita.trabajador} el ${fechaToWords(cita.fecha)} a las ${horaToWords(cita.hora)}.`;
      $('confirmation-detail').textContent = successMsg;
      showScreen('confirmation');
      await speakAsync(successMsg);
    } catch (e) {
      if (e.message === 'cancelled') {
        await speakAsync('Cancelado. Pasamos al formulario manual.');
        exitVoiceFlow('manual');
        return;
      }
      vSetStatus('Error: ' + e.message, 'error');
      await speakAsync('Hubo un error: ' + e.message + '. Pasamos al formulario manual.');
      exitVoiceFlow('manual');
    }
  }

  // ===== CUENTA / HISTORIAL =====
  let currentUser = null;

  async function refreshAuth() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      const data = await r.json();
      currentUser = data.user || null;
    } catch (_) {
      currentUser = null;
    }
    const lbl = $('account-label');
    if (currentUser) lbl.textContent = currentUser.name.split(' ')[0];
    else lbl.textContent = 'Mi cuenta';
    await updatePendingBadge();
  }

  async function updatePendingBadge() {
    const btn = $('account-btn');
    const old = btn.querySelector('.pending-badge');
    if (old) old.remove();
    if (!currentUser) return;
    try {
      const citas = await fetch('/api/citas', { credentials: 'include' }).then(r => r.json());
      const pendientes = citas.filter(c => c.estado === 'atendida' && !c.has_satisfaction);
      if (pendientes.length) {
        const span = document.createElement('span');
        span.className = 'pending-badge';
        span.textContent = pendientes.length;
        span.title = `${pendientes.length} encuesta(s) pendiente(s)`;
        btn.appendChild(span);
      }
      return pendientes;
    } catch (_) {
      return [];
    }
  }

  async function refreshAccount() {
    await refreshAuth();
    $('account-not-logged').hidden = !!currentUser;
    $('account-logged').hidden = !currentUser;
    if (currentUser) {
      $('logged-name').textContent = currentUser.name;
      const citas = await loadMisCitas();
      const pendientesEncuesta = citas.filter(c => c.estado === 'atendida' && !c.has_satisfaction);
      if (pendientesEncuesta.length && !sessionStorage.getItem('survey_prompted_' + currentUser.id)) {
        sessionStorage.setItem('survey_prompted_' + currentUser.id, '1');
        setTimeout(() => openSatisfactionDialog(pendientesEncuesta[0]), 400);
      }
    }
  }

  $('login-form-c').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error-c').textContent = '';
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('login-username').value.trim(), password: $('login-password').value }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.detail || 'Login falló');
      }
      await refreshAccount();
    } catch (e) { $('login-error-c').textContent = e.message; }
  });

  $('register-form-c').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('register-error-c').textContent = '';
    try {
      const body = {
        username: $('reg-username').value.trim(),
        password: $('reg-password').value,
        name: $('reg-name').value.trim(),
        cedula: $('reg-cedula').value.trim(),
        phone: $('reg-phone').value.trim(),
        email: $('reg-email').value.trim(),
        accesibilidad: $('reg-accesibilidad').checked,
      };
      const r = await fetch('/api/auth/register', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const det = Array.isArray(err.detail) ? err.detail.map((d) => d.msg).join('; ') : (err.detail || 'Error');
        throw new Error(det);
      }
      await refreshAccount();
    } catch (e) { $('register-error-c').textContent = e.message; }
  });

  $('logout-c').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    currentUser = null;
    sessionStorage.clear();
    await refreshAccount();
  });

  $('agendar-nueva').addEventListener('click', () => showScreen('intro'));

  async function loadMisCitas() {
    const target = $('mis-citas');
    target.innerHTML = '<p style="color:#6b7280">Cargando...</p>';
    try {
      const r = await fetch('/api/citas', { credentials: 'include' });
      const citas = await r.json();
      if (!citas.length) {
        target.innerHTML = '<p style="color:#6b7280">No tiene citas aún. Agende una desde la pantalla principal.</p>';
        return [];
      }
      citas.sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora));
      target.innerHTML = citas.map(misCitaCard).join('');
      target.querySelectorAll('button[data-id]').forEach((btn) => {
        btn.addEventListener('click', () => onMisCitaAction(btn.dataset.id, btn.dataset.act, citas.find(c => c.id === btn.dataset.id)));
      });
      return citas;
    } catch (e) {
      target.innerHTML = '<p style="color:#b91c1c">Error: ' + e.message + '</p>';
      return [];
    }
  }

  function misCitaCard(c) {
    const labels = { pendiente: 'Pendiente', en_proceso: 'En proceso', atendida: 'Atendida', no_atendida: 'No atendida', cancelada: 'Cancelada' };
    const actions = [];
    if (c.estado === 'pendiente') actions.push(`<button class="cancel" data-id="${c.id}" data-act="cancel">Cancelar</button>`);
    if (c.estado === 'atendida' && !c.has_satisfaction) actions.push(`<button class="satisfy" data-id="${c.id}" data-act="satisfy">Encuesta</button>`);
    const sentNote = c.estado === 'atendida' && c.has_satisfaction
      ? `<span style="font-size:0.82rem;color:var(--success);font-weight:600">✓ Encuesta enviada (${Math.round(c.satisfaction_puntaje)}%)</span>`
      : '';
    return `
      <div class="mis-cita" data-estado="${c.estado}">
        <div class="mis-cita-head">
          <span class="mis-cita-fecha">${fechaToWords(c.fecha)} · ${horaToWords(c.hora)}</span>
          <span style="font-size:0.85rem;font-weight:700;background:#eef;color:#0A2A66;padding:0.15rem 0.55rem;border-radius:999px">${labels[c.estado] || c.estado}</span>
        </div>
        <div class="mis-cita-meta">
          ${escapeHtmlClient(c.servicio_nombre)} · ${escapeHtmlClient(c.subservicio_nombre || '')}
          ${c.worker_name ? '<br>Trabajador: ' + escapeHtmlClient(c.worker_name) : ''}
        </div>
        ${sentNote}
        ${actions.length ? `<div class="mis-cita-actions">${actions.join('')}</div>` : ''}
      </div>
    `;
  }

  function escapeHtmlClient(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function onMisCitaAction(id, act, cita) {
    if (act === 'cancel') {
      if (!confirm('¿Cancelar esta cita?')) return;
      await fetch(`/api/citas/${id}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: 'cancelada' }),
      });
      await loadMisCitas();
    } else if (act === 'satisfy') {
      openSatisfactionDialog(cita);
    }
  }

  function openSatisfactionDialog(cita) {
    const dlg = $('satisfaction-dialog');
    $('sat-cita-info').textContent = `${cita.servicio_nombre} · ${cita.fecha} · ${cita.hora}`;
    const questions = [
      '¿El trabajador fue amable?',
      '¿El tiempo fue adecuado?',
      '¿Se resolvió su problema?',
      '¿La información fue clara?',
      '¿Recomendaría el servicio?',
      '¿El sistema fue accesible?',
      '¿Volvería a utilizar este sistema?',
    ];
    $('sat-questions').innerHTML = questions.map((q, i) => `
      <label class="sat-q"><input type="checkbox" id="sat-q${i}"> ${q}</label>
    `).join('');
    $('sat-comentario').value = '';

    const onCancel = () => { dlg.close(); cleanup(); };
    const onSubmit = async (e) => {
      e.preventDefault();
      const respuestas = questions.map((_, i) => $('sat-q' + i).checked);
      try {
        await fetch(`/api/citas/${cita.id}/satisfaction`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ respuestas, comentario: $('sat-comentario').value }),
        });
        dlg.close(); cleanup();
        await loadMisCitas();
        await updatePendingBadge();
      } catch (e) { alert(e.message); }
    };
    const cleanup = () => {
      $('sat-cancel').removeEventListener('click', onCancel);
      $('satisfaction-form').removeEventListener('submit', onSubmit);
    };
    $('sat-cancel').addEventListener('click', onCancel);
    $('satisfaction-form').addEventListener('submit', onSubmit);
    dlg.showModal();
  }

  // ===== VOICE AUTH =====
  async function askVoiceCedula(prompt = 'Diga su cédula completa.') {
    return await askValue({
      prompt,
      field: 'cedula',
      parse: (t) => {
        const masked = maskCedula(transcriptToCedula(t));
        return /^\d{3}-\d{6}-\d{4}[A-Z]$/.test(masked) ? masked : null;
      },
      formatTTS: (v) => spellCedula(v),
      missingPrompt: 'No reconocí una cédula válida. Vuelva a intentar.',
    });
  }

  async function askVoicePIN(prompt) {
    return await askValue({
      prompt,
      parse: (t) => {
        const digits = transcriptToCedula(t).replace(/[^0-9]/g, '');
        return digits.length >= 4 ? digits.slice(0, 4) : null;
      },
      formatTTS: (v) => v.split('').join(' '),
      missingPrompt: 'No reconocí cuatro dígitos. Diga cuatro números.',
    });
  }

  async function ensureVoiceAuth() {
    await refreshAuth();
    if (currentUser) return true;
    await speakAsync('Antes de continuar, necesitamos identificarlo.');
    const tieneCuenta = await askYesNo('¿Ya tiene cuenta en BACCITA? Diga sí o no.');
    if (tieneCuenta) return await voiceLoginFlow();
    return await voiceRegisterFlow();
  }

  async function voiceLoginFlow() {
    let intento = 0;
    while (intento < 3) {
      intento += 1;
      const cedula = await askVoiceCedula('Diga su cédula.');
      const pin = await askVoicePIN('Ahora diga su clave numérica de cuatro dígitos.');
      try {
        const r = await fetch('/api/auth/login', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: cedula, password: pin }),
        });
        if (r.ok) {
          currentUser = (await r.json()).user;
          await refreshAuth();
          await speakAsync(`Bienvenido, ${currentUser.name}.`);
          return true;
        }
      } catch (_) {}
      await speakAsync('No pude verificar su cuenta.');
      const reintentar = await askYesNo('¿Quiere reintentar el ingreso? Diga sí. Diga no para crear una cuenta nueva.');
      if (!reintentar) return await voiceRegisterFlow();
    }
    await speakAsync('Demasiados intentos. Le crearé una cuenta nueva.');
    return await voiceRegisterFlow();
  }

  async function voiceRegisterFlow() {
    await speakAsync('Vamos a crear su cuenta. Solo necesito su nombre, cédula, y una clave.');
    const nombre = await askValue({ prompt: 'Diga su nombre completo.', field: 'nombre' });
    const cedula = await askVoiceCedula('Ahora dígame su cédula.');
    const pin = await askVoicePIN('Cree una clave numérica de cuatro dígitos. La usará en próximas visitas.');
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cedula, password: pin, name: nombre, cedula }),
      });
      if (r.ok) {
        currentUser = (await r.json()).user;
        await refreshAuth();
        await speakAsync(`Cuenta creada. Bienvenido, ${nombre}.`);
        return true;
      }
      const err = await r.json().catch(() => ({}));
      const detail = Array.isArray(err.detail) ? err.detail.map(d => d.msg).join('; ') : (err.detail || 'Error');
      if (/ya existe/i.test(detail)) {
        await speakAsync('Esa cédula ya tiene una cuenta. Vamos a ingresarla.');
        const pin2 = await askVoicePIN('Diga la clave de su cuenta existente.');
        const r2 = await fetch('/api/auth/login', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: cedula, password: pin2 }),
        });
        if (r2.ok) {
          currentUser = (await r2.json()).user;
          await refreshAuth();
          await speakAsync(`Bienvenido, ${currentUser.name}.`);
          return true;
        }
        await speakAsync('Clave incorrecta.');
        return false;
      }
      await speakAsync('No pude crear la cuenta.');
      return false;
    } catch (e) {
      await speakAsync('Hubo un error de conexión.');
      return false;
    }
  }

  refreshAuth();
  loadConfig();
})();
