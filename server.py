#!/usr/bin/env python3
"""
Beacon Wars — Zero-Dependency Python 3 HTTP/JSON Server + Optional Cloud Relay Bridge

Usage:
  python server.py                     # Run local UI + REST API on http://localhost:8080
  python server.py --port 8080 --bridge # Also bridge /api/matches/{code} with live GitHub Pages Cloud Relay!
"""

from __future__ import annotations
import argparse
import json
import mimetypes
import os
import random
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

import game_engine as ge

REPO_DIR = os.path.dirname(os.path.abspath(__file__))
NTFY_BASE = "https://ntfy.sh"
TOPIC_PREFIX = "bw_v1_"
SAFE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PUBLIC_PAGES_URL = "https://ducanh3005.github.io/beacon-wars/"


def generate_match_code(length: int = 6) -> str:
    return "".join(random.choice(SAFE_ALPHABET) for _ in range(length))


class CloudRelayBridge:
    """Syncs deterministic match event streams with ntfy.sh for serverless browser <-> HTTP bot play."""

    def __init__(self, base_url: str = NTFY_BASE) -> None:
        self.base_url = base_url.rstrip("/")
        self.cursors: Dict[str, Optional[str]] = {}
        self.raw_events: Dict[str, List[Dict[str, Any]]] = {}
        self.seen_ids: Dict[str, set] = {}

    def topic_url(self, code: str) -> str:
        return f"{self.base_url}/{TOPIC_PREFIX}{code.upper()}"

    def publish_event(self, code: str, event: Dict[str, Any]) -> Optional[str]:
        url = self.topic_url(code)
        payload = json.dumps(event, separators=(",", ":")).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "text/plain; charset=utf-8", "User-Agent": "BeaconWars-Server/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            body = resp.read().decode("utf-8", errors="replace").strip()
            if body:
                meta = json.loads(body.splitlines()[0])
                return meta.get("id")
        return None

    def fetch_session(self, code: str) -> Optional[ge.MatchSession]:
        code = code.upper()
        if code not in self.raw_events:
            self.raw_events[code] = []
            self.seen_ids[code] = set()
            self.cursors[code] = None

        since = self.cursors[code] or "12h"
        url = f"{self.topic_url(code)}/json?poll=1&since={urllib.parse.quote(since)}"
        req = urllib.request.Request(url, headers={"User-Agent": "BeaconWars-Server/1.0"}, method="GET")
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read().decode("utf-8", errors="replace")

        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                envelope = json.loads(line)
            except json.JSONDecodeError:
                continue
            if envelope.get("event") != "message":
                continue
            msg_id = envelope.get("id")
            if msg_id and msg_id in self.seen_ids[code]:
                continue
            if msg_id:
                self.seen_ids[code].add(msg_id)
                self.cursors[code] = msg_id
            msg_text = envelope.get("message", "")
            try:
                evt = json.loads(msg_text)
                if isinstance(evt, dict):
                    self.raw_events[code].append(evt)
            except json.JSONDecodeError:
                continue

        if not self.raw_events[code]:
            return None
        return ge.reconstruct_cloud_session(code, self.raw_events[code])


