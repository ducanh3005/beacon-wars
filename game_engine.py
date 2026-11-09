"""
Beacon Wars — Core Deterministic Hex Strategy Engine (Python 3, Zero Dependencies)

Board: Radius-3 axial hex grid (37 hexes).
Players: 2 to 4 players (Human or AI Agent).
Win Condition: First to 25 Victory Points (VP), or highest VP after Round 12.
"""

from __future__ import annotations
import copy
from typing import Any, Dict, List, Optional, Tuple

BOARD_RADIUS = 3
MAX_ROUNDS = 12
TARGET_VP = 25
MAX_UNITS_PER_HEX = 4
MAX_ENERGY = 10
BASE_AP = 3
BASE_ENERGY_INCOME = 1
WELL_ENERGY_BONUS = 2

# Fixed axial neighbor order (pointy/flat invariant axial topology)
HEX_DIRECTIONS: List[Tuple[int, int]] = [
    (1, 0),
    (1, -1),
    (0, -1),
    (-1, 0),
    (-1, 1),
    (0, 1),
]

CENTRAL_NEXUS: Tuple[int, int] = (0, 0)
OUTER_BEACONS: List[Tuple[int, int]] = [
    (2, 0),
    (-2, 0),
    (0, 2),
    (0, -2),
]
# Klein four-group symmetric Energy Wells: every spawn has identical distances [2, 2, 4, 4, 5, 5]
ENERGY_WELLS: List[Tuple[int, int]] = [
    (-2, 1),
    (-1, 2),
    (1, -2),
    (2, -1),
    (-1, -1),
    (1, 1),
]

PLAYER_SPAWNS: Dict[int, Tuple[int, int]] = {
    1: (-3, 0),
    2: (3, 0),
    3: (0, -3),
    4: (0, 3),
}

PLAYER_META: Dict[int, Dict[str, str]] = {
    1: {"name": "P1 Cyan", "color": "#22d3ee", "faction": "Azure Vanguard"},
    2: {"name": "P2 Amber", "color": "#fbbf24", "faction": "Solaris Syndicate"},
    3: {"name": "P3 Emerald", "color": "#34d399", "faction": "Verdant Collective"},
    4: {"name": "P4 Coral", "color": "#fb7185", "faction": "Crimson Horizon"},
}

ACTION_COSTS: Dict[str, Tuple[int, int]] = {
    "DEPLOY": (1, 1),   # (AP, Energy)
    "STRIKE": (2, 1),
    "SHIELD": (1, 2),
    "PULSE": (2, 4),
    "END_TURN": (0, 0),
}


def hex_key(q: int, r: int) -> str:
    return f"{q},{r}"


def parse_hex_key(key: str) -> Tuple[int, int]:
    parts = key.split(",")
    return int(parts[0].strip()), int(parts[1].strip())


def hex_distance(a: Tuple[int, int], b: Tuple[int, int]) -> int:
    dq = a[0] - b[0]
    dr = a[1] - b[1]
    ds = (-a[0] - a[1]) - (-b[0] - b[1])
    return (abs(dq) + abs(dr) + abs(ds)) // 2


def is_on_board(q: int, r: int) -> bool:
    return max(abs(q), abs(r), abs(-q - r)) <= BOARD_RADIUS


def all_board_coords() -> List[Tuple[int, int]]:
    coords: List[Tuple[int, int]] = []
    for q in range(-BOARD_RADIUS, BOARD_RADIUS + 1):
        for r in range(-BOARD_RADIUS, BOARD_RADIUS + 1):
            if is_on_board(q, r):
                coords.append((q, r))
    return coords


def get_neighbors(q: int, r: int) -> List[Tuple[int, int]]:
    out: List[Tuple[int, int]] = []
    for dq, dr in HEX_DIRECTIONS:
        nq, nr = q + dq, r + dr
        if is_on_board(nq, nr):
            out.append((nq, nr))
    return out


def terrain_at(q: int, r: int) -> str:
    pos = (q, r)
    if pos == CENTRAL_NEXUS:
        return "NEXUS"
    if pos in OUTER_BEACONS:
        return "BEACON"
    if pos in ENERGY_WELLS:
        return "WELL"
    return "SECTOR"


