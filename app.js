// ------------------ Máquina de estados + lógica de cierre de línea ------------------

const Estado = {
  ESPERAR_ENVASE: "ESPERAR_ENVASE",
  TOMAR_PESO: "TOMAR_PESO",
  DESVIAR_OK: "DESVIAR_OK",
  DESVIAR_RECHAZO: "DESVIAR_RECHAZO",
  CONFIRMAR_SALIDA: "CONFIRMAR_SALIDA",
  LINEA_CERRADA: "LINEA_CERRADA",
};

let running = true;
let estado = Estado.ESPERAR_ENVASE;

// UI
const elEstado = document.getElementById("estado");
const elMotor = document.getElementById("motor");
const elPeso = document.getElementById("peso");
const elResultado = document.getElementById("resultado");
const elOkCount = document.getElementById("okCount");
const elBadCount = document.getElementById("badCount");
const elVentana = document.getElementById("ventana");

const alarmBox = document.getElementById("alarmBox");
const alarmText = document.getElementById("alarmText");

const presenceDot = document.getElementById("presenceDot");
const scaleDot = document.getElementById("scaleDot");
const exitDot = document.getElementById("exitDot");

const diverter = document.getElementById("diverter");
const laneA = document.getElementById("laneA");
const laneB = document.getElementById("laneB");
const logList = document.getElementById("logList");

// Controles
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");
const btnReset = document.getElementById("btnReset");
const btnSpawn = document.getElementById("btnSpawn");

const speedEl = document.getElementById("speed");
const targetEl = document.getElementById("target");
const tolEl = document.getElementById("tol");
const critMinEl = document.getElementById("critMin");
const critMaxEl = document.getElementById("critMax");
const samplesEl = document.getElementById("samples");
const windowNEl = document.getElementById("windowN");
const maxFailsEl = document.getElementById("maxFails");
const timeoutEl = document.getElementById("timeout");

// Stats / QC
let okCount = 0;
let badCount = 0;
let qcWindow = []; // array de booleans (OK=true, NOK=false)
let motivoCierre = "";

// Envases en banda principal (varios a la vez)
let envases = [];
let nextId = 1;

// Zonas (px dentro de la banda)
const Z = {
  sensorX: 80,
  scaleX: 170,
  diverterX: 260,
  exitX: 460, // se ajusta luego según ancho real
};

function nowMs() { return performance.now(); }

function setEstado(s) {
  estado = s;
  elEstado.textContent = s;
}

function setMotor(on) {
  running = on;
  elMotor.textContent = on ? "ON" : "OFF";
}

function log(msg, kind = "info") {
  const div = document.createElement("div");
  div.className = "logItem";
  const cls = kind === "ok" ? "ok" : kind === "bad" ? "bad" : kind === "warn" ? "warn" : "";
  div.innerHTML = `<span class="${cls}">${msg}</span>`;
  logList.prepend(div);
  // limitar log
  while (logList.childNodes.length > 40) logList.removeChild(logList.lastChild);
}

function showAlarm(show, text = "") {
  alarmBox.classList.toggle("show", show);
  alarmText.textContent = show ? text : "—";
}

