#!/usr/bin/env python3
"""
Beacon Wars — Automated Test Suite (Rules, Geometry, 2–4P Matches, JS/Python Parity, & HTTP/JSON API)

Run:
  python test_game.py
"""

from __future__ import annotations
import json
import os
import shutil
import subprocess
import threading
import unittest
import urllib.error
import urllib.request

import game_engine as ge
import sample_bot as sb
import server as srv

REPO_DIR = os.path.dirname(os.path.abspath(__file__))


class TestBeaconWarsEngine(unittest.TestCase):
    def test_board_geometry_and_symmetry(self) -> None:
        state = ge.create_initial_state(max_players=4)
        board = state["board"]
        self.assertEqual(len(board), 37, "Radius-3 axial hex board must have exactly 37 hexes")

        terrains = [c["terrain"] for c in board.values()]
        self.assertEqual(terrains.count("NEXUS"), 1)
        self.assertEqual(terrains.count("BEACON"), 4)
        self.assertEqual(terrains.count("WELL"), 6)
        self.assertEqual(terrains.count("SECTOR"), 26)

        # Verify Klein four-group mathematical symmetry across all 4 spawns
        beacons = [ge.CENTRAL_NEXUS] + ge.OUTER_BEACONS
        expected_beacon_dists = None
        expected_well_dists = None
        for p in range(1, 5):
            sp = ge.PLAYER_SPAWNS[p]
            b_dists = sorted(ge.hex_distance(sp, b) for b in beacons)
            w_dists = sorted(ge.hex_distance(sp, w) for w in ge.ENERGY_WELLS)
            if expected_beacon_dists is None:
                expected_beacon_dists = b_dists
                expected_well_dists = w_dists
            else:
                self.assertEqual(b_dists, expected_beacon_dists)
                self.assertEqual(w_dists, expected_well_dists)

    def test_deploy_reinforce_expand_and_orbital_recovery(self) -> None:
        state = ge.create_initial_state(max_players=2)
        # P1 starts at (-3,0) with 2 units, 3 AP, 2 Energy (1 base + 1 income)
        p1 = state["players"]["1"]
        self.assertEqual(p1["ap"], 3)
        self.assertEqual(p1["energy"], 2)

        # Expand to adjacent Outer Beacon (-2, 0)
        ge.apply_move(state, 1, {"action": "DEPLOY", "q": -2, "r": 0})
        self.assertEqual(state["board"]["-2,0"]["owner"], 1)
        self.assertEqual(state["board"]["-2,0"]["units"], 1)

        # Illegal deploy to distant non-adjacent hex (2, 0)
        ok, _, _ = ge.validate_move(state, 1, {"action": "DEPLOY", "q": 2, "r": 0})
        self.assertFalse(ok)

        # Max 4 units cap check
        p1["ap"] = 5
        p1["energy"] = 5
        state["board"]["-3,0"]["units"] = 4
        ok_cap, _, _ = ge.validate_move(state, 1, {"action": "DEPLOY", "q": -3, "r": 0})
        self.assertFalse(ok_cap)

        # Orbital Recovery if player has 0 hexes
        for c in state["board"].values():
            if c["owner"] == 1:
                c["owner"] = 0
                c["units"] = 0
        legal = ge.get_legal_moves(state, 1)
        orbital_moves = [m for m in legal if m["action"] == "DEPLOY" and m.get("mode") == "ORBITAL"]
        self.assertTrue(len(orbital_moves) > 0)

    def test_strike_flanking_capture_tie_and_repulse(self) -> None:
        state = ge.create_initial_state(max_players=2)
        board = state["board"]
        state["players"]["1"]["ap"] = 6
        state["players"]["1"]["energy"] = 6

        # Setup enemy at (0,0) with 2 units
        board["0,0"]["owner"] = 2
        board["0,0"]["units"] = 2

        # Attacker at (-1,0) with 2 units + 1 flanking ally at (0,-1) -> Atk = 2 + 1 = 3 vs Def = 2 -> CAPTURE!
        board["-1,0"]["owner"] = 1
        board["-1,0"]["units"] = 2
        board["0,-1"]["owner"] = 1
        board["0,-1"]["units"] = 1

        prev = ge.preview_strike(state, 1, -1, 0, 0, 0)
        self.assertIsNotNone(prev)
        assert prev is not None
        self.assertEqual(prev["attackPower"], 3)
        self.assertEqual(prev["defensePower"], 2)
        self.assertEqual(prev["outcome"], "CAPTURE")

        ge.apply_move(state, 1, {"action": "STRIKE", "from_q": -1, "from_r": 0, "to_q": 0, "to_r": 0})
        self.assertEqual(board["0,0"]["owner"], 1)
        self.assertEqual(board["0,0"]["units"], 1)
        self.assertEqual(board["-1,0"]["units"], 1)

        # Test TIE clearing a 1-unit defender when Atk 2 == Def 1? Wait: Atk 2 vs Def 2 (1 unit? No, 2 units -> 1 left; 2 Atk vs 0? If shielded: 1u + 2 shield = 3 Def vs 3 Atk -> TIE clears 1u defender!)
        board["1,0"]["owner"] = 2
        board["1,0"]["units"] = 1
        board["1,0"]["shielded"] = True  # Def = 1 + 2 = 3
        board["0,0"]["units"] = 2        # + flank from (0,-1)? (0,-1) is dist 2 from (1,0); add flank at (1,-1)
        board["1,-1"]["owner"] = 1
        board["1,-1"]["units"] = 1       # Atk = 2 + 1 = 3 == Def 3 -> TIE!
        ge.apply_move(state, 1, {"action": "STRIKE", "from": "0,0", "to": "1,0"})
        self.assertEqual(board["1,0"]["owner"], 0)
        self.assertEqual(board["1,0"]["units"], 0)
        self.assertFalse(board["1,0"]["shielded"])

        # Test REPULSED (Atk 2 < Def 4)
        state["players"]["1"]["ap"] = 3
        board["0,1"]["owner"] = 2
        board["0,1"]["units"] = 4
        board["0,0"]["units"] = 2
        ge.apply_move(state, 1, {"action": "STRIKE", "from_q": 0, "from_r": 0, "to_q": 0, "to_r": 1})
        self.assertEqual(board["0,0"]["units"], 1)
        self.assertEqual(board["0,1"]["owner"], 2)
        self.assertEqual(board["0,1"]["units"], 4)

    def test_shield_duration_and_pulse_pushback(self) -> None:
        state = ge.create_initial_state(max_players=2)
        board = state["board"]
        p1 = state["players"]["1"]
        p1["ap"] = 3
        p1["energy"] = 8

        # P1 holds Central Nexus (0,0)
        board["0,0"]["owner"] = 1
        board["0,0"]["units"] = 2
        # Unshielded enemy 1-unit scout at (1,0) -> should be pushed to (2,0)!
        board["1,0"]["owner"] = 2
        board["1,0"]["units"] = 1
        # Shielded enemy 1-unit scout at (0,1) -> should NOT be pushed!
        board["0,1"]["owner"] = 2
        board["0,1"]["units"] = 1
        board["0,1"]["shielded"] = True

        # Shield (0,0) (1 AP, 2 Energy) + Pulse (2 AP, 4 Energy)
        ge.apply_move(state, 1, {"action": "SHIELD", "q": 0, "r": 0})
        self.assertTrue(board["0,0"]["shielded"])

        entry = ge.apply_move(state, 1, {"action": "PULSE"})
        self.assertEqual(entry["vpGain"], 3)
        self.assertEqual(entry["pushedScouts"], 1)
        self.assertEqual(board["1,0"]["owner"], 0)
        self.assertEqual(board["2,0"]["owner"], 2)
        self.assertEqual(board["2,0"]["units"], 1)
        self.assertEqual(board["0,1"]["owner"], 2, "Shielded scout must resist Pulse pushback")

        # End P1 turn (+2 Nexus VP -> 5 VP total) -> P2 turn -> End P2 turn -> P1's shield expires!
        ge.apply_move(state, 1, {"action": "END_TURN"})
        self.assertEqual(state["players"]["1"]["vp"], 5)
        self.assertTrue(board["0,0"]["shielded"], "Shield must stay active during opponent's turn")

        # P1 cannot Pulse on immediate next turn (1-turn recharge)
        ge.apply_move(state, 2, {"action": "END_TURN"})
        self.assertFalse(board["0,0"]["shielded"], "Shield must expire at start of owner's next turn")
        self.assertEqual(state["players"]["1"]["pulseCooldown"], 1)
        p1["energy"] = 8
        ok_pulse, _, _ = ge.validate_move(state, 1, {"action": "PULSE"})
        self.assertFalse(ok_pulse, "Pulse must require 1 turn to recharge")

    def test_2p_3p_4p_bot_matches_complete_cleanly(self) -> None:
        for mp in (2, 3, 4):
            sess = ge.MatchSession(
                match_code=f"AUTO{mp}P",
                max_players=mp,
                creator_name="Bot-1",
                creator_type="builtin_bot",
                start_waiting=True,
            )
            sess.fill_bots()
            self.assertEqual(sess.state["status"], "FINISHED")
            self.assertIn(sess.state["winner"], range(1, mp + 1))
            self.assertLessEqual(sess.state["round"], ge.MAX_ROUNDS)
            self.assertGreater(len(sess.log), 10)

    def test_round_limit_tiebreaker(self) -> None:
        state = ge.create_initial_state(max_players=2)
        # Fast-forward passive end-turns through all 12 rounds
        while state["status"] == "ACTIVE":
            ge.apply_move(state, state["activePlayer"], {"action": "END_TURN"})
        self.assertEqual(state["status"], "FINISHED")
        self.assertIsNotNone(state["winner"])

    def test_js_and_python_engine_bit_for_bit_parity(self) -> None:
        if not shutil.which("node"):
            self.skipTest("Node.js not installed; skipping cross-language parity check")

        py_results = {}
        for mp in (2, 3, 4):
            s = ge.MatchSession(
                match_code=f"PAR{mp}P",
                max_players=mp,
                creator_name="Bot-Cyan",
                creator_type="builtin_bot",
                creator_client_id="builtin_bot_1",
                start_waiting=True,
            )
            s.fill_bots()
            py_results[str(mp)] = {"state": s.state, "moves": len(s.log)}

        engine_js_path = os.path.join(REPO_DIR, "engine.js").replace("\\", "/")
        js_snippet = f"""
        const fs = require('fs'), vm = require('vm');
        const mod = {{ exports: {{}} }};
        vm.runInNewContext(fs.readFileSync('{engine_js_path}', 'utf8'), {{ module: mod, exports: mod.exports }});
        const eng = mod.exports;
        const out = {{}};
        for (const mp of [2, 3, 4]) {{
          const s = new eng.MatchSession({{
            matchCode: `PAR${{mp}}P`,
            maxPlayers: mp,
            creatorName: 'Bot-Cyan',
            creatorType: 'builtin_bot',
            creatorClientId: 'builtin_bot_1',
            startWaiting: true
          }});
          s.fillBots();
          out[String(mp)] = {{ state: s.state, moves: s.log.length }};
        }}
        console.log(JSON.stringify(out));
        """
        raw = subprocess.check_output(["node", "-e", js_snippet], text=True)
        js_results = json.loads(raw)
        self.assertEqual(py_results, js_results)


class TestBeaconWarsHttpApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = srv.run_server(host="127.0.0.1", port=0, bridge=False, quiet=True)
        cls.port = cls.httpd.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _req(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict, dict]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if data is not None else {}
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.status, dict(resp.headers), json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers), json.loads(err.read().decode("utf-8"))

    def test_static_browser_ui_and_cors(self) -> None:
        with urllib.request.urlopen(f"{self.base_url}/", timeout=5) as resp:
            html = resp.read().decode("utf-8")
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Access-Control-Allow-Origin"), "*")
            self.assertIn("BEACON WARS", html)

    def test_match_lifecycle_and_validation_endpoints(self) -> None:
        # 1. Create 3P match
        code_status, _, created = self._req("POST", "/api/matches", {
            "maxPlayers": 3,
            "playerName": "HumanHost",
            "playerType": "human",
        })
        self.assertEqual(code_status, 201)
        match_code = created["matchCode"]
        p1_token = created["playerToken"]
        self.assertEqual(created["state"]["status"], "WAITING")

        # 2. Agent joins Seat 2
        j_status, _, joined = self._req("POST", f"/api/matches/{match_code}/join", {
            "playerName": "AgentTwo",
            "playerType": "agent",
        })
        self.assertEqual(j_status, 200)
        self.assertEqual(joined["player"], 2)
        p2_token = joined["playerToken"]

        # 3. Fill Seat 3 with built-in bot -> match auto-starts!
        f_status, _, filled = self._req("POST", f"/api/matches/{match_code}/fill-bots", {})
        self.assertEqual(f_status, 200)
        self.assertEqual(filled["filledSeats"], [3])
        self.assertEqual(filled["state"]["status"], "ACTIVE")

        # 4. Out-of-turn move by Player 2 is rejected with HTTP 400
        bad_status, _, bad_res = self._req("POST", f"/api/matches/{match_code}/move", {
            "player": 2,
            "playerToken": p2_token,
            "action": "END_TURN",
        })
        self.assertEqual(bad_status, 400)
        self.assertFalse(bad_res["ok"])

        # 5. Valid DEPLOY + END_TURN by Player 1
        m1_status, _, m1_res = self._req("POST", f"/api/matches/{match_code}/move", {
            "player": 1,
            "playerToken": p1_token,
            "action": "DEPLOY",
            "q": -2,
            "r": 0,
        })
        self.assertEqual(m1_status, 200)
        self.assertTrue(m1_res["ok"])

        m2_status, _, m2_res = self._req("POST", f"/api/matches/{match_code}/move", {
            "player": 1,
            "playerToken": p1_token,
            "action": "END_TURN",
        })
        self.assertEqual(m2_status, 200)
        self.assertEqual(m2_res["state"]["activePlayer"], 2)

        # 6. Player 2 ends turn -> Seat 3 (built-in bot) auto-plays its entire turn and hands back to Player 1!
        m3_status, _, m3_res = self._req("POST", f"/api/matches/{match_code}/move", {
            "player": 2,
            "playerToken": p2_token,
            "action": "END_TURN",
        })
        self.assertEqual(m3_status, 200)
        self.assertTrue(len(m3_res["botMoves"]) >= 1)
        self.assertEqual(m3_res["state"]["activePlayer"], 1)
        self.assertEqual(m3_res["state"]["round"], 2)

        # 7. Replay endpoint returns all frames
        r_status, _, rep = self._req("GET", f"/api/matches/{match_code}/replay")
        self.assertEqual(r_status, 200)
        self.assertEqual(len(rep["frames"]), len(rep["moves"]) + 1)

    def test_sample_bot_completes_full_match_over_http(self) -> None:
        final_snap = sb.play_rest_api_match(
            server_url=self.base_url,
            match_code=None,
            bot_name="TestBot",
            max_players=2,
            fill_bots=True,
            strategy="aggressive",
            move_delay=0.0,
        )
        self.assertEqual(final_snap["state"]["status"], "FINISHED")
        self.assertIn(final_snap["winner"], (1, 2))


if __name__ == "__main__":
    unittest.main(verbosity=2)
