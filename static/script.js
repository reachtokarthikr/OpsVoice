/* ===== OpsVoice - Command Center Client ===== */

// --- DOM References ---
const connectBtn = document.getElementById("connect-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const micBtn = document.getElementById("mic-btn");
const cameraBtn = document.getElementById("camera-btn");
const sendBtn = document.getElementById("send-btn");
const clearLogBtn = document.getElementById("clear-log-btn");
const textForm = document.getElementById("text-form");
const textInput = document.getElementById("text-input");
const transcriptEl = document.getElementById("transcript");
const eventLogEl = document.getElementById("event-log");
const cameraPreview = document.getElementById("camera-preview");
const connectionStatus = document.getElementById("connection-status");
const audioStatus = document.getElementById("audio-status");
const cameraStatus = document.getElementById("camera-status");
const orbContainer = document.getElementById("orb-container");
const orbLabel = document.getElementById("orb-label");
const stateIcon = document.getElementById("state-icon");
const stateLabel = document.getElementById("state-label");
const agentStateBar = document.getElementById("agent-state-bar");
const eventLogToggle = document.getElementById("event-log-toggle");
const waveformCanvas = document.getElementById("waveform-canvas");
const serviceCardsEl = document.getElementById("service-cards");
const incidentListEl = document.getElementById("incident-list");
const toolCardsEl = document.getElementById("tool-cards");
const dropZone = document.getElementById("drop-zone");
const cameraModeTypeBtn = document.getElementById("camera-mode-type-btn");
const cameraModeVoiceBtn = document.getElementById("camera-mode-voice-btn");
const cameraModeHelp = document.getElementById("camera-mode-help");
const cameraModeButtons = [cameraModeTypeBtn, cameraModeVoiceBtn].filter(Boolean);
const utf8Encoder = new TextEncoder();
const TEXT_LOG_EXTENSIONS = new Set(["log", "txt", "json", "ndjson", "out"]);
const TEXT_LOG_MIME_TYPES = new Set(["application/json", "application/x-ndjson"]);
const MAX_LOG_UPLOAD_BYTES = 48 * 1024;
const MAX_CAMERA_FRAME_BASE64_CHARS = 42 * 1024;
const CAMERA_FRAME_DIMENSIONS = [384, 320, 256];
const CAMERA_FRAME_QUALITIES = [0.65, 0.5, 0.4];

// --- Alert state ---
let alertQueue = [];
let alertToastTimeout = null;

// --- State ---
let websocket;
let userId = "";
let sessionId = "";
let sessionToken = "";  // auth token from /session
let micStream;
let micContext;
let micSource;
let workletNode;       // AudioWorklet replaces deprecated ScriptProcessor
let analyserNode;
let playbackContext;
let playbackCursor = 0;
let activePlaybackSources = []; // Fix #1: track all queued audio sources
let cameraStream;
let cameraInterval;
let cameraCanvas;      // Fix #3: reusable canvas for camera capture
let lastCameraFrameBase64 = "";
let lastCameraFrameMimeType = "image/jpeg";
let hasLoggedCameraFrameReady = false;
let waveformAnimId;
let agentState = "idle"; // idle | listening | analyzing | tool | speaking
let firstTranscript = true;
let recentTranscriptKeys = []; // Fix: sliding-window dedup
const MAX_DEDUP_KEYS = 20;
let voiceModeEnabled = false;
let speechDetected = false;
let lastSpeechAt = 0;
let stoppingMicrophone = false;
let pendingVoiceResume = false;
let cameraInteractionMode = "voice";
const CAMERA_MODE_CONFIG = {
  text: {
    label: "Camera + Type",
    help: "Typed prompts use the live camera frame. Voice stays normal unless you switch to Camera + Type + Voice.",
  },
  voice: {
    label: "Camera + Type + Voice",
    help: "Typed and spoken prompts both use the live camera frame while the camera is on.",
  },
};

// Fix #4: WebSocket auto-reconnect state
let reconnectAttempts = 0;
let reconnectTimer = null;
let intentionalDisconnect = false;
const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_MS = 500;

// Fix #6: Adaptive VAD — noise floor estimation
let noiseFloorRms = 0.01;
const NOISE_FLOOR_ALPHA = 0.05;       // smoothing factor for noise floor
const VAD_THRESHOLD_MULTIPLIER = 2.5;  // speech must be N× above noise floor
const VAD_MIN_THRESHOLD = 0.008;       // absolute minimum threshold
let VOICE_SILENCE_MS = 1200;          // configurable via setSilenceTimeout()

// ===== AGENT STATE MACHINE =====
const STATES = {
  idle:      { icon: "II", label: "Idle", steps: [0,0,0,0] },
  connected: { icon: "OK", label: "Connected - Ready", steps: [0,0,0,0] },
  listening: { icon: "IN", label: "Listening...", steps: [2,0,0,0] },
  analyzing: { icon: "..", label: "Analyzing...", steps: [1,2,0,0] },
  tool:      { icon: "FX", label: "Running Tool...", steps: [1,1,2,0] },
  speaking:  { icon: "AI", label: "Speaking...", steps: [1,1,1,2] },
};

/** Allow users to configure the VAD silence timeout (ms). */
function setSilenceTimeout(ms) {
  VOICE_SILENCE_MS = Math.max(500, Math.min(ms, 10000));
}

function setAgentState(state) {
  agentState = state;
  const info = STATES[state] || STATES.idle;
  stateIcon.textContent = info.icon;
  stateIcon.className = `state-icon ${state}`;
  stateLabel.textContent = info.label;
  stateLabel.className = `state-label${state !== "idle" ? " active" : ""}`;
  agentStateBar.className = `agent-state-bar${state !== "idle" ? " active" : ""}`;

  const stepEls = [
    document.getElementById("step-listen"),
    document.getElementById("step-analyze"),
    document.getElementById("step-tool"),
    document.getElementById("step-speak"),
  ];
  info.steps.forEach((v, i) => {
    stepEls[i].className = `state-step${v === 1 ? " done" : v === 2 ? " current" : ""}`;
  });

  // Update orb container state
  orbContainer.className = `orb-container ${state === "idle" ? "idle" : state}`;
  const labels = {
    idle: "Click Connect to begin",
    connected: voiceModeEnabled ? "Voice chat is ready" : "Click Mic to start speaking",
    listening: "Listening to you...",
    analyzing: "Processing your request...",
    tool: "Executing tool...",
    speaking: "OpsVoice is responding...",
  };
  orbLabel.textContent = labels[state] || "";
}

// ===== CONNECTION STATE =====
function setConnectionState(state) {
  connectionStatus.textContent = state;
  connectionStatus.classList.toggle("is-connected", state === "Connected");
  connectionStatus.classList.toggle("is-idle", state !== "Connected");
}

// ===== LOGGING =====
function logEvent(label, data) {
  const entry = `${new Date().toLocaleTimeString()} ${label}\n${data}\n\n`;
  eventLogEl.textContent = entry + eventLogEl.textContent.slice(0, 16000);
}

// ===== MARKDOWN RENDERER =====
function escapeHtml(text) {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
}

function renderMarkdown(text) {
  let html = escapeHtml(text)
    // Bold: **text** or __text__
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    // Italic: *text* or _text_
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    // Inline code: `text`
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    // Line breaks
    .replace(/\n/g, "<br>");
  return html;
}

// ===== TRANSCRIPT =====
function addTranscript(speaker, text) {
  if (!text || !text.trim()) return;

  const normalizedText = text.replace(/\s+/g, " ").trim();
  const transcriptKey = `${speaker.toLowerCase()}::${normalizedText.toLowerCase()}`;
  // Sliding-window dedup: reject if this key appeared in the last N entries
  if (recentTranscriptKeys.includes(transcriptKey)) return;
  recentTranscriptKeys.push(transcriptKey);
  if (recentTranscriptKeys.length > MAX_DEDUP_KEYS) recentTranscriptKeys.shift();

  // Clear empty state on first real entry
  if (firstTranscript) {
    transcriptEl.innerHTML = "";
    firstTranscript = false;
  }

  const speakerLower = speaker.toLowerCase();
  const isSystem = speakerLower === "system";
  const isAgent = speakerLower !== "user" && !isSystem;
  const entry = document.createElement("div");
  entry.className = `transcript-entry ${isSystem ? "is-system" : isAgent ? "is-agent" : "is-user"}`;
  const strong = document.createElement("strong");
  strong.textContent = speaker;
  const span = document.createElement("span");
  entry.appendChild(strong);
  entry.appendChild(span);
  const rendered = renderMarkdown(text);

  transcriptEl.prepend(entry);

  // Typewriter effect for agent messages (renders markdown after completion)
  if (isAgent) {
    typewriterEffect(span, text, rendered, 8);
  } else {
    span.innerHTML = rendered;
  }
}

function stripMarkdownSyntax(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")   // **bold**
    .replace(/__(.+?)__/g, "$1")        // __bold__
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1") // *italic*
    .replace(/`([^`]+)`/g, "$1");       // `code`
}

function typewriterEffect(el, rawText, renderedHtml, speed) {
  // Type a clean (markdown-stripped) version, then swap to fully rendered HTML at the end
  const displayText = stripMarkdownSyntax(rawText);
  let i = 0;
  el.textContent = "";
  const interval = setInterval(() => {
    if (i < displayText.length) {
      el.textContent += displayText.charAt(i);
      i++;
    } else {
      clearInterval(interval);
      // Swap to rendered markdown once complete
      el.innerHTML = renderedHtml;
    }
  }, speed);
}

// ===== TOOL EXECUTION CARDS =====
function addToolCard(toolName, args, status, result) {
  // Clear empty state
  const emptyState = toolCardsEl.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  const card = document.createElement("div");
  card.className = "tool-card";

  const statusClass = status === "running" ? "running" : "done";
  const statusText = status === "running" ? "Running..." : "Complete";

  card.innerHTML = `
    <div class="tool-card-header">
      <span class="tool-card-icon">Tool</span>
      <span class="tool-card-name"></span>
      <span class="tool-card-status ${statusClass}">${statusText}</span>
    </div>
  `;
  card.querySelector(".tool-card-name").textContent = toolName;

  if (result) {
    const resultDiv = document.createElement("div");
    resultDiv.className = "tool-card-result";
    resultDiv.textContent = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    card.appendChild(resultDiv);
  }

  toolCardsEl.prepend(card);

  // Max 10 cards
  while (toolCardsEl.children.length > 10) {
    toolCardsEl.removeChild(toolCardsEl.lastChild);
  }
}

// ===== SERVICE HEALTH DASHBOARD =====
function renderServiceCards(services) {
  serviceCardsEl.innerHTML = "";
  for (const [name, data] of Object.entries(services)) {
    const card = document.createElement("div");
    card.className = "service-card";

    const statusClass = data.status === "healthy" ? "healthy" : data.status === "degraded" ? "degraded" : "critical";

    const latencyClass = data.latency_ms_p95 > 800 ? "danger" : data.latency_ms_p95 > 300 ? "warn" : "ok";
    const errorClass = data.error_rate_percent > 5 ? "danger" : data.error_rate_percent > 1 ? "warn" : "ok";
    const cpuClass = data.cpu_percent > 85 ? "danger" : data.cpu_percent > 65 ? "warn" : "ok";

    card.innerHTML = `
      <div class="service-card-header">
        <span class="service-name"></span>
        <span class="service-badge ${statusClass}"></span>
      </div>
      <div class="service-metrics">
        <div class="metric">
          <span class="metric-label">P95 Latency</span>
          <span class="metric-value ${latencyClass}"></span>
        </div>
        <div class="metric">
          <span class="metric-label">Error Rate</span>
          <span class="metric-value ${errorClass}"></span>
        </div>
        <div class="metric">
          <span class="metric-label">CPU</span>
          <span class="metric-value ${cpuClass}"></span>
        </div>
        <div class="metric">
          <span class="metric-label">Status</span>
          <span class="metric-value ${statusClass === 'healthy' ? 'ok' : statusClass === 'degraded' ? 'warn' : 'danger'}"></span>
        </div>
      </div>
      <div class="service-summary"></div>
    `;
    card.querySelector(".service-name").textContent = name;
    card.querySelector(".service-badge").textContent = data.status;
    const metricValues = card.querySelectorAll(".metric-value");
    metricValues[0].textContent = `${data.latency_ms_p95}ms`;
    metricValues[1].textContent = `${data.error_rate_percent}%`;
    metricValues[2].textContent = `${data.cpu_percent}%`;
    metricValues[3].textContent = statusClass.toUpperCase();
    card.querySelector(".service-summary").textContent = data.summary;
    serviceCardsEl.appendChild(card);
  }
}

// ===== INCIDENTS =====
function renderIncidents(incidents) {
  if (!incidents || incidents.length === 0) {
    incidentListEl.innerHTML = `<div class="empty-state"><div class="empty-state-icon">OK</div><p>No active incidents</p></div>`;
    return;
  }
  incidentListEl.innerHTML = "";
  for (const inc of incidents) {
    const card = document.createElement("div");
    card.className = "incident-card";
    const sevClass = inc.severity === "P1" || inc.severity === "HIGH" ? "P1" : inc.severity === "P2" || inc.severity === "MEDIUM" ? "P2" : "P3";
    card.innerHTML = `
      <div class="incident-header">
        <span class="incident-severity ${sevClass}"></span>
        <span class="incident-title"></span>
      </div>
      <div class="incident-meta">
        <span class="inc-service"></span>
        <span class="inc-status"></span>
      </div>
    `;
    card.querySelector(".incident-severity").textContent = inc.severity;
    card.querySelector(".incident-title").textContent = inc.title;
    card.querySelector(".inc-service").textContent = `Service: ${inc.service}`;
    card.querySelector(".inc-status").textContent = `Status: ${inc.status}`;
    incidentListEl.appendChild(card);
  }
}

// ===== PROACTIVE ALERT TOASTS =====
function showAlertToast(alert) {
  // Remove existing toast if any
  const existing = document.querySelector(".alert-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `alert-toast severity-${alert.severity || "P2"}`;

  const severityColors = { P1: "#ef4444", P2: "#f59e0b", P3: "#6b7280" };
  const color = severityColors[alert.severity] || severityColors.P2;

  toast.innerHTML = `
    <div class="alert-toast-header">
      <span class="alert-toast-badge" style="background: ${color}20; color: ${color}">${alert.severity || "ALERT"}</span>
      <span class="alert-toast-title"></span>
      <button class="alert-toast-close" type="button" aria-label="Dismiss">&times;</button>
    </div>
    <div class="alert-toast-body">
      <div class="alert-toast-service"></div>
      <div class="alert-toast-summary"></div>
      <div class="alert-toast-metrics">
        <span>Latency: <b>${alert.metrics?.latency_ms_p95 || "?"}ms</b></span>
        <span>Errors: <b>${alert.metrics?.error_rate_percent || "?"}%</b></span>
        <span>CPU: <b>${alert.metrics?.cpu_percent || "?"}%</b></span>
      </div>
    </div>
  `;

  // Set text content safely
  toast.querySelector(".alert-toast-title").textContent = `${alert.service} is now ${alert.current_status}`;
  toast.querySelector(".alert-toast-service").textContent = `Service: ${alert.service}`;
  toast.querySelector(".alert-toast-summary").textContent = alert.summary || "";

  toast.querySelector(".alert-toast-close").addEventListener("click", () => {
    toast.classList.add("dismissing");
    setTimeout(() => toast.remove(), 300);
  });

  document.body.appendChild(toast);

  // Auto-dismiss after 10 seconds
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.add("dismissing");
      setTimeout(() => toast.remove(), 300);
    }
  }, 10000);

  // Flash the sidebar to draw attention
  const sidebar = document.getElementById("sidebar");
  sidebar.classList.add("alert-flash");
  setTimeout(() => sidebar.classList.remove("alert-flash"), 2000);

  // Refresh service health and incidents
  fetchServiceHealth();
  fetchIncidents();
}

// ===== AUDIO PLAYBACK =====
function getPlaybackContext() {
  if (!playbackContext) {
    playbackContext = new AudioContext({ sampleRate: 24000 });
  }
  return playbackContext;
}

function pcmBytesToAudioBuffer(audioBytes, sampleRate = 24000) {
  const pcm = new Int16Array(audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength));
  const buffer = getPlaybackContext().createBuffer(1, pcm.length, sampleRate);
  const channelData = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) {
    channelData[i] = pcm[i] / 32768;
  }
  return buffer;
}

function queueAudioPlayback(base64Data) {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const context = getPlaybackContext();
  const source = context.createBufferSource();
  source.buffer = pcmBytesToAudioBuffer(bytes);
  source.connect(context.destination);

  const now = context.currentTime;
  playbackCursor = Math.max(playbackCursor, now);
  source.start(playbackCursor);
  playbackCursor += source.buffer.duration;

  // Fix #1: track this source so we only resume voice after the LAST one ends
  activePlaybackSources.push(source);
  setAgentState("speaking");

  source.onended = () => {
    const idx = activePlaybackSources.indexOf(source);
    if (idx !== -1) activePlaybackSources.splice(idx, 1);
    // Only transition state when ALL queued audio has finished
    if (activePlaybackSources.length === 0) {
      if (agentState === "speaking") {
        setAgentState(micStream ? "listening" : "connected");
      }
      maybeResumeVoiceLoop();
    }
  };
}

// Fix #2: flush all queued audio when the user starts speaking
function flushPlaybackQueue() {
  for (const src of activePlaybackSources) {
    try { src.stop(); } catch (_) { /* already stopped */ }
  }
  activePlaybackSources = [];
  playbackCursor = 0;
  if (agentState === "speaking") {
    setAgentState(micStream ? "listening" : "connected");
  }
}

// ===== AUDIO INPUT =====
function downsampleTo16k(float32Samples, inputRate) {
  if (inputRate === 16000) return float32Samples;
  const ratio = inputRate / 16000;
  const length = Math.round(float32Samples.length / ratio);
  const output = new Float32Array(length);
  let outputIndex = 0;
  let inputIndex = 0;

  while (outputIndex < length) {
    const nextIndex = Math.round((outputIndex + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let i = inputIndex; i < nextIndex && i < float32Samples.length; i++) {
      sum += float32Samples[i];
      count++;
    }
    output[outputIndex] = count > 0 ? sum / count : 0;
    outputIndex++;
    inputIndex = nextIndex;
  }
  return output;
}

function floatTo16BitPCM(float32Samples) {
  const pcm = new Int16Array(float32Samples.length);
  for (let i = 0; i < float32Samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32Samples[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm.buffer;
}

function updateMicButton() {
  micBtn.classList.toggle("active", voiceModeEnabled || Boolean(micStream));
  const label = micBtn.querySelector(".mic-label");
  if (label) label.textContent = voiceModeEnabled ? "Stop voice" : "Start voice";
  micBtn.title = voiceModeEnabled ? "Stop interactive voice chat" : "Start interactive voice chat";
  micBtn.setAttribute("aria-pressed", voiceModeEnabled ? "true" : "false");
}

function getCameraModeConfig(mode = cameraInteractionMode) {
  return CAMERA_MODE_CONFIG[mode] || CAMERA_MODE_CONFIG.voice;
}

function usesCameraForVoiceTurns() {
  return cameraInteractionMode === "voice";
}

function syncCameraModeUI() {
  const config = getCameraModeConfig();
  for (const button of cameraModeButtons) {
    if (!button) continue;
    const mode = button.getAttribute("data-camera-mode") || button.dataset.cameraMode;
    const selected = mode === cameraInteractionMode;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", selected ? "true" : "false");
  }
  if (cameraModeHelp) {
    cameraModeHelp.textContent = config.help;
  }
}

function setCameraInteractionMode(mode, options = {}) {
  if (!CAMERA_MODE_CONFIG[mode]) return;

  const previousMode = cameraInteractionMode;
  cameraInteractionMode = mode;
  syncCameraModeUI();

  if (options.silent || previousMode === mode) return;

  const config = getCameraModeConfig();
  logEvent("[camera]", `camera mode set to ${config.label.toLowerCase()}`);
  if (cameraStream) {
    const message = usesCameraForVoiceTurns()
      ? "Camera mode updated. Typed and voice prompts now use the live camera view."
      : "Camera mode updated. Typed prompts use the live camera view. Voice stays normal unless you switch modes.";
    addTranscript("SYSTEM", message);
  }
}

function notifyVoiceActivity(type) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) return;

  const payload = { type };
  if (type === "activity_start" && usesCameraForVoiceTurns() && cameraStream && lastCameraFrameBase64) {
    payload.mimeType = lastCameraFrameMimeType;
    payload.data = lastCameraFrameBase64;
    logEvent("[camera]", "attached latest camera frame to voice turn");
  }

  websocket.send(JSON.stringify(payload));
}

function getRms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

async function maybeResumeVoiceLoop() {
  if (!pendingVoiceResume || !voiceModeEnabled || micStream) return;
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    pendingVoiceResume = false;
    return;
  }

  if (playbackContext && playbackCursor > playbackContext.currentTime + 0.1) {
    return;
  }

  pendingVoiceResume = false;
  try {
    await startMicrophone();
  } catch (error) {
    voiceModeEnabled = false;
    updateMicButton();
    logEvent("[system]", `voice resume error: ${error.message}`);
  }
}

// ===== WAVEFORM VISUALIZER =====
function startWaveform() {
  if (!analyserNode) return;

  const ctx = waveformCanvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = waveformCanvas.getBoundingClientRect();
  waveformCanvas.width = rect.width * dpr;
  waveformCanvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    waveformAnimId = requestAnimationFrame(draw);
    analyserNode.getByteTimeDomainData(dataArray);

    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    // Gradient line
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    gradient.addColorStop(0, "rgba(0, 212, 170, 0.8)");
    gradient.addColorStop(0.5, "rgba(59, 130, 246, 0.8)");
    gradient.addColorStop(1, "rgba(139, 92, 246, 0.8)");

    ctx.lineWidth = 2;
    ctx.strokeStyle = gradient;
    ctx.beginPath();

    const sliceWidth = w / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * h) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }

    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Glow effect
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(0, 212, 170, 0.15)";
    ctx.stroke();
  }

  draw();
}

function stopWaveform() {
  if (waveformAnimId) {
    cancelAnimationFrame(waveformAnimId);
    waveformAnimId = null;
  }
  const ctx = waveformCanvas.getContext("2d");
  const rect = waveformCanvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
}

// ===== MICROPHONE =====
async function startMicrophone() {
  if (micStream || stoppingMicrophone) return;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });

  micContext = new AudioContext();
  micSource = micContext.createMediaStreamSource(micStream);
  analyserNode = micContext.createAnalyser();
  analyserNode.fftSize = 2048;

  // Fix #5: Use AudioWorklet instead of deprecated ScriptProcessor
  try {
    await micContext.audioWorklet.addModule("/static/mic-processor.js");
    workletNode = new AudioWorkletNode(micContext, "mic-processor", {
      processorOptions: { inputSampleRate: micContext.sampleRate },
    });
  } catch (err) {
    // Fallback: if AudioWorklet fails (e.g. non-HTTPS localhost), use ScriptProcessor
    logEvent("[system]", `AudioWorklet unavailable, using fallback: ${err.message}`);
    workletNode = null;
  }

  speechDetected = false;
  lastSpeechAt = performance.now();
  stoppingMicrophone = false;
  pendingVoiceResume = false;
  notifyVoiceActivity("activity_start");

  if (workletNode) {
    // AudioWorklet path — audio processing runs off main thread
    workletNode.port.onmessage = (e) => {
      if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
      const { pcm, rms } = e.data;
      _handleVadAndSend(rms, pcm);
    };
    micSource.connect(analyserNode);
    analyserNode.connect(workletNode);
    workletNode.connect(micContext.destination);
  } else {
    // Fallback ScriptProcessor path
    const fallbackProcessor = micContext.createScriptProcessor(4096, 1, 1);
    fallbackProcessor.onaudioprocess = (event) => {
      if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const rms = getRms(input);
      const downsampled = downsampleTo16k(input, micContext.sampleRate);
      _handleVadAndSend(rms, floatTo16BitPCM(downsampled));
    };
    micSource.connect(analyserNode);
    analyserNode.connect(fallbackProcessor);
    fallbackProcessor.connect(micContext.destination);
    // Store reference for cleanup
    workletNode = fallbackProcessor;
    workletNode._isFallback = true;
  }

  audioStatus.textContent = "Mic on";
  audioStatus.className = "pill is-mic-on";
  updateMicButton();
  setAgentState("listening");
  startWaveform();
}

// Fix #6: Adaptive VAD with noise floor estimation + Fix #2: flush on speech
function _handleVadAndSend(rms, pcmBuffer) {
  const adaptiveThreshold = Math.max(VAD_MIN_THRESHOLD, noiseFloorRms * VAD_THRESHOLD_MULTIPLIER);

  if (rms >= adaptiveThreshold) {
    if (!speechDetected) {
      // User started speaking — flush any agent audio still playing
      flushPlaybackQueue();
    }
    speechDetected = true;
    lastSpeechAt = performance.now();
  } else {
    // Update noise floor estimate during silence
    noiseFloorRms = NOISE_FLOOR_ALPHA * rms + (1 - NOISE_FLOOR_ALPHA) * noiseFloorRms;
    if (speechDetected && performance.now() - lastSpeechAt >= VOICE_SILENCE_MS && !stoppingMicrophone) {
      stopMicrophone({ autoStopped: true });
      return;
    }
  }
  websocket.send(pcmBuffer);
}

function stopMicrophone(options = {}) {
  const { autoStopped = false } = options;
  if (stoppingMicrophone) return;
  stoppingMicrophone = true;

  stopWaveform();
  if (workletNode) {
    if (workletNode._isFallback) {
      // ScriptProcessor fallback cleanup
      workletNode.disconnect();
      workletNode.onaudioprocess = null;
    } else {
      // AudioWorklet cleanup — signal the processor to stop
      workletNode.port.postMessage("stop");
      workletNode.disconnect();
    }
    workletNode = null;
  }
  if (analyserNode) {
    analyserNode.disconnect();
    analyserNode = null;
  }
  if (micSource) {
    micSource.disconnect();
    micSource = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (micContext) {
    micContext.close();
    micContext = null;
  }
  notifyVoiceActivity("activity_end");
  audioStatus.textContent = "Mic off";
  audioStatus.className = "pill";
  speechDetected = false;
  lastSpeechAt = 0;
  updateMicButton();
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    setAgentState(autoStopped ? "analyzing" : "connected");
  } else {
    setAgentState("idle");
  }
  pendingVoiceResume = autoStopped && voiceModeEnabled;
  stoppingMicrophone = false;
}

// ===== BUTTON LABEL HELPERS =====
const _cameraSvg = cameraBtn.querySelector("svg")?.outerHTML || "";
function _setCameraBtnLabel(text) {
  cameraBtn.innerHTML = _cameraSvg + " " + text;
}

async function waitForCameraPreview() {
  if (cameraPreview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && cameraPreview.videoWidth > 0) {
    return;
  }

  await new Promise((resolve, reject) => {
    const handleLoaded = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Camera preview failed to initialize."));
    };
    const cleanup = () => {
      cameraPreview.removeEventListener("loadedmetadata", handleLoaded);
      cameraPreview.removeEventListener("error", handleError);
    };

    cameraPreview.addEventListener("loadedmetadata", handleLoaded, { once: true });
    cameraPreview.addEventListener("error", handleError, { once: true });
  });
}

// ===== CAMERA =====
let cameraFramePending = false;

function captureCameraFrame() {
  const sourceWidth = cameraPreview.videoWidth || 768;
  const sourceHeight = cameraPreview.videoHeight || 768;
  const context = cameraCanvas.getContext("2d");
  if (!context) return null;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const sourceMaxDimension = Math.max(sourceWidth, sourceHeight);
  let lastAttempt = null;

  for (const targetMaxDimension of CAMERA_FRAME_DIMENSIONS) {
    const scale = sourceMaxDimension > targetMaxDimension ? targetMaxDimension / sourceMaxDimension : 1;
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    cameraCanvas.width = width;
    cameraCanvas.height = height;
    context.drawImage(cameraPreview, 0, 0, width, height);

    for (const quality of CAMERA_FRAME_QUALITIES) {
      const dataUrl = cameraCanvas.toDataURL("image/jpeg", quality);
      const base64 = dataUrl.split(",")[1];
      lastAttempt = { base64, width, height, quality };
      if (base64.length <= MAX_CAMERA_FRAME_BASE64_CHARS) {
        return lastAttempt;
      }
    }
  }

  return lastAttempt && lastAttempt.base64.length <= MAX_CAMERA_FRAME_BASE64_CHARS ? lastAttempt : null;
}

function sendUserTextMessage(text) {
  if (!text || !websocket || websocket.readyState !== WebSocket.OPEN) return false;

  if (cameraStream && lastCameraFrameBase64) {
    websocket.send(JSON.stringify({
      type: "multimodal_text",
      text,
      mimeType: lastCameraFrameMimeType,
      data: lastCameraFrameBase64,
    }));
    logEvent("[camera]", "attached latest camera frame to text prompt");
  } else {
    websocket.send(JSON.stringify({ type: "text", text }));
  }

  addTranscript("USER", text);
  setAgentState("analyzing");
  return true;
}

async function startCamera() {
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 768 }, height: { ideal: 768 }, facingMode: { ideal: "environment" } },
    audio: false,
  });

  cameraPreview.srcObject = cameraStream;
  await cameraPreview.play();
  await waitForCameraPreview();
  // Fix #3: reuse a single canvas instead of creating one per frame
  if (!cameraCanvas) cameraCanvas = document.createElement("canvas");
  lastCameraFrameBase64 = "";
  hasLoggedCameraFrameReady = false;
  cameraFramePending = false;
  cameraInterval = window.setInterval(() => {
    const frame = captureCameraFrame();
    if (!frame) {
      if (!hasLoggedCameraFrameReady) {
        logEvent("[camera]", `unable to compress camera frame below ${MAX_CAMERA_FRAME_BASE64_CHARS} base64 chars`);
      }
      return;
    }

    lastCameraFrameBase64 = frame.base64;
    lastCameraFrameMimeType = "image/jpeg";
    if (!hasLoggedCameraFrameReady) {
      hasLoggedCameraFrameReady = true;
      logEvent("[camera]", `camera frame ready (${frame.width}x${frame.height}, quality ${frame.quality})`);
    }

    // In "Camera + Type" mode only capture frames locally for use when user submits text.
    // Only stream frames to the server in "Camera + Type + Voice" mode (alongside voice input).
    if (!usesCameraForVoiceTurns()) return;

    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
    if (cameraFramePending) return;

    const payload = JSON.stringify({
      type: "image",
      mimeType: lastCameraFrameMimeType,
      data: lastCameraFrameBase64,
    });
    cameraFramePending = true;
    try {
      websocket.send(payload);
    } finally {
      setTimeout(() => { cameraFramePending = false; }, 0);
    }
  }, 1000);

  cameraStatus.textContent = "Camera on";
  cameraStatus.className = "pill is-camera-on";
  _setCameraBtnLabel("Stop camera");
  const cameraReadyMessage = usesCameraForVoiceTurns()
    ? 'Camera is on. Current mode: Camera + Type + Voice. Ask by voice or type, for example: "What do you see in this view?"'
    : 'Camera is on. Current mode: Camera + Type. Typed prompts use this view. Switch modes if you want voice to use the camera too.';
  addTranscript("SYSTEM", cameraReadyMessage);
  logEvent("[camera]", "camera enabled; streaming one frame per second");
}

function stopCamera() {
  const wasRunning = Boolean(cameraStream);
  if (cameraInterval) {
    window.clearInterval(cameraInterval);
    cameraInterval = undefined;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  lastCameraFrameBase64 = "";
  hasLoggedCameraFrameReady = false;
  cameraPreview.srcObject = null;
  cameraStatus.textContent = "Camera off";
  cameraStatus.className = "pill";
  _setCameraBtnLabel("Camera");
  if (wasRunning) {
    addTranscript("SYSTEM", "Camera stopped.");
    logEvent("[camera]", "camera stopped");
  }
}

// ===== EVENT MESSAGE HANDLER =====
function handleEventMessage(eventPayload) {
  logEvent("[agent]", JSON.stringify(eventPayload, null, 2));

  // Handle proactive alerts (not regular agent events)
  if (eventPayload?.type === "proactive_alert") {
    showAlertToast(eventPayload);
    addTranscript("SYSTEM", `Alert: ${eventPayload.service} status changed to ${eventPayload.current_status}. ${eventPayload.summary}`);
    logEvent("[alert]", JSON.stringify(eventPayload, null, 2));
    return;
  }

  // Detect tool calls from the event
  const actions = eventPayload?.actions || {};
  const functionCalls = eventPayload?.content?.parts?.filter(p => p.functionCall) || [];
  const functionResponses = eventPayload?.content?.parts?.filter(p => p.functionResponse) || [];

  // Tool call started
  for (const fc of functionCalls) {
    setAgentState("tool");
    addToolCard(fc.functionCall.name, fc.functionCall.args, "running", null);
  }

  // Tool call result
  for (const fr of functionResponses) {
    const name = fr.functionResponse?.name || "tool";
    const result = fr.functionResponse?.response;
    addToolCard(name, null, "done", result);

    // Update service cards if it's a health check result
    if (name === "check_service_health" && result?.service) {
      fetchServiceHealth();
    }
    // Update incidents if incident was created
    if (name === "create_incident" || name === "update_incident_status" || name === "get_open_incidents") {
      fetchIncidents();
    }
  }

  // Collect transcription text first (preferred source - avoids duplicates)
  const inputTranscript = actions?.inputAudioTranscription?.text || "";
  const outputTranscript = actions?.outputAudioTranscription?.text || "";

  // Handle text and audio parts - only use content.parts.text if no transcription is available
  const parts = eventPayload?.content?.parts || [];
  const fallbackTexts = [];
  for (const part of parts) {
    if (part.text) {
      fallbackTexts.push(part.text);
    }
    if (part.inlineData?.mimeType?.startsWith("audio/pcm") && part.inlineData.data) {
      queueAudioPlayback(part.inlineData.data);
    }
  }

  // Handle transcriptions
  if (inputTranscript) {
    addTranscript("USER", inputTranscript);
  }
  if (outputTranscript) {
    addTranscript("OPSVOICE", outputTranscript);
  } else {
    const fallbackText = fallbackTexts.join("\n").trim();
    if (fallbackText) {
      addTranscript(eventPayload.author || "OPSVOICE", fallbackText);
    }
  }

  // If we got a turn complete, switch back from analyzing/tool to listening or connected
  if (eventPayload?.turnComplete) {
    if (agentState === "analyzing" || agentState === "tool") {
      setAgentState(micStream ? "listening" : "connected");
    }
    pendingVoiceResume = pendingVoiceResume || (voiceModeEnabled && !micStream);
    maybeResumeVoiceLoop();
  }
}

// ===== API FETCHERS =====
function authHeaders() {
  return sessionToken ? { "Authorization": `Bearer ${sessionToken}` } : {};
}

async function fetchServiceHealth() {
  try {
    const resp = await fetch("/api/services", { headers: authHeaders() });
    if (resp.ok) {
      const data = await resp.json();
      renderServiceCards(data);
    } else {
      serviceCardsEl.innerHTML = `<div class="empty-state"><p>Services unavailable</p></div>`;
    }
  } catch (e) {
    serviceCardsEl.innerHTML = `<div class="empty-state"><p>Connection error</p></div>`;
  }
}

async function fetchIncidents() {
  try {
    const resp = await fetch("/api/incidents", { headers: authHeaders() });
    if (resp.ok) {
      const data = await resp.json();
      renderIncidents(data.items || []);
    } else {
      incidentListEl.innerHTML = `<div class="empty-state"><p>Failed to load incidents</p></div>`;
    }
  } catch (e) {
    incidentListEl.innerHTML = `<div class="empty-state"><p>Connection error</p></div>`;
  }
}

// ===== WEBSOCKET =====
async function fetchSession() {
  const response = await fetch("/session");
  if (!response.ok) throw new Error("Unable to create a local session.");
  return response.json();
}

async function connect() {
  intentionalDisconnect = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  // Eagerly initialize audio context on user gesture to avoid autoplay issues
  try {
    const ctx = getPlaybackContext();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
  } catch(e) { /* ignore */ }

  const session = await fetchSession();
  userId = session.user_id;
  sessionId = session.session_id;
  sessionToken = session.token;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${protocol}://${window.location.host}/ws/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(sessionToken)}`;
  websocket = new WebSocket(wsUrl);

  websocket.onopen = () => {
    reconnectAttempts = 0; // reset on successful connect
    setConnectionState("Connected");
    disconnectBtn.disabled = false;
    sendBtn.disabled = false;
    logEvent("[system]", `connected to session ${sessionId}`);
    setAgentState("connected");
    updateMicButton();

    // Pre-fetch service health & incidents
    fetchServiceHealth();
    fetchIncidents();

    // Periodic dashboard refresh
    if (window._healthRefreshInterval) clearInterval(window._healthRefreshInterval);
    window._healthRefreshInterval = setInterval(() => {
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        fetchServiceHealth();
        fetchIncidents();
      }
    }, 10000);
  };

  websocket.onmessage = (event) => {
    try {
      handleEventMessage(JSON.parse(event.data));
    } catch (error) {
      logEvent("[server]", event.data);
    }
  };

  websocket.onerror = () => {
    logEvent("[system]", "websocket error");
  };

  websocket.onclose = () => {
    const wasConnected = connectionStatus.textContent === "Connected";
    setConnectionState("Disconnected");
    disconnectBtn.disabled = true;
    sendBtn.disabled = true;
    stopMicrophone();
    stopCamera();
    websocket = undefined;
    sessionToken = "";
    if (window._healthRefreshInterval) { clearInterval(window._healthRefreshInterval); window._healthRefreshInterval = null; }
    voiceModeEnabled = false;
    pendingVoiceResume = false;
    updateMicButton();
    setAgentState("idle");

    // Fix #4: auto-reconnect with exponential backoff (only if not user-initiated)
    // Check intentionalDisconnect again in the timeout callback to handle races
    if (!intentionalDisconnect && wasConnected && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts);
      reconnectAttempts++;
      setConnectionState(`Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      logEvent("[system]", `connection lost, reconnecting in ${delay}ms...`);
      connectBtn.disabled = true;
      reconnectTimer = setTimeout(async () => {
        // Re-check: user may have clicked disconnect while timer was pending
        if (intentionalDisconnect) {
          connectBtn.disabled = false;
          return;
        }
        try {
          await connect();
        } catch (err) {
          logEvent("[system]", `reconnect failed: ${err.message}`);
          connectBtn.disabled = false;
        }
      }, delay);
    } else {
      connectBtn.disabled = false;
    }
  };
}

function disconnect() {
  intentionalDisconnect = true;
  reconnectAttempts = 0;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (websocket) websocket.close();
}

async function ensureConnected() {
  if (websocket && websocket.readyState === WebSocket.OPEN) return;
  connectBtn.disabled = true;
  try {
    await connect();
  } catch (error) {
    connectBtn.disabled = false;
    throw error;
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection timeout")), 10000);
    const interval = setInterval(() => {
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      } else if (!websocket || websocket.readyState >= WebSocket.CLOSING) {
        clearInterval(interval);
        clearTimeout(timeout);
        reject(new Error("Connection failed"));
      }
    }, 100);
  });
}

function reportUploadIssue(message) {
  addTranscript("SYSTEM", message);
  logEvent("[system]", message);
}

function getFileExtension(fileName) {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex + 1).toLowerCase();
}

function isImageFile(file) {
  return Boolean(file?.type?.startsWith("image/"));
}

function isTextLogFile(file) {
  if (!file) return false;
  if (file.type?.startsWith("text/")) return true;
  if (TEXT_LOG_MIME_TYPES.has(file.type)) return true;
  return TEXT_LOG_EXTENSIONS.has(getFileExtension(file.name));
}

function truncateTextByUtf8Bytes(text, maxBytes) {
  const totalBytes = utf8Encoder.encode(text).length;
  if (totalBytes <= maxBytes) {
    return { text, totalBytes, truncated: false };
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidateBytes = utf8Encoder.encode(text.slice(0, mid)).length;
    if (candidateBytes <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return {
    text: text.slice(0, low),
    totalBytes,
    truncated: true,
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

async function uploadImageFile(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const base64 = String(dataUrl).split(",")[1];
  websocket.send(JSON.stringify({
    type: "image",
    mimeType: file.type,
    data: base64,
  }));
  addTranscript("USER", `Uploaded image: ${file.name}`);
  logEvent("[upload]", `image ${file.name} (${file.type || "unknown"}, ${file.size} bytes)`);
  setAgentState("analyzing");
}

async function uploadTextLogFile(file) {
  const rawText = await file.text();
  if (!rawText.trim()) {
    reportUploadIssue(`"${file.name}" is empty, so there is nothing to analyze.`);
    return;
  }

  const { text, totalBytes, truncated } = truncateTextByUtf8Bytes(rawText, MAX_LOG_UPLOAD_BYTES);
  const prompt = [
    "Analyze this uploaded log file. Summarize the issue, likely cause, and next troubleshooting step.",
    `File: ${file.name}`,
    truncated ? `Note: only the first ${MAX_LOG_UPLOAD_BYTES} bytes were uploaded.` : null,
    "Log contents:",
    "```",
    text,
    "```",
  ].filter(Boolean).join("\n\n");

  websocket.send(JSON.stringify({ type: "text", text: prompt }));
  addTranscript("USER", `Uploaded log file: ${file.name}${truncated ? " (truncated)" : ""}`);
  logEvent(
    "[upload]",
    `log ${file.name} (${totalBytes} bytes${truncated ? `, truncated to ${MAX_LOG_UPLOAD_BYTES} bytes` : ""})`,
  );
  setAgentState("analyzing");
}

