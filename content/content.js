// Study Assistant — Bom Condutor
// Content script: detecta el test en bomcondutor.pt, verifica la respuesta y muestra
// por qué es correcta/errónea (explicación oficial + IA en español).

(() => {
  if (window.__BC_SA_INJECTED__) return;
  window.__BC_SA_INJECTED__ = true;

  const PANEL_ID = "bc-sa-panel";

  let settings = null;
  let setupByIndex = null;
  let setupById = null;
  const questionCache = new Map(); // qid -> { correctOption, explanation, question, options }
  const aiCache = new Map(); // qid -> { text }
  const chatHistories = new Map(); // qid -> [{role, content}]
  let rendered = null; // estado del último panel renderizado
  let panelEl = null;
  let dragState = null;
  let renderToken = 0;
  let aiBusy = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);

  const esc = (str) =>
    String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // ---------- util JSON con llaves balanceadas (AngularJS constants) ----------
  function extractBalancedJSON(script, start) {
    let depth = 0,
      inStr = false,
      strChar = null,
      escFlag = false;
    for (let i = start; i < script.length; i++) {
      const ch = script[i];
      if (inStr) {
        if (escFlag) escFlag = false;
        else if (ch === "\\") escFlag = true;
        else if (ch === strChar) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true;
        strChar = ch;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return script.slice(start, i + 1);
      }
    }
    return null;
  }

  function extractConstant(script, name) {
    const re = new RegExp("BC\\.(?:constant|value)\\(['\"]" + name + "['\"]\\s*,", "i");
    const m = re.exec(script);
    if (!m) return null;
    const start = script.indexOf("{", m.index);
    if (start === -1) return null;
    return extractBalancedJSON(script, start);
  }

  // ---------- descifrado (portado de bomCondutorService) ----------
  function decryptCorrectOption(qid, encoded) {
    try {
      let b64 = encoded;
      const pad = b64.length % 4;
      if (pad > 0) b64 += "=".repeat(4 - pad);
      const decodedVal = parseInt(atob(b64).trim(), 10);
      return String.fromCharCode(decodedVal - qid);
    } catch (e) {
      return "";
    }
  }

  function decryptExplanation(qid, encrypted) {
    if (!encrypted) return null;
    try {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      const shift = String(qid)
        .split("")
        .reduce((s, d) => s + parseInt(d, 10), 0);
      const shiftedChars = chars.slice(shift) + chars.slice(0, shift);
      let translated = "";
      for (const c of encrypted) {
        const idx = shiftedChars.indexOf(c);
        translated += idx !== -1 ? chars[idx] : c;
      }
      let b64 = translated;
      const pad = b64.length % 4;
      if (pad > 0) b64 += "=".repeat(4 - pad);
      const decodedStr = atob(b64);
      try {
        return JSON.parse(decodedStr);
      } catch (e) {
        return decodedStr;
      }
    } catch (e) {
      return null;
    }
  }

  // ---------- settings ----------
  async function loadSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
      if (res && res.ok) settings = res.settings;
    } catch (e) {
      settings = null;
    }
  }

  // ---------- testSetup ----------
  function parseTestSetup() {
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      const t = s.textContent || "";
      if (!t.includes("testSetup")) continue;
      const json = extractConstant(t, "testSetup");
      if (!json) continue;
      try {
        const data = JSON.parse(json);
        if (Array.isArray(data)) {
          setupByIndex = data;
        } else if (data && typeof data === "object") {
          const meta = ["hash", "type", "category", "time", "title"];
          const keys = Object.keys(data)
            .filter((k) => !meta.includes(k))
            .sort((a, b) => +a - +b);
          setupByIndex = keys.map((k) => data[k]);
        } else continue;
        setupById = new Map();
        for (const q of setupByIndex) if (q && q.id != null) setupById.set(q.id, q);
        return;
      } catch (e) {
        /* siguiente script */
      }
    }
  }

  // ---------- obtener y parsear una pregunta desde /questao/{id} ----------
  async function fetchQuestion(qid) {
    if (questionCache.has(qid)) return questionCache.get(qid);
    try {
      const resp = await fetch(`https://www.bomcondutor.pt/questao/${qid}`);
      if (resp.status !== 200) return null;
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, "text/html");

      let correctOption = "";
      const scripts = doc.querySelectorAll("script");
      for (const s of scripts) {
        const t = s.textContent || "";
        if (t.includes(`bc${qid}=function`)) {
          const m = t.match(new RegExp(`bc${qid}\\(['"]([A-Za-z0-9+/=]+)['"]\\)`));
          if (m) {
            correctOption = decryptCorrectOption(qid, m[1]);
            break;
          }
        }
      }

      let explanation = null;
      for (const s of scripts) {
        const t = s.textContent || "";
        if (!t.includes("questionHelp")) continue;
        const json = extractConstant(t, "questionHelp");
        if (!json) continue;
        try {
          const helpData = JSON.parse(json);
          const qData = helpData[qid];
          if (qData && qData.explanation) explanation = decryptExplanation(qid, qData.explanation);
        } catch (e) {
          /* ignorar */
        }
        break;
      }

      const textEl = $(".question-text .text", doc);
      const question = textEl ? textEl.textContent.trim() : "";
      const options = {};
      doc.querySelectorAll("ul.answers li.answer").forEach((li) => {
        const letter = li.querySelector(".option");
        const text = li.querySelector(".answer-text");
        if (letter && text) options[letter.textContent.trim()] = text.textContent.trim();
      });

      const data = { id: qid, question, options, correctOption, explanation };
      questionCache.set(qid, data);
      return data;
    } catch (e) {
      console.error("[StudyAssistant] fetchQuestion failed", qid, e);
      return null;
    }
  }

  async function warmCache() {
    if (!setupByIndex) return;
    for (const q of setupByIndex) {
      if (!q || q.id == null) continue;
      if (questionCache.has(q.id)) continue;
      try {
        await fetchQuestion(q.id);
      } catch (e) {
        /* continuar */
      }
      await sleep(350);
    }
  }

  // ---------- estado actual del DOM ----------
  function getCurrentQuestionId() {
    const img = $(".question-image img, img[data-ng-src*='questions/'], img[src*='questions/']");
    if (img) {
      const src = img.getAttribute("data-ng-src") || img.getAttribute("src") || "";
      const m = src.match(/questions\/(\d+)\.jpg/);
      if (m) return parseInt(m[1], 10);
    }
    const numEl = $(".exam-content .question-text .number, .question-text .number");
    if (numEl && setupByIndex) {
      const idx = parseInt(numEl.textContent.trim(), 10) - 1;
      if (setupByIndex[idx] && setupByIndex[idx].id != null) return setupByIndex[idx].id;
    }
    return null;
  }

  function readAnswerState() {
    const correctEl = $("ul.answers li.answer.correct");
    const selectedEl = $("ul.answers li.answer.selected");
    const letterOf = (el) => (el ? (el.querySelector(".option")?.textContent || "").trim() : null);
    return { correctLetter: letterOf(correctEl), selectedLetter: letterOf(selectedEl) };
  }

  function isReviewPage() {
    return !!$("ul.answers li.answer.correct");
  }

  function getQuestionText() {
    const el = $(".exam-content > .question-text > .text, .question-text .text");
    return el ? el.textContent.trim() : "";
  }

  function getOptionsFromDOM() {
    const options = {};
    document.querySelectorAll("ul.answers li.answer").forEach((li) => {
      const letter = li.querySelector(".option");
      const text = li.querySelector(".answer-text");
      if (letter && text) options[letter.textContent.trim()] = text.textContent.trim();
    });
    return options;
  }

  // ---------- panel ----------
  function buildPanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement("div");
    panelEl.id = PANEL_ID;
    panelEl.innerHTML = `
      <div class="bc-sa-header">
        <span class="bc-sa-title"><span class="bc-sa-dot"></span> Study Assistant</span>
        <div class="bc-sa-header-btns">
          <button class="bc-sa-min" title="Minimizar">—</button>
          <button class="bc-sa-close" title="Cerrar">×</button>
        </div>
      </div>
      <div class="bc-sa-body"></div>
      <div class="bc-sa-footer">
        <span>Bom Condutor · Explicador</span>
        <span class="bc-sa-footer-links">
          <a href="#" class="bc-sa-wrong">❌ Erradas (<span class="bc-sa-wrong-count">0</span>)</a>
          <a href="#" class="bc-sa-config">Ajustes ⚙</a>
        </span>
      </div>`;
    document.body.appendChild(panelEl);

    // Evitar que el sitio capture las teclas mientras se escribe en el panel
    ["keydown", "keyup", "keypress"].forEach((evt) => {
      window.addEventListener(
        evt,
        (e) => {
          if (panelEl && panelEl.contains(e.target)) e.stopPropagation();
        },
        true
      );
    });

    panelEl.querySelector(".bc-sa-close").addEventListener("click", () => hidePanel());
    panelEl.querySelector(".bc-sa-min").addEventListener("click", () => {
      const body = panelEl.querySelector(".bc-sa-body");
      const footer = panelEl.querySelector(".bc-sa-footer");
      const minimized = panelEl.classList.toggle("bc-sa-minimized");
      body.style.display = minimized ? "none" : "";
      footer.style.display = minimized ? "none" : "";
      panelEl.querySelector(".bc-sa-min").textContent = minimized ? "□" : "—";
    });
    panelEl.querySelector(".bc-sa-config").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
        else openSettingsPage();
      } catch (err) {
        openSettingsPage();
      }
    });
    const wrongLink = panelEl.querySelector(".bc-sa-wrong");
    if (wrongLink) wrongLink.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: "OPEN_PAGE", path: "wrong.html" });
      } catch (err) {
        window.open(chrome.runtime.getURL("wrong.html"), "_blank");
      }
    });

    const header = panelEl.querySelector(".bc-sa-header");
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".bc-sa-close") || e.target.closest(".bc-sa-min")) return;
      const rect = panelEl.getBoundingClientRect();
      dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      document.addEventListener("mousemove", onDrag);
      document.addEventListener("mouseup", () => {
        document.removeEventListener("mousemove", onDrag);
        dragState = null;
      });
    });
    return panelEl;
  }

  function openSettingsPage() {
    try {
      chrome.runtime.sendMessage({ type: "OPEN_PAGE", path: "options/options.html" });
    } catch (e) {
      window.open(chrome.runtime.getURL("options/options.html"), "_blank");
    }
  }

  function onDrag(e) {
    if (!dragState || !panelEl) return;
    panelEl.style.left = e.clientX - dragState.dx + "px";
    panelEl.style.top = e.clientY - dragState.dy + "px";
    panelEl.style.right = "auto";
  }

  function showPanel() {
    buildPanel();
    panelEl.style.display = "block";
    if (!dragState) {
      panelEl.style.top = "20px";
      panelEl.style.right = "20px";
      panelEl.style.left = "auto";
    }
  }

  function hidePanel() {
    if (panelEl) panelEl.style.display = "none";
  }

  function setupCollapseDelegation() {
    const body = panelEl.querySelector(".bc-sa-body");
    if (!body || body.dataset.collapseBound) return;
    body.dataset.collapseBound = "1";
    body.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-bc-collapse]");
      if (!btn) return;
      const el = document.getElementById(btn.getAttribute("data-bc-collapse"));
      if (!el) return;
      const collapsed = el.classList.toggle("bc-sa-collapsed");
      btn.textContent = collapsed ? "▼ Mostrar" : "▲ Ocultar";
    });
  }

  function updateAIBox(qid, text, error) {
    const box = document.getElementById(`bc-sa-ai-${qid}`);
    const btn = panelEl && panelEl.querySelector(".bc-sa-ai-btn");
    if (btn) btn.disabled = false;
    aiBusy = false;
    if (!box) return;
    if (text) {
      box.innerHTML = text
        .split(/\n+/)
        .map((p) => {
          const raw = p.trim();
          let html = esc(raw);
          if (/^Correcta:/.test(raw)) html = `<span class="bc-sa-ai-answer">${html}</span>`;
          else if (/^Explicaci[oó]n:/i.test(raw)) html = html.replace(/^Explicaci[oó]n:/i, "<b>Explicación:</b>");
          return `<p>${html}</p>`;
        })
        .filter((p) => p !== "<p></p>")
        .join("");
    } else if (error) {
      box.innerHTML = `<div class="bc-sa-error">${esc(error)}</div>`;
    }
    const toggle = panelEl && panelEl.querySelector(`.bc-sa-ai-toggle[data-bc-collapse="bc-sa-ai-${qid}"]`);
    if (toggle) toggle.style.display = box.innerHTML ? "inline-block" : "none";
  }

  function showChatInput(qid) {
    const chat = document.getElementById(`bc-sa-chat-${qid}`);
    if (chat) chat.style.display = "block";
    const input = document.getElementById(`bc-sa-chat-input-${qid}`);
    if (input) setTimeout(() => input.focus(), 100);
  }

  function setupChatListeners(qid) {
    const input = document.getElementById(`bc-sa-chat-input-${qid}`);
    const sendBtn = document.getElementById(`bc-sa-chat-send-${qid}`);
    if (!input || !sendBtn || input.dataset.bound) return;
    input.dataset.bound = "1";
    const send = () => handleFollowUp(qid);
    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  }

  async function handleFollowUp(qid) {
    const input = document.getElementById(`bc-sa-chat-input-${qid}`);
    const msgsEl = document.getElementById(`bc-sa-chat-msgs-${qid}`);
    if (!input || !msgsEl) return;
    const text = input.value.trim();
    if (!text) return;

    msgsEl.innerHTML += `<div class="bc-sa-chat-user">${esc(text)}</div>`;
    input.value = "";

    if (!chatHistories.has(qid)) chatHistories.set(qid, []);
    const history = chatHistories.get(qid);
    history.push({ role: "user", content: text });

    const loadingId = `bc-sa-chat-loading-${qid}`;
    msgsEl.innerHTML += `<div class="bc-sa-chat-ai" id="${loadingId}"><span class="bc-sa-spinner"></span></div>`;
    msgsEl.scrollTop = msgsEl.scrollHeight;

    const qData = questionCache.get(qid) || {};
    const question = qData.question || getQuestionText();
    const options = qData.options || getOptionsFromDOM();
    const correctOption = qData.correctOption || "";

    try {
      const res = await chrome.runtime.sendMessage({
        type: "AI_FOLLOWUP",
        question: { question, options, correctOption },
        history
      });
      const loadingEl = document.getElementById(loadingId);
      if (loadingEl) loadingEl.remove();

      if (res && res.ok) {
        history.push({ role: "assistant", content: res.text });
        msgsEl.innerHTML += `<div class="bc-sa-chat-ai">${esc(res.text).split(/\n+/).map((p) => `<p>${p}</p>`).join("")}</div>`;
      } else {
        msgsEl.innerHTML += `<div class="bc-sa-chat-ai bc-sa-error">${esc((res && res.error) || "Error al conectar con la IA.")}</div>`;
      }
    } catch (e) {
      const loadingEl = document.getElementById(loadingId);
      if (loadingEl) loadingEl.remove();
      msgsEl.innerHTML += `<div class="bc-sa-chat-ai bc-sa-error">Error: ${esc(e.message || e)}</div>`;
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  async function triggerAI(qid, question, options, correctOption) {
    if (aiBusy) return;
    if (aiCache.has(qid)) {
      updateAIBox(qid, aiCache.get(qid).text);
      return;
    }
    if (!correctOption) {
      updateAIBox(qid, null, "No se pudo verificar la opción correcta automáticamente, así que la IA no puede explicarla.");
      return;
    }
    aiBusy = true;
    const btn = panelEl && panelEl.querySelector(".bc-sa-ai-btn");
    const box = document.getElementById(`bc-sa-ai-${qid}`);
    if (btn) btn.disabled = true;
    if (box) box.innerHTML = `<span class="bc-sa-spinner"></span> La IA está escribiendo la explicación...`;
    try {
      const res = await Promise.race([
        chrome.runtime.sendMessage({
          type: "AI_EXPLAIN",
          question: { question, options, correctOption }
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("La IA tardó demasiado (más de 60s). Vuelve a intentarlo.")), 60000)
        )
      ]);
      if (res && res.ok) {
        aiCache.set(qid, { text: res.text });
        updateAIBox(qid, res.text);
        patchWrongAI(qid, res.text);
        showChatInput(qid);
        setupChatListeners(qid);
      } else {
        updateAIBox(qid, null, (res && res.error) || "Error al conectar con la IA. Revisa tu API Key en los Ajustes ⚙.");
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (msg.includes("Extension context invalidated")) {
        updateAIBox(qid, null, "Extensión actualizada — recarga la página con F5 para continuar.");
      } else {
        updateAIBox(qid, null, "Error: " + msg);
      }
    } finally {
      aiBusy = false;
      const b = panelEl && panelEl.querySelector(".bc-sa-ai-btn");
      if (b) b.disabled = false;
    }
  }

  function renderPanel(data) {
    buildPanel();
    showPanel();
    const body = panelEl.querySelector(".bc-sa-body");

    let verdictHtml = "";
    if (data.verdict === true) {
      verdictHtml = `<div class="bc-sa-verdict bc-sa-ok">✓ Correcto. ¡Bien hecho!</div>`;
    } else if (data.verdict === false) {
      verdictHtml = `<div class="bc-sa-verdict bc-sa-err">✗ Incorrecto.</div>`;
    } else if (data.resolved) {
      verdictHtml = `<div class="bc-sa-verdict bc-sa-neutral">No se pudo verificar la respuesta automáticamente.</div>`;
    } else {
      verdictHtml = `<div class="bc-sa-verdict bc-sa-neutral"><span class="bc-sa-spinner"></span>Analizando tu respuesta...</div>`;
    }

    let html = verdictHtml;

    if (data.pick || data.correct) {
      html += `<div class="bc-sa-answers">`;
      if (data.pick) html += `<div><b>Tu respuesta:</b> ${esc(data.pick)}</div>`;
      if (data.correct) html += `<div><b>Respuesta correcta:</b> ${esc(data.correct)}</div>`;
      html += `</div>`;
    }

    if (data.question) {
      html += `<div class="bc-sa-question">${esc(data.question)}</div>`;
    }

    if (data.explanation) {
      html += `<div class="bc-sa-official">
        <div class="bc-sa-sec-head"><span class="bc-sa-label">Explicación oficial (PT)</span><button class="bc-sa-collapse-btn" data-bc-collapse="bc-sa-official-body-${data.qid}">▲ Ocultar</button></div>
        <div class="bc-sa-official-body" id="bc-sa-official-body-${data.qid}">${data.explanation}</div>
      </div>`;
    }

    html += `<div class="bc-sa-ai">
      <button class="bc-sa-ai-btn">✨ Explicar con IA (Español)</button>
      <button class="bc-sa-collapse-btn bc-sa-ai-toggle" data-bc-collapse="bc-sa-ai-${data.qid}" style="display:none;">▲ Ocultar explicación</button>
      <div class="bc-sa-ai-text" id="bc-sa-ai-${data.qid}"></div>
      <div class="bc-sa-chat" id="bc-sa-chat-${data.qid}" style="display:none;">
        <div class="bc-sa-chat-label">💬 Preguntar sobre esta respuesta</div>
        <div class="bc-sa-chat-messages" id="bc-sa-chat-msgs-${data.qid}"></div>
        <div class="bc-sa-chat-input-row">
          <input type="text" id="bc-sa-chat-input-${data.qid}" placeholder="Escribe tu duda..." class="bc-sa-chat-input" />
          <button class="bc-sa-chat-send" id="bc-sa-chat-send-${data.qid}">➤</button>
        </div>
      </div>
    </div>`;

    body.innerHTML = html;

    const btn = body.querySelector(".bc-sa-ai-btn");
    btn.addEventListener("click", () => {
      triggerAI(data.qid, data.question, data.options, data.correct);
    });

    setupCollapseDelegation();

    if (aiCache.has(data.qid)) {
      updateAIBox(data.qid, aiCache.get(data.qid).text);
      showChatInput(data.qid);
      setupChatListeners(data.qid);
      restoreChat(data.qid);
    }
  }

  function restoreChat(qid) {
    const msgsEl = document.getElementById(`bc-sa-chat-msgs-${qid}`);
    if (!msgsEl) return;
    const history = chatHistories.get(qid);
    if (!history || !history.length) return;
    msgsEl.innerHTML = history
      .map((m) =>
        m.role === "user"
          ? `<div class="bc-sa-chat-user">${esc(m.content)}</div>`
          : `<div class="bc-sa-chat-ai">${esc(m.content).split(/\n+/).map((p) => `<p>${p}</p>`).join("")}</div>`
      )
      .join("");
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // ---------- lógica principal ----------
  function getCurrentSection() {
    const parts = location.pathname.split("/").filter(Boolean);
    // /teste/B/novas -> B, /teste/B/tematico/14 -> B/tematico-14
    if (parts[0] === "teste" && parts[1]) return parts.slice(1, 3).join("/") || parts[1];
    return "general";
  }

  async function saveWrongAnswer(data) {
    try {
      const section = getCurrentSection();
      const url = `https://www.bomcondutor.pt/questao/${data.qid}`;
      const { wrongQuestions = [] } = await chrome.storage.local.get("wrongQuestions");
      // por sección: si ya existe esa pregunta en esa sección, la mueve al frente; si existe en otra sección, duplica como nueva entrada por sección
      const list = (wrongQuestions || []).filter((w) => !(w.qid === data.qid && w.section === section));
      list.unshift({
        qid: data.qid,
        question: data.question || "",
        options: data.options || {},
        correct: data.correct || null,
        pick: data.pick || null,
        explanation: data.explanation || null,
        ai: null,
        section,
        url,
        ts: Date.now()
      });
      // límite por sección 80, global 300; expira >30 días
      const now = Date.now();
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      const filtered = list.filter((w) => now - (w.ts || 0) < THIRTY_DAYS);
      // aplica tope por sección
      const bySec = {};
      const capped = [];
      for (const w of filtered) {
        bySec[w.section] = (bySec[w.section] || 0) + 1;
        if (bySec[w.section] <= 80) capped.push(w);
        if (capped.length >= 300) break;
      }
      await chrome.storage.local.set({ wrongQuestions: capped });
      updateWrongCount();
    } catch (e) {
      /* almacenamiento opcional: ignorar errores */
    }
  }

  async function patchWrongAI(qid, text) {
    try {
      const section = getCurrentSection();
      const { wrongQuestions = [] } = await chrome.storage.local.get("wrongQuestions");
      const cur = (wrongQuestions || []).find((w) => w.qid === qid && w.section === section) || (wrongQuestions || []).find((w) => w.qid === qid) || {};
      const list = (wrongQuestions || []).filter((w) => !(w.qid === qid && (w.section === section || !w.section)));
      list.unshift({ ...cur, qid, section: cur.section || section, url: cur.url || `https://www.bomcondutor.pt/questao/${qid}`, ai: text });
      await chrome.storage.local.set({ wrongQuestions: list.slice(0, 300) });
    } catch (e) {
      /* ignorar */
    }
  }

  async function updateWrongCount() {
    const el = panelEl && panelEl.querySelector(".bc-sa-wrong-count");
    if (!el) return;
    try {
      const { wrongQuestions = [] } = await chrome.storage.local.get("wrongQuestions");
      el.textContent = (wrongQuestions || []).length;
    } catch (e) {
      el.textContent = "0";
    }
  }

  async function handleAnswer() {
    if (!settings) await loadSettings();
    if (!settings || !settings.panelEnabled) return;

    const review = isReviewPage();
    if (settings.mode === "exam" && !review) return; // modo examen real: sin feedback durante el test

    const qid = getCurrentQuestionId();
    if (qid == null) return;

    const state = readAnswerState();

    // usuario deseleccionó su respuesta en modo estudio -> ocultar panel de esta pregunta
    if (!review && !state.selectedLetter) {
      if (rendered && rendered.qid === qid) hidePanel();
      return;
    }
    if (review && !state.correctLetter) return;

    const questionText = getQuestionText() || (setupById && setupById.get(qid)?.questao) || "";
    let options = getOptionsFromDOM();
    if (!Object.keys(options).length && setupById && setupById.get(qid)?.respostas) {
      options = setupById.get(qid).respostas;
    }

    // mismo estado ya renderizado -> no hacer nada
    if (
      rendered &&
      rendered.qid === qid &&
      rendered.pick === state.selectedLetter &&
      rendered.correct === state.correctLetter &&
      rendered.mode === (review ? "review" : "study") &&
      rendered.resolved
    ) {
      return;
    }

    const token = ++renderToken;
    const data = {
      qid,
      mode: review ? "review" : "study",
      pick: state.selectedLetter,
      correct: state.correctLetter,
      question: questionText,
      options,
      resolved: false,
      verdict: null,
      explanation: null
    };
    rendered = data;
    renderPanel(data);

    if (!review) {
      const resolved = await fetchQuestion(qid);
      if (token !== renderToken) return; // el usuario ya navegó a otra pregunta
      if (resolved) {
        data.correct = resolved.correctOption || state.correctLetter || null;
        data.explanation = resolved.explanation;
        data.resolved = true;
        data.verdict = data.correct && data.pick ? data.pick === data.correct : null;
        if (data.verdict === false) saveWrongAnswer(data);
        renderPanel(data);
        if (data.verdict === false && settings.autoExplain && !aiCache.has(qid)) {
          triggerAI(qid, data.question, data.options, data.correct);
        }
      } else {
        data.resolved = true;
        renderPanel(data);
      }
    } else {
      data.resolved = true;
      data.verdict = data.pick ? data.pick === data.correct : null;
      if (data.verdict === false) saveWrongAnswer(data);
      renderPanel(data);
      // carga perezosa de la explicación oficial en la revisión
      fetchQuestion(qid).then((resolved) => {
        if (token !== renderToken) return;
        if (resolved && resolved.explanation && !data.explanation) {
          data.explanation = resolved.explanation;
          renderPanel(data);
        }
      });
    }
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function startObserving() {
    const target = $("#exam, .bc-test-navigator, .exam-content") || document.body;
    const observer = new MutationObserver(
      debounce(() => {
        handleAnswer();
      }, 100)
    );
    observer.observe(target, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
      childList: true
    });
  }

  // ---------- init ----------
  async function init() {
    if (!location.pathname.startsWith("/teste/")) return;
    await loadSettings();
    parseTestSetup();
    if (settings && settings.panelEnabled && settings.mode === "study" && setupByIndex && !isReviewPage()) {
      warmCache().catch(() => {});
    }
    startObserving();
    if (isReviewPage()) handleAnswer();
  }

  init();
})();