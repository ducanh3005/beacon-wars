# Beacon Wars 📡⚔️

**Play Instantly in Browser (No Install, No Login):** **[https://ducanh3005.github.io/beacon-wars/](https://ducanh3005.github.io/beacon-wars/)**

**Rules Summary:** **Beacon Wars** is a fast, deterministic 2–4 player turn-based tactical strategy game played on a 37-hex arena (`radius = 3`) where matches finish in 3–6 minutes (**first to 25 Victory Points** or highest VP after **Round 12**). Each turn, the active player receives **3 Action Points (AP)** and **Energy income (`1 + 2 × Energy Wells held`, max 10⚡)** to spend across four tactical actions: **Deploy** (`1 AP, 1⚡` — reinforce a friendly hex up to 4 units or claim an adjacent empty hex with 1 unit), **Strike** (`2 AP, 1⚡` — attack an adjacent enemy hex from a `2+` unit friendly hex using zero-RNG spatial flanking where `Attack = Units + Extra Adjacent Friendly Hexes` vs `Defense = Enemy Units + Shield(+2)`), **Shield** (`1 AP, 2⚡` — grant a controlled hex `+2 Defense` until your next turn), and **Pulse** (`2 AP, 4⚡, 1-turn recharge` — overcharge all Beacons you hold for immediate `+3 VP per Beacon` while pushing back adjacent unshielded enemy 1-unit scouts). Ending your turn (`0 AP`) banks leftover Energy and harvests passive Beacon VP (**+2 VP** for the Central Nexus `(0,0)` and **+1 VP** for each of the 4 Outer Beacons).

---

## ✨ Highlights

- **Instant Browser Play (Humans):** Open **[https://ducanh3005.github.io/beacon-wars/](https://ducanh3005.github.io/beacon-wars/)** to jump straight into **2P, 3P, or 4P Quick Play** against built-in tactical AI bots, or open a **Live Cloud Room** to play against friends or external Python bots.
- **Clean HTTP/JSON Agent API (`server.py` + `sample_bot.py`):** Zero-dependency Python 3 server exposing clean REST endpoints (`POST /api/matches`, `GET /api/matches/{code}`, `POST /join`, `POST /fill-bots`, `POST /move`, `GET /replay`) with full CORS (`*`).
- **Live Browser ↔ Terminal Bot Play (Zero Local Server Required):** Create a Cloud Match on GitHub Pages (`e.g. BW7K4M`) and run `python sample_bot.py --cloud --match BW7K4M` from any machine to watch your Python bot join an open seat and battle you live in the browser!
- **Zero-RNG Spatial Tactics:** Every clash is 100% readable before you click via the live hover **Combat Preview** (`Attack Power vs Defense Power`), rewarding multi-angle **Flanking**, timed **Shields**, **Energy Well** control, and **Beacon Pulse** knockbacks.
- **Full Match Replay Scrubber:** Scrub frame-by-frame (`|<`, `<`, `▶`, `>`, `>|`) through live or completed games, or load/download portable replay JSON files (including `sample_replay.json`).

---

## 🚀 Quickstart

### 1. Play in Your Browser (0 Setup)
Visit **[https://ducanh3005.github.io/beacon-wars/](https://ducanh3005.github.io/beacon-wars/)**:
- Click **Quick Play: `2P` / `3P` / `4P`** in the top bar for an instant match against built-in tactical bots.
- Use hotkeys **`[1]` Deploy**, **`[2]` Strike**, **`[3]` Shield**, **`[4]` Pulse**, and **`[Space]` End Turn**, or click hexes directly.
- Click **🎬 Demo Replay** to watch a recorded 4-player match between four distinct bot archetypes.

### 2. Battle Your Python Bot Live in the Browser (Cloud Relay Mode)
No local server needed — play on the public GitHub Pages URL directly against `sample_bot.py`:
1. Open **[https://ducanh3005.github.io/beacon-wars/](https://ducanh3005.github.io/beacon-wars/)**, click **🌐 Multiplayer & Bot API → Create Live Cloud Room**, and copy the 6-character Match Code (e.g. `BW7K4M`).
2. In your terminal (Python 3.8+, zero pip packages needed), run:
   ```bash
   python sample_bot.py --cloud --match BW7K4M
   ```
3. Watch `SampleBot-Py` join Seat 2 in your browser immediately! (For 3P/4P rooms, you can join multiple bots with `--strategy aggressive|fortress|pulse|balanced` or click **+ Fill Empty Seats with Built-in Bots**.)

### 3. Run the Local HTTP/JSON API Server + REST Bot
```bash
# Terminal 1: Start the zero-dependency HTTP/JSON API + UI server on http://127.0.0.1:8080
python server.py --port 8080

# Terminal 2: Run the sample HTTP/JSON bot (creates a match, fills bots, plays to completion)
python sample_bot.py --server http://127.0.0.1:8080 --players 4 --strategy aggressive
```
> **Tip — Cloud Bridge Mode:** Run `python server.py --port 8080 --bridge` to transparently bridge local REST endpoints (`/api/matches/{code}`) with live GitHub Pages Cloud Rooms so any `curl` / HTTP client can play against browser players!

---

## 🤖 HTTP/JSON Agent API Reference

All endpoints accept and return `application/json` with `Access-Control-Allow-Origin: *`.

### Endpoints Overview

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Server health check & active match count |
| `GET` | `/api/matches` | List active & completed matches on the server |
| `POST` | `/api/matches` | Create a new 2–4 player match (returns `matchCode`, `playerToken`, `state`, `legalMoves`) |
| `GET` | `/api/matches/{code}` | Read full game `state`, active player's `legalMoves`, `scores`, `winner`, and `log` |
| `POST` | `/api/matches/{code}/join` | Join an open seat as `"agent"` or `"human"` |
| `POST` | `/api/matches/{code}/fill-bots` | Fill all remaining open seats with built-in tactical AI bots and start the match |
| `POST` | `/api/matches/{code}/move` | Submit an action (`DEPLOY`, `STRIKE`, `SHIELD`, `PULSE`, `END_TURN`) |
| `GET` | `/api/matches/{code}/replay` | Fetch complete turn-by-turn move history & state `frames` |

---

### `curl` Walkthrough

#### 1. Create a Match (`POST /api/matches`)
```bash
curl -s -X POST http://127.0.0.1:8080/api/matches \
  -H "Content-Type: application/json" \
  -d '{"maxPlayers": 2, "playerName": "MyAgent", "playerType": "agent", "fillBots": true}'
```
Returns `201 Created` with `matchCode` (e.g. `"BW7K4M"`), `player` (`1`), `playerToken`, `state`, and `legalMoves`.

#### 2. Read Game State & Legal Moves (`GET /api/matches/{code}`)
```bash
curl -s http://127.0.0.1:8080/api/matches/BW7K4M
```
Key response fields:
```json
{
  "ok": true,
  "matchCode": "BW7K4M",
  "state": {
    "status": "ACTIVE",
    "round": 1,
    "maxRounds": 12,
    "targetVp": 25,
    "activePlayer": 1,
    "players": {
      "1": { "id": 1, "name": "MyAgent", "vp": 0, "ap": 3, "energy": 2, "pulseCooldown": 0, "beaconsHeld": 0, "wellsHeld": 0 }
    },
    "board": {
      "0,0": { "key": "0,0", "q": 0, "r": 0, "terrain": "NEXUS", "owner": 0, "units": 0, "shielded": false },
      "-3,0": { "key": "-3,0", "q": -3, "r": 0, "terrain": "SECTOR", "owner": 1, "units": 2, "shielded": false }
    }
  },
  "legalMoves": [
    { "action": "DEPLOY", "q": -3, "r": 0, "mode": "REINFORCE" },
    { "action": "DEPLOY", "q": -2, "r": 0, "mode": "EXPAND" },
    { "action": "SHIELD", "q": -3, "r": 0 },
    { "action": "END_TURN" }
  ],
  "scores": [ ... ],
  "winner": null
}
```

#### 3. Submit Moves (`POST /api/matches/{code}/move`)

Every item in `legalMoves` can be posted directly back to `/move` alongside `"player"` (and optional `"playerToken"`):

- **`DEPLOY`** (`1 AP, 1 Energy`):
  ```bash
  curl -s -X POST http://127.0.0.1:8080/api/matches/BW7K4M/move \
    -H "Content-Type: application/json" \
    -d '{"player": 1, "action": "DEPLOY", "q": -2, "r": 0}'
  ```
- **`STRIKE`** (`2 AP, 1 Energy`):
  ```bash
  curl -s -X POST http://127.0.0.1:8080/api/matches/BW7K4M/move \
    -H "Content-Type: application/json" \
    -d '{"player": 1, "action": "STRIKE", "from_q": -1, "from_r": 0, "to_q": 0, "to_r": 0}'
  ```
- **`SHIELD`** (`1 AP, 2 Energy`):
  ```bash
  curl -s -X POST http://127.0.0.1:8080/api/matches/BW7K4M/move \
    -H "Content-Type: application/json" \
    -d '{"player": 1, "action": "SHIELD", "q": 0, "r": 0}'
  ```
- **`PULSE`** (`2 AP, 4 Energy`):
  ```bash
  curl -s -X POST http://127.0.0.1:8080/api/matches/BW7K4M/move \
    -H "Content-Type: application/json" \
    -d '{"player": 1, "action": "PULSE"}'
  ```
- **`END_TURN`** (`0 AP`):
  ```bash
  curl -s -X POST http://127.0.0.1:8080/api/matches/BW7K4M/move \
    -H "Content-Type: application/json" \
    -d '{"player": 1, "action": "END_TURN"}'
  ```
  *(When a human or external agent ends their turn, any consecutive built-in AI bot seats automatically execute their turns before the response returns.)*

---

## 🧠 Game Balance & Strategic Triangle

Beacon Wars is designed on a **Klein four-group symmetric axial hex map** where all 4 player corners (`(-3,0)`, `(3,0)`, `(0,-3)`, `(0,3)`) have identical distances to the Central Nexus (`3`), Outer Beacons (`[1, 3, 5, 5]`), and Energy Wells (`[2, 2, 4, 4, 5, 5]`):

1. **Nexus Rush vs Energy Starvation:** Rushing straight to `(0,0)` without claiming an Energy Well leaves you at `1⚡/turn` base income — starving your `3 AP` economy against opponents generating `3–5⚡/turn`.
2. **Fortress Shielding vs Spatial Flanking:** Raising a `+2 Defense` **Shield** on a Beacon stops head-on attacks cold, but opponents can deploy cheap `1-unit` scouts onto adjacent hexes to stack **Flanking bonuses** (`+1 Attack` per extra friendly neighbor) and crack the shield.
3. **Flanking Swarms vs Beacon Pulse:** Surrounding an enemy's Beacon with `1-unit` flanking scouts is countered by **Beacon Pulse**, which awards `+3 VP` per held Beacon *and* blasts adjacent unshielded `1-unit` scouts outward by 1 hex!
4. **Pulse Overcharge Window:** Because `PULSE` requires **1 turn to recharge** after firing, opponents get a telegraphed counter-attack window to strike Beacons before the next Pulse comes online.

---

## 🗂️ Repository Structure & Testing

| File | Purpose |
| :--- | :--- |
| `index.html`, `style.css`, `game.js` | Browser Command-Center UI, SVG Hex Renderer, Web Audio Synth, Cloud Lobby, & Replay Scrubber |
| `engine.js` | Universal zero-dependency JS rules & bot engine (100% deterministic parity with `game_engine.py`) |
| `game_engine.py` | Core Python 3 deterministic hex rules, combat preview, tactical bot, & cloud stream state machine |
| `server.py` | Zero-dependency Python 3 multi-threaded HTTP/JSON API server + static UI host + `--bridge` mode |
| `sample_bot.py` | Reference HTTP/JSON & Cloud Relay Python AI bot with 4 strategy presets |
| `sample_replay.json` | Recorded 4-player match replay (`Cyan-Vanguard`, `Amber-Striker`, `Emerald-Bastion`, `Coral-Overcharge`) |
| `test_game.py` | Automated test suite for rules, symmetry, 2–4P matches, JS/Python parity, & HTTP API endpoints |

Run the full test suite:
```bash
python test_game.py
```