// Helpers
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function randn() {
  // ruido approx normal (Box-Muller)
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function readConfig() {
  const target = Number(targetEl.value);
  const tol = Number(tolEl.value);
  const min = target - tol;
  const max = target + tol;

  return {
    speed: Number(speedEl.value),
    target,
    min,
    max,
    critMin: Number(critMinEl.value),
    critMax: Number(critMaxEl.value),
    samples: clamp(Number(samplesEl.value), 1, 15),
    windowN: clamp(Number(windowNEl.value), 1, 50),
    maxFails: clamp(Number(maxFailsEl.value), 1, 50),
    timeoutMs: Math.max(0.2, Number(timeoutEl.value)) * 1000,
  };
}

function qcPush(ok, windowN) {
  qcWindow.unshift(ok);
  qcWindow = qcWindow.slice(0, windowN);
}

function qcFails() {
  return qcWindow.filter(v => v === false).length;
}

function updateHud(pesoText = null, resultText = null) {
  elOkCount.textContent = String(okCount);
  elBadCount.textContent = String(badCount);

  const { windowN } = readConfig();
  const fails = qcFails();
  elVentana.textContent = `${fails}/${Math.min(windowN, qcWindow.length)}`;

  if (pesoText !== null) elPeso.textContent = pesoText;
  if (resultText !== null) elResultado.textContent = resultText;
}

// ------------------ Modelado de envase ------------------
// Cada envase tiene: posición, flags de eventos por zona, resultado, timers
function spawnEnvase() {
  if (estado === Estado.LINEA_CERRADA) return;
  const e = {
    id: nextId++,
    x: -40,
    ok: null,
    peso: null,

    seenPresence: false,
    weighed: false,
    diverted: false,
    exitSeen: false,

    tDivertStart: null, // para timeout salida
    dom: null,
  };
  envases.push(e);
  renderEnvase(e);
  log(`Envase <b>#${e.id}</b> creado`, "info");
}

function renderEnvase(e) {
  const belt = document.getElementById("belt");
  const pkg = document.createElement("div");
  pkg.className = "package";
  pkg.style.left = `${e.x}px`;
  pkg.dataset.id = String(e.id);

  const label = document.createElement("div");
  label.className = "pkgLabel";
  label.textContent = `#${e.id}`;
  pkg.appendChild(label);

  belt.appendChild(pkg);
  e.dom = pkg;
}

function removeEnvase(e) {
  if (e.dom) e.dom.remove();
  envases = envases.filter(x => x !== e);
}

// ------------------ Simulación sensor de peso ------------------
function sampleWeight(target) {
  // 1) mayoría “normal” alrededor de target
  // 2) a veces outliers críticos (vacío/sobrellenado)
  const r = Math.random();
  if (r < 0.06) return target - 40 + randn() * 1.8; // crítico bajo
  if (r < 0.12) return target + 40 + randn() * 1.8; // crítico alto
  if (r < 0.22) return target - 10 + randn() * 1.2; // fuera de tolerancia
  if (r < 0.32) return target + 10 + randn() * 1.2; // fuera de tolerancia

  return target + randn() * 1.2; // normal con ruido
}

function filteredWeight(cfg) {
  const samples = [];
  for (let i = 0; i < cfg.samples; i++) samples.push(sampleWeight(cfg.target));
  const avg = samples.reduce((a,b)=>a+b,0) / samples.length;
  return avg;
}

// ------------------ Cierre de línea ------------------
function closeLine(reason) {
  motivoCierre = reason;
  setEstado(Estado.LINEA_CERRADA);
  setMotor(false);
  diverter.classList.remove("toB");
  showAlarm(true, reason);
  log(`🚨 <b>CIERRE DE LÍNEA</b>: ${reason}`, "warn");
}

// ------------------ Desviador (pulso) ------------------
// Industrial: default A, si rechazo -> B por X ms y vuelve a A
let divertUntil = 0;
const DIVERT_PULSE_MS = 260;

function setDiverterToBPulse() {
  divertUntil = nowMs() + DIVERT_PULSE_MS;
}

// ------------------ Sensores visuales ------------------
function setDotActive(dot, on) {
  dot.classList.toggle("active", on);
}

// ------------------ Loop principal ------------------
let lastT = null;

function loop(t) {
  if (lastT === null) lastT = t;
  const dt = t - lastT;
  lastT = t;

  const cfg = readConfig();
  const belt = document.getElementById("belt");
  Z.exitX = belt.clientWidth - 10;

  // desviador pulso
  if (nowMs() < divertUntil) diverter.classList.add("toB");
  else diverter.classList.remove("toB");

  // si línea cerrada: animación en pausa pero mantenemos UI viva
  if (!running) {
    requestAnimationFrame(loop);
    return;
  }

  // mover envases
  const speedPx = cfg.speed; // px/s
  for (const e of [...envases]) {
    e.x += (speedPx * dt) / 1000;
    if (e.dom) e.dom.style.left = `${e.x}px`;

    // Zona presencia (evento 1 vez)
    if (!e.seenPresence && e.x >= Z.sensorX) {
      e.seenPresence = true;
      setDotActive(presenceDot, true);
      setEstado(Estado.TOMAR_PESO);
      log(`Presencia detectada en <b>#${e.id}</b>`, "info");
      setTimeout(() => setDotActive(presenceDot, false), 150);
    }

    // Zona báscula (evento 1 vez)
    if (!e.weighed && e.x >= Z.scaleX) {
      e.weighed = true;
      setDotActive(scaleDot, true);

      const w = filteredWeight(cfg);
      e.peso = w;

      // Reglas
      if (w < cfg.critMin || w > cfg.critMax) {
        updateHud(`${w.toFixed(1)} g`, "CRÍTICO");
        e.dom?.classList.add("bad");
        closeLine(`Peso CRÍTICO en #${e.id}: ${w.toFixed(1)}g (crit ${cfg.critMin}-${cfg.critMax})`);
        setTimeout(() => setDotActive(scaleDot, false), 150);
        break;
      }

      const ok = (w >= cfg.min && w <= cfg.max);
      e.ok = ok;

      updateHud(`${w.toFixed(1)} g`, ok ? "OK" : "NO OK");
      log(`Peso #${e.id}: <b>${w.toFixed(1)}g</b> → ${ok ? '<span class="ok">OK</span>' : '<span class="bad">NO OK</span>'}`, ok ? "ok" : "bad");

      // Ventana QC
      qcPush(ok, cfg.windowN);
      const fails = qcFails();
      updateHud();

      // Demasiados fallos en ventana => cierre
      if (qcWindow.length >= Math.min(cfg.windowN, qcWindow.length) && fails >= cfg.maxFails && qcWindow.length >= cfg.windowN) {
        closeLine(`Demasiados rechazos: ${fails}/${cfg.windowN}. Revisar proceso/calibración.`);
        setTimeout(() => setDotActive(scaleDot, false), 150);
        break;
      }

      // Desvío (pulso a B si NO OK)
      if (ok) {
        setEstado(Estado.DESVIAR_OK);
        e.dom?.classList.add("ok");
      } else {
        setEstado(Estado.DESVIAR_RECHAZO);
        e.dom?.classList.add("bad");
        setDiverterToBPulse();
      }

      // empieza timeout salida
      e.tDivertStart = nowMs();
      setEstado(Estado.CONFIRMAR_SALIDA);

      setTimeout(() => setDotActive(scaleDot, false), 150);
    }

    // Zona salida (evento 1 vez)
    if (!e.exitSeen && e.x >= Z.exitX) {
      e.exitSeen = true;
      setDotActive(exitDot, true);
      setTimeout(() => setDotActive(exitDot, false), 150);

      // manda a línea
      pushToLane(e.ok ? laneA : laneB, e);
      removeEnvase(e);

      // si ya no hay envases, estado vuelve a esperar
      if (envases.length === 0) setEstado(Estado.ESPERAR_ENVASE);
      continue;
    }

    // Timeout salida (atasco): si ya pesó y no sale
    if (e.tDivertStart !== null && nowMs() - e.tDivertStart > cfg.timeoutMs) {
      closeLine(`Timeout de salida (atasco) en #${e.id}. No confirmó salida en ${cfg.timeoutMs/1000}s.`);
      break;
    }
  }

  requestAnimationFrame(loop);
}

// Animación en líneas A/B
function pushToLane(laneEl, e) {
  const pkg = document.createElement("div");
  pkg.className = `package ${e.ok ? "ok" : "bad"}`;
  pkg.style.left = "-30px";

  const label = document.createElement("div");
  label.className = "pkgLabel";
  label.textContent = `#${e.id}`;
  pkg.appendChild(label);

  laneEl.appendChild(pkg);

  let x = -30;
  const target = laneEl.clientWidth + 30;
  const speed = 260;

  function step(tPrev) {
    const go = (tNow) => {
      const dt = tNow - tPrev;
      tPrev = tNow;
      x += (speed * dt) / 1000;
      pkg.style.left = `${x}px`;
      if (x < target) requestAnimationFrame(go);
      else pkg.remove();
    };
    requestAnimationFrame(go);
  }
  requestAnimationFrame((t) => step(t));

  if (e.ok) okCount++;
  else badCount++;

  updateHud(e.peso ? `${e.peso.toFixed(1)} g` : "—", e.ok ? "OK → Línea A" : "NO OK → Línea B");
  log(`Salida #${e.id} → ${e.ok ? '<span class="ok">Línea A</span>' : '<span class="bad">Línea B</span>'}`, e.ok ? "ok" : "bad");
}

// ------------------ Botones ------------------
btnStart.addEventListener("click", () => {
  if (estado === Estado.LINEA_CERRADA) return; // no start si está cerrada
  setMotor(true);
  showAlarm(false);
  log("Start", "info");
});

btnStop.addEventListener("click", () => {
  setMotor(false);
  log("Stop", "warn");
});

btnReset.addEventListener("click", () => {
  // reset sólo si estaba cerrada
  if (estado !== Estado.LINEA_CERRADA) return;
  motivoCierre = "";
  showAlarm(false);

  // limpia todo (en real podrías elegir no borrar contadores)
  envases.forEach(e => e.dom?.remove());
  envases = [];
  qcWindow = [];

  diverter.classList.remove("toB");
  divertUntil = 0;

  updateHud("—", "—");
  setEstado(Estado.ESPERAR_ENVASE);
  setMotor(true);
  log("✅ Reset operador. Línea reanudada.", "ok");
});

btnSpawn.addEventListener("click", () => spawnEnvase());

// Spawn automático (suave)
setInterval(() => {
  if (!running) return;
  if (estado === Estado.LINEA_CERRADA) return;
  if (envases.length < 3 && Math.random() < 0.35) spawnEnvase();
}, 700);

// Inicial
setEstado(Estado.ESPERAR_ENVASE);
setMotor(true);
updateHud("—", "—");
requestAnimationFrame(loop);
