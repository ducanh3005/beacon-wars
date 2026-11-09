#!/usr/bin/env python3
"""
Beacon Wars — Sample AI Agent (`sample_bot.py`, Zero Dependencies)

Supports TWO ways to play:
  1. Standard HTTP/JSON REST API (against `python server.py`):
       python sample_bot.py                                      # Auto-create 2P match vs bot & play!
       python sample_bot.py --server http://localhost:8080 --match BW7K4M

  2. Serverless Live Cloud Relay (against https://ducanh3005.github.io/beacon-wars/):
       python sample_bot.py --cloud --match BW7K4M               # Join a browser Cloud Match live!
       python sample_bot.py --cloud --create --players 2         # Host a Cloud Match & print browser link!
"""

from __future__ import annotations
import argparse
import json
import random
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

import game_engine as ge

NTFY_BASE = "https://ntfy.sh"
TOPIC_PREFIX = "bw_v1_"
PUBLIC_URL = "https://ducanh3005.github.io/beacon-wars/"
SAFE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


# ============================================================================
# Readable, Hackable Agent Decision Logic (operates purely on JSON state + legalMoves)
# ============================================================================

def hex_dist(q1: int, r1: int, q2: int, r2: int) -> int:
    return (abs(q1 - q2) + abs(r1 - r2) + abs((-q1 - r1) - (-q2 - r2))) // 2


def evaluate_move(
    state: Dict[str, Any],
    player: int,
    move: Dict[str, Any],
    strategy: str = "balanced",
) -> float:
    """
    Scores a candidate legal move from `legalMoves` using only public JSON `state`.
    Customize these weights or plug in an LLM / MCTS search to build your own bot!
    """
    action = move["action"]
    if action == "END_TURN":
        return 0.0

    board: Dict[str, Dict[str, Any]] = state["board"]
    me = state["players"][str(player)]
    target_vp = state.get("targetVp", 25)

    # Identify highest-VP opponent so we contest the leader in 3P/4P games
    leader_opp, leader_vp = 0, 0
    for pid, pinfo in state["players"].items():
        if int(pid) != player and pinfo["vp"] > leader_vp:
            leader_vp = pinfo["vp"]
            leader_opp = int(pid)

    if action == "PULSE":
        vp_gain = int(move.get("vpGain", 3))
        if me["vp"] + vp_gain >= target_vp:
            return 10000.0  # Instant win!
        score = vp_gain * 68.0 - 55.0
        if strategy == "pulse":
            score += 75.0
        if me["energy"] >= 6:
            score += 25.0
        return score

    if action == "STRIKE":
        outcome = move.get("outcome", "REPULSED")
        target_cell = board[f"{move['to_q']},{move['to_r']}"]
        terrain = target_cell["terrain"]

        if outcome == "REPULSED":
            return -500.0
        if outcome == "TIE":
            if target_cell["units"] == 1 and terrain in ("NEXUS", "BEACON", "WELL"):
                return 80.0 if terrain == "NEXUS" else 55.0
            return -75.0

        # Winning CAPTURE strike!
        terrain_value = {"NEXUS": 300.0, "BEACON": 215.0, "WELL": 150.0, "SECTOR": 45.0}[terrain]
        score = 165.0 + terrain_value
        if target_cell["owner"] == leader_opp and leader_vp >= 5:
            score += 55.0
        if strategy == "aggressive":
            score += 80.0
        return score

    if action == "DEPLOY":
        q, r = int(move["q"]), int(move["r"])
        cell = board[f"{q},{r}"]
        terrain = cell["terrain"]

        if cell["owner"] == 0:
            # Expanding onto an unclaimed hex
            terrain_value = {"NEXUS": 355.0, "BEACON": 220.0, "WELL": 175.0, "SECTOR": 45.0}[terrain]
            if terrain == "WELL" and me["wellsHeld"] == 0:
                terrain_value += 60.0
            if strategy == "pulse" and terrain in ("WELL", "BEACON", "NEXUS"):
                terrain_value += 45.0

            # Pull toward high-value unowned objectives
            pull = 0.0
            for c in board.values():
                if c["owner"] != player and c["terrain"] in ("NEXUS", "BEACON", "WELL"):
                    d = hex_dist(q, r, c["q"], c["r"])
                    w = 38.0 if c["terrain"] == "NEXUS" else (30.0 if c["terrain"] == "BEACON" else 22.0)
                    pull = max(pull, max(0, 4 - d) * w)

            # Flanking bonus setup next to enemy hexes
            flank_bonus = 0.0
            for c in board.values():
                if c["owner"] not in (0, player) and hex_dist(q, r, c["q"], c["r"]) == 1:
                    flank_bonus += 35.0 if c["terrain"] in ("NEXUS", "BEACON") else 12.0

            return terrain_value + pull + flank_bonus
        else:
            # Reinforcing an owned hex
            adj_enemies = [
                c for c in board.values()
                if c["owner"] not in (0, player) and hex_dist(q, r, c["q"], c["r"]) == 1
            ]
            if not adj_enemies:
                if terrain in ("NEXUS", "BEACON") and cell["units"] == 1:
                    return 85.0
                return -25.0  # Save energy rather than stacking idle backline units

            best = 125.0 if cell["units"] == 1 else 80.0
            for ec in adj_enemies:
                if ec["terrain"] in ("NEXUS", "BEACON", "WELL"):
                    best = max(best, 260.0 if (me["ap"] >= 3 and me["energy"] >= 2) else 150.0)
            if strategy == "aggressive":
                best += 40.0
            return best

    if action == "SHIELD":
        q, r = int(move["q"]), int(move["r"])
        cell = board[f"{q},{r}"]
        terrain = cell["terrain"]
        adj_enemies = [
            c for c in board.values()
            if c["owner"] not in (0, player) and hex_dist(q, r, c["q"], c["r"]) == 1
        ]
        if not adj_enemies:
            return -100.0
        threatened = max(ec["units"] for ec in adj_enemies) >= cell["units"]
        base = {"NEXUS": 255.0, "BEACON": 195.0, "WELL": 130.0, "SECTOR": 30.0}[terrain]
        if not threatened:
            base -= 55.0
        if strategy == "fortress":
            base += 75.0
        return base

    return -100.0