async function handleUploadedFile(file) {
  if (!file) {
    reportUploadIssue("No file was detected in the upload area.");
    return;
  }

  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    reportUploadIssue("Connect to OpsVoice before uploading a screenshot or log file.");
    return;
  }

  try {
    if (isImageFile(file)) {
      await uploadImageFile(file);
      return;
    }

    if (isTextLogFile(file)) {
      await uploadTextLogFile(file);
      return;
    }
  } catch (error) {
    reportUploadIssue(`Upload failed for "${file.name}": ${error.message}`);
    return;
  }

  reportUploadIssue(`Unsupported file "${file.name}". Upload an image or a text log file such as .log, .txt, or .json.`);
}

// ===== DRAG & DROP FILE UPLOAD =====
function setupDropZone() {
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    await handleUploadedFile(e.dataTransfer.files[0]);
  });

  // Also handle click to select file
  dropZone.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.log,.txt,.json,.ndjson,.out";
    input.onchange = async () => {
      await handleUploadedFile(input.files[0]);
    };
    input.click();
  });
}

// ===== EVENT LOG TOGGLE =====
function setupCameraModeControls() {
  for (const button of cameraModeButtons) {
    if (!button) continue;
    button.addEventListener("click", async (e) => {
      e.preventDefault();
      const mode = button.getAttribute("data-camera-mode") || button.dataset.cameraMode;
      if (!mode) return;

      const wasVoiceEnabled = voiceModeEnabled;
      setCameraInteractionMode(mode);

      try {
        await ensureConnected();
        if (!cameraStream) await startCamera();

        if (mode === "voice") {
          // "Camera + Type + Voice": always ensure voice is running
          if (!voiceModeEnabled || !micStream) {
            voiceModeEnabled = true;
            updateMicButton();
            await startMicrophone();
          }
        } else if (mode === "text") {
          // "Camera + Type": stop voice if it was running
          if (voiceModeEnabled || micStream) {
            voiceModeEnabled = false;
            stopMicrophone();
          }
        }
      } catch (error) {
        voiceModeEnabled = false;
        updateMicButton();
        addTranscript("SYSTEM", `Failed to start: ${error.message}`);
        logEvent("[system]", `camera mode auto-start error: ${error.message}`);
      }
    });
  }
  syncCameraModeUI();
}

