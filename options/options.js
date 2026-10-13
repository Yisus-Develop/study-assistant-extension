// Study Assistant — Ajustes (options page)

const DEFAULT_SETTINGS = {
  aiProvider: "openrouter",
  mode: "study",
  autoExplain: true,
  panelEnabled: true,
  keys: { google: "", openai: "", anthropic: "", openrouter: "", opencode: "" },
  models: {
    google: "gemini-3.6-flash",
    openai: "gpt-4o-mini",
    anthropic: "claude-3-5-sonnet-20241022",
    openrouter: "nvidia/nemotron-3-nano-30b-a3b",
    opencode: "nemotron-3-ultra-free",
    local: "llama3"
  },
  headers: { google: "", openai: "", anthropic: "", openrouter: "", opencode: "", local: "" },
  localEndpoint: "http://localhost:11434"
};

const PRE_MODELS = {
  google: [
    ["gemini-3.6-flash", "Gemini 3.6 Flash ← Recomendado"],
    ["gemini-3.6-flash-lite", "Gemini 3.6 Flash Lite (más rápido)"],
    ["gemini-3.6-pro", "Gemini 3.6 Pro (más preciso)"]
  ],
  openai: [
    ["gpt-4o-mini", "GPT-4o Mini"],
    ["gpt-4o", "GPT-4o"],
    ["gpt-3.5-turbo", "GPT-3.5 Turbo"]
  ],
  anthropic: [
    ["claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet"],
    ["claude-3-5-haiku-20241022", "Claude 3.5 Haiku"]
  ],
  openrouter: [
    ["nvidia/nemotron-3-nano-30b-a3b", "Nemotron 3 Nano 30B (Gratis) ← Más rápido (0.9s)"],
    ["nvidia/nemotron-3-super-120b-a12b:free", "Nemotron 3 Super 120B (Gratis) ← Más detallado"],
    ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "Nemotron 3 Nano Reasoning 30B (Gratis)"]
  ],
  opencode: [
    ["muse-spark-1.2-contributor-free", "Muse Spark 1.2 Free (Gratis) ← Recomendado"],
    ["muse-spark-1.3-contributor-free", "Muse Spark 1.3 Free (Gratis)"],
    ["muse-spark-1.2", "Muse Spark 1.2 (Pagado)"],
    ["muse-spark-1.3", "Muse Spark 1.3 (Pagado)"],
    ["ling-3.0-flash-fin-free", "Ling 3.0 Flash Fin Free (Gratis)"],
    ["mimo-v2.5-free", "MiMo V2.5 Free (Gratis)"],
    ["big-pickle", "Big Pickle (Gratis)"],
    ["nemotron-3-ultra-free", "Nemotron 3 Ultra Free (Gratis)"],
    ["nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free (Gratis)"],
    ["mimo-v2.5-pro", "Mimo 2.5 Pro"]
  ],
  chromeai: [
    ["gemini-nano", "Gemini Nano (integrado en Chrome, gratis)"]
  ],
  local: [
    ["llama3", "Llama 3 (Ollama)"],
    ["mistral", "Mistral (Ollama)"],
    ["qwen", "Qwen (Ollama)"]
  ]
};

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };

function deepMerge(base, override) {
  const out = { ...base };
  for (const k of Object.keys(override || {})) {
    if (override[k] && typeof override[k] === "object" && !Array.isArray(override[k]) && base[k] && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

async function load() {
  const stored = await chrome.storage.local.get("settings");
  settings = deepMerge(DEFAULT_SETTINGS, stored.settings || {});
  $("panelEnabled").checked = settings.panelEnabled;
  $("autoExplain").checked = settings.autoExplain;
  $("mode").value = settings.mode;
  $("aiProvider").value = settings.aiProvider;
  renderFields();
  refreshBridge();
}

const FASTEST = { openrouter: "nvidia/nemotron-3-nano-30b-a3b", opencode: "nemotron-3-ultra-free", google: "gemini-3.6-flash" };

async function populateLiveModels(provider, select, statusEl) {
  if (!["openrouter", "opencode", "google"].includes(provider)) return;
  try {
    if (statusEl) statusEl.textContent = "Cargando modelos disponibles...";
    const res = await chrome.runtime.sendMessage({ type: "GET_AVAILABLE_MODELS", provider });
    if (!res || !res.ok || !res.models || !res.models.length) throw new Error((res && res.error) || "sin modelos");
    const current = settings.models[provider] || "";
    select.innerHTML = "";
    res.models.forEach((id) => {
      const opt = document.createElement("option");
      opt.value = id;
      let label = id;
      if (id === FASTEST[provider]) label += " ← Más rápido";
      else if (id.endsWith(":free")) label += " (gratis)";
      opt.textContent = label;
      select.appendChild(opt);
    });
    const custom = document.createElement("option");
    custom.value = "[custom]";
    custom.textContent = "✏️ Escribir modelo personalizado...";
    select.appendChild(custom);
    const inList = res.models.includes(current);
    select.value = inList ? current : "[custom]";
    if (statusEl) statusEl.textContent = `✓ ${res.models.length} modelos disponibles (gratis primero). El más rápido marcado.`;
  } catch (e) {
    if (statusEl) statusEl.textContent = "No se pudieron cargar modelos en vivo (" + (e.message || e) + "). Mostrando lista local.";
  }
}

function renderFields() {
  const provider = $("aiProvider").value;
  const container = $("fields");
  container.innerHTML = "";

  if (provider === "chromeai") {
    const info = document.createElement("div");
    info.className = "help";
    info.innerHTML = "✓ <b>No necesita clave ni configuración.</b> Usa el modelo Gemini Nano integrado en Chrome (se descarga solo la primera vez, ~2 GB). Requiere Chrome de escritorio 138+. Si no está disponible, verifica chrome://components → \"Optimization Guide On Device Model\".";
    container.appendChild(info);
  } else if (provider !== "local") {
    // API key
    container.appendChild(field({
      id: "key",
      label: `API Key (${provider})`,
      type: "password",
      value: settings.keys[provider] || "",
      placeholder: "Inserta tu clave de API...",
      help: "Se guarda localmente en tu navegador (chrome.storage.local)."
    }));

    // Modelo
    const modelWrap = document.createElement("div");
    modelWrap.className = "form-group";
    modelWrap.innerHTML = `<label for="model">Modelo (${provider})</label><select id="model"></select>`;
    const select = modelWrap.querySelector("select");
    const pre = PRE_MODELS[provider] || [];
    pre.forEach(([id, name]) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      select.appendChild(opt);
    });
    const custom = document.createElement("option");
    custom.value = "[custom]";
    custom.textContent = "✏️ Escribir modelo personalizado...";
    select.appendChild(custom);
    const current = settings.models[provider] || "";
    select.value = pre.some(([id]) => id === current) ? current : "[custom]";
    container.appendChild(modelWrap);
    // estado y botón de modelos en vivo
    const liveRow = document.createElement("div");
    liveRow.className = "help";
    liveRow.style.display = "flex";
    liveRow.style.justifyContent = "space-between";
    liveRow.style.alignItems = "center";
    liveRow.style.gap = "8px";
    liveRow.innerHTML = `<span id="liveStatus">Mostrando lista local. Pulsa actualizar para ver los disponibles.</span><button id="liveBtn" class="btn ghost" style="padding:6px 10px;font-size:11px;white-space:nowrap;">↻ Cargar disponibles</button>`;
    container.appendChild(liveRow);
    const statusEl = liveRow.querySelector("#liveStatus");
    const btn = liveRow.querySelector("#liveBtn");
    btn.addEventListener("click", () => populateLiveModels(provider, select, statusEl));
    // auto-cargar en segundo plano si hay bridge/clave
    populateLiveModels(provider, select, statusEl);

    // Input modelo personalizado si hace falta
    if (!pre.some(([id]) => id === current)) {
      container.appendChild(field({
        id: "modelCustom",
        label: "Modelo alternativo",
        type: "text",
        value: current,
        placeholder: "ej. gemini-1.5-flash"
      }));
    }

    // Cabeceras HTTP opcionales
    container.appendChild(field({
      id: "headers",
      label: "Cabeceras HTTP personalizadas (opcional)",
      type: "textarea",
      value: settings.headers[provider] || "",
      placeholder: '{ "Authorization": "Bearer MI_TOKEN" }  o  líneas "Clave: Valor"',
      help: "JSON o líneas Clave: Valor. Para autenticación adicional."
    }));
  } else {
    container.appendChild(field({
      id: "endpoint",
      label: "Endpoint de API local",
      type: "text",
      value: settings.localEndpoint,
      placeholder: "ej. http://localhost:11434"
    }));
    container.appendChild(field({
      id: "modelCustom",
      label: "Modelo local",
      type: "text",
      value: settings.models.local || "",
      placeholder: "ej. llama3, mistral, qwen",
      help: "Tal y como aparece en 'ollama list'."
    }));
    container.appendChild(field({
      id: "headers",
      label: "Cabeceras HTTP (opcional)",
      type: "textarea",
      value: settings.headers.local || "",
      placeholder: "Authorization: Bearer MI_TOKEN",
      help: "Para endpoints locales protegidos."
    }));
  }
}

function field({ id, label, type, value, placeholder, help }) {
  const wrap = document.createElement("div");
  wrap.className = "form-group";
  let input;
  if (type === "textarea") {
    input = `<textarea id="${id}" rows="3" placeholder="${placeholder || ""}"></textarea>`;
  } else {
    input = `<input id="${id}" type="${type}" placeholder="${placeholder || ""}" />`;
  }
  wrap.innerHTML = `<label for="${id}">${label}</label>${input}`;
  wrap.querySelector("input, textarea").value = value || "";
  if (help) wrap.innerHTML += `<div class="help">${help}</div>`;
  return wrap;
}

function collect() {
  const provider = $("aiProvider").value;
  settings.panelEnabled = $("panelEnabled").checked;
  settings.autoExplain = $("autoExplain").checked;
  settings.mode = $("mode").value;
  settings.aiProvider = provider;

  if (provider === "chromeai") {
    settings.models.chromeai = "gemini-nano";
  } else if (provider !== "local") {
    settings.keys[provider] = $("key").value;
    const modelSelect = $("model");
    if (modelSelect) {
      const chosen = modelSelect.value;
      settings.models[provider] = chosen === "[custom]" ? ($("modelCustom") ? $("modelCustom").value : "") : chosen;
    }
    settings.headers[provider] = $("headers") ? $("headers").value : "";
  } else {
    settings.localEndpoint = $("endpoint").value;
    settings.models.local = $("modelCustom").value;
    settings.headers.local = $("headers").value;
  }
}

$("aiProvider").addEventListener("change", renderFields);

$("saveBtn").addEventListener("click", async () => {
  collect();
  await chrome.storage.local.set({ settings });
  const saved = $("saved");
  saved.classList.add("show");
  setTimeout(() => saved.classList.remove("show"), 2500);
  setStatus("Ajustes guardados. El panel de la extensión usará este proveedor.", "ok");
});

$("testBtn").addEventListener("click", async () => {
  collect();
  const btn = $("testBtn");
  btn.disabled = true;
  btn.textContent = "Comprobando...";
  setStatus("Enviando prueba de conexión...", "info");
  try {
    await chrome.storage.local.set({ settings });
    const res = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
    setStatus((res && res.message) || "Sin respuesta del servicio.", res && res.ok ? "ok" : "err");
  } catch (e) {
    setStatus("Error: " + (e.message || e), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Testear conexión con IA";
  }
});

function setStatus(msg, cls) {
  const el = $("status");
  el.className = "status " + cls;
  el.textContent = msg;
}

const PROVIDER_LABELS = {
  opencode: "OpenCode Zen",
  google: "Google Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  openrouter: "OpenRouter",
  chromeai: "IA de Chrome (Gemini Nano)",
  local: "Local"
};

async function refreshBridge() {
  const banner = $("bridgeBanner");
  const list = $("bridgeList");
  const btn = $("bridgeRefresh");
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_BRIDGE_STATUS" });
    if (res && res.connected) {
      banner.className = "bridge on";
      list.textContent = "Claves importadas de opencode: " + (res.providers || []).map((p) => PROVIDER_LABELS[p] || p).join(", ");
      if (btn) btn.style.display = "none";
    } else {
      banner.className = "bridge";
      list.textContent = "Bridge de opencode no detectado. Inicia el puente local (tools/start-bridge.ps1) para usar automáticamente tus claves de opencode, o configura una clave manualmente abajo.";
      if (btn) btn.style.display = "inline-flex";
    }
  } catch (e) {
    banner.className = "bridge";
    list.textContent = "No se pudo consultar el estado del bridge de opencode.";
    if (btn) btn.style.display = "inline-flex";
  }
}

$("bridgeRefresh").addEventListener("click", refreshBridge);
load();