def choose_agent_move(
    state: Dict[str, Any],
    legal_moves: List[Dict[str, Any]],
    player: int,
    strategy: str = "balanced",
) -> Dict[str, Any]:
    if not legal_moves:
        return {"action": "END_TURN"}
    scored = [(evaluate_move(state, player, m, strategy), idx, m) for idx, m in enumerate(legal_moves)]
    scored.sort(key=lambda item: (item[0], -item[1]), reverse=True)
    return scored[0][2]


# ============================================================================
# Mode 1: HTTP/JSON REST API Client (`--server http://localhost:8080`)
# ============================================================================

def http_json(method: str, url: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json", "User-Agent": "BeaconWars-SampleBot/1.0"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        try:
            err_json = json.loads(body)
            raise RuntimeError(f"HTTP {err.code}: {err_json.get('error', body)}") from err
        except json.JSONDecodeError:
            raise RuntimeError(f"HTTP {err.code}: {body}") from err


def play_rest_api_match(
    server_url: str,
    match_code: Optional[str],
    bot_name: str,
    max_players: int,
    fill_bots: bool,
    strategy: str,
    move_delay: float,
) -> Dict[str, Any]:
    base = server_url.rstrip("/")
    if match_code:
        code = match_code.upper()
        print(f"[REST Bot] Joining match {code} on {base} as '{bot_name}' ({strategy})...")
        res = http_json("POST", f"{base}/api/matches/{code}/join", {
            "playerName": bot_name,
            "playerType": "agent",
        })
        my_seat = int(res["player"])
        my_token = res["playerToken"]
        if fill_bots and res["state"]["status"] == "WAITING":
            res = http_json("POST", f"{base}/api/matches/{code}/fill-bots", {})
    else:
        print(f"[REST Bot] Creating new {max_players}P match on {base} as '{bot_name}' ({strategy})...")
        res = http_json("POST", f"{base}/api/matches", {
            "maxPlayers": max_players,
            "playerName": bot_name,
            "playerType": "agent",
            "fillBots": fill_bots,
        })
        code = res["matchCode"]
        my_seat = int(res["player"])
        my_token = res["playerToken"]

    print(f"[REST Bot] Seated as Player {my_seat} in Match {code}!")

    last_printed_seq = 0
    while True:
        snap = http_json("GET", f"{base}/api/matches/{code}")
        state = snap["state"]

        for entry in snap.get("log", []):
            if entry["seq"] > last_printed_seq:
                print(f"  [R{entry['round']} #{entry['seq']:02d}] {entry['summary']}")
                last_printed_seq = entry["seq"]

        if state["status"] == "FINISHED":
            print("\n============================================================")
            print(f"  MATCH {code} FINISHED! Winner: Player {state['winner']} — {state['winReason']}")
            for sc in snap["scores"]:
                marker = " <-- (SampleBot)" if sc["player"] == my_seat else ""
                print(
                    f"    P{sc['player']} {sc['name']:16s} | {sc['vp']:2d} VP | "
                    f"{sc['beaconsHeld']} Beacons | {sc['wellsHeld']} Wells | {sc['totalUnits']} Units{marker}"
                )
            print("============================================================")
            return snap

        if state["status"] == "WAITING":
            time.sleep(0.5)
            continue

        if state["activePlayer"] != my_seat:
            time.sleep(0.3)
            continue

        legal_moves = snap.get("legalMoves", [])
        chosen = choose_agent_move(state, legal_moves, my_seat, strategy=strategy)
        if move_delay > 0:
            time.sleep(move_delay)

        http_json("POST", f"{base}/api/matches/{code}/move", {
            "player": my_seat,
            "playerToken": my_token,
            **chosen,
        })


# ============================================================================
# Mode 2: Serverless Live Cloud Relay (`--cloud --match <CODE>`)
# Plays directly against humans in https://ducanh3005.github.io/beacon-wars/
# ============================================================================

class CloudMatchClient:
    def __init__(self, match_code: str, relay_base: str = NTFY_BASE) -> None:
        self.code = match_code.upper()
        self.topic_url = f"{relay_base.rstrip('/')}/{TOPIC_PREFIX}{self.code}"
        self.cursor: Optional[str] = None
        self.seen_ids: set = set()
        self.events: List[Dict[str, Any]] = []

    def post_event(self, event: Dict[str, Any]) -> None:
        raw = json.dumps(event, separators=(",", ":")).encode("utf-8")
        req = urllib.request.Request(
            self.topic_url,
            data=raw,
            headers={"Content-Type": "text/plain; charset=utf-8", "User-Agent": "BeaconWars-SampleBot/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()

    def poll_session(self) -> Optional[ge.MatchSession]:
        since = self.cursor or "12h"
        url = f"{self.topic_url}/json?poll=1&since={urllib.parse.quote(since)}"
        req = urllib.request.Request(url, headers={"User-Agent": "BeaconWars-SampleBot/1.0"}, method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            lines = resp.read().decode("utf-8", errors="replace").splitlines()

        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                env = json.loads(line)
            except json.JSONDecodeError:
                continue
            if env.get("event") != "message":
                continue
            mid = env.get("id")
            if mid and mid in self.seen_ids:
                continue
            if mid:
                self.seen_ids.add(mid)
                self.cursor = mid
            try:
                evt = json.loads(env.get("message", ""))
                if isinstance(evt, dict):
                    self.events.append(evt)
            except json.JSONDecodeError:
                continue

        if not self.events:
            return None
        return ge.reconstruct_cloud_session(self.code, self.events)


def play_cloud_match(
    match_code: Optional[str],
    create_new: bool,
    bot_name: str,
    max_players: int,
    fill_bots: bool,
    strategy: str,
    move_delay: float,
) -> Dict[str, Any]:
    client_id = f"pybot_{secrets.token_hex(5)}"

    if create_new or not match_code:
        code = (match_code or "".join(random.choice(SAFE_ALPHABET) for _ in range(6))).upper()
        cloud = CloudMatchClient(code)
        print(f"[Cloud Bot] Creating Cloud Match {code} ({max_players}P)...")
        cloud.post_event({
            "v": 1,
            "type": "CREATE",
            "code": code,
            "maxPlayers": max_players,
            "name": bot_name,
            "playerType": "agent",
            "clientId": client_id,
            "ts": int(time.time()),
        })
        print(f"[Cloud Bot] Invite a human in browser: {PUBLIC_URL}?match={code}")
        if fill_bots:
            cloud.post_event({"v": 1, "type": "FILL_BOTS", "clientId": client_id, "ts": int(time.time())})
    else:
        code = match_code.upper()
        cloud = CloudMatchClient(code)
        print(f"[Cloud Bot] Connecting to Cloud Match {code}...")
        sess = cloud.poll_session()
        if sess is None:
            raise RuntimeError(
                f"Cloud Match '{code}' not found on relay. Create it first in browser at {PUBLIC_URL} or pass --create."
            )
        # Join open seat if not already seated
        already_seated = any(
            sess.state["players"][str(p)].get("clientId") == client_id
            for p in range(1, sess.state["maxPlayers"] + 1)
        )
        if not already_seated:
            cloud.post_event({
                "v": 1,
                "type": "JOIN",
                "code": code,
                "name": bot_name,
                "playerType": "agent",
                "clientId": client_id,
                "ts": int(time.time()),
            })
        if fill_bots:
            cloud.post_event({"v": 1, "type": "FILL_BOTS", "clientId": client_id, "ts": int(time.time())})

    my_seat: Optional[int] = None
    last_printed_seq = 0

    while True:
        sess = cloud.poll_session()
        if sess is None:
            time.sleep(0.8)
            continue

        st = sess.state
        if my_seat is None:
            for p in range(1, st["maxPlayers"] + 1):
                if st["players"][str(p)].get("clientId") == client_id:
                    my_seat = p
                    print(f"[Cloud Bot] Joined Match {code} as Player {my_seat} ({bot_name})!")
                    break
            if my_seat is None and st["status"] != "WAITING":
                raise RuntimeError(f"Match {code} is already full!")

        for entry in sess.log:
            if entry["seq"] > last_printed_seq:
                print(f"  [R{entry['round']} #{entry['seq']:02d}] {entry['summary']}")
                last_printed_seq = entry["seq"]

        if st["status"] == "FINISHED":
            snap = sess.to_api_response()
            print("\n============================================================")
            print(f"  CLOUD MATCH {code} FINISHED! Winner: Player {st['winner']} — {st['winReason']}")
            for sc in snap["scores"]:
                marker = " <-- (SampleBot)" if sc["player"] == my_seat else ""
                print(
                    f"    P{sc['player']} {sc['name']:16s} | {sc['vp']:2d} VP | "
                    f"{sc['beaconsHeld']} Beacons | {sc['wellsHeld']} Wells | {sc['totalUnits']} Units{marker}"
                )
            print("============================================================")
            return snap

        if st["status"] == "WAITING" or my_seat is None:
            time.sleep(1.0)
            continue

        if st["activePlayer"] != my_seat:
            time.sleep(0.8)
            continue

        # Execute our turn move-by-move on the deterministic cloud stream
        while st["status"] == "ACTIVE" and st["activePlayer"] == my_seat:
            legal = ge.get_legal_moves(st, my_seat)
            chosen = choose_agent_move(st, legal, my_seat, strategy=strategy)
            move_seq = st["seq"]
            cloud.post_event({
                "v": 1,
                "type": "MOVE",
                "seq": move_seq,
                "player": my_seat,
                "move": chosen,
                "clientId": client_id,
                "ts": int(time.time()),
            })
            # Advance local mirror immediately so we can chain actions cleanly in our turn
            entry, bot_entries = sess.submit_move(my_seat, chosen)
            print(f"  [R{entry['round']} #{entry['seq']:02d}] {entry['summary']}")
            for be in bot_entries:
                print(f"  [R{be['round']} #{be['seq']:02d}] {be['summary']}")
            last_printed_seq = sess.state["seq"]
            if move_delay > 0 and st["status"] == "ACTIVE":
                time.sleep(move_delay)


def main() -> None:
    parser = argparse.ArgumentParser(description="Beacon Wars Sample Tactical AI Bot (HTTP/JSON + Cloud Relay)")
    parser.add_argument("--server", default="http://127.0.0.1:8080", help="REST API server URL (default: http://127.0.0.1:8080)")
    parser.add_argument("--match", default=None, help="6-character Match Code to join (e.g. BW7K4M)")
    parser.add_argument("--cloud", action="store_true", help="Play over serverless Cloud Relay (works live with GitHub Pages!)")
    parser.add_argument("--create", action="store_true", help="Create a new Cloud Match when using --cloud")
    parser.add_argument("--players", type=int, default=2, choices=[2, 3, 4], help="Player count when creating a match (2, 3, or 4)")
    parser.add_argument("--name", default="SampleBot-Py", help="Display name for this bot")
    parser.add_argument(
        "--strategy",
        default="balanced",
        choices=["balanced", "aggressive", "fortress", "pulse"],
        help="Tactical personality preset",
    )
    parser.add_argument("--no-fill-bots", action="store_true", help="Do not auto-fill remaining empty seats with built-in bots")
    parser.add_argument("--delay", type=float, default=None, help="Delay in seconds between moves")
    args = parser.parse_args()

    fill_bots = not args.no_fill_bots
    if args.cloud and args.match and not args.create:
        # When joining a human's Cloud Match, don't overwrite other open human/bot seats unless asked
        fill_bots = False

    default_delay = 0.35 if args.cloud else 0.05
    delay = default_delay if args.delay is None else args.delay

    try:
        if args.cloud:
            play_cloud_match(
                match_code=args.match,
                create_new=args.create or (args.match is None),
                bot_name=args.name,
                max_players=args.players,
                fill_bots=fill_bots,
                strategy=args.strategy,
                move_delay=delay,
            )
        else:
            play_rest_api_match(
                server_url=args.server,
                match_code=args.match,
                bot_name=args.name,
                max_players=args.players,
                fill_bots=fill_bots,
                strategy=args.strategy,
                move_delay=delay,
            )
    except KeyboardInterrupt:
        print("\n[Bot] Interrupted by user.")
        sys.exit(0)
    except Exception as exc:
        print(f"\n[Bot Error] {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