function setupEventLogToggle() {
  eventLogToggle.addEventListener("click", () => {
    eventLogToggle.classList.toggle("open");
    eventLogEl.classList.toggle("visible");
  });
}

// ===== CLICK ON ORB TO TOGGLE MIC =====
function setupOrb() {
  orbContainer.addEventListener("click", async () => {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
    if (voiceModeEnabled) {
      voiceModeEnabled = false;
      stopMicrophone();
    } else {
      try {
        voiceModeEnabled = true;
        updateMicButton();
        await startMicrophone();
      } catch (err) {
        voiceModeEnabled = false;
        updateMicButton();
        logEvent("[system]", `mic error: ${err.message}`);
      }
    }
  });
}

// ===== EVENT LISTENERS =====
connectBtn.addEventListener("click", async () => {
  connectBtn.disabled = true;
  try {
    await connect();
  } catch (error) {
    logEvent("[system]", error.message);
    addTranscript("SYSTEM", `Connection failed: ${error.message}. Check the server is running and try again.`);
    connectBtn.disabled = false;
  }
});

disconnectBtn.addEventListener("click", () => {
  connectBtn.disabled = false;
  disconnect();
});

micBtn.addEventListener("click", async () => {
  if (voiceModeEnabled) {
    voiceModeEnabled = false;
    stopMicrophone();
    return;
  }
  try {
    await ensureConnected();
    voiceModeEnabled = true;
    updateMicButton();
    await startMicrophone();
  } catch (error) {
    voiceModeEnabled = false;
    updateMicButton();
    addTranscript("SYSTEM", `Voice start failed: ${error.message}`);
    logEvent("[system]", `mic error: ${error.message}`);
  }
});