def create_initial_state(
    max_players: int = 2,
    match_code: str = "LOCAL",
    seats: Optional[Dict[int, Dict[str, Any]]] = None,
    status: str = "ACTIVE",
) -> Dict[str, Any]:
    if max_players not in (2, 3, 4):
        raise ValueError("max_players must be 2, 3, or 4")

    board: Dict[str, Dict[str, Any]] = {}
    for q, r in all_board_coords():
        k = hex_key(q, r)
        board[k] = {
            "key": k,
            "q": q,
            "r": r,
            "terrain": terrain_at(q, r),
            "owner": 0,
            "units": 0,
            "shielded": False,
        }

    players: Dict[str, Dict[str, Any]] = {}
    for p in range(1, max_players + 1):
        sq, sr = PLAYER_SPAWNS[p]
        sk = hex_key(sq, sr)
        board[sk]["owner"] = p
        board[sk]["units"] = 2

        seat_info = (seats or {}).get(p, {})
        meta = PLAYER_META[p]
        # Turn-order balance: Seat 1 starts with 1 stored Energy (+1 income = 2 on Turn 1),
        # Seats 2-3 start with 2 stored Energy, Seat 4 starts with 3 stored Energy.
        initial_energy = 1 if p == 1 else (3 if p == 4 else 2)
        players[str(p)] = {
            "id": p,
            "name": seat_info.get("name") or meta["name"],
            "color": meta["color"],
            "faction": meta["faction"],
            "type": seat_info.get("type", "open"),  # "human" | "agent" | "builtin_bot" | "open"
            "clientId": seat_info.get("clientId"),
            "vp": 0,
            "ap": 0,
            "energy": initial_energy,
            "pulseCooldown": 0,
            "beaconsHeld": 0,
            "wellsHeld": 0,
            "totalUnits": 2,
            "hexesHeld": 1,
        }

    state: Dict[str, Any] = {
        "matchCode": match_code,
        "status": status,  # "WAITING" | "ACTIVE" | "FINISHED"
        "maxPlayers": max_players,
        "round": 1,
        "maxRounds": MAX_ROUNDS,
        "targetVp": TARGET_VP,
        "activePlayer": 1,
        "winner": None,
        "winReason": None,
        "seq": 0,
        "turnNumber": 1,
        "players": players,
        "board": board,
        "lastMove": None,
    }

    _recompute_player_counts(state)
    if status == "ACTIVE":
        _begin_player_turn(state, 1)
    return state


def _recompute_player_counts(state: Dict[str, Any]) -> None:
    for p_str, pdata in state["players"].items():
        pdata["beaconsHeld"] = 0
        pdata["wellsHeld"] = 0
        pdata["totalUnits"] = 0
        pdata["hexesHeld"] = 0

    for cell in state["board"].values():
        owner = cell["owner"]
        if owner > 0:
            pdata = state["players"][str(owner)]
            pdata["hexesHeld"] += 1
            pdata["totalUnits"] += cell["units"]
            if cell["terrain"] in ("NEXUS", "BEACON"):
                pdata["beaconsHeld"] += 1
            elif cell["terrain"] == "WELL":
                pdata["wellsHeld"] += 1


def _begin_player_turn(state: Dict[str, Any], player: int) -> None:
    # Clear shields belonging to this player at the start of their turn
    for cell in state["board"].values():
        if cell["owner"] == player and cell["shielded"]:
            cell["shielded"] = False

    _recompute_player_counts(state)
    pdata = state["players"][str(player)]
    if pdata.get("pulseCooldown", 0) > 0:
        pdata["pulseCooldown"] -= 1
    income = BASE_ENERGY_INCOME + pdata["wellsHeld"] * WELL_ENERGY_BONUS
    pdata["energy"] = min(MAX_ENERGY, pdata["energy"] + income)
    pdata["ap"] = BASE_AP
    state["activePlayer"] = player


def preview_strike(state: Dict[str, Any], player: int, from_q: int, from_r: int, to_q: int, to_r: int) -> Optional[Dict[str, Any]]:
    fk = hex_key(from_q, from_r)
    tk = hex_key(to_q, to_r)
    board = state["board"]
    if fk not in board or tk not in board:
        return None
    origin = board[fk]
    target = board[tk]
    if origin["owner"] != player or origin["units"] < 2:
        return None
    if target["owner"] == 0 or target["owner"] == player:
        return None
    if hex_distance((from_q, from_r), (to_q, to_r)) != 1:
        return None

    flank_Count = 0
    for nq, nr in get_neighbors(to_q, to_r):
        if (nq, nr) == (from_q, from_r):
            continue
        if board[hex_key(nq, nr)]["owner"] == player:
            flank_Count += 1

    attack_power = origin["units"] + flank_Count
    shield_bonus = 2 if target["shielded"] else 0
    defense_power = target["units"] + shield_bonus

    if attack_power > defense_power:
        outcome = "CAPTURE"
        advancing_units = max(1, origin["units"] - 1)
    elif attack_power == defense_power:
        outcome = "TIE"
        advancing_units = 0
    else:
        outcome = "REPULSED"
        advancing_units = 0

    return {
        "from": fk,
        "to": tk,
        "attackerUnits": origin["units"],
        "flankBonus": flank_Count,
        "attackPower": attack_power,
        "defenderOwner": target["owner"],
        "defenderUnits": target["units"],
        "shieldBonus": shield_bonus,
        "defensePower": defense_power,
        "outcome": outcome,
        "advancingUnits": advancing_units,
    }


