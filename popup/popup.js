// Study Assistant — popup

const PROVIDER_NAMES = {
  google: "Google Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  openrouter: "OpenRouter",
  opencode: "OpenCode Zen",
  chromeai: "IA de Chrome (Gemini Nano)",
  local: "Modelo local (Ollama)"
};

const MODE_NAMES = {
  study: "Modo estudio (feedback instantáneo)",
  exam: "Modo examen real (explicaciones al final)"
};

async function init() {
  const stored = await chrome.storage.local.get(["settings", "wrongQuestions"]);
  const s = stored.settings || {};
  const wrongCount = (stored.wrongQuestions || []).length;

  const el = document.getElementById("status");
  const providerName = PROVIDER_NAMES[s.aiProvider] || "No configurado";
  const modeName = MODE_NAMES[s.mode] || "Modo estudio";
  const enabled = s.panelEnabled !== false;

  let keyOk = s.aiProvider === "local" || s.aiProvider === "chromeai" || (s.keys && s.keys[s.aiProvider]);
  let bridgeLine = "";

  try {
    const bridge = await chrome.runtime.sendMessage({ type: "GET_BRIDGE_STATUS" });
    if (bridge && bridge.connected) {
      bridgeLine = `<div class="val" style="color:#34d399;">🔗 Claves de opencode conectadas</div>`;
      if (!keyOk && bridge.providers && bridge.providers.length) keyOk = true;
    }
  } catch (e) { /* sin bridge */ }

  el.innerHTML =
    `<div><b>Panel:</b> <span class="val">${enabled ? "Activo ✓" : "Desactivado"}</span></div>` +
    `<div><b>Proveedor:</b> ${providerName}</div>` +
    `<div><b>Modo:</b> ${modeName}</div>` +
    `<div><b>API Key:</b> <span class="val">${keyOk ? "configurada ✓" : "⚠ pendiente"}</span></div>` +
    `<div><b>Falladas:</b> <span class="val">${wrongCount}</span></div>` +
    bridgeLine;
}

document.getElementById("wrong").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("wrong.html") });
});

document.getElementById("options").addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});

init();