cameraBtn.addEventListener("click", async () => {
  if (cameraStream) {
    stopCamera();
    return;
  }
  try {
    await ensureConnected();
    await startCamera();
  } catch (error) {
    addTranscript("SYSTEM", `Camera error: ${error.message}`);
    logEvent("[system]", `camera error: ${error.message}`);
  }
});

textForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text || !websocket || websocket.readyState !== WebSocket.OPEN) return;
  if (sendUserTextMessage(text)) {
    textInput.value = "";
  }
});

clearLogBtn.addEventListener("click", () => {
  transcriptEl.innerHTML = "";
  eventLogEl.textContent = "";
  toolCardsEl.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg></div><p>Tool calls will appear here</p></div>`;
  firstTranscript = true;
  recentTranscriptKeys = [];
});

// ===== WAVEFORM RESIZE HANDLER =====
window.addEventListener("resize", () => {
  if (waveformAnimId && analyserNode) {
    // Re-initialize canvas dimensions on resize
    const ctx = waveformCanvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = waveformCanvas.getBoundingClientRect();
    waveformCanvas.width = rect.width * dpr;
    waveformCanvas.height = rect.height * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }
});

// ===== PAGE UNLOAD CLEANUP =====
window.addEventListener("beforeunload", () => {
  intentionalDisconnect = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (websocket) { try { websocket.close(); } catch (_) {} }
  if (playbackContext) { try { playbackContext.close(); } catch (_) {} playbackContext = null; }
  stopMicrophone();
  stopCamera();
});

// ===== INIT =====
setupDropZone();
setupCameraModeControls();
setupEventLogToggle();
setupOrb();
updateMicButton();

