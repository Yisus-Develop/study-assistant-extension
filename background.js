// Study Assistant — Bom Condutor
// Service worker: resuelve llamadas IA multi-proveedor (sin CORS gracias a host_permissions).

const DEFAULT_SETTINGS = {
  aiProvider: "openrouter",
  mode: "study",
  autoExplain: true,
  panelEnabled: true,
  keys: {
    google: "",
    openai: "",
    anthropic: "",
    openrouter: "",
    opencode: ""
  },
  models: {
    google: "gemini-3.6-flash",
    openai: "gpt-4o-mini",
    anthropic: "claude-3-5-sonnet-20241022",
    openrouter: "nvidia/nemotron-3-nano-30b-a3b",
    opencode: "nemotron-3-ultra-free",
    chromeai: "gemini-nano",
    local: "llama3"
  },
  headers: {
    google: "",
    openai: "",
    anthropic: "",
    openrouter: "",
    opencode: "",
    local: ""
  },
  localEndpoint: "http://localhost:11434"
};

const BRIDGE_URL = "http://127.0.0.1:47821";
let bridgeKeys = null;
let bridgeStatus = { connected: false, providers: [], checkedAt: 0 };

async function loadBridgeKeys(force) {
  if (!force && bridgeStatus.checkedAt && Date.now() - bridgeStatus.checkedAt < 30000) {
    return bridgeStatus;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const resp = await fetch(`${BRIDGE_URL}/v1/keys`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error("bridge http " + resp.status);
    const data = await resp.json();
    if (!data || !data.ok) throw new Error("bridge payload inválido");
    bridgeKeys = data.providers || {};
    bridgeStatus = { connected: true, providers: data.order || Object.keys(bridgeKeys), checkedAt: Date.now() };
  } catch (e) {
    bridgeKeys = null;
    bridgeStatus = { connected: false, providers: [], checkedAt: Date.now() };
  }
  chrome.storage.local.set({ bridgeStatus }).catch(() => {});
  return bridgeStatus;
}

function parseHeaders(str) {
  if (!str || !str.trim()) return {};
  try {
    const obj = JSON.parse(str);
    return obj && typeof obj === "object" ? obj : {};
  } catch (e) {
    const headers = {};
    for (const line of String(str).split("\n")) {
      const sep = line.indexOf(":");
      if (sep !== -1) {
        const key = line.substring(0, sep).trim();
        const value = line.substring(sep + 1).trim();
        if (key && value) headers[key] = value;
      }
    }
    return headers;
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(["settings", "bridgeStatus"]);
  const s = Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
  // Migración: nvidia eliminado -> openrouter
  if (s.aiProvider === "nvidia") s.aiProvider = "openrouter";
  if (s.models && s.models.nvidia) delete s.models.nvidia;
  if (s.keys && s.keys.nvidia) delete s.keys.nvidia;
  if (stored.bridgeStatus) bridgeStatus = Object.assign(bridgeStatus, stored.bridgeStatus);
  // Migración: base antigua de Zen (los modelos gratis no existen ahí)
  if (s.opencodeBase && s.opencodeBase.includes("/zen/go/v1")) s.opencodeBase = "https://opencode.ai/zen/v1";
  // Migración: el nano de OpenRouter no lleva sufijo :free (eso devuelve 404)
  if (s.models && s.models.openrouter === "nvidia/nemotron-3-nano-30b-a3b:free") s.models.openrouter = "nvidia/nemotron-3-nano-30b-a3b";
  // Migración: Gemini 1.5 ya no existe (404) -> 2.0 Flash
  if (s.models && s.models.google && /gemini-(1\.5|2\.0|2\.5)/.test(s.models.google)) s.models.google = "gemini-3.6-flash";
  if (s.models && s.models.google === "gemini-2.0-flash-exp") s.models.google = "gemini-3.6-flash";
  let importedKeys = false;
  const NO_KEY_PROVIDERS = ["chromeai", "local"];
  if (bridgeKeys) {
    for (const prov of Object.keys(bridgeKeys)) {
      const bk = bridgeKeys[prov];
      if (bk.key && !s.keys[prov]) { s.keys[prov] = bk.key; importedKeys = true; }
      if (bk.model && !s.models[prov]) s.models[prov] = bk.model;
      if (prov === "opencode" && bk.base) s.opencodeBase = bk.base;
      if (prov === "local" && bk.endpoint) s.localEndpoint = bk.endpoint;
    }
    if (!NO_KEY_PROVIDERS.includes(s.aiProvider) && !s.keys[s.aiProvider]) {
      const avail = (bridgeStatus.providers || []).filter((p) => bridgeKeys[p] && bridgeKeys[p].key);
      if (avail.length) s.aiProvider = avail[0];
    }
    if (s.aiProvider === "google") {
      if (bridgeKeys.opencode && bridgeKeys.opencode.key) {
        s.aiProvider = "opencode";
      } else if (bridgeKeys.openrouter && bridgeKeys.openrouter.key) {
        s.aiProvider = "openrouter";
      }
    }
  }
  // Migración: Zen gratis bloqueado fuera de OpenCode (400 MissingSessionID) y es lento.
  // Si el proveedor activo es opencode con modelo -free, migrar a openrouter.
  const isFreeZen = s.aiProvider === "opencode" && /-free$/.test(s.models && s.models.opencode || "");
  if (isFreeZen && s.keys && s.keys.openrouter) {
    s.aiProvider = "openrouter";
    chrome.storage.local.set({ settings: s }).catch(() => {});
  }
  // Migración antigua: Zen gratis es lento -> OpenRouter nano
  const mig = await chrome.storage.local.get("migratedToOpenrouter");
  if (!mig.migratedToOpenrouter && s.aiProvider === "opencode" && s.keys && s.keys.openrouter) {
    s.aiProvider = "openrouter";
    chrome.storage.local.set({ migratedToOpenrouter: true, settings: s }).catch(() => {});
  }
  // Persistir claves importadas para sobrevivir si el bridge se cae
  if (importedKeys) chrome.storage.local.set({ settings: s }).catch(() => {});
  return s;
}

async function askAI(prompt, settings, signal) {
  const provider = settings.aiProvider || "google";
  const key = (settings.keys && settings.keys[provider]) || "";
  const model = (settings.models && settings.models[provider]) || "";
  const headers = parseHeaders(settings.headers && settings.headers[provider]);

  switch (provider) {
    case "google": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7 }
        })
      });
      if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini no devolvió texto.");
      return text;
    }

    case "openai": {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...headers },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.7 })
      });
      if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}`);
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error("OpenAI no devolvió texto.");
      return text;
    }

    case "anthropic": {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          ...headers
        },
        body: JSON.stringify({ model, max_tokens: 1000, messages: [{ role: "user", content: prompt }], temperature: 0.7 })
      });
      if (!resp.ok) throw new Error(`Claude HTTP ${resp.status}`);
      const data = await resp.json();
      const text = data?.content?.[0]?.text;
      if (!text) throw new Error("Claude no devolvió texto.");
      return text;
    }

    case "opencode": {
      // Zen gratis bloqueado (400 MissingSessionID) - lanzar error directo para forzar fallback
      if (/-free$/.test(model)) throw new Error("OpenCode Zen gratis no disponible fuera de OpenCode (usa OpenRouter).");
      let base = (settings.opencodeBase || "https://opencode.ai/zen/v1").replace(/\/$/, "");
      if (/-free$/.test(model) && !base.includes("/zen/v1")) base = "https://opencode.ai/zen/v1";
      const resp = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...headers },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.6, max_tokens: 900 }),
        signal
      });
      if (!resp.ok) throw new Error(`OpenCode Zen HTTP ${resp.status}`);
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error("OpenCode Zen no devolvió texto.");
      return text;
    }

    case "openrouter": {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": "https://github.com/Yisus-Develop/study-assistant",
          "X-Title": "Study Assistant Extension",
          ...headers
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.6, max_tokens: 900, reasoning: { effort: "low" } }),
        signal
      });
      if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`);
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error("OpenRouter no devolvió texto.");
      return text;
    }

    case "chromeai": {
      const lm = self.LanguageModel || (self.ai && self.ai.languageModel);
      if (!lm) throw new Error("Tu navegador no tiene la API de IA integrada (requiere Chrome de escritorio 138+).");
      let availability = "unknown";
      try {
        availability = await lm.availability();
      } catch (e) {
        try { availability = (await lm.capabilities()).available; } catch (e2) {}
      }
      if (availability === "unavailable" || availability === "no") {
        throw new Error("Gemini Nano no está disponible en este navegador. Descarga el modelo desde chrome://components (\"Optimization Guide On Device Model\").");
      }
      const session = await lm.create({
        initialPrompts: [{ role: "system", content: "Eres un instructor de conducir portugués. Respondes SIEMPRE en español, de forma breve y clara." }],
        monitor(m) { m.addEventListener("downloadprogress", () => {}); }
      });
      try {
        const text = await session.prompt(prompt);
        if (!text) throw new Error("Gemini Nano no devolvió texto.");
        return text;
      } finally {
        try { session.destroy(); } catch (e) { /* noop */ }
      }
    }

    case "local": {
      const endpoint = (settings.localEndpoint || "http://localhost:11434").replace(/\/$/, "");
      // Intento OpenAI-compatible (/v1/chat/completions)
      try {
        const resp = await fetch(`${endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.7 })
        });
        if (resp.ok) {
          const data = await resp.json();
          const text = data?.choices?.[0]?.message?.content;
          if (text) return text;
        }
      } catch (e) {
        /* fallback a Ollama nativo */
      }
      // Fallback: API nativa de Ollama (/api/generate)
      const base = endpoint.replace(/\/v1\/?$/, "");
      const resp = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ model, prompt, stream: false })
      });
      if (!resp.ok) throw new Error(`Local HTTP ${resp.status}`);
      const data = await resp.json();
      const text = data?.response;
      if (!text) throw new Error("El modelo local no devolvió texto.");
      return text;
    }

    default:
      throw new Error("Proveedor de IA no soportado.");
  }
}

async function callWithRetry(fn, attempts = 2, delayMs = 700) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const text = await fn();
      if (text && text.trim()) return text;
      lastErr = new Error("No devolvió texto");
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastErr;
}

async function askAIWithFallback(prompt, settings) {
  const attemptWithTimeout = (s, timeout = 12000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    return askAI(prompt, s, ctrl.signal).finally(() => clearTimeout(timer));
  };
  const hasKey = (p) => (settings.keys && settings.keys[p]);
  const REMOTE = ["openrouter", "google", "opencode", "openai", "anthropic"];
  // Orden: proveedor elegido primero; luego los que tengan clave (OpenCode gratis ya no sirve fuera de la app, va al final)
  const order = [];
  if (settings.aiProvider) order.push(settings.aiProvider);
  for (const p of REMOTE) if (hasKey(p) && !order.includes(p)) order.push(p);
  let lastErr;
  for (const prov of order) {
    const s = Object.assign({}, settings, {
      aiProvider: prov,
      models: Object.assign({}, settings.models, { [prov]: (settings.models && settings.models[prov]) || undefined })
    });
    try {
      return await callWithRetry(() => attemptWithTimeout(s), 1);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("No hay proveedor de IA disponible.");
}

function buildExplainPrompt(question) {
  const options = question.options || {};
  const optionsStr = Object.entries(options)
    .map(([letter, text]) => `${letter}) ${text}`)
    .join("\n");

  const correctText = options[question.correctOption] || question.correctOption;
  const answerLine = `${question.correctOption}) ${correctText}`;

  return [
    `Pregunta del examen de conducir de Portugal: "${question.question}"`,
    `Opciones:\n${optionsStr}`,
    `Respuesta correcta: ${answerLine}`,
    "",
    "Responde SOLO en español con este formato exacto y sin nada más:",
    `Correcta: ${answerLine}`,
    "Explicación: <de 3 a 4 frases explicando la norma del Código da Estrada que la justifica>",
    "",
    "PROHIBIDO: mostrar tu proceso de pensamiento, razonamiento interno, pasos numerados o texto en inglés.",
    "No menciones ni parafrasees estas instrucciones. Empieza directamente por «Correcta:»."
  ].join("\n");
}

// Líneas que son razonamiento interno/meta del modelo (se descartan aunque contengan palabras en español)
const REASONING_META = [
  /key constraint/i,
  /core question/i,
  /identify the/i,
  /determine the/i,
  /the statement is/i,
  /the multiple choice/i,
  /i need to respond/i,
  /i['’]?ll (?:start|respond|answer|keep|note)/i,
  /here['’]?s (?:a|the) thinking/i,
  /analy[sz]e (?:user|the request|user request)/i,
  /s[eé] conciso/i,
  /responde directamente/i,
  /solo la explicaci[oó]n, nada m[aá]s/i,
  /the user (?:wants|asked|expects|requires)/i,
  /^(?:the|this) (?:question|statement|issue|rule|fact|answer|correct)/i,
  /^correcta\s*:\s*[a-d0-9]?\s*$/i,
  /^expica\s*[:.]/i,
  /^\s*\d+\s*[\.)]\s*(?:identify|determine|explain|check|verify|analy|extract|format|review|conclusion|fact|question)/i,
  /^\s*(?:[-*•]\s*)?(?:analysis|plan|observation|reasoning|thinking|next steps|constraints?)\s*:?\s*$/i,
  /^\s*(?:ok+|okay|claro|entendido|vamos a|voy a|let me|let['’]?s|first,|second,|third,|now,|then,|finally,|to answer|note that)\b/i
];
// Inglés típico de razonamiento — una línea en inglés SIN marcas de español se descarta
const ENGLISH_META = /\b(?:the|and|with|because|should|would|there|their|this|from|shows?|wants?|directly|sentence|process|prohibited outside|is indeed)\b/i;
// Marcas de español/pt REALES que una explicación legítima usa (sin préstamos como
// «Código da Estrada», que también aparecen citados dentro de razonamiento en inglés)
const SPANISH_MARKERS = /\b(?:que|porque|para|seg[uú]n|est[aá]|prohibido|proibido|deben?|circulaci[oó]n|velocidad|distancia|se[nñ]al|carril|peat[oó]n|prioridad|multa|antes|despu[eé]s|entre|hasta|desde|tambi[eé]n|puede[n]?|obligatorio|permitido|siempre|fuera de|fuera|de la|en el|una|pero|no se|estacionar|aplica|norma|r[eí]g|v[ií]a)\b/i;

function stripAIReasoning(text) {
  if (!text || !text.trim()) return text;
  let cleaned = text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\*\*/g, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 1) Filtro línea a línea: fuera el razonamiento interno del modelo
  const kept = cleaned
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l)
    .filter((l) => {
      if (REASONING_META.some((r) => r.test(l))) return false;
      if (ENGLISH_META.test(l) && !SPANISH_MARKERS.test(l)) return false;
      return true;
    });
  cleaned = kept.join("\n").trim();

  // 2) Marcadores de sección útil en español — todo lo que ESTÉ ANTES del primero se descarta
  const USEFUL = /(?:^|\n)\s*(?:\*\*)?(?:Norma|Regla|Correcta|Respuesta|Explicaci[oó]n|Trampa|Vocabulario|Art\.|Código da Estrada|Se[ñn]al|La |El |Este |Seg[úu]n|Pregunta|Opc)/i;
  const cut = cleaned.search(USEFUL);
  if (cut > 0) cleaned = cleaned.slice(cut).trim();

  // 3) Si no queda nada útil (solo razonamiento basura), devolver vacío
  if (!cleaned || cleaned.length < 10) return "";

  return cleaned;
}

async function testConnection(settings) {
  try {
    const text = await askAIWithFallback("Responde únicamente con la palabra PING", settings);
    if (text.toLowerCase().includes("ping")) {
      return { ok: true, message: "Conexión exitosa. El modelo respondió correctamente." };
    }
    return { ok: true, message: `Conexión establecida pero la respuesta no contenía 'PING': "${text.substring(0, 50)}"` };
  } catch (err) {
    return { ok: false, message: `Error de conexión: ${err.message || err}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "AI_EXPLAIN") {
    (async () => {
      await loadBridgeKeys();
      const settings = await getSettings();
      if (!settings.panelEnabled) return;
      const text = await askAIWithFallback(buildExplainPrompt(msg.question), settings);
      const cleaned = stripAIReasoning(text);
      if (!cleaned) {
        sendResponse({ ok: false, error: "La IA devolvió solo razonamiento interno, sin explicación. Pulsa «✨ Explicar con IA» otra vez." });
        return;
      }
      sendResponse({ ok: true, text: cleaned });
    })().catch((err) => {
      sendResponse({ ok: false, error: err.message || String(err) });
    });
    return true; // respuesta asíncrona
  }

  if (msg.type === "AI_FOLLOWUP") {
    (async () => {
      await loadBridgeKeys();
      const settings = await getSettings();
      if (!settings.panelEnabled) return;
      const history = msg.history || [];
      const lastUser = history.filter((m) => m.role === "user").pop();
      if (!lastUser) return sendResponse({ ok: false, error: "No hay pregunta." });
      const q = msg.question || {};
      const options = q.options || {};
      const isTrueFalse = Object.keys(options).length === 2 &&
        Object.values(options).some((t) => /^(verdadero|falso|certo|errado|true|false)$/i.test(t.trim()));
      const context = [
        "Eres un instructor de conducir portugués explicando en español.",
        isTrueFalse ? "Pregunta de verdadero/falso:" : "Pregunta del examen:",
        "\"" + (q.question || "") + "\"",
        "Respuesta correcta: " + (q.correctOption || "") + (isTrueFalse ? " (" + (options[q.correctOption] || "") + ")" : ""),
        "",
        "Historial de la conversación:"
      ].join("\n");
      const histStr = history.map((m) => (m.role === "user" ? "Alumno" : "Instructor") + ": " + m.content).join("\n");
      const prompt = context + "\n" + histStr + "\n\nAlumno: " + lastUser.content + "\n\nResponde en español. Sé breve y claro. Ve directo a la respuesta. NO pienses en voz alta, NO empieces con 'ok' ni 'claro', NO expliques qué vas a hacer.";
      const text = await askAIWithFallback(prompt, settings);
      const cleaned = stripAIReasoning(text);
      if (!cleaned) {
        sendResponse({ ok: false, error: "La IA no devolvió una respuesta clara. Repite tu duda." });
        return;
      }
      sendResponse({ ok: true, text: cleaned });
    })().catch((err) => {
      sendResponse({ ok: false, error: err.message || String(err) });
    });
    return true;
  }

  if (msg.type === "GET_SETTINGS") {
    loadBridgeKeys().then(() => getSettings()).then((s) => sendResponse({ ok: true, settings: s }));
    return true;
  }

  if (msg.type === "GET_BRIDGE_STATUS") {
    loadBridgeKeys().then((st) => sendResponse({ ok: true, ...st, providersWithKeys: bridgeKeys }));
    return true;
  }

  if (msg.type === "TEST_CONNECTION") {
    getSettings().then(async (s) => {
      sendResponse(await testConnection(s));
    });
    return true;
  }

  if (msg.type === "OPEN_PAGE") {
    const url = msg.url || (msg.path ? chrome.runtime.getURL(msg.path) : null);
    if (url) chrome.tabs.create({ url });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GET_AVAILABLE_MODELS") {
    (async () => {
      await loadBridgeKeys();
      const settings = await getSettings();
      const provider = msg.provider;
      let key = (settings.keys && settings.keys[provider]) || "";
      if (!key && bridgeKeys && bridgeKeys[provider]) key = bridgeKeys[provider].key || bridgeKeys[provider];
      let base = provider === "opencode" ? (bridgeKeys && bridgeKeys.opencode && bridgeKeys.opencode.base) || "https://opencode.ai/zen/v1" : "";
      try {
        if (provider === "openrouter") {
          const resp = await fetch("https://openrouter.ai/api/v1/models", {
            headers: key ? { Authorization: `Bearer ${key}` } : {}
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const j = await resp.json();
          const list = (j.data || []).map((m) => m.id).filter(Boolean);
          const free = list.filter((id) => id.includes(":free") || id.includes("free"));
          const out = free.length ? free : list;
          sendResponse({ ok: true, models: out.slice(0, 40) });
        } else if (provider === "opencode") {
          const url = `${base.replace(/\/$/, "")}/models`;
          const resp = await fetch(url, {
            headers: key ? { Authorization: `Bearer ${key}` } : {}
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const j = await resp.json();
          const list = (j.data || []).map((m) => m.id).filter(Boolean);
          sendResponse({ ok: true, models: list.slice(0, 60) });
        } else if (provider === "google") {
          if (!key) throw new Error("Falta API Key de Google");
          const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const j = await resp.json();
          const list = (j.models || []).map((m) => (m.name || "").replace("models/", "")).filter(Boolean)
            .filter((id) => id.includes("gemini") && !id.includes("embedding") && !id.includes("vision"));
          sendResponse({ ok: true, models: list.slice(0, 30) });
        } else {
          sendResponse({ ok: false, error: "Proveedor sin listado dinámico" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  return false;
});

loadBridgeKeys();

// Exports solo para pruebas con Node (el service worker MV3 no define `module`)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { stripAIReasoning, buildExplainPrompt, askAI, askAIWithFallback };
}