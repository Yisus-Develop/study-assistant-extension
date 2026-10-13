(function () {
  const listEl = document.getElementById("list");
  const countEl = document.getElementById("count");
  const toast = document.getElementById("toast");
  const filterEl = document.getElementById("sectionFilter");
  let all = [];

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 1500);
  }

  async function load() {
    const { wrongQuestions = [] } = await chrome.storage.local.get("wrongQuestions");
    all = (wrongQuestions || []).map((w) => ({ section: w.section || "general", url: w.url || `https://www.bomcondutor.pt/questao/${w.qid}`, ...w }));
    // expira >30 días ya filtrado al guardar, pero por si acaso
    const THIRTY = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    all = all.filter((w) => now - (w.ts || 0) < THIRTY);
    buildFilter();
    render();
  }

  function buildFilter() {
    const secs = [...new Set(all.map((w) => w.section))].sort();
    const cur = filterEl.value;
    filterEl.innerHTML = '<option value="all">Todas las secciones</option>';
    secs.forEach((s) => {
      const o = document.createElement("option");
      o.value = s;
      const cnt = all.filter((w) => w.section === s).length;
      o.textContent = `${s} (${cnt})`;
      filterEl.appendChild(o);
    });
    if (secs.includes(cur)) filterEl.value = cur;
    document.getElementById("clearSectionBtn").style.display = filterEl.value !== "all" ? "inline-flex" : "none";
  }

  function filtered() {
    const f = filterEl.value;
    return f === "all" ? all : all.filter((w) => w.section === f);
  }

  function render() {
    const list = filtered();
    document.getElementById("clearSectionBtn").style.display = filterEl.value !== "all" ? "inline-flex" : "none";
    if (!list.length) {
      const msg = filterEl.value === "all"
        ? `<div class="empty"><div class="big">🎉</div>¡No hay preguntas falladas!<br>Cuando falles una en un test de estudio, aparecerá aquí por sección y podrás abrirla en Bom Condutor.</div>`
        : `<div class="empty"><div class="big">📚</div>No hay erradas en <b>${esc(filterEl.value)}</b><br>Cambia de sección o haz más tests.</div>`;
      listEl.innerHTML = msg;
      countEl.textContent = all.length ? `${all.length} guardadas · ${list.length} en esta sección` : "";
      return;
    }
    countEl.textContent = `${list.length} en ${filterEl.value === "all" ? "total" : esc(filterEl.value)} · ${all.length} guardadas`;
    listEl.innerHTML = list.map((w) => {
      const globalIdx = all.indexOf(w);
      const opts = Object.entries(w.options || {})
        .map(([letter, text]) => {
          const cls = [];
          if (letter === w.pick) cls.push("is-pick");
          if (letter === w.correct) cls.push("is-correct");
          return `<div class="opt ${cls.join(" ")}"><span class="letter">${esc(letter)}</span><span>${esc(text)}</span></div>`;
        })
        .join("");
      const official = w.explanation
        ? `<div class="sec">Explicación oficial (PT)</div><div class="expl official">${esc(w.explanation)}</div>`
        : "";
      const ai = w.ai
        ? `<div class="sec">Explicación IA (Español)</div><div class="expl ai">${esc(w.ai)}</div>`
        : "";
      return `<div class="card">
        <div class="qhead">
          <span class="qid">#${esc(w.qid)} · <span style="background:rgba(99,102,241,0.2);padding:2px 6px;border-radius:6px;font-size:10px;">${esc(w.section)}</span></span>
          <span style="display:flex; gap:8px; align-items:center;">
            <span class="qdate">${fmtDate(w.ts)}</span>
            <button class="del" data-i="${globalIdx}">✕</button>
          </span>
        </div>
        <div class="qtext">${esc(w.question)}</div>
        <div class="opts">${opts}</div>
        ${official}
        ${ai}
        <div style="margin-top:10px;display:flex;gap:8px;">
          <a href="${esc(w.url)}" target="_blank" style="font-size:12px;color:#818cf8;text-decoration:none;background:rgba(129,140,248,0.12);padding:6px 10px;border-radius:8px;">🔗 Ver en Bom Condutor</a>
        </div>
      </div>`;
    }).join("");
  }

  filterEl.addEventListener("change", render);

  document.getElementById("list").addEventListener("click", async (e) => {
    const btn = e.target.closest(".del");
    if (!btn) return;
    all.splice(parseInt(btn.dataset.i, 10), 1);
    await chrome.storage.local.set({ wrongQuestions: all });
    buildFilter();
    render();
    showToast("Pregunta eliminada");
  });

  document.getElementById("clearBtn").addEventListener("click", async () => {
    if (!confirm("¿Borrar todas las preguntas falladas guardadas?")) return;
    await chrome.storage.local.set({ wrongQuestions: [] });
    all = [];
    buildFilter();
    render();
    showToast("Historial borrado");
  });

  document.getElementById("clearSectionBtn").addEventListener("click", async () => {
    const sec = filterEl.value;
    if (sec === "all" || !confirm(`¿Borrar las erradas de la sección \"${sec}\"?`)) return;
    all = all.filter((w) => w.section !== sec);
    await chrome.storage.local.set({ wrongQuestions: all });
    filterEl.value = "all";
    buildFilter();
    render();
    showToast(`Sección ${sec} borrada`);
  });

  document.getElementById("backBtn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  load();
})();
