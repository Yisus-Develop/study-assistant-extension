# Study Assistant — Extensión Bom Condutor 🧠

> Extensión de **Chrome / Edge** para [bomcondutor.pt](https://www.bomcondutor.pt): mientras haces tus tests de código, te dice **al instante por qué** tu respuesta es correcta o errónea — con la explicación oficial en portugués y una explicación en **español** generada con IA.

**No es solo "correcto o incorrecto": entiendes cada fallo y aprendes la norma del Código da Estrada.**

---

## ✨ Qué hace

- ✅/❌ **Veredicto instantáneo** al hacer clic, con la **letra correcta**.
- **Explicación oficial en portugués** (la misma que usa la web).
- **Explicación en español con IA**: qué norma aplica, por qué tu opción es la correcta y en qué se equivocan las demás.
- 💬 **Chat de dudas**: pregunta "¿y por qué?" sobre la misma respuesta.
- **Modo estudio** (feedback inmediato) y **Modo examen real** (sin ayudas; las explicaciones aparecen solo en la página de resultados).
- Panel arrastrable, contador de erradas y estilos propios. **No cambia tu puntuación ni modifica la web.**

---

## 📦 Instalación (2 minutos)

### Paso 1 — Cargar la extensión (una sola vez)

1. Abre Chrome o Edge y ve a la página de extensiones:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Activa el **modo desarrollador** (interruptor arriba a la derecha).
3. Pulsa **"Cargar descomprimida" / "Load unpacked"**.
4. Selecciona la carpeta de esta extensión (la que clonaste o descargaste).

### Paso 2 — Conectar la IA (elige **UNA** opción)

#### Opción A — Clave API (recomendada)

1. Consigue una clave gratis en [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (Google Gemini, plan gratuito).
2. Haz clic en el icono de la extensión → **"Abrir ajustes"**.
3. Elige el **proveedor** (Gemini gratis es la vía más fácil):

   | Proveedor | Coste | Notas |
   |---|---|---|
   | Google Gemini | Gratis | Recomendado — plan gratuito en [aistudio](https://aistudio.google.com/apikey) |
   | OpenRouter | Hay modelos gratis | [openrouter.ai/keys](https://openrouter.ai/keys) |
   | OpenAI | Pago | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
   | Anthropic Claude | Pago | [console.anthropic.com](https://console.anthropic.com/) |
   | NVIDIA NIM | Plan gratis | [build.nvidia.com](https://build.nvidia.com/) |
   | Modelo local (Ollama) | Gratis, sin clave | Instala [Ollama](https://ollama.com/) y `ollama pull llama3` |

4. Pega tu **API Key**, elige el **modelo**, pulsa **"Testear conexión con IA"** y luego **"Guardar configuración"**.

#### Opción B — Sin configurar nada (solo si ya usas OpenCode)

Si tienes [opencode](https://opencode.ai) instalado, la extensión **importa sola** las claves que ya tienes configuradas ahí a través de un puente local (`127.0.0.1`) — sin pegar ninguna API key:

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-bridge.ps1
```

Eso registra una tarea que arranca el puente en cada inicio de sesión. Para arrancarlo ya mismo:

```powershell
powershell -ExecutionPolicy Bypass -File tools\start-bridge.ps1
```

Verifica el estado en **Ajustes ⚙** (banner verde *"Claves importadas de opencode"*) o abriendo `http://127.0.0.1:47821/v1/keys` en el navegador.

> El puente solo escucha en `127.0.0.1` (tu equipo) y no expone nada fuera de tu máquina.

---

## 🖥️ Cómo se usa

1. Abre un test en `https://www.bomcondutor.pt/teste/...` (examen, nuevas, temático, difícil o erradas).
2. Haz clic en una respuesta → aparece un panel flotante con:
   - ✅/❌ veredicto
   - tu respuesta vs. la correcta
   - explicación oficial (PT)
   - botón **"✨ Explicar con IA (Español)"**
3. La IA responde con **`Correcta: X) …`** (verde) y una **Explicación** breve en español.
4. ¿Duda? Escribe en **"💬 Preguntar sobre esta respuesta"**.

> El panel es arrastrable (mantén pulsado el encabezado) y se cierra con la ✕.
> En **Modo examen real** el panel se oculta mientras contestas y solo aparece en la página de resultados (`/teste/resultado`).

---

## ⚙️ Modos de trabajo

| Modo | Qué hace |
|---|---|
| **Modo estudio** (por defecto) | Feedback inmediato tras cada respuesta; si fallas, la IA te explica el fallo automáticamente (opcional). |
| **Modo examen real** | Como un examen de verdad: sin panel ni explicaciones hasta la pantalla de resultados. |

Se cambia en **Ajustes ⚙**.

---

## ⚠️ Privacidad

- **Tus claves API se guardan solo en tu navegador** (`chrome.storage.local`). No se envían a ningún servidor nuestro.
- Nada se sube a servidores de terceros salvo, al pulsar "Explicar con IA", el **texto de la pregunta + sus opciones + la letra correcta** a **tu** proveedor de IA elegido (Google, OpenAI, etc.).
- **Nada se sube a servidores del desarrollador.** Esta extensión no tiene backend propio.
- El puente de OpenCode (opcional) solo escucha en `127.0.0.1`.

---

## 🗂️ Estructura

```
study-assistant-extension/
├── manifest.json          # MV3: permisos, content script, service worker
├── background.js          # Llamadas IA multi-proveedor (sin CORS) + importación desde opencode
├── content/
│   ├── content.js         # Detección de test, descifrado, panel flotante
│   └── content.css        # Estilos del panel
├── options/               # Página de ajustes (+ banner del puente opencode)
├── popup/                 # Estado rápido desde el icono
├── tools/                 # Puente local de claves opencode (opcional)
└── README.md
```

---

## 🛠️ Notas técnicas

- El content script lee la constante AngularJS `BC.constant('testSetup', {...})` para conocer el banco de preguntas del test y descifra (con el mismo algoritmo que la web) la opción correcta y la explicación oficial desde `/questao/{id}`.
- La verificación instantánea en modo estudio usa una **precarga en segundo plano** de las preguntas del test para que el veredicto aparezca sin esperas.
- En modo revisión (`/teste/resultado`) lee las clases `.answer.correct` / `.answer.wrong` que añade la propia web.
- Las llamadas a las APIs de IA se hacen desde el **service worker** de la extensión, evitando CORS.
- La respuesta de la IA pasa por un filtro (`stripAIReasoning`) que elimina el razonamiento interno de los modelos y exige el formato **`Correcta: … / Explicación: …`** en español.

---

## 📄 Licencia

Uso personal y educativo. Consulta la licencia del repositorio.
