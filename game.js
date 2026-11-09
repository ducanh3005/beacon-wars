/**
 * Beacon Wars — Interactive Browser Command-Center UI, Web Audio Synth,
 * Serverless Cloud Relay Client (ntfy.sh), Local REST Client, & Replay Scrubber.
 */
(function () {
  "use strict";

  const E = window.BeaconEngine;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const HEX_SIZE = 43;
  const SQRT3 = Math.sqrt(3);
  const NTFY_BASE = "https://ntfy.sh";
  const TOPIC_PREFIX = "bw_v1_";
  const SAFE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  const FACTION_COLORS = {
    0: { fill: "#0f182b", inner: "#142038", stroke: "#334155", glow: "none" },
    1: { fill: "rgba(34, 211, 238, 0.20)", inner: "rgba(34, 211, 238, 0.30)", stroke: "#22d3ee", glow: "#22d3ee" },
    2: { fill: "rgba(251, 191, 36, 0.20)", inner: "rgba(251, 191, 36, 0.30)", stroke: "#fbbf24", glow: "#fbbf24" },
    3: { fill: "rgba(52, 211, 153, 0.20)", inner: "rgba(52, 211, 153, 0.30)", stroke: "#34d399", glow: "#34d399" },
    4: { fill: "rgba(251, 113, 133, 0.20)", inner: "rgba(251, 113, 133, 0.30)", stroke: "#fb7185", glow: "#fb7185" },
  };

  // ==========================================================================
  // Web Audio Sci-Fi Synthesizer (Zero External Audio Assets)
  // ==========================================================================
  class SoundFX {
    constructor() {
      this.enabled = true;
      this.ctx = null;
    }

    _ensureCtx() {
      if (!this.enabled) return null;
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) this.ctx = new AudioCtx();
      }
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    tone(freq, endFreq, duration, type = "sine", gainVal = 0.09, delay = 0) {
      const ctx = this._ensureCtx();
      if (!ctx) return;
      const now = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      if (endFreq && endFreq !== freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), now + duration);
      }
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(gainVal, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    }

    playForMove(entry) {
      if (!entry || !this.enabled) return;
      switch (entry.action) {
        case "DEPLOY":
          this.tone(420, 640, 0.12, "triangle", 0.08);
          break;
        case "STRIKE":
          if (entry.outcome === "CAPTURE") {
            this.tone(180, 90, 0.18, "sawtooth", 0.09);
            this.tone(523.25, 783.99, 0.22, "triangle", 0.09, 0.05);
          } else {
            this.tone(240, 110, 0.18, "square", 0.07);
          }
          break;
        case "SHIELD":
          this.tone(523.25, 659.25, 0.14, "sine", 0.07, 0);
          this.tone(659.25, 1046.5, 0.2, "sine", 0.07, 0.07);
          break;
        case "PULSE":
          this.tone(110, 55, 0.38, "sawtooth", 0.1);
          this.tone(440, 880, 0.35, "triangle", 0.09, 0.04);
          this.tone(659.25, 1318.5, 0.38, "sine", 0.07, 0.09);
          break;
        case "END_TURN":
          this.tone(360, 480, 0.09, "sine", 0.05);
          break;
      }
    }

    playVictory() {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((n, idx) => this.tone(n, n, 0.26, "triangle", 0.09, idx * 0.11));
    }
  }

  const sfx = new SoundFX();

  // ==========================================================================
  // Client Application State
  // ==========================================================================
  const app = {
    mode: "QUICK", // "QUICK" | "CLOUD" | "REST" | "REPLAY"
    session: null, // E.MatchSession for QUICK / CLOUD, or mirror for REST / REPLAY
    mySeats: new Set([1]), // Seats controlled by this browser user
    clientId: getOrCreateClientId(),

    // UI interaction state
    selectedAction: "DEPLOY", // "DEPLOY" | "STRIKE" | "SHIELD" | null
    strikeOriginKey: null,
    hoveredHexKey: null,
    botAnimTimer: null,
    botAnimating: false,

    // Replay scrubber state
    scrubIndex: 0, // Index into frames[]
    isLiveScrub: true,
    replayTimer: null,

    // Cloud Relay state
    cloudCode: null,
    cloudSse: null,
    cloudPollTimer: null,
    cloudCursor: null,
    cloudSeenIds: new Set(),
    cloudEvents: [],
    pendingCloudEvents: [],
    cloudPostChain: Promise.resolve(),

    // REST API state
    restBaseUrl: "http://localhost:8080",
    restCode: null,
    restToken: null,
    restPollTimer: null,

    // Lobby UI state
    selectedCloudPlayers: 2,
  };

  function getOrCreateClientId() {
    try {
      let cid = sessionStorage.getItem("bw_client_id");
      if (!cid) {
        cid = "web_" + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem("bw_client_id", cid);
      }
      return cid;
    } catch (_) {
      return "web_" + Math.random().toString(36).slice(2, 10);
    }
  }

  function randomMatchCode(len = 6) {
    let out = "";
    for (let i = 0; i < len; i++) {
      out += SAFE_ALPHABET[Math.floor(Math.random() * SAFE_ALPHABET.length)];
    }
    return out;
  }

  // ==========================================================================
  // Axial Hex Geometry Helpers (Flat-Top SVG Layout)
  // ==========================================================================
  function axialToPixel(q, r) {
    const x = HEX_SIZE * 1.5 * q;
    const y = HEX_SIZE * SQRT3 * (r + q / 2);
    return [x, y];
  }

  function hexPolygonPoints(cx, cy, radius) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i);
      const px = cx + radius * Math.cos(angle);
      const py = cy + radius * Math.sin(angle);
      pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
    }
    return pts.join(" ");
  }

  // ==========================================================================
  // Cleanup Active Timers / Streams Before Switching Modes
  // ==========================================================================
  function teardownConnections() {
    if (app.botAnimTimer) {
      clearTimeout(app.botAnimTimer);
      app.botAnimTimer = null;
    }
    app.botAnimating = false;
    stopReplayAutoplay();

    if (app.cloudSse) {
      app.cloudSse.close();
      app.cloudSse = null;
    }
    if (app.cloudPollTimer) {
      clearInterval(app.cloudPollTimer);
      app.cloudPollTimer = null;
    }
    if (app.restPollTimer) {
      clearInterval(app.restPollTimer);
      app.restPollTimer = null;
    }
  }

  // ==========================================================================
  // Mode 1: Instant Quick Play vs Built-in Tactical Bots
  // ==========================================================================
  function startQuickPlay(maxPlayers = 2) {
    teardownConnections();
    app.mode = "QUICK";
    app.cloudCode = null;
    app.restCode = null;
    app.mySeats = new Set([1]);

    const sess = new E.MatchSession({
      matchCode: `QP-${maxPlayers}P`,
      maxPlayers,
      creatorName: "You (Commander)",
      creatorType: "human",
      creatorClientId: app.clientId,
      startWaiting: true,
    });
    sess.fillBots();
    app.session = sess;
    app.isLiveScrub = true;
    app.scrubIndex = sess.frames.length - 1;
    app.selectedAction = "DEPLOY";
    app.strikeOriginKey = null;

    // Highlight active quick-play button
    document.querySelectorAll(".quickplay-group .btn").forEach((b) => b.classList.remove("active-qp"));
    const activeBtn = document.getElementById(`btnQuick${maxPlayers}P`);
    if (activeBtn) activeBtn.classList.add("active-qp");

    // Clean URL query param if previously in a cloud room
    if (window.location.search) {
      window.history.replaceState({}, "", window.location.pathname);
    }

    renderAll();
  }

  function stepAnimatedQuickPlayBots() {
    if (app.mode !== "QUICK" || !app.session) return;
    const st = app.session.state;
    if (st.status !== "ACTIVE") {
      app.botAnimating = false;
      renderAll();
      return;
    }
    const actP = st.activePlayer;
    if (st.players[String(actP)].type !== "builtin_bot") {
      app.botAnimating = false;
      autoSelectBestDefaultTool();
      renderAll();
      return;
    }

    app.botAnimating = true;
    renderAll();
    app.botAnimTimer = setTimeout(() => {
      if (app.mode !== "QUICK" || !app.session) return;
      const curState = app.session.state;
      if (curState.status !== "ACTIVE") return;
      const p = curState.activePlayer;
      if (curState.players[String(p)].type !== "builtin_bot") {
        app.botAnimating = false;
        renderAll();
        return;
      }
      const bmove = E.chooseBuiltinBotMove(curState, p);
      const [entry] = app.session.submitMove(p, bmove, false);
      sfx.playForMove(entry);
      if (curState.status === "FINISHED") sfx.playVictory();
      if (app.isLiveScrub) {
        app.scrubIndex = app.session.frames.length - 1;
      }
      renderAll();
      stepAnimatedQuickPlayBots();
    }, 240);
  }

  // ==========================================================================
  // Mode 2: Serverless Live Cloud Multiplayer (ntfy.sh JSON Event Stream)
  // ==========================================================================
  function enqueueCloudPost(code, eventObj) {
    const url = `${NTFY_BASE}/${TOPIC_PREFIX}${code.toUpperCase()}`;
    const body = JSON.stringify(eventObj);
    app.cloudPostChain = app.cloudPostChain
      .then(() =>
        fetch(url, {
          method: "POST",
          body,
          // Plain text/plain avoids CORS preflight on browsers!
        })
      )
      .catch((err) => console.warn("Cloud relay post error:", err));
    return app.cloudPostChain;
  }

  function ingestCloudEnvelope(envelope) {
    if (!envelope || envelope.event !== "message") return false;
    if (envelope.id && app.cloudSeenIds.has(envelope.id)) return false;
    if (envelope.id) {
      app.cloudSeenIds.add(envelope.id);
      app.cloudCursor = envelope.id;
    }
    let evt;
    try {
      evt = JSON.parse(envelope.message || "");
    } catch (_) {
      return false;
    }
    if (!evt || typeof evt !== "object") return false;
    app.cloudEvents.push(evt);
    if (evt.type === "MOVE") {
      app.pendingCloudEvents = app.pendingCloudEvents.filter(
        (pe) => !(pe.type === "MOVE" && pe.seq === evt.seq)
      );
    } else if (evt.type === "FILL_BOTS") {
      app.pendingCloudEvents = app.pendingCloudEvents.filter((pe) => pe.type !== "FILL_BOTS");
    } else if (evt.type === "CREATE") {
      app.pendingCloudEvents = app.pendingCloudEvents.filter((pe) => pe.type !== "CREATE");
    }
    return true;
  }

  function rebuildCloudStateFromEvents() {
    if (!app.cloudCode) return;
    const prevSeq = app.session ? app.session.state.seq : 0;
    const prevStatus = app.session ? app.session.state.status : "WAITING";
    const mergedEvents = app.cloudEvents.concat(app.pendingCloudEvents);
    const rebuilt = E.reconstructCloudSession(app.cloudCode, mergedEvents);
    if (!rebuilt) return;

    app.session = rebuilt;
    app.mySeats = new Set();
    for (let p = 1; p <= rebuilt.state.maxPlayers; p++) {
      if (rebuilt.state.players[String(p)].clientId === app.clientId) {
        app.mySeats.add(p);
      }
    }

    if (rebuilt.state.seq > prevSeq && rebuilt.log.length > 0) {
      const latest = rebuilt.log[rebuilt.log.length - 1];
      sfx.playForMove(latest);
    }
    if (prevStatus !== "FINISHED" && rebuilt.state.status === "FINISHED") {
      sfx.playVictory();
    }

    if (app.isLiveScrub) {
      app.scrubIndex = rebuilt.frames.length - 1;
    }
    autoSelectBestDefaultTool();
    renderAll();
  }

  async function pollCloudOnce() {
    if (app.mode !== "CLOUD" || !app.cloudCode) return;
    const since = app.cloudCursor || "12h";
    const url = `${NTFY_BASE}/${TOPIC_PREFIX}${app.cloudCode}/json?poll=1&since=${encodeURIComponent(since)}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const text = await resp.text();
      let changed = false;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const env = JSON.parse(trimmed);
          if (ingestCloudEnvelope(env)) changed = true;
        } catch (_) {}
      }
      if (changed) rebuildCloudStateFromEvents();
    } catch (_) {}
  }

  function connectCloudStream(code) {
    const cleanCode = code.toUpperCase();
    app.cloudCode = cleanCode;
    app.cloudCursor = null;
    app.cloudSeenIds = new Set();
    app.cloudEvents = [];
    app.pendingCloudEvents = [];

    // Update browser URL so user can share or refresh seamlessly
    const newUrl = `${window.location.pathname}?match=${cleanCode}`;
    window.history.replaceState({}, "", newUrl);

    // Subscribe via SSE for <200ms real-time updates + poll fallback
    try {
      const sseUrl = `${NTFY_BASE}/${TOPIC_PREFIX}${cleanCode}/sse?since=12h`;
      const es = new EventSource(sseUrl);
      es.onmessage = (e) => {
        try {
          const env = JSON.parse(e.data);
          if (ingestCloudEnvelope(env)) rebuildCloudStateFromEvents();
        } catch (_) {}
      };
      app.cloudSse = es;
    } catch (_) {}

    pollCloudOnce();
    app.cloudPollTimer = setInterval(pollCloudOnce, 2500);
  }

  async function createCloudMatch(maxPlayers, playerName) {
    teardownConnections();
    app.mode = "CLOUD";
    const code = randomMatchCode(6);
    const name = (playerName || "Commander").trim() || "Commander";

    document.querySelectorAll(".quickplay-group .btn").forEach((b) => b.classList.remove("active-qp"));

    // Optimistic initial session while CREATE posts
    app.session = new E.MatchSession({
      matchCode: code,
      maxPlayers,
      creatorName: name,
      creatorType: "human",
      creatorClientId: app.clientId,
      startWaiting: true,
    });
    app.mySeats = new Set([1]);
    app.isLiveScrub = true;
    app.scrubIndex = 0;

    connectCloudStream(code);
    await enqueueCloudPost(code, {
      v: 1,
      type: "CREATE",
      code,
      maxPlayers,
      name,
      playerType: "human",
      clientId: app.clientId,
      ts: Math.floor(Date.now() / 1000),
    });
    closeModal("lobbyModal");
    renderAll();
  }

  async function joinCloudMatch(code, playerName) {
    const cleanCode = (code || "").trim().toUpperCase();
    if (!cleanCode) return;
    teardownConnections();
    app.mode = "CLOUD";
    app.session = null;
    document.querySelectorAll(".quickplay-group .btn").forEach((b) => b.classList.remove("active-qp"));

    connectCloudStream(cleanCode);
    await pollCloudOnce();

    const name = (playerName || "Challenger").trim() || "Challenger";
    const alreadyIn =
      app.session &&
      Object.values(app.session.state.players).some((p) => p.clientId === app.clientId);

    if (!alreadyIn) {
      await enqueueCloudPost(cleanCode, {
        v: 1,
        type: "JOIN",
        code: cleanCode,
        name,
        playerType: "human",
        clientId: app.clientId,
        ts: Math.floor(Date.now() / 1000),
      });
      await pollCloudOnce();
    }
    closeModal("lobbyModal");
    renderAll();
  }

  // ==========================================================================
  // Mode 3: Local REST HTTP/JSON Server (`python server.py`)
  // ==========================================================================
  function applyRestSnapshot(snap) {
    if (!snap || !snap.state) return;
    const prevSeq = app.session ? app.session.state.seq : 0;
    const prevStatus = app.session ? app.session.state.status : "WAITING";

    if (!app.session || app.session.matchCode !== snap.matchCode) {
      app.session = {
        matchCode: snap.matchCode,
        state: snap.state,
        log: snap.log || [],
        frames: [E.deepClone(snap.state)],
      };
    } else {
      app.session.state = snap.state;
      app.session.log = snap.log || [];
      if (snap.state.seq > prevSeq) {
        app.session.frames.push(E.deepClone(snap.state));
        if (app.session.log.length > 0) {
          sfx.playForMove(app.session.log[app.session.log.length - 1]);
        }
      } else {
        app.session.frames[app.session.frames.length - 1] = E.deepClone(snap.state);
      }
    }

    if (prevStatus !== "FINISHED" && snap.state.status === "FINISHED") {
      sfx.playVictory();
    }
    if (app.isLiveScrub) {
      app.scrubIndex = app.session.frames.length - 1;
    }
    autoSelectBestDefaultTool();
    renderAll();
  }

  async function pollRestMatch() {
    if (app.mode !== "REST" || !app.restCode) return;
    try {
      const resp = await fetch(`${app.restBaseUrl}/api/matches/${app.restCode}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.ok) applyRestSnapshot(data);
    } catch (_) {}
  }

  async function createRestMatch() {
    const base = document.getElementById("restServerUrl").value.trim().replace(/\/+$/, "");
    const maxPlayers = parseInt(document.getElementById("restPlayerCount").value, 10) || 2;
    try {
      const resp = await fetch(`${base}/api/matches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxPlayers,
          playerName: "Commander (Browser)",
          playerType: "human",
          fillBots: false,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || "Failed to create match");

      teardownConnections();
      app.mode = "REST";
      app.restBaseUrl = base;
      app.restCode = data.matchCode;
      app.restToken = data.playerToken;
      app.mySeats = new Set([data.player]);
      app.session = null;
      app.isLiveScrub = true;
      document.querySelectorAll(".quickplay-group .btn").forEach((b) => b.classList.remove("active-qp"));

      applyRestSnapshot(data);
      app.restPollTimer = setInterval(pollRestMatch, 900);
      closeModal("lobbyModal");
    } catch (err) {
      alert(`Could not reach local REST server at ${base}.\nRun 'python server.py' first!\n\nDetails: ${err.message}`);
    }
  }

  async function joinOrSpectateRestMatch(asSpectator = false) {
    const base = document.getElementById("restServerUrl").value.trim().replace(/\/+$/, "");
    const code = document.getElementById("restJoinCode").value.trim().toUpperCase();
    if (!code) {
      alert("Enter a 6-character Match Code first.");
      return;
    }
    try {
      let data;
      let mySeatSet = new Set();
      let token = null;
      if (asSpectator) {
        const resp = await fetch(`${base}/api/matches/${code}`);
        data = await resp.json();
        if (!resp.ok || !data.ok) throw new Error(data.error || "Match not found");
      } else {
        const resp = await fetch(`${base}/api/matches/${code}/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playerName: "Browser Human", playerType: "human" }),
        });
        data = await resp.json();
        if (!resp.ok || !data.ok) throw new Error(data.error || "Unable to join seat");
        mySeatSet.add(data.player);
        token = data.playerToken;
      }

      teardownConnections();
      app.mode = "REST";
      app.restBaseUrl = base;
      app.restCode = code;
      app.restToken = token;
      app.mySeats = mySeatSet;
      app.session = null;
      app.isLiveScrub = true;

      applyRestSnapshot(data);
      app.restPollTimer = setInterval(pollRestMatch, 900);
      closeModal("lobbyModal");
    } catch (err) {
      alert(`REST Error: ${err.message}`);
    }
  }

  // ==========================================================================
  // Fill Empty Seats With Built-in Bots (Cloud or REST)
  // ==========================================================================
  async function fillEmptySeatsWithBots() {
    if (!app.session) return;
    if (app.mode === "CLOUD" && app.cloudCode) {
      const fillEvt = {
        v: 1,
        type: "FILL_BOTS",
        clientId: app.clientId,
        ts: Math.floor(Date.now() / 1000),
      };
      app.pendingCloudEvents.push(fillEvt);
      app.session.fillBots();
      if (app.isLiveScrub) app.scrubIndex = app.session.frames.length - 1;
      renderAll();
      await enqueueCloudPost(app.cloudCode, fillEvt);
    } else if (app.mode === "REST" && app.restCode) {
      const resp = await fetch(`${app.restBaseUrl}/api/matches/${app.restCode}/fill-bots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await resp.json();
      if (data.ok) applyRestSnapshot(data);
    }
  }

  // ==========================================================================
  // Mode 4: Load / Watch Match Replays
  // ==========================================================================
  function loadReplayObject(rep) {
    if (!rep || !Array.isArray(rep.frames) || rep.frames.length === 0) {
      alert("Invalid replay JSON file.");
      return;
    }
    teardownConnections();
    app.mode = "REPLAY";
    app.mySeats = new Set();
    app.session = {
      matchCode: rep.matchCode || "REPLAY",
      state: E.deepClone(rep.frames[rep.frames.length - 1]),
      log: rep.moves || [],
      frames: rep.frames,
    };
    app.isLiveScrub = false;
    app.scrubIndex = 0;
    document.querySelectorAll(".quickplay-group .btn").forEach((b) => b.classList.remove("active-qp"));
    renderAll();
    startReplayAutoplay();
  }

  async function loadSampleReplay() {
    try {
      const resp = await fetch("sample_replay.json");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      loadReplayObject(data);
    } catch (err) {
      alert(`Failed to load sample_replay.json: ${err.message}`);
    }
  }

  function downloadCurrentReplay() {
    if (!app.session) return;
    if (app.mode === "REST" && app.restCode) {
      window.open(`${app.restBaseUrl}/api/matches/${app.restCode}/replay`, "_blank");
      return;
    }
    const rep = app.session.toReplayObject
      ? app.session.toReplayObject()
      : {
          game: "Beacon Wars",
          version: "1.0",
          matchCode: app.session.matchCode,
          winner: app.session.state.winner,
          winReason: app.session.state.winReason,
          moves: app.session.log,
          frames: app.session.frames,
        };
    const blob = new Blob([JSON.stringify(rep, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `beacon-wars-${(app.session.matchCode || "match").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function startReplayAutoplay() {
    stopReplayAutoplay();
    const btn = document.getElementById("repPlay");
    if (btn) btn.textContent = "⏸";
    app.replayTimer = setInterval(() => {
      if (!app.session || app.scrubIndex >= app.session.frames.length - 1) {
        stopReplayAutoplay();
        return;
      }
      app.scrubIndex += 1;
      app.isLiveScrub = app.scrubIndex === app.session.frames.length - 1;
      const moveEntry = app.session.log[app.scrubIndex - 1];
      if (moveEntry) sfx.playForMove(moveEntry);
      renderAll();
    }, 450);
  }

  function stopReplayAutoplay() {
    if (app.replayTimer) {
      clearInterval(app.replayTimer);
      app.replayTimer = null;
    }
    const btn = document.getElementById("repPlay");
    if (btn) btn.textContent = "▶";
  }

  // ==========================================================================
  // Submitting Human Moves Across Active Modes
  // ==========================================================================
  function isHumanTurnInteractive() {
    if (!app.session || !app.isLiveScrub || app.botAnimating) return false;
    const st = app.session.state;
    if (st.status !== "ACTIVE") return false;
    return app.mySeats.has(st.activePlayer);
  }

  function autoSelectBestDefaultTool() {
    if (!app.session) return;
    const st = app.session.state;
    if (st.status !== "ACTIVE" || !app.mySeats.has(st.activePlayer)) return;
    const legal = E.getLegalMoves(st, st.activePlayer);
    const hasDeploy = legal.some((m) => m.action === "DEPLOY");
    const hasStrike = legal.some((m) => m.action === "STRIKE");
    const hasShield = legal.some((m) => m.action === "SHIELD");

    if (app.selectedAction === "STRIKE" && hasStrike) return;
    if (app.selectedAction === "SHIELD" && hasShield) return;
    if (hasDeploy) {
      app.selectedAction = "DEPLOY";
      app.strikeOriginKey = null;
    } else if (hasStrike) {
      app.selectedAction = "STRIKE";
    } else if (hasShield) {
      app.selectedAction = "SHIELD";
      app.strikeOriginKey = null;
    } else {
      app.selectedAction = null;
      app.strikeOriginKey = null;
    }
  }

  async function executeHumanMove(moveObj) {
    if (!isHumanTurnInteractive()) return;
    const st = app.session.state;
    const player = st.activePlayer;
    const [ok, errMsg, canonical] = E.validateMove(st, player, moveObj);
    if (!ok || !canonical) {
      console.warn("Illegal move:", errMsg);
      return;
    }

    app.strikeOriginKey = null;

    if (app.mode === "QUICK") {
      const [entry] = app.session.submitMove(player, canonical, false);
      sfx.playForMove(entry);
      if (app.session.state.status === "FINISHED") sfx.playVictory();
      app.isLiveScrub = true;
      app.scrubIndex = app.session.frames.length - 1;
      autoSelectBestDefaultTool();
      renderAll();
      if (app.session.state.status === "ACTIVE" && app.session.state.players[String(app.session.state.activePlayer)].type === "builtin_bot") {
        stepAnimatedQuickPlayBots();
      }
      return;
    }

    if (app.mode === "CLOUD" && app.cloudCode) {
      const moveSeq = st.seq;
      const evt = {
        v: 1,
        type: "MOVE",
        seq: moveSeq,
        player,
        move: canonical,
        clientId: app.clientId,
        ts: Math.floor(Date.now() / 1000),
      };
      app.pendingCloudEvents.push(evt);
      const [entry] = app.session.submitMove(player, canonical, true);
      sfx.playForMove(entry);
      if (app.session.state.status === "FINISHED") sfx.playVictory();
      app.isLiveScrub = true;
      app.scrubIndex = app.session.frames.length - 1;
      autoSelectBestDefaultTool();
      renderAll();
      await enqueueCloudPost(app.cloudCode, evt);
      return;
    }

    if (app.mode === "REST" && app.restCode) {
      try {
        const resp = await fetch(`${app.restBaseUrl}/api/matches/${app.restCode}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            player,
            playerToken: app.restToken,
            ...canonical,
          }),
        });
        const data = await resp.json();
        if (data.ok) applyRestSnapshot(data);
      } catch (err) {
        console.error("REST move failed:", err);
      }
    }
  }

  // ==========================================================================
  // Hex Click & Action Selection Handlers
  // ==========================================================================
  function selectActionMode(actionName) {
    if (!isHumanTurnInteractive()) return;
    const st = app.session.state;
    const p = st.activePlayer;
    const legal = E.getLegalMoves(st, p);

    if (actionName === "PULSE") {
      if (legal.some((m) => m.action === "PULSE")) {
        executeHumanMove({ action: "PULSE" });
      }
      return;
    }
    if (actionName === "END_TURN") {
      executeHumanMove({ action: "END_TURN" });
      return;
    }

    app.selectedAction = actionName;
    app.strikeOriginKey = null;

    if (actionName === "STRIKE") {
      // If user only has a single valid origin hex for STRIKE, auto-select it!
      const origins = Array.from(
        new Set(legal.filter((m) => m.action === "STRIKE").map((m) => E.hexKey(m.from_q, m.from_r)))
      );
      if (origins.length === 1) {
        app.strikeOriginKey = origins[0];
      }
    }
    renderAll();
  }

  function onHexClick(q, r) {
    if (!isHumanTurnInteractive()) return;
    const st = app.session.state;
    const p = st.activePlayer;
    const key = E.hexKey(q, r);
    const cell = st.board[key];
    const legal = E.getLegalMoves(st, p);

    if (app.selectedAction === "STRIKE") {
      if (app.strikeOriginKey) {
        const [fq, fr] = E.parseHexKey(app.strikeOriginKey);
        const canHit = legal.some(
          (m) => m.action === "STRIKE" && m.from_q === fq && m.from_r === fr && m.to_q === q && m.to_r === r
        );
        if (canHit) {
          executeHumanMove({ action: "STRIKE", from_q: fq, from_r: fr, to_q: q, to_r: r });
          return;
        }
      }
      // Allow clicking another valid friendly attacker hex
      const isValidOrigin = legal.some((m) => m.action === "STRIKE" && m.from_q === q && m.from_r === r);
      if (isValidOrigin) {
        app.strikeOriginKey = key;
        renderAll();
        return;
      }
    }

    if (app.selectedAction === "SHIELD") {
      if (legal.some((m) => m.action === "SHIELD" && m.q === q && m.r === r)) {
        executeHumanMove({ action: "SHIELD", q, r });
        return;
      }
    }

    if (app.selectedAction === "DEPLOY") {
      // Smart shortcut: if user clicks an adjacent enemy hex while holding a 2+ unit attacker, switch to STRIKE if only 1 attacker, or deploy if legal
      if (legal.some((m) => m.action === "DEPLOY" && m.q === q && m.r === r)) {
        executeHumanMove({ action: "DEPLOY", q, r });
        return;
      }
      // If user clicks an enemy hex and has a valid STRIKE against it, select STRIKE!
      const strikesOnTarget = legal.filter((m) => m.action === "STRIKE" && m.to_q === q && m.to_r === r);
      if (strikesOnTarget.length === 1) {
        executeHumanMove(strikesOnTarget[0]);
        return;
      } else if (strikesOnTarget.length > 1) {
        app.selectedAction = "STRIKE";
        app.strikeOriginKey = E.hexKey(strikesOnTarget[0].from_q, strikesOnTarget[0].from_r);
        renderAll();
        return;
      }
    }
  }

  // ==========================================================================
  // Rendering: Scoreboard, Action Bar, SVG Hex Grid, Tooltip, Replay, Log
  // ==========================================================================
  function getDisplayedState() {
    if (!app.session) return null;
    const frames = app.session.frames || [];
    if (frames.length === 0) return app.session.state;
    const idx = Math.max(0, Math.min(app.scrubIndex, frames.length - 1));
    return frames[idx];
  }

  function renderAll() {
    const state = getDisplayedState();
    if (!state) return;
    renderTopHud(state);
    renderStageBanner(state);
    renderScoreboard(state);
    renderHexBoard(state);
    renderActionBar(state);
    renderConnectionCard(state);
    renderMoveLog();
    renderReplayBar();
  }

  function renderTopHud(state) {
    const modeBadge = document.getElementById("hudModeBadge");
    const roundBadge = document.getElementById("hudRoundBadge");

    if (app.mode === "QUICK") {
      modeBadge.textContent = `⚡ QUICK PLAY (${state.maxPlayers}P)`;
    } else if (app.mode === "CLOUD") {
      modeBadge.textContent = `☁️ CLOUD LIVE • ${app.cloudCode || ""}`;
    } else if (app.mode === "REST") {
      modeBadge.textContent = `🔌 REST API • ${app.restCode || ""}`;
    } else {
      modeBadge.textContent = `🎬 REPLAY • ${state.matchCode || ""}`;
    }
    roundBadge.textContent = `ROUND ${state.round} / ${state.maxRounds}`;
  }

  function renderStageBanner(state) {
    const banner = document.getElementById("stageBanner");
    if (!app.isLiveScrub && app.mode !== "REPLAY") {
      banner.className = "stage-banner";
      banner.innerHTML = `
        <span>⏪ Viewing historical frame <strong>${app.scrubIndex} / ${app.session.frames.length - 1}</strong></span>
        <button class="btn btn-xs btn-primary" id="btnResumeLive">Jump to Live &gt;|</button>
      `;
      document.getElementById("btnResumeLive").onclick = () => {
        app.isLiveScrub = true;
        app.scrubIndex = app.session.frames.length - 1;
        renderAll();
      };
      return;
    }

    if (state.status === "FINISHED") {
      banner.className = "stage-banner victory";
      banner.innerHTML = `
        <span>🏆 <strong>VICTORY:</strong> ${escapeHtml(state.winReason || `Player ${state.winner} wins!`)}</span>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-xs btn-primary" id="btnPlayAgainBanner">🔄 Play Again</button>
          <button class="btn btn-xs btn-ghost" id="btnRewatchBanner">▶ Replay Match</button>
        </div>
      `;
      document.getElementById("btnPlayAgainBanner").onclick = () => startQuickPlay(state.maxPlayers);
      document.getElementById("btnRewatchBanner").onclick = () => {
        app.isLiveScrub = false;
        app.scrubIndex = 0;
        renderAll();
        startReplayAutoplay();
      };
      return;
    }

    if (state.status === "WAITING") {
      const openCount = Object.values(state.players).filter((p) => p.type === "open").length;
      banner.className = "stage-banner";
      banner.innerHTML = `
        <span>⏳ Waiting for <strong>${openCount}</strong> more Commander(s) or Python Bot to join Room <strong>${escapeHtml(state.matchCode)}</strong>...</span>
        <button class="btn btn-xs btn-accent" id="btnFillBanner">🤖 + Fill Empty Seats with Bots</button>
      `;
      document.getElementById("btnFillBanner").onclick = fillEmptySeatsWithBots;
      return;
    }

    banner.className = "stage-banner hidden";
  }

  function renderScoreboard(state) {
    const container = document.getElementById("playersList");
    const shortTurn = document.getElementById("turnStatusShort");
    const activeP = state.players[String(state.activePlayer)];
    shortTurn.textContent =
      state.status === "FINISHED"
        ? `Winner: P${state.winner}`
        : state.status === "WAITING"
        ? "Lobby Open"
        : `${activeP ? activeP.name : `P${state.activePlayer}`}'s Turn`;

    let html = "";
    for (let p = 1; p <= state.maxPlayers; p++) {
      const pdata = state.players[String(p)];
      const isTurn = state.status === "ACTIVE" && state.activePlayer === p;
      const isMe = app.mySeats.has(p);
      const pct = Math.min(100, Math.round((pdata.vp / state.targetVp) * 100));
      const income = 1 + pdata.wellsHeld * 2;
      const roleBadge = isMe
        ? "YOU"
        : pdata.type === "builtin_bot"
        ? "BOT"
        : pdata.type === "agent"
        ? "API BOT"
        : pdata.type === "open"
        ? "OPEN"
        : "HUMAN";

      const borderStyle = isTurn ? `border-color:${pdata.color};` : "";
      html += `
        <div class="player-card ${isTurn ? "active-turn" : ""}" style="${borderStyle}">
          <div class="pcard-top">
            <div class="pcard-id">
              <span class="pcard-swatch" style="background:${pdata.color};box-shadow:0 0 8px ${pdata.color};"></span>
              <span class="pcard-name">${escapeHtml(pdata.name)}</span>
              <span class="pcard-role">${roleBadge}</span>
            </div>
            <div class="pcard-vp" style="color:${pdata.color};">${pdata.vp}<span style="font-size:0.7rem;color:#64748b;">/${state.targetVp} VP</span></div>
          </div>
          <div class="vp-bar-track">
            <div class="vp-bar-fill" style="width:${pct}%;background:${pdata.color};"></div>
          </div>
          <div class="pcard-stats">
            <div class="stat-chip" title="Action Points">AP <strong>${pdata.ap}</strong></div>
            <div class="stat-chip" title="Energy &amp; Income/Turn">⚡<strong>${pdata.energy}</strong>+${income}</div>
            <div class="stat-chip" title="Controlled Beacons">📡<strong>${pdata.beaconsHeld}</strong></div>
            <div class="stat-chip" title="Total Garrison Units">⚙<strong>${pdata.totalUnits}</strong></div>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;
  }

  function renderHexBoard(state) {
    const cellsLayer = document.getElementById("hexCellsLayer");
    const overLayer = document.getElementById("hexOverlaysLayer");
    cellsLayer.innerHTML = "";
    overLayer.innerHTML = "";

    const interactive = isHumanTurnInteractive();
    const actP = state.activePlayer;
    const legal = interactive ? E.getLegalMoves(state, actP) : [];

    // Build highlight lookup maps
    const highlightMap = {}; // key -> { color, kind, strikePreview }
    if (interactive) {
      if (app.selectedAction === "DEPLOY") {
        for (const m of legal) {
          if (m.action === "DEPLOY") {
            highlightMap[E.hexKey(m.q, m.r)] = {
              color: m.mode === "EXPAND" ? "#22d3ee" : "#34d399",
              kind: m.mode,
            };
          }
        }
      } else if (app.selectedAction === "SHIELD") {
        for (const m of legal) {
          if (m.action === "SHIELD") {
            highlightMap[E.hexKey(m.q, m.r)] = { color: "#60a5fa", kind: "SHIELD" };
          }
        }
      } else if (app.selectedAction === "STRIKE") {
        for (const m of legal) {
          if (m.action === "STRIKE") {
            const origKey = E.hexKey(m.from_q, m.from_r);
            if (!highlightMap[origKey]) {
              highlightMap[origKey] = { color: "#fbbf24", kind: "ORIGIN" };
            }
          }
        }
        if (app.strikeOriginKey) {
          const [fq, fr] = E.parseHexKey(app.strikeOriginKey);
          highlightMap[app.strikeOriginKey] = { color: "#ffffff", kind: "SELECTED_ORIGIN" };
          for (const m of legal) {
            if (m.action === "STRIKE" && m.from_q === fq && m.from_r === fr) {
              const tKey = E.hexKey(m.to_q, m.to_r);
              const prev = E.previewStrike(state, actP, fq, fr, m.to_q, m.to_r);
              const col =
                m.outcome === "CAPTURE" ? "#4ade80" : m.outcome === "TIE" ? "#fbbf24" : "#fb7185";
              highlightMap[tKey] = { color: col, kind: "TARGET", strikePreview: prev };
            }
          }
        }
      }
    }

    const lastMove = state.lastMove;

    for (const cell of Object.values(state.board)) {
      const [cx, cy] = axialToPixel(cell.q, cell.r);
      const pal = FACTION_COLORS[cell.owner] || FACTION_COLORS[0];

      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "hex-group");
      g.setAttribute("data-key", cell.key);

      // Outer hex polygon
      const polyOuter = document.createElementNS(SVG_NS, "polygon");
      polyOuter.setAttribute("class", "hex-poly-outer");
      polyOuter.setAttribute("points", hexPolygonPoints(cx, cy, HEX_SIZE - 1.6));
      polyOuter.setAttribute("fill", pal.fill);
      polyOuter.setAttribute(
        "stroke",
        cell.owner > 0
          ? pal.stroke
          : cell.terrain === "NEXUS"
          ? "rgba(250, 204, 21, 0.55)"
          : cell.terrain === "BEACON"
          ? "rgba(56, 189, 248, 0.45)"
          : cell.terrain === "WELL"
          ? "rgba(192, 132, 252, 0.42)"
          : "#24324a"
      );
      polyOuter.setAttribute("stroke-width", cell.owner > 0 ? "2.1" : "1.3");
      g.appendChild(polyOuter);

      // Special Terrain Ambient Backdrop
      if (cell.terrain === "NEXUS") {
        const ring = document.createElementNS(SVG_NS, "polygon");
        ring.setAttribute("points", hexPolygonPoints(cx, cy, HEX_SIZE - 8));
        ring.setAttribute("fill", "rgba(250, 204, 21, 0.08)");
        ring.setAttribute("stroke", "rgba(250, 204, 21, 0.45)");
        ring.setAttribute("stroke-width", "1.2");
        ring.setAttribute("stroke-dasharray", "4 3");
        g.appendChild(ring);

        const badge = svgText(cx, cy - 22, "★ NEXUS +2", "#fde047", "8.2px", "700");
        g.appendChild(badge);
      } else if (cell.terrain === "BEACON") {
        const ring = document.createElementNS(SVG_NS, "circle");
        ring.setAttribute("cx", cx);
        ring.setAttribute("cy", cy);
        ring.setAttribute("r", "24");
        ring.setAttribute("fill", "rgba(56, 189, 248, 0.06)");
        ring.setAttribute("stroke", "rgba(56, 189, 248, 0.35)");
        ring.setAttribute("stroke-dasharray", "3 3");
        g.appendChild(ring);

        const badge = svgText(cx, cy - 22, "◈ BEACON +1", "#7dd3fc", "7.8px", "700");
        g.appendChild(badge);
      } else if (cell.terrain === "WELL") {
        const badge = svgText(cx, cy - 22, "⚡ WELL +2", "#d8b4fe", "7.8px", "700");
        g.appendChild(badge);
      }

      // Shield Forcefield Dome
      if (cell.shielded) {
        const shPoly = document.createElementNS(SVG_NS, "polygon");
        shPoly.setAttribute("points", hexPolygonPoints(cx, cy, HEX_SIZE - 5.5));
        shPoly.setAttribute("fill", "rgba(96, 165, 250, 0.14)");
        shPoly.setAttribute("stroke", "#93c5fd");
        shPoly.setAttribute("stroke-width", "2.2");
        shPoly.setAttribute("stroke-dasharray", "5 3");
        g.appendChild(shPoly);

        const shTag = svgText(cx + 19, cy - 8, "🛡+2", "#bfdbfe", "8.5px", "700");
        g.appendChild(shTag);
      }

      // Garrison Units Token
      if (cell.owner > 0 && cell.units > 0) {
        const uCircle = document.createElementNS(SVG_NS, "circle");
        uCircle.setAttribute("cx", cx);
        uCircle.setAttribute("cy", cy + 1);
        uCircle.setAttribute("r", "13.5");
        uCircle.setAttribute("fill", "#08101f");
        uCircle.setAttribute("stroke", pal.stroke);
        uCircle.setAttribute("stroke-width", "2.2");
        g.appendChild(uCircle);

        const uNum = svgText(cx, cy + 5.5, String(cell.units), "#ffffff", "13.5px", "700");
        g.appendChild(uNum);

        // Unit orbital pips
        for (let u = 0; u < cell.units; u++) {
          const ang = -Math.PI / 2 + (u - (cell.units - 1) / 2) * 0.48;
          const px = cx + 18.5 * Math.cos(ang);
          const py = cy + 1 + 18.5 * Math.sin(ang);
          const pip = document.createElementNS(SVG_NS, "circle");
          pip.setAttribute("cx", px.toFixed(1));
          pip.setAttribute("cy", py.toFixed(1));
          pip.setAttribute("r", "2.5");
          pip.setAttribute("fill", pal.stroke);
          g.appendChild(pip);
        }
      } else if (cell.terrain !== "SECTOR") {
        // Subtle center glyph on unclaimed special hexes
        const sym = cell.terrain === "NEXUS" ? "★" : cell.terrain === "BEACON" ? "◈" : "⚡";
        const col =
          cell.terrain === "NEXUS"
            ? "rgba(250,204,21,0.5)"
            : cell.terrain === "BEACON"
            ? "rgba(56,189,248,0.45)"
            : "rgba(192,132,252,0.45)";
        g.appendChild(svgText(cx, cy + 5, sym, col, "15px", "700"));
      }

      // Coordinate footer label
      g.appendChild(svgText(cx, cy + 28, `${cell.q},${cell.r}`, "rgba(148,163,184,0.42)", "7.5px", "600"));

      // Highlight ring for legal moves or last move
      const hl = highlightMap[cell.key];
      if (hl) {
        const hlPoly = document.createElementNS(SVG_NS, "polygon");
        hlPoly.setAttribute("points", hexPolygonPoints(cx, cy, HEX_SIZE - 3.5));
        hlPoly.setAttribute("fill", "none");
        hlPoly.setAttribute("stroke", hl.color);
        hlPoly.setAttribute("stroke-width", hl.kind === "SELECTED_ORIGIN" ? "3" : "2.2");
        if (hl.kind !== "SELECTED_ORIGIN") {
          hlPoly.setAttribute("class", "hex-target-ring");
        }
        overLayer.appendChild(hlPoly);
      } else if (
        lastMove &&
        ((lastMove.q === cell.q && lastMove.r === cell.r) ||
          (lastMove.to_q === cell.q && lastMove.to_r === cell.r))
      ) {
        const lmPoly = document.createElementNS(SVG_NS, "polygon");
        lmPoly.setAttribute("points", hexPolygonPoints(cx, cy, HEX_SIZE - 4));
        lmPoly.setAttribute("fill", "none");
        lmPoly.setAttribute("stroke", "rgba(255,255,255,0.42)");
        lmPoly.setAttribute("stroke-width", "1.6");
        lmPoly.setAttribute("stroke-dasharray", "3 3");
        overLayer.appendChild(lmPoly);
      }

      // Events
      g.addEventListener("click", () => onHexClick(cell.q, cell.r));
      g.addEventListener("mouseenter", (ev) => {
        app.hoveredHexKey = cell.key;
        showHexTooltip(ev, state, cell, highlightMap[cell.key]);
      });
      g.addEventListener("mousemove", (ev) => moveHexTooltip(ev));
      g.addEventListener("mouseleave", () => {
        app.hoveredHexKey = null;
        hideHexTooltip();
      });

      cellsLayer.appendChild(g);
    }

    // Draw directional strike vector if origin is selected
    if (interactive && app.selectedAction === "STRIKE" && app.strikeOriginKey && app.hoveredHexKey) {
      const targetHl = highlightMap[app.hoveredHexKey];
      if (targetHl && targetHl.kind === "TARGET") {
        const [fq, fr] = E.parseHexKey(app.strikeOriginKey);
        const [tq, tr] = E.parseHexKey(app.hoveredHexKey);
        const [x1, y1] = axialToPixel(fq, fr);
        const [x2, y2] = axialToPixel(tq, tr);
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", x1);
        line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("stroke", targetHl.color);
        line.setAttribute("stroke-width", "3.5");
        line.setAttribute("stroke-dasharray", "6 4");
        line.setAttribute("filter", "url(#neonGlow)");
        overLayer.appendChild(line);
      }
    }
  }

  function svgText(x, y, str, fill, fontSize, fontWeight) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", x);
    t.setAttribute("y", y);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("fill", fill);
    t.setAttribute("font-size", fontSize);
    t.setAttribute("font-weight", fontWeight);
    t.setAttribute("font-family", "JetBrains Mono, monospace");
    t.setAttribute("pointer-events", "none");
    t.textContent = str;
    return t;
  }

  function showHexTooltip(ev, state, cell, hl) {
    const tt = document.getElementById("hexTooltip");
    const terrainLabel = {
      NEXUS: "★ Central Nexus (+2 VP/turn)",
      BEACON: "◈ Outer Beacon (+1 VP/turn)",
      WELL: "⚡ Energy Well (+2⚡/turn)",
      SECTOR: "Standard Sector",
    }[cell.terrain];

    const ownerName =
      cell.owner === 0 ? "Neutral (Unclaimed)" : state.players[String(cell.owner)].name;

    let combatHtml = "";
    if (hl && hl.strikePreview) {
      const p = hl.strikePreview;
      const outLabel =
        p.outcome === "CAPTURE"
          ? `CAPTURE! (${p.advancingUnits} unit${p.advancingUnits > 1 ? "s" : ""} advance)`
          : p.outcome === "TIE"
          ? "CLASH (-1 unit both sides)"
          : "REPULSED (-1 attacker unit)";
      combatHtml = `
        <div class="tt-combat">
          ⚔️ <strong>STRIKE PREVIEW</strong><br/>
          Attack: <strong>${p.attackPower}</strong> (${p.attackerUnits}u + ${p.flankBonus} flank) vs
          Defense: <strong>${p.defensePower}</strong> (${p.defenderUnits}u${p.shieldBonus ? " + 2🛡" : ""})<br/>
          Outcome: <span class="hex-Tooltip-outcome-${p.outcome}">${outLabel}</span>
        </div>
      `;
    }

    tt.innerHTML = `
      <div class="tt-header">Hex (${cell.q}, ${cell.r}) — ${terrainLabel}</div>
      <div class="tt-sub">
        Owner: <strong>${escapeHtml(ownerName)}</strong>
        ${cell.owner > 0 ? ` • Units: <strong>${cell.units}/4</strong>` : ""}
        ${cell.shielded ? ` • <strong>🛡 Shielded (+2 Def)</strong>` : ""}
      </div>
      ${combatHtml}
    `;
    tt.classList.remove("hidden");
    moveHexTooltip(ev);
  }

  function moveHexTooltip(ev) {
    const tt = document.getElementById("hexTooltip");
    const vp = document.getElementById("boardViewport");
    if (tt.classList.contains("hidden")) return;
    const rect = vp.getBoundingClientRect();
    let left = ev.clientX - rect.left + 16;
    let top = ev.clientY - rect.top + 14;
    if (left + 280 > rect.width) left = Math.max(8, left - 295);
    if (top + 115 > rect.height) top = Math.max(8, top - 115);
    tt.style.left = `${left}px`;
    tt.style.top = `${top}px`;
  }

  function hideHexTooltip() {
    document.getElementById("hexTooltip").classList.add("hidden");
  }

  function renderActionBar(state) {
    const interactive = isHumanTurnInteractive();
    const actP = state.activePlayer;
    const legal = interactive ? E.getLegalMoves(state, actP) : [];
    const pdata = state.players[String(actP)];

    const canDeploy = legal.some((m) => m.action === "DEPLOY");
    const canStrike = legal.some((m) => m.action === "STRIKE");
    const canShield = legal.some((m) => m.action === "SHIELD");
    const pulseMove = legal.find((m) => m.action === "PULSE");

    const bDeploy = document.getElementById("actDeploy");
    const bStrike = document.getElementById("actStrike");
    const bShield = document.getElementById("actShield");
    const bPulse = document.getElementById("actPulse");
    const bEnd = document.getElementById("actEndTurn");

    bDeploy.disabled = !interactive || !canDeploy;
    bStrike.disabled = !interactive || !canStrike;
    bShield.disabled = !interactive || !canShield;
    bPulse.disabled = !interactive || !pulseMove;
    bEnd.disabled = !interactive;

    bDeploy.classList.toggle("selected", interactive && app.selectedAction === "DEPLOY");
    bStrike.classList.toggle("selected", interactive && app.selectedAction === "STRIKE");
    bShield.classList.toggle("selected", interactive && app.selectedAction === "SHIELD");

    const pulseDesc = document.getElementById("actPulseDesc");
    if (pdata && pdata.pulseCooldown > 0) {
      pulseDesc.textContent = `Recharging (${pdata.pulseCooldown}t)`;
    } else if (pulseMove) {
      pulseDesc.textContent = `Ready: +${pulseMove.vpGain} VP!`;
    } else {
      pulseDesc.textContent = "+3 VP/Beacon & Push";
    }

    const noOtherMoves = interactive && !canDeploy && !canStrike && !canShield && !pulseMove;
    bEnd.classList.toggle("ready-glow", noOtherMoves);

    // Update contextual hint bar
    const hintEl = document.getElementById("actionHintText");
    if (state.status === "FINISHED") {
      hintEl.textContent = `Match complete! Use the scrubber below to review any turn or start a new game.`;
    } else if (state.status === "WAITING") {
      hintEl.textContent = `Waiting for players/bots to join... Click "+ Fill Empty Seats with Bots" to start immediately!`;
    } else if (app.botAnimating) {
      hintEl.textContent = `🤖 ${pdata.name} is executing tactical maneuvers...`;
    } else if (!interactive) {
      hintEl.textContent = app.isLiveScrub
        ? `Waiting for ${pdata.name} (Seat ${actP}) to move...`
        : `Replay Scrubber active — click [>|] on the timeline to return to live play.`;
    } else if (noOtherMoves) {
      hintEl.textContent = `0 AP / no remaining actions — Press [Space] or click END TURN to harvest Beacon VP!`;
    } else if (app.selectedAction === "DEPLOY") {
      hintEl.textContent = `DEPLOY selected: Click any glowing cyan hex to expand, or emerald hex to reinforce (+1 Unit).`;
    } else if (app.selectedAction === "STRIKE") {
      hintEl.textContent = app.strikeOriginKey
        ? `STRIKE origin (${app.strikeOriginKey}) locked — Hover an adjacent enemy hex to preview combat & click to attack!`
        : `STRIKE selected: Click one of your glowing 2+ unit garrisons to select your attacking force.`;
    } else if (app.selectedAction === "SHIELD") {
      hintEl.textContent = `SHIELD selected: Click a controlled hex to fortify it with +2 Defense until your next turn.`;
    } else {
      hintEl.textContent = `Your turn (${pdata.ap} AP, ${pdata.energy}⚡): Choose an action below.`;
    }
  }

  function renderConnectionCard(state) {
    const card = document.getElementById("connectionCard");
    if (app.mode !== "CLOUD" && app.mode !== "REST") {
      card.classList.add("hidden");
      return;
    }
    card.classList.remove("hidden");

    const code = app.mode === "CLOUD" ? app.cloudCode : app.restCode;
    document.getElementById("connCardTitle").textContent =
      app.mode === "CLOUD" ? "LIVE CLOUD ROOM" : "LOCAL REST SERVER";
    document.getElementById("connMatchCode").textContent = code || "------";

    const cmd =
      app.mode === "CLOUD"
        ? `python sample_bot.py --cloud --match ${code}`
        : `python sample_bot.py --server ${app.restBaseUrl} --match ${code}`;
    document.getElementById("connBotCmd").textContent = cmd;

    const hasOpen = Object.values(state.players).some((p) => p.type === "open");
    document.getElementById("btnFillBotsSidebar").classList.toggle("hidden", !hasOpen);
  }

  function renderMoveLog() {
    const listEl = document.getElementById("moveLogList");
    const countEl = document.getElementById("logCountBadge");
    const logs = (app.session && app.session.log) || [];
    countEl.textContent = `${logs.length} move${logs.length === 1 ? "" : "s"}`;

    if (logs.length === 0) {
      listEl.innerHTML = `<div class="log-empty">Awaiting opening deployment...</div>`;
      return;
    }

    const colors = { 1: "#22d3ee", 2: "#fbbf24", 3: "#34d399", 4: "#fb7185" };
    let html = "";
    const startIdx = Math.max(0, logs.length - 80);
    for (let i = startIdx; i < logs.length; i++) {
      const item = logs[i];
      const frameIdx = i + 1;
      const isSelected = !app.isLiveScrub && app.scrubIndex === frameIdx;
      const col = colors[item.player] || "#64748b";
      html += `
        <div class="log-item ${isSelected ? "active-frame" : ""}" style="border-left-color:${col};" data-frame="${frameIdx}">
          <span class="log-tag">R${item.round} #${item.seq}</span>
          <span>${escapeHtml(item.summary)}</span>
        </div>
      `;
    }
    listEl.innerHTML = html;
    if (app.isLiveScrub) {
      listEl.scrollTop = listEl.scrollHeight;
    }

    listEl.querySelectorAll(".log-item").forEach((el) => {
      el.addEventListener("click", () => {
        const f = parseInt(el.getAttribute("data-frame"), 10);
        if (!isNaN(f) && app.session && f < app.session.frames.length) {
          stopReplayAutoplay();
          app.scrubIndex = f;
          app.isLiveScrub = f === app.session.frames.length - 1;
          renderAll();
        }
      });
    });
  }

  function renderReplayBar() {
    const slider = document.getElementById("repSlider");
    const counter = document.getElementById("repCounter");
    const maxFrame = app.session ? Math.max(0, app.session.frames.length - 1) : 0;
    slider.max = String(maxFrame);
    slider.value = String(Math.min(app.scrubIndex, maxFrame));
    const suffix = app.mode === "REPLAY" ? "REPLAY" : app.isLiveScrub ? "LIVE" : "HISTORY";
    counter.textContent = `Frame ${app.scrubIndex} / ${maxFrame} (${suffix})`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ==========================================================================
  // Modal & Clipboard Helpers
  // ==========================================================================
  function openModal(id) {
    document.getElementById(id).classList.remove("hidden");
  }

  function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
  }

  async function copyTextWithFeedback(btn, text) {
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = "✓ Copied!";
      setTimeout(() => {
        btn.textContent = orig;
      }, 1300);
    } catch (_) {}
  }

  // ==========================================================================
  // Wire Up DOM Events & Boot Application
  // ==========================================================================
  function bindEvents() {
    // Quick Play buttons
    document.getElementById("btnQuick2P").onclick = () => startQuickPlay(2);
    document.getElementById("btnQuick3P").onclick = () => startQuickPlay(3);
    document.getElementById("btnQuick4P").onclick = () => startQuickPlay(4);

    // Topbar modals & controls
    document.getElementById("btnOpenLobby").onclick = () => openModal("lobbyModal");
    document.getElementById("btnCloseLobby").onclick = () => closeModal("lobbyModal");
    document.getElementById("btnOpenRules").onclick = () => openModal("rulesModal");
    document.getElementById("btnCloseRules").onclick = () => closeModal("rulesModal");
    document.getElementById("btnLoadSampleReplay").onclick = loadSampleReplay;

    const audioBtn = document.getElementById("btnToggleAudio");
    audioBtn.onclick = () => {
      sfx.enabled = !sfx.enabled;
      audioBtn.textContent = sfx.enabled ? "🔊 SFX" : "🔇 Muted";
    };

    // Close modals on backdrop click
    ["lobbyModal", "rulesModal"].forEach((mid) => {
      const el = document.getElementById(mid);
      el.addEventListener("click", (e) => {
        if (e.target === el) closeModal(mid);
      });
    });

    // Lobby tabs
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.getAttribute("data-tab")).classList.add("active");
      };
    });

    // Cloud player count segmented buttons
    document.querySelectorAll("#cloudPlayerCountSeg .seg-btn").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll("#cloudPlayerCountSeg .seg-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        app.selectedCloudPlayers = parseInt(btn.getAttribute("data-players"), 10) || 2;
      };
    });

    // Cloud & REST lobby buttons
    document.getElementById("btnCreateCloudMatch").onclick = () =>
      createCloudMatch(app.selectedCloudPlayers, document.getElementById("cloudCreateName").value);
    document.getElementById("btnJoinCloudMatch").onclick = () =>
      joinCloudMatch(
        document.getElementById("cloudJoinCode").value,
        document.getElementById("cloudJoinName").value
      );
    document.getElementById("btnCreateRestMatch").onclick = createRestMatch;
    document.getElementById("btnJoinRestMatch").onclick = () => joinOrSpectateRestMatch(false);
    document.getElementById("btnSpectateRestMatch").onclick = () => joinOrSpectateRestMatch(true);

    // Sidebar connection card buttons
    document.getElementById("btnCopyCode").onclick = (e) => {
      const code = app.mode === "CLOUD" ? app.cloudCode : app.restCode;
      if (code) copyTextWithFeedback(e.currentTarget, code);
    };
    document.getElementById("btnCopyLink").onclick = (e) => {
      copyTextWithFeedback(e.currentTarget, window.location.href);
    };
    document.getElementById("btnCopyBotCmd").onclick = (e) => {
      copyTextWithFeedback(e.currentTarget, document.getElementById("connBotCmd").textContent);
    };
    document.getElementById("btnFillBotsSidebar").onclick = fillEmptySeatsWithBots;

    // Action Bar buttons
    document.getElementById("actDeploy").onclick = () => selectActionMode("DEPLOY");
    document.getElementById("actStrike").onclick = () => selectActionMode("STRIKE");
    document.getElementById("actShield").onclick = () => selectActionMode("SHIELD");
    document.getElementById("actPulse").onclick = () => selectActionMode("PULSE");
    document.getElementById("actEndTurn").onclick = () => selectActionMode("END_TURN");

    // Keyboard shortcuts
    window.addEventListener("keydown", (ev) => {
      if (ev.target && ["INPUT", "TEXTAREA", "SELECT"].includes(ev.target.tagName)) return;
      if (!document.getElementById("lobbyModal").classList.contains("hidden") ||
          !document.getElementById("rulesModal").classList.contains("hidden")) {
        if (ev.key === "Escape") {
          closeModal("lobbyModal");
          closeModal("rulesModal");
        }
        return;
      }

      if (ev.key === "1") selectActionMode("DEPLOY");
      else if (ev.key === "2") selectActionMode("STRIKE");
      else if (ev.key === "3") selectActionMode("SHIELD");
      else if (ev.key === "4") selectActionMode("PULSE");
      else if (ev.key === " " || ev.code === "Space") {
        if (isHumanTurnInteractive()) {
          ev.preventDefault();
          selectActionMode("END_TURN");
        }
      } else if (ev.key === "Escape") {
        app.strikeOriginKey = null;
        renderAll();
      }
    });

    // Replay Scrubber controls
    document.getElementById("repFirst").onclick = () => {
      if (!app.session) return;
      stopReplayAutoplay();
      app.scrubIndex = 0;
      app.isLiveScrub = app.session.frames.length <= 1;
      renderAll();
    };
    document.getElementById("repPrev").onclick = () => {
      if (!app.session) return;
      stopReplayAutoplay();
      app.scrubIndex = Math.max(0, app.scrubIndex - 1);
      app.isLiveScrub = app.scrubIndex === app.session.frames.length - 1;
      renderAll();
    };
    document.getElementById("repPlay").onclick = () => {
      if (app.replayTimer) stopReplayAutoplay();
      else {
        if (app.session && app.scrubIndex >= app.session.frames.length - 1) {
          app.scrubIndex = 0;
        }
        startReplayAutoplay();
      }
    };
    document.getElementById("repNext").onclick = () => {
      if (!app.session) return;
      stopReplayAutoplay();
      app.scrubIndex = Math.min(app.session.frames.length - 1, app.scrubIndex + 1);
      app.isLiveScrub = app.scrubIndex === app.session.frames.length - 1;
      renderAll();
    };
    document.getElementById("repLast").onclick = () => {
      if (!app.session) return;
      stopReplayAutoplay();
      app.scrubIndex = app.session.frames.length - 1;
      app.isLiveScrub = true;
      renderAll();
    };
    document.getElementById("repSlider").oninput = (ev) => {
      if (!app.session) return;
      stopReplayAutoplay();
      app.scrubIndex = parseInt(ev.target.value, 10) || 0;
      app.isLiveScrub = app.scrubIndex === app.session.frames.length - 1;
      renderAll();
    };
    document.getElementById("btnDownloadReplay").onclick = downloadCurrentReplay;
    document.getElementById("inputUploadReplay").onchange = (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          loadReplayObject(JSON.parse(String(reader.result)));
        } catch (err) {
          alert(`Invalid JSON replay: ${err.message}`);
        }
      };
      reader.readAsText(file);
      ev.target.value = "";
    };
  }

  function boot() {
    bindEvents();

    // Auto-join Cloud Match if ?match=CODE is in the URL!
    const params = new URLSearchParams(window.location.search);
    const urlMatch = params.get("match");
    if (urlMatch && urlMatch.trim().length >= 4) {
      joinCloudMatch(urlMatch.trim(), "Challenger");
      return;
    }

    // If opened from local `python server.py`, prefill REST Server URL to current origin
    if (window.location.protocol.startsWith("http") && !window.location.hostname.includes("github.io")) {
      const restInput = document.getElementById("restServerUrl");
      if (restInput) restInput.value = window.location.origin;
    }

    // Launch instant playable 2P Quick Play match on boot (zero friction!)
    startQuickPlay(2);
  }

  window.addEventListener("DOMContentLoaded", boot);
})();