class MatchStore:
    def __init__(self, bridge_enabled: bool = False) -> None:
        self.lock = threading.RLock()
        self.sessions: Dict[str, ge.MatchSession] = {}
        self.cloud_backed: set = set()
        self.bridge_enabled = bridge_enabled
        self.bridge = CloudRelayBridge()

    def list_matches(self) -> List[Dict[str, Any]]:
        with self.lock:
            out = []
            for code, sess in self.sessions.items():
                st = sess.state
                out.append({
                    "matchCode": code,
                    "status": st["status"],
                    "maxPlayers": st["maxPlayers"],
                    "round": st["round"],
                    "activePlayer": st["activePlayer"],
                    "winner": st["winner"],
                    "cloud": code in self.cloud_backed,
                    "players": [
                        {"id": p, "name": st["players"][str(p)]["name"], "type": st["players"][str(p)]["type"], "vp": st["players"][str(p)]["vp"]}
                        for p in range(1, st["maxPlayers"] + 1)
                    ],
                })
            return out

    def create_match(
        self,
        max_players: int = 2,
        player_name: str = "Player 1",
        player_type: str = "agent",
        fill_bots: bool = False,
        cloud: bool = False,
    ) -> Tuple[ge.MatchSession, str]:
        with self.lock:
            code = generate_match_code()
            while code in self.sessions:
                code = generate_match_code()

            token = f"tok_{secrets.token_hex(6)}"
            use_cloud = cloud or self.bridge_enabled

            if use_cloud:
                create_evt = {
                    "v": 1,
                    "type": "CREATE",
                    "code": code,
                    "maxPlayers": max_players,
                    "name": player_name,
                    "playerType": player_type,
                    "clientId": token,
                    "ts": int(time.time()),
                }
                self.bridge.publish_event(code, create_evt)
                if fill_bots:
                    self.bridge.publish_event(code, {"v": 1, "type": "FILL_BOTS", "clientId": token, "ts": int(time.time())})
                sess = self.bridge.fetch_session(code)
                if sess is None:
                    sess = ge.MatchSession(code, max_players, player_name, player_type, token, start_waiting=True)
                    if fill_bots:
                        sess.fill_bots()
                self.cloud_backed.add(code)
            else:
                sess = ge.MatchSession(
                    match_code=code,
                    max_players=max_players,
                    creator_name=player_name,
                    creator_type=player_type,
                    creator_client_id=token,
                    start_waiting=True,
                )
                if fill_bots:
                    sess.fill_bots()

            self.sessions[code] = sess
            return sess, token

    def get_match(self, code: str, force_cloud: bool = False) -> Optional[ge.MatchSession]:
        code = code.upper()
        with self.lock:
            if force_cloud or self.bridge_enabled or code in self.cloud_backed:
                try:
                    csess = self.bridge.fetch_session(code)
                    if csess is not None:
                        self.sessions[code] = csess
                        self.cloud_backed.add(code)
                        return csess
                except Exception:
                    pass
            return self.sessions.get(code)

    def join_match(
        self,
        code: str,
        player_name: str = "Remote Agent",
        player_type: str = "agent",
        preferred_seat: Optional[int] = None,
        force_cloud: bool = False,
    ) -> Tuple[Optional[ge.MatchSession], Optional[int], str]:
        code = code.upper()
        with self.lock:
            sess = self.get_match(code, force_cloud=force_cloud)
            if sess is None:
                return None, None, ""
            token = f"tok_{secrets.token_hex(6)}"
            if code in self.cloud_backed or self.bridge_enabled or force_cloud:
                join_evt: Dict[str, Any] = {
                    "v": 1,
                    "type": "JOIN",
                    "code": code,
                    "name": player_name,
                    "playerType": player_type,
                    "clientId": token,
                    "ts": int(time.time()),
                }
                if preferred_seat is not None:
                    join_evt["preferredSeat"] = preferred_seat
                self.bridge.publish_event(code, join_evt)
                sess = self.bridge.fetch_session(code) or sess
                self.sessions[code] = sess
                self.cloud_backed.add(code)
                seat = None
                for p in range(1, sess.state["maxPlayers"] + 1):
                    if sess.state["players"][str(p)].get("clientId") == token:
                        seat = p
                        break
                return sess, seat, token
            else:
                seat = sess.join_seat(player_name, player_type, token, preferred_seat)
                return sess, seat, token

    def fill_bots(self, code: str) -> Tuple[Optional[ge.MatchSession], List[int]]:
        code = code.upper()
        with self.lock:
            sess = self.get_match(code)
            if sess is None:
                return None, []
            if code in self.cloud_backed:
                before_open = [
                    p for p in range(1, sess.state["maxPlayers"] + 1)
                    if sess.state["players"][str(p)]["type"] == "open"
                ]
                self.bridge.publish_event(code, {"v": 1, "type": "FILL_BOTS", "ts": int(time.time())})
                sess = self.bridge.fetch_session(code) or sess
                self.sessions[code] = sess
                return sess, before_open
            else:
                filled = sess.fill_bots()
                return sess, filled

    def submit_move(
        self,
        code: str,
        player: int,
        raw_move: Dict[str, Any],
        player_token: Optional[str] = None,
    ) -> Tuple[Optional[ge.MatchSession], Optional[Dict[str, Any]], List[Dict[str, Any]], Optional[str]]:
        code = code.upper()
        with self.lock:
            sess = self.get_match(code)
            if sess is None:
                return None, None, [], f"Match '{code}' not found"

            st = sess.state
            if str(player) not in st["players"]:
                return sess, None, [], f"Invalid player seat '{player}'"

            seat_cid = st["players"][str(player)].get("clientId")
            if player_token and seat_cid and player_token != seat_cid:
                return sess, None, [], "Invalid playerToken for this seat"

            ok, err_msg, canonical = ge.validate_move(st, player, raw_move)
            if not ok or canonical is None:
                return sess, None, [], err_msg

            if code in self.cloud_backed:
                prev_len = len(sess.log)
                move_evt = {
                    "v": 1,
                    "type": "MOVE",
                    "seq": st["seq"],
                    "player": player,
                    "move": canonical,
                    "clientId": seat_cid or player_token or "",
                    "ts": int(time.time()),
                }
                self.bridge.publish_event(code, move_evt)
                sess = self.bridge.fetch_session(code) or sess
                self.sessions[code] = sess
                new_entries = sess.log[prev_len:]
                applied = new_entries[0] if new_entries else None
                bot_entries = new_entries[1:] if len(new_entries) > 1 else []
                return sess, applied, bot_entries, None
            else:
                applied, bot_entries = sess.submit_move(player, canonical)
                return sess, applied, bot_entries, None