def get_legal_moves(state: Dict[str, Any], player: Optional[int] = None) -> List[Dict[str, Any]]:
    if state["status"] != "ACTIVE":
        return []
    act_p = state["activePlayer"]
    if player is not None and player != act_p:
        return []

    pdata = state["players"][str(act_p)]
    ap = pdata["ap"]
    energy = pdata["energy"]
    board = state["board"]
    moves: List[Dict[str, Any]] = []

    owned_cells = [c for c in board.values() if c["owner"] == act_p]
    owned_coords = {(c["q"], c["r"]) for c in owned_cells}

    # 1. DEPLOY (1 AP, 1 Energy)
    if ap >= 1 and energy >= 1:
        deploy_targets: List[Tuple[int, int, str]] = []
        if len(owned_cells) == 0:
            # Orbital Recovery: if wiped out, may deploy onto any empty outer-ring hex
            for q, r in all_board_coords():
                if hex_distance((0, 0), (q, r)) == BOARD_RADIUS and board[hex_key(q, r)]["owner"] == 0:
                    deploy_targets.append((q, r, "ORBITAL"))
        else:
            seen_expand = set()
            for c in owned_cells:
                if c["units"] < MAX_UNITS_PER_HEX:
                    deploy_targets.append((c["q"], c["r"], "REINFORCE"))
                for nq, nr in get_neighbors(c["q"], c["r"]):
                    if (nq, nr) not in seen_expand and board[hex_key(nq, nr)]["owner"] == 0:
                        seen_expand.add((nq, nr))
                        deploy_targets.append((nq, nr, "EXPAND"))
        deploy_targets.sort(key=lambda item: (item[0], item[1]))
        for q, r, mode in deploy_targets:
            moves.append({
                "action": "DEPLOY",
                "q": q,
                "r": r,
                "mode": mode,
            })

    # 2. STRIKE (2 AP, 1 Energy)
    if ap >= 2 and energy >= 1:
        strike_list: List[Tuple[int, int, int, int, Dict[str, Any]]] = []
        for c in owned_cells:
            if c["units"] < 2:
                continue
            fq, fr = c["q"], c["r"]
            for tq, tr in get_neighbors(fq, fr):
                tcell = board[hex_key(tq, tr)]
                if tcell["owner"] != 0 and tcell["owner"] != act_p:
                    prev = preview_strike(state, act_p, fq, fr, tq, tr)
                    if prev is not None:
                        strike_list.append((fq, fr, tq, tr, prev))
        strike_list.sort(key=lambda item: (item[0], item[1], item[2], item[3]))
        for fq, fr, tq, tr, prev in strike_list:
            moves.append({
                "action": "STRIKE",
                "from_q": fq,
                "from_r": fr,
                "to_q": tq,
                "to_r": tr,
                "outcome": prev["outcome"],
                "attackPower": prev["attackPower"],
                "defensePower": prev["defensePower"],
            })

    # 3. SHIELD (1 AP, 2 Energy)
    if ap >= 1 and energy >= 2:
        shield_targets = [(c["q"], c["r"]) for c in owned_cells if not c["shielded"]]
        shield_targets.sort()
        for q, r in shield_targets:
            moves.append({
                "action": "SHIELD",
                "q": q,
                "r": r,
            })

    # 4. PULSE (2 AP, 4 Energy, 1-turn recharge after use)
    if ap >= 2 and energy >= 4 and pdata.get("pulseCooldown", 0) == 0:
        beacons_held = [c for c in owned_cells if c["terrain"] in ("NEXUS", "BEACON")]
        if len(beacons_held) > 0:
            moves.append({
                "action": "PULSE",
                "beacons": len(beacons_held),
                "vpGain": 3 * len(beacons_held),
            })

    # 5. END_TURN (0 AP, 0 Energy)
    moves.append({"action": "END_TURN"})
    return moves


