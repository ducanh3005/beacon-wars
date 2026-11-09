/**
 * Beacon Wars — Core Deterministic Hex Strategy Engine (Universal JS, Zero Dependencies)
 * Exact 1-to-1 deterministic parity with game_engine.py for Browser UI & Cloud Relay.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BeaconEngine = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const BOARD_RADIUS = 3;
  const MAX_ROUNDS = 12;
  const TARGET_VP = 25;
  const MAX_UNITS_PER_HEX = 4;
  const MAX_ENERGY = 10;
  const BASE_AP = 3;
  const BASE_ENERGY_INCOME = 1;
  const WELL_ENERGY_BONUS = 2;

  const HEX_DIRECTIONS = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ];

  const CENTRAL_NEXUS = [0, 0];
  const OUTER_BEACONS = [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
  ];
  const ENERGY_WELLS = [
    [-2, 1],
    [-1, 2],
    [1, -2],
    [2, -1],
    [-1, -1],
    [1, 1],
  ];

  const PLAYER_SPAWNS = {
    1: [-3, 0],
    2: [3, 0],
    3: [0, -3],
    4: [0, 3],
  };

  const PLAYER_META = {
    1: { name: "P1 Cyan", color: "#22d3ee", faction: "Azure Vanguard" },
    2: { name: "P2 Amber", color: "#fbbf24", faction: "Solaris Syndicate" },
    3: { name: "P3 Emerald", color: "#34d399", faction: "Verdant Collective" },
    4: { name: "P4 Coral", color: "#fb7185", faction: "Crimson Horizon" },
  };

  const ACTION_COSTS = {
    DEPLOY: [1, 1],
    STRIKE: [2, 1],
    SHIELD: [1, 2],
    PULSE: [2, 4],
    END_TURN: [0, 0],
  };

  function hexKey(q, r) {
    return `${q},${r}`;
  }

  function parseHexKey(key) {
    const parts = String(key).split(",");
    return [parseInt(parts[0].trim(), 10), parseInt(parts[1].trim(), 10)];
  }

  function hexDistance(a, b) {
    const dq = a[0] - b[0];
    const dr = a[1] - b[1];
    const ds = (-a[0] - a[1]) - (-b[0] - b[1]);
    return Math.floor((Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2);
  }

  function isOnBoard(q, r) {
    return Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r)) <= BOARD_RADIUS;
  }

  function allBoardCoords() {
    const coords = [];
    for (let q = -BOARD_RADIUS; q <= BOARD_RADIUS; q++) {
      for (let r = -BOARD_RADIUS; r <= BOARD_RADIUS; r++) {
        if (isOnBoard(q, r)) {
          coords.push([q, r]);
        }
      }
    }
    return coords;
  }

  function getNeighbors(q, r) {
    const out = [];
    for (let i = 0; i < HEX_DIRECTIONS.length; i++) {
      const nq = q + HEX_DIRECTIONS[i][0];
      const nr = r + HEX_DIRECTIONS[i][1];
      if (isOnBoard(nq, nr)) {
        out.push([nq, nr]);
      }
    }
    return out;
  }

  function terrainAt(q, r) {
    if (q === CENTRAL_NEXUS[0] && r === CENTRAL_NEXUS[1]) return "NEXUS";
    for (const [bq, br] of OUTER_BEACONS) {
      if (q === bq && r === br) return "BEACON";
    }
    for (const [wq, wr] of ENERGY_WELLS) {
      if (q === wq && r === wr) return "WELL";
    }
    return "SECTOR";
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function compareTuples(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    }
    return a.length - b.length;
  }

  function recomputePlayerCounts(state) {
    for (const pStr of Object.keys(state.players)) {
      const pdata = state.players[pStr];
      pdata.beaconsHeld = 0;
      pdata.wellsHeld = 0;
      pdata.totalUnits = 0;
      pdata.hexesHeld = 0;
    }
    for (const cell of Object.values(state.board)) {
      if (cell.owner > 0) {
        const pdata = state.players[String(cell.owner)];
        pdata.hexesHeld += 1;
        pdata.totalUnits += cell.units;
        if (cell.terrain === "NEXUS" || cell.terrain === "BEACON") {
          pdata.beaconsHeld += 1;
        } else if (cell.terrain === "WELL") {
          pdata.wellsHeld += 1;
        }
      }
    }
  }

  function beginPlayerTurn(state, player) {
    for (const cell of Object.values(state.board)) {
      if (cell.owner === player && cell.shielded) {
        cell.shielded = false;
      }
    }
    recomputePlayerCounts(state);
    const pdata = state.players[String(player)];
    if ((pdata.pulseCooldown || 0) > 0) {
      pdata.pulseCooldown -= 1;
    }
    let income = BASE_ENERGY_INCOME + pdata.wellsHeld * WELL_ENERGY_BONUS;
    pdata.energy = Math.min(MAX_ENERGY, pdata.energy + income);
    pdata.ap = BASE_AP;
    state.activePlayer = player;
  }

  function createInitialState(maxPlayers = 2, matchCode = "LOCAL", seats = null, status = "ACTIVE") {
    if (![2, 3, 4].includes(maxPlayers)) {
      throw new Error("maxPlayers must be 2, 3, or 4");
    }
    const board = {};
    for (const [q, r] of allBoardCoords()) {
      const k = hexKey(q, r);
      board[k] = {
        key: k,
        q,
        r,
        terrain: terrainAt(q, r),
        owner: 0,
        units: 0,
        shielded: false,
      };
    }

    const players = {};
    for (let p = 1; p <= maxPlayers; p++) {
      const [sq, sr] = PLAYER_SPAWNS[p];
      const sk = hexKey(sq, sr);
      board[sk].owner = p;
      board[sk].units = 2;

      const seatInfo = (seats && seats[p]) || {};
      const meta = PLAYER_META[p];
      players[String(p)] = {
        id: p,
        name: seatInfo.name || meta.name,
        color: meta.color,
        faction: meta.faction,
        type: seatInfo.type || "open",
        clientId: seatInfo.clientId === undefined ? null : seatInfo.clientId,
        vp: 0,
        ap: 0,
        energy: p === 1 ? 1 : p === 4 ? 3 : 2,
        pulseCooldown: 0,
        beaconsHeld: 0,
        wellsHeld: 0,
        totalUnits: 2,
        hexesHeld: 1,
      };
    }

    const state = {
      matchCode,
      status,
      maxPlayers,
      round: 1,
      maxRounds: MAX_ROUNDS,
      targetVp: TARGET_VP,
      activePlayer: 1,
      winner: null,
      winReason: null,
      seq: 0,
      turnNumber: 1,
      players,
      board,
      lastMove: null,
    };

    recomputePlayerCounts(state);
    if (status === "ACTIVE") {
      beginPlayerTurn(state, 1);
    }
    return state;
  }

  function previewStrike(state, player, fromQ, fromR, toQ, toR) {
    const fk = hexKey(fromQ, fromR);
    const tk = hexKey(toQ, toR);
    const board = state.board;
    if (!board[fk] || !board[tk]) return null;
    const origin = board[fk];
    const target = board[tk];
    if (origin.owner !== player || origin.units < 2) return null;
    if (target.owner === 0 || target.owner === player) return null;
    if (hexDistance([fromQ, fromR], [toQ, toR]) !== 1) return null;

    let flankCount = 0;
    for (const [nq, nr] of getNeighbors(toQ, toR)) {
      if (nq === fromQ && nr === fromR) continue;
      if (board[hexKey(nq, nr)].owner === player) {
        flankCount += 1;
      }
    }

    const attackPower = origin.units + flankCount;
    const shieldBonus = target.shielded ? 2 : 0;
    const defensePower = target.units + shieldBonus;

    let outcome = "REPULSED";
    let advancingUnits = 0;
    if (attackPower > defensePower) {
      outcome = "CAPTURE";
      advancingUnits = Math.max(1, origin.units - 1);
    } else if (attackPower === defensePower) {
      outcome = "TIE";
    }

    return {
      from: fk,
      to: tk,
      attackerUnits: origin.units,
      flankBonus: flankCount,
      attackPower,
      defenderOwner: target.owner,
      defenderUnits: target.units,
      shieldBonus,
      defensePower,
      outcome,
      advancingUnits,
    };
  }

  function getLegalMoves(state, player = null) {
    if (state.status !== "ACTIVE") return [];
    const actP = state.activePlayer;
    if (player !== null && player !== actP) return [];

    const pdata = state.players[String(actP)];
    const ap = pdata.ap;
    const energy = pdata.energy;
    const board = state.board;
    const moves = [];

    const ownedCells = Object.values(board).filter((c) => c.owner === actP);

    // 1. DEPLOY
    if (ap >= 1 && energy >= 1) {
      const deployTargets = [];
      if (ownedCells.length === 0) {
        for (const [q, r] of allBoardCoords()) {
          if (hexDistance([0, 0], [q, r]) === BOARD_RADIUS && board[hexKey(q, r)].owner === 0) {
            deployTargets.push([q, r, "ORBITAL"]);
          }
        }
      } else {
        const seenExpand = new Set();
        for (const c of ownedCells) {
          if (c.units < MAX_UNITS_PER_HEX) {
            deployTargets.push([c.q, c.r, "REINFORCE"]);
          }
          for (const [nq, nr] of getNeighbors(c.q, c.r)) {
            const nk = hexKey(nq, nr);
            if (!seenExpand.has(nk) && board[nk].owner === 0) {
              seenExpand.add(nk);
              deployTargets.push([nq, nr, "EXPAND"]);
            }
          }
        }
      }
      deployTargets.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
      for (const [q, r, mode] of deployTargets) {
        moves.push({ action: "DEPLOY", q, r, mode });
      }
    }

    // 2. STRIKE
    if (ap >= 2 && energy >= 1) {
      const strikeList = [];
      for (const c of ownedCells) {
        if (c.units < 2) continue;
        for (const [tq, tr] of getNeighbors(c.q, c.r)) {
          const tcell = board[hexKey(tq, tr)];
          if (tcell.owner !== 0 && tcell.owner !== actP) {
            const prev = previewStrike(state, actP, c.q, c.r, tq, tr);
            if (prev) {
              strikeList.push([c.q, c.r, tq, tr, prev]);
            }
          }
        }
      }
      strikeList.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]) || (a[3] - b[3]));
      for (const [fq, fr, tq, tr, prev] of strikeList) {
        moves.push({
          action: "STRIKE",
          from_q: fq,
          from_r: fr,
          to_q: tq,
          to_r: tr,
          outcome: prev.outcome,
          attackPower: prev.attackPower,
          defensePower: prev.defensePower,
        });
      }
    }

    // 3. SHIELD
    if (ap >= 1 && energy >= 2) {
      const shieldTargets = ownedCells
        .filter((c) => !c.shielded)
        .map((c) => [c.q, c.r]);
      shieldTargets.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
      for (const [q, r] of shieldTargets) {
        moves.push({ action: "SHIELD", q, r });
      }
    }

    // 4. PULSE
    if (ap >= 2 && energy >= 4 && (pdata.pulseCooldown || 0) === 0) {
      const beaconsHeld = ownedCells.filter((c) => c.terrain === "NEXUS" || c.terrain === "BEACON");
      if (beaconsHeld.length > 0) {
        moves.push({
          action: "PULSE",
          beacons: beaconsHeld.length,
          vpGain: 3 * beaconsHeld.length,
        });
      }
    }

    // 5. END_TURN
    moves.push({ action: "END_TURN" });
    return moves;
  }

  function normalizeMoveInput(rawMove) {
    if (!rawMove || typeof rawMove !== "object") {
      throw new Error("Move must be a JSON object");
    }
    const action = String(rawMove.action || "").toUpperCase().trim();
    const out = { action };

    if (action === "DEPLOY" || action === "SHIELD") {
      if (rawMove.q !== undefined && rawMove.r !== undefined) {
        out.q = parseInt(rawMove.q, 10);
        out.r = parseInt(rawMove.r, 10);
      } else if (rawMove.target !== undefined) {
        const [q, r] = parseHexKey(rawMove.target);
        out.q = q;
        out.r = r;
      } else {
        throw new Error(`${action} requires integer 'q' and 'r'`);
      }
    } else if (action === "STRIKE") {
      if (
        rawMove.from_q !== undefined &&
        rawMove.from_r !== undefined &&
        rawMove.to_q !== undefined &&
        rawMove.to_r !== undefined
      ) {
        out.from_q = parseInt(rawMove.from_q, 10);
        out.from_r = parseInt(rawMove.from_r, 10);
        out.to_q = parseInt(rawMove.to_q, 10);
        out.to_r = parseInt(rawMove.to_r, 10);
      } else if (rawMove.from !== undefined && rawMove.to !== undefined) {
        const [fq, fr] = parseHexKey(rawMove.from);
        const [tq, tr] = parseHexKey(rawMove.to);
        out.from_q = fq;
        out.from_r = fr;
        out.to_q = tq;
        out.to_r = tr;
      } else {
        throw new Error("STRIKE requires 'from_q','from_r','to_q','to_r'");
      }
    } else if (action !== "PULSE" && action !== "END_TURN") {
      throw new Error(`Unknown action '${action}'`);
    }
    return out;
  }

  function validateMove(state, player, rawMove) {
    if (state.status !== "ACTIVE") {
      return [false, `Match is not active (current status: ${state.status})`, null];
    }
    if (player !== state.activePlayer) {
      return [false, `It is Player ${state.activePlayer}'s turn, not Player ${player}`, null];
    }
    let norm;
    try {
      norm = normalizeMoveInput(rawMove);
    } catch (err) {
      return [false, err.message, null];
    }

    const legal = getLegalMoves(state, player);
    const action = norm.action;
    for (const lm of legal) {
      if (lm.action !== action) continue;
      if (action === "DEPLOY" || action === "SHIELD") {
        if (lm.q === norm.q && lm.r === norm.r) return [true, "OK", lm];
      } else if (action === "STRIKE") {
        if (
          lm.from_q === norm.from_q &&
          lm.from_r === norm.from_r &&
          lm.to_q === norm.to_q &&
          lm.to_r === norm.to_r
        ) {
          return [true, "OK", lm];
        }
      } else {
        return [true, "OK", lm];
      }
    }

    const pdata = state.players[String(player)];
    const [apCost, enCost] = ACTION_COSTS[action] || [0, 0];
    if (pdata.ap < apCost) {
      return [false, `Insufficient AP for ${action} (need ${apCost}, have ${pdata.ap})`, null];
    }
    if (pdata.energy < enCost) {
      return [false, `Insufficient Energy for ${action} (need ${enCost}, have ${pdata.energy})`, null];
    }
    if (action === "PULSE" && (pdata.pulseCooldown || 0) > 0) {
      return [false, "PULSE is recharging (1-turn cooldown after overcharging Beacons)", null];
    }
    return [false, `Illegal ${action} target or precondition failed`, null];
  }

  function passiveBeaconVpForPlayer(state, player) {
    let vp = 0;
    for (const cell of Object.values(state.board)) {
      if (cell.owner === player) {
        if (cell.terrain === "NEXUS") vp += 2;
        else if (cell.terrain === "BEACON") vp += 1;
      }
    }
    return vp;
  }

  function resolveRoundLimitWinner(state) {
    recomputePlayerCounts(state);
    let bestPlayer = 1;
    let bestTuple = [-1, -1, -1, -1, -1];
    for (let p = 1; p <= state.maxPlayers; p++) {
      const pdata = state.players[String(p)];
      const cand = [pdata.vp, pdata.beaconsHeld, pdata.totalUnits, pdata.energy, p];
      if (compareTuples(cand, bestTuple) > 0) {
        bestTuple = cand;
        bestPlayer = p;
      }
    }
    const w = state.players[String(bestPlayer)];
    const reason = `${w.name} wins after Round ${MAX_ROUNDS} with ${w.vp} VP (${w.beaconsHeld} Beacons, ${w.totalUnits} Units)!`;
    return [bestPlayer, reason];
  }

  function applyMove(state, player, rawMove) {
    const [ok, msg, canonical] = validateMove(state, player, rawMove);
    if (!ok || !canonical) {
      throw new Error(msg);
    }

    const action = canonical.action;
    const pdata = state.players[String(player)];
    const pname = pdata.name;
    const [apCost, enCost] = ACTION_COSTS[action];
    pdata.ap -= apCost;
    pdata.energy -= enCost;

    const board = state.board;
    let summary = "";
    const details = { action, player, round: state.round };

    if (action === "DEPLOY") {
      const { q, r } = canonical;
      const cell = board[hexKey(q, r)];
      if (cell.owner === player) {
        cell.units += 1;
        summary = `${pname} deployed +1 unit on (${q},${r}) [${cell.units} units]`;
        Object.assign(details, { q, r, mode: "REINFORCE", units: cell.units });
      } else {
        cell.owner = player;
        cell.units = 1;
        cell.shielded = false;
        const tLabel = cell.terrain !== "SECTOR" ? ` [${cell.terrain}]` : "";
        summary = `${pname} claimed (${q},${r})${tLabel}`;
        Object.assign(details, { q, r, mode: "EXPAND", terrain: cell.terrain });
      }
    } else if (action === "STRIKE") {
      const { from_q: fq, from_r: fr, to_q: tq, to_r: tr } = canonical;
      const prev = previewStrike(state, player, fq, fr, tq, tr);
      const origin = board[hexKey(fq, fr)];
      const target = board[hexKey(tq, tr)];
      const outcome = prev.outcome;
      Object.assign(details, {
        from_q: fq,
        from_r: fr,
        to_q: tq,
        to_r: tr,
        attackPower: prev.attackPower,
        defensePower: prev.defensePower,
        flankBonus: prev.flankBonus,
        outcome,
      });
      if (outcome === "CAPTURE") {
        origin.units = 1;
        target.owner = player;
        target.units = prev.advancingUnits;
        target.shielded = false;
        summary = `${pname} captured (${tq},${tr}) from (${fq},${fr}) [Atk ${prev.attackPower} vs Def ${prev.defensePower}]`;
      } else if (outcome === "TIE") {
        origin.units -= 1;
        target.units -= 1;
        if (target.units <= 0) {
          target.owner = 0;
          target.units = 0;
          target.shielded = false;
          summary = `${pname} clashed at (${tq},${tr}) — mutual attrition cleared the hex! [Atk ${prev.attackPower} vs Def ${prev.defensePower}]`;
        } else {
          summary = `${pname} clashed at (${tq},${tr}) — both sides lost 1 unit [Atk ${prev.attackPower} vs Def ${prev.defensePower}]`;
        }
      } else {
        origin.units -= 1;
        summary = `${pname}'s strike on (${tq},${tr}) was repulsed (-1 unit) [Atk ${prev.attackPower} vs Def ${prev.defensePower}]`;
      }
    } else if (action === "SHIELD") {
      const { q, r } = canonical;
      board[hexKey(q, r)].shielded = true;
      summary = `${pname} fortified (${q},${r}) with a +2 Defense Shield`;
      Object.assign(details, { q, r });
    } else if (action === "PULSE") {
      const heldBeacons = Object.values(board)
        .filter((c) => c.owner === player && (c.terrain === "NEXUS" || c.terrain === "BEACON"))
        .map((c) => [c.q, c.r]);
      heldBeacons.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
      const vpGain = 3 * heldBeacons.length;
      pdata.vp += vpGain;
      pdata.pulseCooldown = 2;
      let pushedCount = 0;

      for (const [bq, br] of heldBeacons) {
        for (const [dq, dr] of HEX_DIRECTIONS) {
          const nq = bq + dq;
          const nr = br + dr;
          if (!isOnBoard(nq, nr)) continue;
          const ncell = board[hexKey(nq, nr)];
          if (ncell.owner !== 0 && ncell.owner !== player && ncell.units === 1 && !ncell.shielded) {
            const enemyOwner = ncell.owner;
            const pq = bq + 2 * dq;
            const pr = br + 2 * dr;
            ncell.owner = 0;
            ncell.units = 0;
            ncell.shielded = false;
            pushedCount += 1;
            if (isOnBoard(pq, pr)) {
              const dest = board[hexKey(pq, pr)];
              if (dest.owner === 0) {
                dest.owner = enemyOwner;
                dest.units = 1;
                dest.shielded = false;
              } else if (dest.owner === enemyOwner && dest.units < MAX_UNITS_PER_HEX) {
                dest.units += 1;
              }
            }
          }
        }
      }

      summary =
        `${pname} triggered BEACON PULSE across ${heldBeacons.length} beacon(s) for +${vpGain} VP` +
        (pushedCount ? ` and pushed ${pushedCount} enemy scout(s)!` : "!");
      Object.assign(details, { beacons: heldBeacons.length, vpGain, pushedScouts: pushedCount });

      recomputePlayerCounts(state);
      if (pdata.vp >= TARGET_VP) {
        state.status = "FINISHED";
        state.winner = player;
        state.winReason = `${pname} reached ${pdata.vp} VP via Beacon Pulse!`;
      }
    } else if (action === "END_TURN") {
      pdata.energy = Math.min(MAX_ENERGY, pdata.energy);
      const passiveVp = passiveBeaconVpForPlayer(state, player);
      pdata.vp += passiveVp;
      recomputePlayerCounts(state);
      const vpNote = passiveVp > 0 ? ` (+${passiveVp} Beacon VP -> ${pdata.vp} VP)` : ` (${pdata.vp} VP)`;
      summary = `${pname} ended turn${vpNote}`;
      Object.assign(details, { passiveVp, totalVp: pdata.vp });

      if (pdata.vp >= TARGET_VP) {
        state.status = "FINISHED";
        state.winner = player;
        state.winReason = `${pname} reached ${pdata.vp} Victory Points!`;
      } else {
        if (player < state.maxPlayers) {
          state.turnNumber += 1;
          beginPlayerTurn(state, player + 1);
        } else {
          if (state.round >= MAX_ROUNDS) {
            state.status = "FINISHED";
            const [winP, winReason] = resolveRoundLimitWinner(state);
            state.winner = winP;
            state.winReason = winReason;
          } else {
            state.round += 1;
            state.turnNumber += 1;
            beginPlayerTurn(state, 1);
          }
        }
      }
    }

    recomputePlayerCounts(state);
    state.seq += 1;
    const logEntry = Object.assign({ seq: state.seq, summary }, details);
    state.lastMove = logEntry;
    return logEntry;
  }

  function getScoresSummary(state) {
    recomputePlayerCounts(state);
    const scores = [];
    for (let p = 1; p <= state.maxPlayers; p++) {
      const pdata = state.players[String(p)];
      scores.push({
        player: p,
        name: pdata.name,
        type: pdata.type,
        vp: pdata.vp,
        beaconsHeld: pdata.beaconsHeld,
        wellsHeld: pdata.wellsHeld,
        totalUnits: pdata.totalUnits,
        hexesHeld: pdata.hexesHeld,
        energy: pdata.energy,
        ap: pdata.ap,
        pulseCooldown: pdata.pulseCooldown || 0,
      });
    }
    return scores;
  }

  function moveTiebreakKey(move) {
    const order = { PULSE: 5, STRIKE: 4, DEPLOY: 3, SHIELD: 2, END_TURN: 1 };
    const act = move.action;
    if (act === "DEPLOY" || act === "SHIELD") {
      return [order[act], -move.q, -move.r, 0, 0];
    }
    if (act === "STRIKE") {
      return [order[act], -move.from_q, -move.from_r, -move.to_q, -move.to_r];
    }
    return [order[act], 0, 0, 0, 0];
  }

  function scoreTacticalMove(state, player, move) {
    const act = move.action;
    if (act === "END_TURN") return 0;

    const board = state.board;
    const pdata = state.players[String(player)];

    let maxOppVp = 0;
    let leaderOpp = 0;
    for (let p = 1; p <= state.maxPlayers; p++) {
      if (p !== player) {
        const ovp = state.players[String(p)].vp;
        if (ovp > maxOppVp) {
          maxOppVp = ovp;
          leaderOpp = p;
        }
      }
    }

    if (act === "PULSE") {
      const heldBeacons = Object.values(board)
        .filter((c) => c.owner === player && (c.terrain === "NEXUS" || c.terrain === "BEACON"))
        .map((c) => [c.q, c.r]);
      heldBeacons.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
      const vpGain = 3 * heldBeacons.length;
      if (pdata.vp + vpGain >= TARGET_VP) return 1000000;

      let pushed = 0;
      const seenScouts = new Set();
      for (const [bq, br] of heldBeacons) {
        for (const [dq, dr] of HEX_DIRECTIONS) {
          const nq = bq + dq;
          const nr = br + dr;
          const nk = hexKey(nq, nr);
          if (isOnBoard(nq, nr) && !seenScouts.has(nk)) {
            const nc = board[nk];
            if (nc.owner !== 0 && nc.owner !== player && nc.units === 1 && !nc.shielded) {
              seenScouts.add(nk);
              pushed += 1;
            }
          }
        }
      }

      let score = vpGain * 65 + pushed * 70 - 60;
      if (pdata.energy >= 6) score += 25;
      if (state.round >= 9) score += 40;
      return score;
    }

    if (act === "STRIKE") {
      const prev = previewStrike(state, player, move.from_q, move.from_r, move.to_q, move.to_r);
      if (!prev) return -10000;
      const target = board[hexKey(move.to_q, move.to_r)];
      const terrain = target.terrain;
      if (prev.outcome === "REPULSED") return -500;
      if (prev.outcome === "TIE") {
        if (target.units === 1) {
          if (terrain === "NEXUS") return 95;
          if (terrain === "BEACON") return 70;
          if (terrain === "WELL") return 50;
        }
        return -80;
      }

      const tBonus = { NEXUS: 290, BEACON: 210, WELL: 145, SECTOR: 40 }[terrain];
      const leaderBonus = target.owner === leaderOpp && maxOppVp >= 5 ? 55 : 0;
      const simPassive =
        passiveBeaconVpForPlayer(state, player) +
        (terrain === "NEXUS" ? 2 : terrain === "BEACON" ? 1 : 0);
      if (pdata.vp + simPassive >= TARGET_VP) return 900000;
      return 160 + tBonus + leaderBonus + prev.advancingUnits * 20;
    }

    if (act === "DEPLOY") {
      const { q, r } = move;
      const cell = board[hexKey(q, r)];
      const terrain = cell.terrain;
      if (cell.owner === 0) {
        let tBonus = { NEXUS: 350, BEACON: 215, WELL: 170, SECTOR: 45 }[terrain];
        if (terrain === "WELL" && pdata.wellsHeld === 0) {
          tBonus += 55;
        }

        let bestPull = 0;
        for (const oc of Object.values(board)) {
          if (oc.owner !== player && (oc.terrain === "NEXUS" || oc.terrain === "BEACON" || oc.terrain === "WELL")) {
            const d = hexDistance([q, r], [oc.q, oc.r]);
            let weight = oc.terrain === "NEXUS" ? 38 : oc.terrain === "BEACON" ? 30 : 22;
            if (oc.owner !== 0) weight += 8;
            const pull = Math.max(0, 4 - d) * weight;
            if (pull > bestPull) bestPull = pull;
          }
        }

        let flankSetup = 0;
        for (const [nq, nr] of getNeighbors(q, r)) {
          const nc = board[hexKey(nq, nr)];
          if (nc.owner !== 0 && nc.owner !== player) {
            flankSetup += nc.terrain === "NEXUS" || nc.terrain === "BEACON" || nc.terrain === "WELL" ? 35 : 12;
          }
        }

        const simPassive =
          passiveBeaconVpForPlayer(state, player) +
          (terrain === "NEXUS" ? 2 : terrain === "BEACON" ? 1 : 0);
        if (pdata.vp + simPassive >= TARGET_VP) return 850000;

        return tBonus + bestPull + flankSetup;
      } else {
        const adjEnemies = getNeighbors(q, r)
          .map(([nq, nr]) => board[hexKey(nq, nr)])
          .filter((ec) => ec.owner !== 0 && ec.owner !== player);

        let score = -20;
        if ((terrain === "NEXUS" || terrain === "BEACON" || terrain === "WELL") && cell.units === 1) {
          score = terrain === "NEXUS" || terrain === "BEACON" ? 95 : 70;
        }
        if (adjEnemies.length > 0) {
          let bestFront = cell.units === 1 ? 120 : 80;
          for (const ec of adjEnemies) {
            let flanks = 0;
            for (const [nq2, nr2] of getNeighbors(ec.q, ec.r)) {
              if (nq2 === q && nr2 === r) continue;
              if (board[hexKey(nq2, nr2)].owner === player) flanks += 1;
            }
            const newAtk = cell.units + 1 + flanks;
            const ecDef = ec.units + (ec.shielded ? 2 : 0);
            const canStrikeNow = pdata.ap >= 3 && pdata.energy >= 2;
            if (newAtk > ecDef) {
              const objVal = { NEXUS: 260, BEACON: 180, WELL: 135, SECTOR: 45 }[ec.terrain];
              const comboScore = (canStrikeNow ? 135 : 75) + objVal;
              if (comboScore > bestFront) bestFront = comboScore;
            } else if (ec.terrain === "NEXUS" || ec.terrain === "BEACON" || ec.terrain === "WELL") {
              if (135 > bestFront) bestFront = 135;
            }
          }
          if (bestFront > score) score = bestFront;
        }
        return score;
      }
    }

    if (act === "SHIELD") {
      const { q, r } = move;
      const cell = board[hexKey(q, r)];
      const terrain = cell.terrain;
      const adjEnemies = getNeighbors(q, r)
        .map(([nq, nr]) => board[hexKey(nq, nr)])
        .filter((ec) => ec.owner !== 0 && ec.owner !== player);
      if (adjEnemies.length === 0) return -100;
      const maxEnemyUnits = Math.max(...adjEnemies.map((ec) => ec.units));
      const threatened = maxEnemyUnits >= cell.units;
      if (terrain === "NEXUS") return threatened ? 255 : 185;
      if (terrain === "BEACON") return threatened ? 195 : 140;
      if (terrain === "WELL") return threatened ? 135 : 75;
      return threatened && cell.units >= 3 ? 55 : -40;
    }

    return -100;
  }

  function chooseBuiltinBotMove(state, player = null) {
    const actP = player === null ? state.activePlayer : player;
    const legal = getLegalMoves(state, actP);
    if (!legal.length) return { action: "END_TURN" };

    let bestMove = legal[0];
    let bestScore = -9999999;
    let bestTie = [0, 0, 0, 0, 0];
    for (const m of legal) {
      const s = scoreTacticalMove(state, actP, m);
      const tb = moveTiebreakKey(m);
      if (s > bestScore || (s === bestScore && compareTuples(tb, bestTie) > 0)) {
        bestScore = s;
        bestTie = tb;
        bestMove = m;
      }
    }
    return bestMove;
  }

  function runActiveBuiltinBots(state, maxSteps = 200) {
    const botLogs = [];
    let steps = 0;
    while (state.status === "ACTIVE" && steps < maxSteps) {
      const actP = state.activePlayer;
      if (state.players[String(actP)].type !== "builtin_bot") break;
      const move = chooseBuiltinBotMove(state, actP);
      const entry = applyMove(state, actP, move);
      botLogs.push(entry);
      steps += 1;
    }
    return botLogs;
  }

  class MatchSession {
    constructor({
      matchCode = "LOCAL",
      maxPlayers = 2,
      creatorName = "Player 1",
      creatorType = "human",
      creatorClientId = "local_host",
      startWaiting = false,
    } = {}) {
      this.matchCode = matchCode;
      this.seatTokens = { 1: creatorClientId };
      const seats = {
        1: {
          name: creatorName,
          type: creatorType,
          clientId: creatorClientId,
        },
      };
      const initStatus = startWaiting ? "WAITING" : "ACTIVE";
      this.state = createInitialState(maxPlayers, matchCode, seats, initStatus);
      this.log = [];
      this.frames = [deepClone(this.state)];
    }

    _recordFrame(entry) {
      this.log.push(entry);
      this.frames.push(deepClone(this.state));
    }

    checkAutoStart() {
      if (this.state.status !== "WAITING") return;
      const openSeats = [];
      for (let p = 1; p <= this.state.maxPlayers; p++) {
        if (this.state.players[String(p)].type === "open") openSeats.push(p);
      }
      if (openSeats.length === 0) {
        this.state.status = "ACTIVE";
        beginPlayerTurn(this.state, 1);
        this.frames = [deepClone(this.state)];
        const botLogs = runActiveBuiltinBots(this.state);
        for (const bl of botLogs) {
          this._recordFrame(bl);
        }
      }
    }

    joinSeat(name, playerType = "agent", clientId = "", preferredSeat = null) {
      if (clientId) {
        for (let p = 1; p <= this.state.maxPlayers; p++) {
          if (this.state.players[String(p)].clientId === clientId) return p;
        }
      }
      let targetSeat = null;
      if (preferredSeat >= 1 && preferredSeat <= this.state.maxPlayers) {
        if (this.state.players[String(preferredSeat)].type === "open") {
          targetSeat = preferredSeat;
        }
      }
      if (targetSeat === null) {
        for (let p = 1; p <= this.state.maxPlayers; p++) {
          if (this.state.players[String(p)].type === "open") {
            targetSeat = p;
            break;
          }
        }
      }
      if (targetSeat === null) return null;

      const pdata = this.state.players[String(targetSeat)];
      pdata.name = name || PLAYER_META[targetSeat].name;
      pdata.type = playerType;
      pdata.clientId = clientId;
      this.seatTokens[targetSeat] = clientId;
      this.checkAutoStart();
      return targetSeat;
    }

    fillBots() {
      const filled = [];
      const botNames = {
        1: "Bot-Cyan",
        2: "Bot-Amber",
        3: "Bot-Emerald",
        4: "Bot-Coral",
      };
      for (let p = 1; p <= this.state.maxPlayers; p++) {
        const pdata = this.state.players[String(p)];
        if (pdata.type === "open") {
          pdata.type = "builtin_bot";
          pdata.name = botNames[p];
          pdata.clientId = `builtin_bot_${p}`;
          filled.push(p);
        }
      }
      if (this.state.status === "WAITING") {
        this.checkAutoStart();
      } else if (this.state.status === "ACTIVE") {
        const botLogs = runActiveBuiltinBots(this.state);
        for (const bl of botLogs) {
          this._recordFrame(bl);
        }
      }
      return filled;
    }

    submitMove(player, rawMove, autoPlayBots = true) {
      const entry = applyMove(this.state, player, rawMove);
      this._recordFrame(entry);
      const botEntries = [];
      if (autoPlayBots && this.state.status === "ACTIVE") {
        while (this.state.status === "ACTIVE") {
          const actP = this.state.activePlayer;
          if (this.state.players[String(actP)].type !== "builtin_bot") break;
          const bmove = chooseBuiltinBotMove(this.state, actP);
          const bentry = applyMove(this.state, actP, bmove);
          this._recordFrame(bentry);
          botEntries.push(bentry);
        }
      }
      return [entry, botEntries];
    }

    applyCloudEvent(evt) {
      if (!evt || typeof evt !== "object") return false;
      const etype = evt.type;
      if (etype === "JOIN") {
        const seat = this.joinSeat(
          String(evt.name || "Remote Agent").slice(0, 28),
          String(evt.playerType || "agent"),
          String(evt.clientId || ""),
          evt.preferredSeat || null
        );
        return seat !== null;
      }
      if (etype === "FILL_BOTS") {
        const filled = this.fillBots();
        return filled.length > 0;
      }
      if (etype === "MOVE") {
        if (this.state.status !== "ACTIVE") return false;
        if (evt.seq !== undefined && evt.seq !== null && parseInt(evt.seq, 10) !== this.state.seq) {
          return false;
        }
        const player = parseInt(evt.player || 0, 10);
        if (player !== this.state.activePlayer) return false;
        const seatCid = this.state.players[String(player)].clientId;
        if (seatCid && evt.clientId && seatCid !== evt.clientId) return false;
        if (!evt.move || typeof evt.move !== "object") return false;
        const [ok] = validateMove(this.state, player, evt.move);
        if (!ok) return false;
        this.submitMove(player, evt.move, true);
        return true;
      }
      return false;
    }

    toReplayObject() {
      return {
        game: "Beacon Wars",
        version: "1.0",
        matchCode: this.matchCode,
        maxPlayers: this.state.maxPlayers,
        winner: this.state.winner,
        winReason: this.state.winReason,
        finalScores: getScoresSummary(this.state),
        moves: this.log,
        frames: this.frames,
      };
    }
  }

  function reconstructCloudSession(matchCode, events) {
    let session = null;
    for (const evt of events) {
      if (!evt || typeof evt !== "object") continue;
      if (evt.type === "CREATE" && session === null) {
        let mp = parseInt(evt.maxPlayers || 2, 10);
        if (![2, 3, 4].includes(mp)) mp = 2;
        session = new MatchSession({
          matchCode,
          maxPlayers: mp,
          creatorName: String(evt.name || "Commander").slice(0, 28),
          creatorType: String(evt.playerType || "human"),
          creatorClientId: String(evt.clientId || "host"),
          startWaiting: true,
        });
      } else if (session !== null) {
        session.applyCloudEvent(evt);
      }
    }
    return session;
  }

  return {
    BOARD_RADIUS,
    MAX_ROUNDS,
    TARGET_VP,
    MAX_UNITS_PER_HEX,
    MAX_ENERGY,
    BASE_AP,
    BASE_ENERGY_INCOME,
    WELL_ENERGY_BONUS,
    HEX_DIRECTIONS,
    CENTRAL_NEXUS,
    OUTER_BEACONS,
    ENERGY_WELLS,
    PLAYER_SPAWNS,
    PLAYER_META,
    ACTION_COSTS,
    hexKey,
    parseHexKey,
    hexDistance,
    isOnBoard,
    allBoardCoords,
    getNeighbors,
    terrainAt,
    deepClone,
    createInitialState,
    previewStrike,
    getLegalMoves,
    normalizeMoveInput,
    validateMove,
    applyMove,
    getScoresSummary,
    scoreTacticalMove,
    chooseBuiltinBotMove,
    runActiveBuiltinBots,
    MatchSession,
    reconstructCloudSession,
  };
});