class BeaconWarsHTTPHandler(BaseHTTPRequestHandler):
    store: MatchStore
    quiet: bool = False

    def log_message(self, fmt: str, *args: Any) -> None:
        if not self.quiet:
            super().log_message(fmt, *args)

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Player-Token")

    def _send_json(self, status_code: int, payload: Dict[str, Any]) -> None:
        raw = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status_code)
        self._send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8", errors="replace").strip()
        if not raw:
            return {}
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("Request body must be a JSON object")
        return data

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/health":
            self._send_json(200, {
                "ok": True,
                "game": "Beacon Wars",
                "version": "1.0",
                "bridge": self.store.bridge_enabled,
                "activeMatches": len(self.store.sessions),
            })
            return

        if path in ("/api/matches", "/api/matches/"):
            self._send_json(200, {
                "ok": True,
                "matches": self.store.list_matches(),
            })
            return

        if path.startswith("/api/matches/"):
            parts = [p for p in path.split("/") if p]
            # ['api', 'matches', '{code}'] or ['api', 'matches', '{code}', 'replay']
            if len(parts) == 3:
                code = parts[2].upper()
                force_cloud = qs.get("cloud", ["0"])[0] in ("1", "true", "yes")
                sess = self.store.get_match(code, force_cloud=force_cloud)
                if sess is None:
                    self._send_json(404, {"ok": False, "error": f"Match '{code}' not found"})
                    return
                self._send_json(200, {"ok": True, **sess.to_api_response()})
                return

            if len(parts) == 4 and parts[3] == "replay":
                code = parts[2].upper()
                sess = self.store.get_match(code)
                if sess is None:
                    self._send_json(404, {"ok": False, "error": f"Match '{code}' not found"})
                    return
                self._send_json(200, {"ok": True, **sess.to_replay_dict()})
                return

            self._send_json(404, {"ok": False, "error": "Unknown API endpoint"})
            return

        # Serve static UI files from repo directory
        rel_path = "index.html" if path in ("", "/") else path.lstrip("/")
        safe_path = os.path.normpath(os.path.join(REPO_DIR, rel_path))
        if not safe_path.startswith(REPO_DIR) or not os.path.isfile(safe_path):
            self._send_json(404, {"ok": False, "error": f"Not found: {path}"})
            return

        ctype, _ = mimetypes.guess_type(safe_path)
        if safe_path.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif safe_path.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif safe_path.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        elif safe_path.endswith(".json"):
            ctype = "application/json; charset=utf-8"

        with open(safe_path, "rb") as f:
            content = f.read()
        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            body = self._read_json_body()
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": f"Invalid JSON body: {exc}"})
            return

        if path in ("/api/matches", "/api/matches/"):
            max_players = int(body.get("maxPlayers", 2))
            if max_players not in (2, 3, 4):
                self._send_json(400, {"ok": False, "error": "maxPlayers must be 2, 3, or 4"})
                return
            player_name = str(body.get("playerName", "Player 1"))[:28]
            player_type = str(body.get("playerType", "agent"))
            if player_type not in ("human", "agent", "builtin_bot"):
                player_type = "agent"
            fill_bots = bool(body.get("fillBots", False))
            cloud = bool(body.get("cloud", False))

            try:
                sess, token = self.store.create_match(
                    max_players=max_players,
                    player_name=player_name,
                    player_type=player_type,
                    fill_bots=fill_bots,
                    cloud=cloud,
                )
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
                return

            self._send_json(201, {
                "ok": True,
                "player": 1,
                "playerToken": token,
                "cloudUrl": f"{PUBLIC_PAGES_URL}?match={sess.match_code}",
                **sess.to_api_response(),
            })
            return

        if path.startswith("/api/matches/"):
            parts = [p for p in path.split("/") if p]
            if len(parts) == 4:
                code = parts[2].upper()
                sub = parts[3]

                if sub == "join":
                    player_name = str(body.get("playerName", "Remote Agent"))[:28]
                    player_type = str(body.get("playerType", "agent"))
                    if player_type not in ("human", "agent"):
                        player_type = "agent"
                    pref_seat = body.get("seat")
                    if pref_seat is not None:
                        pref_seat = int(pref_seat)
                    force_cloud = bool(body.get("cloud", False))

                    sess, seat, token = self.store.join_match(
                        code=code,
                        player_name=player_name,
                        player_type=player_type,
                        preferred_seat=pref_seat,
                        force_cloud=force_cloud,
                    )
                    if sess is None:
                        self._send_json(404, {"ok": False, "error": f"Match '{code}' not found"})
                        return
                    if seat is None:
                        self._send_json(409, {
                            "ok": False,
                            "error": f"Match '{code}' has no open seats",
                            **sess.to_api_response(),
                        })
                        return
                    self._send_json(200, {
                        "ok": True,
                        "player": seat,
                        "playerToken": token,
                        **sess.to_api_response(),
                    })
                    return

                if sub == "fill-bots":
                    sess, filled = self.store.fill_bots(code)
                    if sess is None:
                        self._send_json(404, {"ok": False, "error": f"Match '{code}' not found"})
                        return
                    self._send_json(200, {
                        "ok": True,
                        "filledSeats": filled,
                        **sess.to_api_response(),
                    })
                    return

                if sub == "move":
                    sess = self.store.get_match(code)
                    if sess is None:
                        self._send_json(404, {"ok": False, "error": f"Match '{code}' not found"})
                        return
                    player = int(body.get("player", sess.state["activePlayer"]))
                    token = body.get("playerToken") or self.headers.get("X-Player-Token")
                    raw_move = body.get("move") if isinstance(body.get("move"), dict) else body

                    sess, applied, bot_moves, err = self.store.submit_move(code, player, raw_move, token)
                    if err is not None or sess is None:
                        self._send_json(400, {
                            "ok": False,
                            "error": err or "Move failed",
                            "legalMoves": ge.get_legal_moves(sess.state) if sess else [],
                        })
                        return
                    self._send_json(200, {
                        "ok": True,
                        "appliedMove": applied,
                        "botMoves": bot_moves,
                        **sess.to_api_response(),
                    })
                    return

        self._send_json(404, {"ok": False, "error": f"Unknown endpoint: {path}"})