def normalize_move_input(raw_move: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize flexible JSON payloads (e.g. 'target': 'q,r' or 'q'/'r') into canonical move fields."""
    action = str(raw_move.get("action", "")).upper().strip()
    out: Dict[str, Any] = {"action": action}

    if action in ("DEPLOY", "SHIELD"):
        if "q" in raw_move and "r" in raw_move:
            out["q"] = int(raw_move["q"])
            out["r"] = int(raw_move["r"])
        elif "target" in raw_move:
            q, r = parse_hex_key(str(raw_move["target"]))
            out["q"] = q
            out["r"] = r
        else:
            raise ValueError(f"{action} requires integer 'q' and 'r' (or 'target': 'q,r')")

    elif action == "STRIKE":
        if all(k in raw_move for k in ("from_q", "from_r", "to_q", "to_r")):
            out["from_q"] = int(raw_move["from_q"])
            out["from_r"] = int(raw_move["from_r"])
            out["to_q"] = int(raw_move["to_q"])
            out["to_r"] = int(raw_move["to_r"])
        elif "from" in raw_move and "to" in raw_move:
            fq, fr = parse_hex_key(str(raw_move["from"]))
            tq, tr = parse_hex_key(str(raw_move["to"]))
            out["from_q"], out["from_r"] = fq, fr
            out["to_q"], out["to_r"] = tq, tr
        else:
            raise ValueError("STRIKE requires 'from_q','from_r','to_q','to_r' (or 'from' and 'to' keys)")

    elif action in ("PULSE", "END_TURN"):
        pass
    else:
        raise ValueError(f"Unknown action '{action}'. Valid actions: DEPLOY, STRIKE, SHIELD, PULSE, END_TURN")

    return out


def validate_move(state: Dict[str, Any], player: int, raw_move: Dict[str, Any]) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    if state["status"] != "ACTIVE":
        return False, f"Match is not active (current status: {state['status']})", None
    if player != state["activePlayer"]:
        return False, f"It is Player {state['activePlayer']}'s turn, not Player {player}", None

    try:
        norm = normalize_move_input(raw_move)
    except (ValueError, TypeError) as exc:
        return False, str(exc), None

    legal = get_legal_moves(state, player)
    action = norm["action"]
    for lm in legal:
        if lm["action"] != action:
            continue
        if action in ("DEPLOY", "SHIELD"):
            if lm["q"] == norm["q"] and lm["r"] == norm["r"]:
                return True, "OK", lm
        elif action == "STRIKE":
            if (
                lm["from_q"] == norm["from_q"]
                and lm["from_r"] == norm["from_r"]
                and lm["to_q"] == norm["to_q"]
                and lm["to_r"] == norm["to_r"]
            ):
                return True, "OK", lm
        else:
            return True, "OK", lm

    pdata = state["players"][str(player)]
    ap_cost, en_cost = ACTION_COSTS.get(action, (0, 0))
    if pdata["ap"] < ap_cost:
        return False, f"Insufficient AP for {action} (need {ap_cost}, have {pdata['ap']})", None
    if pdata["energy"] < en_cost:
        return False, f"Insufficient Energy for {action} (need {en_cost}, have {pdata['energy']})", None
    if action == "PULSE" and pdata.get("pulseCooldown", 0) > 0:
        return False, "PULSE is recharging (1-turn cooldown after overcharging Beacons)", None
    return False, f"Illegal {action} target or precondition failed", None


def _passive_beacon_vp_for_player(state: Dict[str, Any], player: int) -> int:
    vp = 0
    for cell in state["board"].values():
        if cell["owner"] == player:
            if cell["terrain"] == "NEXUS":
                vp += 2
            elif cell["terrain"] == "BEACON":
                vp += 1
    return vp


def _resolve_round_limit_winner(state: Dict[str, Any]) -> Tuple[int, str]:
    _recompute_player_counts(state)
    best_player = 1
    best_tuple = (-1, -1, -1, -1, -1)
    for p in range(1, state["maxPlayers"] + 1):
        pdata = state["players"][str(p)]
        cand = (
            pdata["vp"],
            pdata["beaconsHeld"],
            pdata["totalUnits"],
            pdata["energy"],
            p,
        )
        if cand > best_tuple:
            best_tuple = cand
            best_player = p
    w = state["players"][str(best_player)]
    reason = (
        f"{w['name']} wins after Round {MAX_ROUNDS} with {w['vp']} VP "
        f"({w['beaconsHeld']} Beacons, {w['totalUnits']} Units)!"
    )
    return best_player, reason


def apply_move(state: Dict[str, Any], player: int, raw_move: Dict[str, Any]) -> Dict[str, Any]:
    """Mutates `state` in place with a validated move and returns a structured log event."""
    ok, msg, canonical = validate_move(state, player, raw_move)
    if not ok or canonical is None:
        raise ValueError(msg)

    action = canonical["action"]
    pdata = state["players"][str(player)]
    pname = pdata["name"]
    ap_cost, en_cost = ACTION_COSTS[action]
    pdata["ap"] -= ap_cost
    pdata["energy"] -= en_cost

    board = state["board"]
    summary = ""
    details: Dict[str, Any] = {"action": action, "player": player, "round": state["round"]}

    if action == "DEPLOY":
        q, r = canonical["q"], canonical["r"]
        cell = board[hex_key(q, r)]
        if cell["owner"] == player:
            cell["units"] += 1
            summary = f"{pname} deployed +1 unit on ({q},{r}) [{cell['units']} units]"
            details.update({"q": q, "r": r, "mode": "REINFORCE", "units": cell["units"]})
        else:
            cell["owner"] = player
            cell["units"] = 1
            cell["shielded"] = False
            t_label = f" [{cell['terrain']}]" if cell["terrain"] != "SECTOR" else ""
            summary = f"{pname} claimed ({q},{r}){t_label}"
            details.update({"q": q, "r": r, "mode": "EXPAND", "terrain": cell["terrain"]})

    elif action == "STRIKE":
        fq, fr = canonical["from_q"], canonical["from_r"]
        tq, tr = canonical["to_q"], canonical["to_r"]
        prev = preview_strike(state, player, fq, fr, tq, tr)
        assert prev is not None
        origin = board[hex_key(fq, fr)]
        target = board[hex_key(tq, tr)]
        outcome = prev["outcome"]
        details.update({
            "from_q": fq,
            "from_r": fr,
            "to_q": tq,
            "to_r": tr,
            "attackPower": prev["attackPower"],
            "defensePower": prev["defensePower"],
            "flankBonus": prev["flankBonus"],
            "outcome": outcome,
        })
        if outcome == "CAPTURE":
            advancing = prev["advancingUnits"]
            origin["units"] = 1
            target["owner"] = player
            target["units"] = advancing
            target["shielded"] = False
            summary = (
                f"{pname} captured ({tq},{tr}) from ({fq},{fr}) "
                f"[Atk {prev['attackPower']} vs Def {prev['defensePower']}]"
            )
        elif outcome == "TIE":
            origin["units"] -= 1
            target["units"] -= 1
            if target["units"] <= 0:
                target["owner"] = 0
                target["units"] = 0
                target["shielded"] = False
                summary = (
                    f"{pname} clashed at ({tq},{tr}) — mutual attrition cleared the hex! "
                    f"[Atk {prev['attackPower']} vs Def {prev['defensePower']}]"
                )
            else:
                summary = (
                    f"{pname} clashed at ({tq},{tr}) — both sides lost 1 unit "
                    f"[Atk {prev['attackPower']} vs Def {prev['defensePower']}]"
                )
        else:
            origin["units"] -= 1
            summary = (
                f"{pname}'s strike on ({tq},{tr}) was repulsed (-1 unit) "
                f"[Atk {prev['attackPower']} vs Def {prev['defensePower']}]"
            )

    elif action == "SHIELD":
        q, r = canonical["q"], canonical["r"]
        cell = board[hex_key(q, r)]
        cell["shielded"] = True
        summary = f"{pname} fortified ({q},{r}) with a +2 Defense Shield"
        details.update({"q": q, "r": r})

    elif action == "PULSE":
        held_beacons = [
            (c["q"], c["r"])
            for c in board.values()
            if c["owner"] == player and c["terrain"] in ("NEXUS", "BEACON")
        ]
        held_beacons.sort()
        vp_gain = 3 * len(held_beacons)
        pdata["vp"] += vp_gain
        pdata["pulseCooldown"] = 2  # Decrements at start of next turn -> 1 turn cooldown, ready on the turn after!
        pushed_count = 0

        for bq, br in held_beacons:
            for dq, dr in HEX_DIRECTIONS:
                nq, nr = bq + dq, br + dr
                if not is_on_board(nq, nr):
                    continue
                ncell = board[hex_key(nq, nr)]
                if ncell["owner"] != 0 and ncell["owner"] != player and ncell["units"] == 1 and not ncell["shielded"]:
                    enemy_owner = ncell["owner"]
                    pq, pr = bq + 2 * dq, br + 2 * dr
                    ncell["owner"] = 0
                    ncell["units"] = 0
                    ncell["shielded"] = False
                    pushed_count += 1
                    if is_on_board(pq, pr):
                        dest = board[hex_key(pq, pr)]
                        if dest["owner"] == 0:
                            dest["owner"] = enemy_owner
                            dest["units"] = 1
                            dest["shielded"] = False
                        elif dest["owner"] == enemy_owner and dest["units"] < MAX_UNITS_PER_HEX:
                            dest["units"] += 1

        summary = (
            f"{pname} triggered BEACON PULSE across {len(held_beacons)} beacon(s) "
            f"for +{vp_gain} VP"
            + (f" and pushed {pushed_count} enemy scout(s)!" if pushed_count else "!")
        )
        details.update({"beacons": len(held_beacons), "vpGain": vp_gain, "pushedScouts": pushed_count})

        _recompute_player_counts(state)
        if pdata["vp"] >= TARGET_VP:
            state["status"] = "FINISHED"
            state["winner"] = player
            state["winReason"] = f"{pname} reached {pdata['vp']} VP via Beacon Pulse!"

    elif action == "END_TURN":
        pdata["energy"] = min(MAX_ENERGY, pdata["energy"])
        passive_vp = _passive_beacon_vp_for_player(state, player)
        pdata["vp"] += passive_vp
        _recompute_player_counts(state)
        vp_note = f" (+{passive_vp} Beacon VP -> {pdata['vp']} VP)" if passive_vp > 0 else f" ({pdata['vp']} VP)"
        summary = f"{pname} ended turn{vp_note}"
        details.update({"passiveVp": passive_vp, "totalVp": pdata["vp"]})

        if pdata["vp"] >= TARGET_VP:
            state["status"] = "FINISHED"
            state["winner"] = player
            state["winReason"] = f"{pname} reached {pdata['vp']} Victory Points!"
        else:
            if player < state["maxPlayers"]:
                state["turnNumber"] += 1
                _begin_player_turn(state, player + 1)
            else:
                if state["round"] >= MAX_ROUNDS:
                    state["status"] = "FINISHED"
                    win_p, win_reason = _resolve_round_limit_winner(state)
                    state["winner"] = win_p
                    state["winReason"] = win_reason
                else:
                    state["round"] += 1
                    state["turnNumber"] += 1
                    _begin_player_turn(state, 1)

    _recompute_player_counts(state)
    state["seq"] += 1
    log_entry = {
        "seq": state["seq"],
        "summary": summary,
        **details,
    }
    state["lastMove"] = log_entry
    return log_entry


def get_scores_summary(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    _recompute_player_counts(state)
    scores: List[Dict[str, Any]] = []
    for p in range(1, state["maxPlayers"] + 1):
        pdata = state["players"][str(p)]
        scores.append({
            "player": p,
            "name": pdata["name"],
            "type": pdata["type"],
            "vp": pdata["vp"],
            "beaconsHeld": pdata["beaconsHeld"],
            "wellsHeld": pdata["wellsHeld"],
            "totalUnits": pdata["totalUnits"],
            "hexesHeld": pdata["hexesHeld"],
            "energy": pdata["energy"],
            "ap": pdata["ap"],
            "pulseCooldown": pdata.get("pulseCooldown", 0),
        })
    return scores


# ============================================================================
# Deterministic Integer Tactical Bot Heuristic (100% Parity with engine.js)
# ============================================================================

def _move_tiebreak_key(move: Dict[str, Any]) -> Tuple[int, int, int, int, int]:
    order = {"PULSE": 5, "STRIKE": 4, "DEPLOY": 3, "SHIELD": 2, "END_TURN": 1}
    act = move["action"]
    if act in ("DEPLOY", "SHIELD"):
        return (order[act], -move["q"], -move["r"], 0, 0)
    if act == "STRIKE":
        return (order[act], -move["from_q"], -move["from_r"], -move["to_q"], -move["to_r"])
    return (order[act], 0, 0, 0, 0)


def score_tactical_move(state: Dict[str, Any], player: int, move: Dict[str, Any]) -> int:
    """Pure integer heuristic evaluation — identical between Python and JavaScript."""
    act = move["action"]
    if act == "END_TURN":
        return 0

    board = state["board"]
    pdata = state["players"][str(player)]

    # Leader detection (among opponents)
    max_opp_vp = 0
    leader_opp = 0
    for p in range(1, state["maxPlayers"] + 1):
        if p != player:
            ovp = state["players"][str(p)]["vp"]
            if ovp > max_opp_vp:
                max_opp_vp = ovp
                leader_opp = p

    if act == "PULSE":
        held_beacons = [
            (c["q"], c["r"])
            for c in board.values()
            if c["owner"] == player and c["terrain"] in ("NEXUS", "BEACON")
        ]
        held_beacons.sort()
        vp_gain = 3 * len(held_beacons)
        if pdata["vp"] + vp_gain >= TARGET_VP:
            return 1000000

        pushed = 0
        seen_scouts = set()
        for bq, br in held_beacons:
            for dq, dr in HEX_DIRECTIONS:
                nq, nr = bq + dq, br + dr
                if is_on_board(nq, nr) and (nq, nr) not in seen_scouts:
                    nc = board[hex_key(nq, nr)]
                    if nc["owner"] != 0 and nc["owner"] != player and nc["units"] == 1 and not nc["shielded"]:
                        seen_scouts.add((nq, nr))
                        pushed += 1

        score = vp_gain * 65 + pushed * 70 - 60
        if pdata["energy"] >= 6:
            score += 25
        if state["round"] >= 9:
            score += 40
        return score

    if act == "STRIKE":
        prev = preview_strike(state, player, move["from_q"], move["from_r"], move["to_q"], move["to_r"])
        if prev is None:
            return -10000
        target = board[hex_key(move["to_q"], move["to_r"])]
        terrain = target["terrain"]
        outcome = prev["outcome"]

        if outcome == "REPULSED":
            return -500
        if outcome == "TIE":
            if target["units"] == 1:
                if terrain == "NEXUS":
                    return 95
                if terrain == "BEACON":
                    return 70
                if terrain == "WELL":
                    return 50
            return -80

        # CAPTURE
        t_bonus = {"NEXUS": 290, "BEACON": 210, "WELL": 145, "SECTOR": 40}[terrain]
        leader_bonus = 55 if (target["owner"] == leader_opp and max_opp_vp >= 5) else 0
        # Check if holding this beacon at end of turn wins the game
        sim_passive = _passive_beacon_vp_for_player(state, player) + (
            2 if terrain == "NEXUS" else (1 if terrain == "BEACON" else 0)
        )
        if pdata["vp"] + sim_passive >= TARGET_VP:
            return 900000
        return 160 + t_bonus + leader_bonus + prev["advancingUnits"] * 20

    if act == "DEPLOY":
        q, r = move["q"], move["r"]
        cell = board[hex_key(q, r)]
        terrain = cell["terrain"]
        if cell["owner"] == 0:
            # EXPAND
            t_bonus = {"NEXUS": 350, "BEACON": 215, "WELL": 170, "SECTOR": 45}[terrain]
            if terrain == "WELL" and pdata["wellsHeld"] == 0:
                t_bonus += 55

            # Stepping-stone pull toward nearest unowned high-value objective
            best_pull = 0
            for oc in board.values():
                if oc["owner"] != player and oc["terrain"] in ("NEXUS", "BEACON", "WELL"):
                    d = hex_distance((q, r), (oc["q"], oc["r"]))
                    weight = 38 if oc["terrain"] == "NEXUS" else (30 if oc["terrain"] == "BEACON" else 22)
                    if oc["owner"] != 0:
                        weight += 8  # Actively push toward enemy-held objectives to contest!
                    pull = max(0, 4 - d) * weight
                    if pull > best_pull:
                        best_pull = pull

            # Flanking setup bonus around enemy objectives
            flank_setup = 0
            for nq, nr in get_neighbors(q, r):
                nc = board[hex_key(nq, nr)]
                if nc["owner"] != 0 and nc["owner"] != player:
                    flank_setup += 35 if nc["terrain"] in ("NEXUS", "BEACON", "WELL") else 12

            sim_passive = _passive_beacon_vp_for_player(state, player) + (
                2 if terrain == "NEXUS" else (1 if terrain == "BEACON" else 0)
            )
            if pdata["vp"] + sim_passive >= TARGET_VP:
                return 850000

            return t_bonus + best_pull + flank_setup
        else:
            # REINFORCE
            adj_enemies = [
                board[hex_key(nq, nr)]
                for nq, nr in get_neighbors(q, r)
                if board[hex_key(nq, nr)]["owner"] not in (0, player)
            ]
            score = -20
            if terrain in ("NEXUS", "BEACON", "WELL") and cell["units"] == 1:
                score = 95 if terrain in ("NEXUS", "BEACON") else 70
            if len(adj_enemies) > 0:
                # Reinforcing frontline hex to attack or hold
                best_front = 80
                if cell["units"] == 1:
                    best_front = 120
                for ec in adj_enemies:
                    # Check if +1 unit here unlocks a winning STRIKE right now (or threatens enemy objective)
                    flanks = 0
                    for nq2, nr2 in get_neighbors(ec["q"], ec["r"]):
                        if (nq2, nr2) != (q, r) and board[hex_key(nq2, nr2)]["owner"] == player:
                            flanks += 1
                    new_atk = (cell["units"] + 1) + flanks
                    ec_def = ec["units"] + (2 if ec["shielded"] else 0)
                    can_strike_now = pdata["ap"] >= 3 and pdata["energy"] >= 2
                    if new_atk > ec_def:
                        obj_val = {"NEXUS": 260, "BEACON": 180, "WELL": 135, "SECTOR": 45}[ec["terrain"]]
                        combo_score = (135 if can_strike_now else 75) + obj_val
                        if combo_score > best_front:
                            best_front = combo_score
                    elif ec["terrain"] in ("NEXUS", "BEACON", "WELL"):
                        best_front = max(best_front, 135)
                if best_front > score:
                    score = best_front
            return score

    if act == "SHIELD":
        q, r = move["q"], move["r"]
        cell = board[hex_key(q, r)]
        terrain = cell["terrain"]
        adj_enemies = [
            board[hex_key(nq, nr)]
            for nq, nr in get_neighbors(q, r)
            if board[hex_key(nq, nr)]["owner"] not in (0, player)
        ]
        if len(adj_enemies) == 0:
            return -100
        max_enemy_units = max(ec["units"] for ec in adj_enemies)
        threatened = max_enemy_units >= cell["units"]
        if terrain == "NEXUS":
            return 255 if threatened else 185
        if terrain == "BEACON":
            return 195 if threatened else 140
        if terrain == "WELL":
            return 135 if threatened else 75
        return 55 if (threatened and cell["units"] >= 3) else -40

    return -100


def choose_builtin_bot_move(state: Dict[str, Any], player: Optional[int] = None) -> Dict[str, Any]:
    act_p = state["activePlayer"] if player is None else player
    legal = get_legal_moves(state, act_p)
    if not legal:
        return {"action": "END_TURN"}

    best_move = legal[0]
    best_key = (-9999999, (0, 0, 0, 0, 0))
    for m in legal:
        s = score_tactical_move(state, act_p, m)
        cand = (s, _move_tiebreak_key(m))
        if cand > best_key:
            best_key = cand
            best_move = m
    return best_move


def run_Active_builtin_bots(state: Dict[str, Any], max_steps: int = 200) -> List[Dict[str, Any]]:
    """Automatically executes turns for any consecutive `builtin_bot` seats."""
    bot_logs: List[Dict[str, Any]] = []
    steps = 0
    while state["status"] == "ACTIVE" and steps < max_steps:
        act_p = state["activePlayer"]
        ptype = state["players"][str(act_p)]["type"]
        if ptype != "builtin_bot":
            break
        move = choose_builtin_bot_move(state, act_p)
        entry = apply_move(state, act_p, move)
        bot_logs.append(entry)
        steps += 1
    return bot_logs


# ============================================================================
# Deterministic Cloud Event-Stream State Machine (Shared Protocol v1)
# ============================================================================

class MatchSession:
    """
    Manages a complete match (state, move log, replay frames, and cloud event replay)
    identically for local REST API matches and serverless cloud-relayed matches.
    """

    def __init__(
        self,
        match_code: str,
        max_players: int = 2,
        creator_name: str = "Player 1",
        creator_type: str = "human",
        creator_client_id: str = "local_host",
        start_waiting: bool = False,
    ) -> None:
        self.match_code = match_code
        self.seat_tokens: Dict[int, str] = {1: creator_client_id}
        seats = {
            1: {
                "name": creator_name,
                "type": creator_type,
                "clientId": creator_client_id,
            }
        }
        init_status = "WAITING" if start_waiting else "ACTIVE"
        self.state = create_initial_state(
            max_players=max_players,
            match_code=match_code,
            seats=seats,
            status=init_status,
        )
        self.log: List[Dict[str, Any]] = []
        self.frames: List[Dict[str, Any]] = [copy.deepcopy(self.state)]

    def _record_frame(self, log_entry: Dict[str, Any]) -> None:
        self.log.append(log_entry)
        self.frames.append(copy.deepcopy(self.state))

    def check_auto_start(self) -> None:
        if self.state["status"] != "WAITING":
            return
        open_seats = [
            p
            for p in range(1, self.state["maxPlayers"] + 1)
            if self.state["players"][str(p)]["type"] == "open"
        ]
        if len(open_seats) == 0:
            self.state["status"] = "ACTIVE"
            _begin_player_turn(self.state, 1)
            self.frames = [copy.deepcopy(self.state)]
            bot_logs = run_Active_builtin_bots(self.state)
            for bl in bot_logs:
                self._record_frame(bl)

    def join_seat(
        self,
        name: str,
        player_type: str = "agent",
        client_id: str = "",
        preferred_seat: Optional[int] = None,
    ) -> Optional[int]:
        # Check if client_id already holds a seat
        if client_id:
            for p in range(1, self.state["maxPlayers"] + 1):
                if self.state["players"][str(p)].get("clientId") == client_id:
                    return p

        target_seat: Optional[int] = None
        if preferred_seat in range(1, self.state["maxPlayers"] + 1):
            if self.state["players"][str(preferred_seat)]["type"] == "open":
                target_seat = preferred_seat

        if target_seat is None:
            for p in range(1, self.state["maxPlayers"] + 1):
                if self.state["players"][str(p)]["type"] == "open":
                    target_seat = p
                    break

        if target_seat is None:
            return None

        pdata = self.state["players"][str(target_seat)]
        pdata["name"] = name or PLAYER_META[target_seat]["name"]
        pdata["type"] = player_type
        pdata["clientId"] = client_id
        self.seat_tokens[target_seat] = client_id
        self.check_auto_start()
        return target_seat

    def fill_bots(self) -> List[int]:
        filled: List[int] = []
        bot_names = {
            1: "Bot-Cyan",
            2: "Bot-Amber",
            3: "Bot-Emerald",
            4: "Bot-Coral",
        }
        for p in range(1, self.state["maxPlayers"] + 1):
            pdata = self.state["players"][str(p)]
            if pdata["type"] == "open":
                pdata["type"] = "builtin_bot"
                pdata["name"] = bot_names[p]
                pdata["clientId"] = f"builtin_bot_{p}"
                filled.append(p)

        if self.state["status"] == "WAITING":
            self.check_auto_start()
        elif self.state["status"] == "ACTIVE":
            bot_logs = run_Active_builtin_bots(self.state)
            for bl in bot_logs:
                self._record_frame(bl)
        return filled

    def submit_move(self, player: int, raw_move: Dict[str, Any]) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        entry = apply_move(self.state, player, raw_move)
        self._record_frame(entry)
        bot_entries: List[Dict[str, Any]] = []
        if self.state["status"] == "ACTIVE":
            while self.state["status"] == "ACTIVE":
                act_p = self.state["activePlayer"]
                if self.state["players"][str(act_p)]["type"] != "builtin_bot":
                    break
                bmove = choose_builtin_bot_move(self.state, act_p)
                bentry = apply_move(self.state, act_p, bmove)
                self._record_frame(bentry)
                bot_entries.append(bentry)
        return entry, bot_entries

    def apply_cloud_event(self, evt: Dict[str, Any]) -> bool:
        """Deterministically applies a cloud event from ntfy.sh stream. Returns True if state mutated."""
        etype = evt.get("type")
        if etype == "JOIN":
            seat = self.join_seat(
                name=str(evt.get("name", "Remote Agent"))[:28],
                player_type=str(evt.get("playerType", "agent")),
                client_id=str(evt.get("clientId", "")),
                preferred_seat=evt.get("preferredSeat"),
            )
            return seat is not None
        if etype == "FILL_BOTS":
            filled = self.fill_bots()
            return len(filled) > 0
        if etype == "MOVE":
            if self.state["status"] != "ACTIVE":
                return False
            expected_seq = evt.get("seq")
            if expected_seq is not None and int(expected_seq) != self.state["seq"]:
                return False
            player = int(evt.get("player", 0))
            if player != self.state["activePlayer"]:
                return False
            seat_cid = self.state["players"][str(player)].get("clientId")
            evt_cid = evt.get("clientId")
            if seat_cid and evt_cid and seat_cid != evt_cid:
                return False
            raw_move = evt.get("move")
            if not isinstance(raw_move, dict):
                return False
            ok, _, _ = validate_move(self.state, player, raw_move)
            if not ok:
                return False
            self.submit_move(player, raw_move)
            return True
        return False

    def to_api_response(self) -> Dict[str, Any]:
        return {
            "matchCode": self.match_code,
            "state": self.state,
            "legalMoves": get_legal_moves(self.state),
            "scores": get_scores_summary(self.state),
            "winner": self.state["winner"],
            "winReason": self.state["winReason"],
            "log": self.log[-50:],
            "totalMoves": len(self.log),
        }

    def to_replay_dict(self) -> Dict[str, Any]:
        return {
            "game": "Beacon Wars",
            "version": "1.0",
            "matchCode": self.match_code,
            "maxPlayers": self.state["maxPlayers"],
            "winner": self.state["winner"],
            "winReason": self.state["winReason"],
            "finalScores": get_scores_summary(self.state),
            "moves": self.log,
            "frames": self.frames,
        }


def reconstruct_cloud_session(match_code: str, events: List[Dict[str, Any]]) -> Optional[MatchSession]:
    """Rebuilds exact deterministic MatchSession from an ordered list of cloud JSON events."""
    session: Optional[MatchSession] = None
    for evt in events:
        if not isinstance(evt, dict):
            continue
        if evt.get("type") == "CREATE" and session is None:
            mp = int(evt.get("maxPlayers", 2))
            if mp not in (2, 3, 4):
                mp = 2
            session = MatchSession(
                match_code=match_code,
                max_players=mp,
                creator_name=str(evt.get("name", "Commander"))[:28],
                creator_type=str(evt.get("playerType", "human")),
                creator_client_id=str(evt.get("clientId", "host")),
                start_waiting=True,
            )
        elif session is not None:
            session.apply_cloud_event(evt)
    return session