def run_server(host: str = "0.0.0.0", port: int = 8080, bridge: bool = False, quiet: bool = False) -> ThreadingHTTPServer:
    store = MatchStore(bridge_enabled=bridge)

    class BoundHandler(BeaconWarsHTTPHandler):
        pass

    BoundHandler.store = store
    BoundHandler.quiet = quiet

    httpd = ThreadingHTTPServer((host, port), BoundHandler)
    return httpd


def main() -> None:
    parser = argparse.ArgumentParser(description="Beacon Wars HTTP/JSON API + Browser UI Server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080)")
    parser.add_argument(
        "--bridge",
        action="store_true",
        help="Bridge /api/matches/{code} with live GitHub Pages Cloud Relay (ntfy.sh)",
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress per-request access logs")
    args = parser.parse_args()

    httpd = run_server(host=args.host, port=args.port, bridge=args.bridge, quiet=args.quiet)
    mode_str = "LOCAL + CLOUD RELAY BRIDGE" if args.bridge else "LOCAL HTTP/JSON"
    print(f"============================================================")
    print(f"  BEACON WARS Server ({mode_str})")
    print(f"  Browser UI : http://{args.host}:{args.port}/")
    print(f"  REST API   : http://{args.host}:{args.port}/api/matches")
    print(f"============================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down Beacon Wars server...")
        httpd.server_close()


if __name__ == "__main__":
    main()
