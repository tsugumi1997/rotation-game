(() => {
  "use strict";

  const EMPTY = 0, BLACK = 1, WHITE = 2;

  const elBoard = document.getElementById("board");
  const elTurnText = document.getElementById("turnText");
  const elPhaseText = document.getElementById("phaseText");
  const elEvalText = document.getElementById("evalText");
  const elBWText = document.getElementById("bwText");
  const elRoomLabel = document.getElementById("roomLabel");
  const elSeatLabel = document.getElementById("seatLabel");
  const elStatus = document.getElementById("statusText");

  const elRoomCode = document.getElementById("roomCode");
  const btnApplyRoom = document.getElementById("applyRoom");
  const btnCopyLink = document.getElementById("copyLink");

  const btnCommit = document.getElementById("commit");
  const btnUndo = document.getElementById("undo");
  const btnReset = document.getElementById("reset");

  const cbAiWhite = document.getElementById("aiWhite");
  const rbHumanBlack = document.getElementById("humanBlack");
  const rbHumanWhite = document.getElementById("humanWhite");

  const quadBtns = Array.from(document.querySelectorAll(".qbtn"));
  const dirBtns = Array.from(document.querySelectorAll(".dbtn"));

  let board = Array(36).fill(EMPTY);
  let fixed = Array(36).fill(false);

  let turn = BLACK;
  let phase = "place";
  let pendingIndex = -1;
  let pendingColor = EMPTY;

  let selectedQuad = 0;
  let selectedDir = 1;

  let history = [];
  let winCells = new Set();

  // ローカル
  let humanColor = BLACK;
  function aiColorLocal() { return (humanColor === BLACK ? WHITE : BLACK); }

  // Firebase
  const firebaseConfig = {
    apiKey: "AIzaSyBuV-7S_1LuPiTKVdkFjyOvtKUaN136rPE",
    authDomain: "pentago-online.firebaseapp.com",
    databaseURL: "https://pentago-online-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "pentago-online",
    storageBucket: "pentago-online.firebasestorage.app",
    messagingSenderId: "205747321779",
    appId: "1:205747321779:web:a553a1a01d2bfec98da9c6",
    measurementId: "G-F1BSS16ZQ9"
  };

  let onlineEnabled = false;
  let db = null;

  let room = "";
  let lastLocalTs = 0;

  let seat = ""; // "B" | "W" | "S" | ""

  const clientId = (() => {
    const key = "pentago_client_id";
    let v = localStorage.getItem(key);
    if (!v) {
      v = "c_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
      localStorage.setItem(key, v);
    }
    return v;
  })();

  let stateListener = null;
  let seatsListener = null;

  function setStatus(s) { if (elStatus) elStatus.textContent = s; }

  function initFirebaseMaybe() {
    try {
      if (!window.firebase || !firebase.initializeApp) {
        setStatus("Firebase未読込：ローカルで遊べます");
        return;
      }
      if (!firebase.apps || firebase.apps.length === 0) firebase.initializeApp(firebaseConfig);
      db = firebase.database();
      onlineEnabled = true;
      setStatus("Firebase接続OK（Room同期可）");
    } catch {
      onlineEnabled = false;
      db = null;
      setStatus("Firebase初期化失敗：ローカルで遊べます");
    }
  }

  function roomBaseRef() { return db.ref(`rooms/${room}`); }
  function stateRef() { return roomBaseRef().child("state"); }
  function seatsRef() { return roomBaseRef().child("seats"); }
  function presenceRef() { return roomBaseRef().child("presence").child(clientId); }

  function parseRoomFromURL() {
    try {
      const u = new URL(location.href);
      const r = u.searchParams.get("room");
      return r && r.trim() ? r.trim() : "";
    } catch { return ""; }
  }

  function updateURLRoom(r) {
    try {
      const u = new URL(location.href);
      if (r) u.searchParams.set("room", r);
      else u.searchParams.delete("room");
      window.history.replaceState(null, "", u.toString());
    } catch {}
  }

  function detachOnlineListeners() {
    if (!onlineEnabled || !db || !room) return;
    try {
      if (stateListener) stateRef().off("value", stateListener);
      if (seatsListener) seatsRef().off("value", seatsListener);
    } catch {}
    stateListener = null;
    seatsListener = null;
  }

  async function claimSeatTransaction() {
    seat = "";
    const ref = seatsRef();
    const result = await ref.transaction((cur) => {
      cur = cur || {};
      const black = cur.black || "";
      const white = cur.white || "";

      if (black === clientId) return cur;
      if (white === clientId) return cur;

      if (!black) { cur.black = clientId; cur.tBlack = Date.now(); return cur; }
      if (!white) { cur.white = clientId; cur.tWhite = Date.now(); return cur; }
      return cur;
    });

    const val = result && result.snapshot ? result.snapshot.val() : null;
    if (!val) { seat = "S"; return; }

    if (val.black === clientId) seat = "B";
    else if (val.white === clientId) seat = "W";
    else seat = "S";

    try {
      const p = presenceRef();
      p.set({ seat, ts: Date.now() });
      p.onDisconnect().remove();

      if (seat === "B") ref.child("black").onDisconnect().remove();
      if (seat === "W") ref.child("white").onDisconnect().remove();
    } catch {}
  }

  function lockLocalOnlyUI(isOnline) {
    if (rbHumanBlack) rbHumanBlack.disabled = isOnline;
    if (rbHumanWhite) rbHumanWhite.disabled = isOnline;

    if (cbAiWhite) {
      cbAiWhite.disabled = isOnline;
      if (isOnline) cbAiWhite.checked = false;
    }
  }

  function attachOnlineListeners() {
    detachOnlineListeners();
    if (!onlineEnabled || !db || !room) return;

    const onState = (snap) => {
      const data = snap.val();
      if (!data) return;
      if (typeof data.ts === "number" && data.ts < lastLocalTs) return;

      if (Array.isArray(data.board) && data.board.length === 36) board = data.board.slice();
      if (Array.isArray(data.fixed) && data.fixed.length === 36) fixed = data.fixed.slice();
      if (data.turn === BLACK || data.turn === WHITE) turn = data.turn;
      if (typeof data.phase === "string") phase = data.phase;
      if (typeof data.pendingIndex === "number") pendingIndex = data.pendingIndex;
      if (data.pendingColor === BLACK || data.pendingColor === WHITE || data.pendingColor === EMPTY) pendingColor = data.pendingColor;
      if (typeof data.selectedQuad === "number") selectedQuad = data.selectedQuad;
      if (data.selectedDir === -1 || data.selectedDir === 1) selectedDir = data.selectedDir;

      winCells = computeWinCells(board);
      render();
    };
    stateListener = onState;
    stateRef().on("value", onState);

    const onSeats = (snap) => {
      const s = snap.val() || {};
      if (s.black === clientId) seat = "B";
      else if (s.white === clientId) seat = "W";
      else seat = seat || "S";
      render();
    };
    seatsListener = onSeats;
    seatsRef().on("value", onSeats);
  }

  function syncToOnline() {
    if (!onlineEnabled || !db || !room) return;
    try {
      lastLocalTs = Date.now();
      stateRef().set({
        ts: lastLocalTs,
        board,
        fixed,
        turn,
        phase,
        pendingIndex,
        pendingColor,
        selectedQuad,
        selectedDir
      });
    } catch {}
  }

  async function setRoom(r) {
    room = (r || "").trim();

    if (!room) {
      detachOnlineListeners();
      seat = "";
      if (elRoomLabel) elRoomLabel.textContent = "—";
      updateURLRoom("");
      lockLocalOnlyUI(false);
      setStatus("Room未設定：ローカルで遊べます");
      render();
      maybeAIMove();
      return;
    }

    if (elRoomLabel) elRoomLabel.textContent = room;
    updateURLRoom(room);

    if (!onlineEnabled || !db) {
      lockLocalOnlyUI(false);
      setStatus("Firebase未接続：ローカルで遊べます（Room同期不可）");
      render();
      maybeAIMove();
      return;
    }

    lockLocalOnlyUI(true);
    setStatus("Room参加中：席を確保しています…");

    await claimSeatTransaction();

    setStatus(
      seat === "B" ? "黒で参加（先攻）" :
      seat === "W" ? "白で参加（後攻）" :
      "観戦中（席が埋まっています）"
    );

    attachOnlineListeners();

    try {
      await stateRef().transaction((cur) => {
        if (cur) return cur;
        return {
          ts: Date.now(),
          board: Array(36).fill(EMPTY),
          fixed: Array(36).fill(false),
          turn: BLACK,
          phase: "place",
          pendingIndex: -1,
          pendingColor: EMPTY,
          selectedQuad: 0,
          selectedDir: 1
        };
      });
    } catch {}

    render();
  }

  // ===== 盤UI =====
  function makeBoardUI() {
    if (!elBoard) return;
    elBoard.innerHTML = "";
    for (let i = 0; i < 36; i++) {
      const d = document.createElement("div");
      d.className = "cell";
      d.dataset.i = String(i);
      d.dataset.mark = "0";
      d.addEventListener("click", () => onCellClick(i));
      elBoard.appendChild(d);
    }
  }

  // ===== ヘルパ =====
  function countBW(arr) {
    let b = 0, w = 0;
    for (const v of arr) { if (v === BLACK) b++; else if (v === WHITE) w++; }
    return { b, w };
  }

  function canHumanActNow() {
    if (room) {
      if (seat === "B" && turn === BLACK) return true;
      if (seat === "W" && turn === WHITE) return true;
      return false;
    }
    return turn === humanColor;
  }

  // ===== 回転 =====
  function quadIndices(q) {
    const rowBase = (q === 0 || q === 1) ? 0 : 3;
    const colBase = (q === 0 || q === 2) ? 0 : 3;
    const idx = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++)
      idx.push((rowBase + r) * 6 + (colBase + c));
    return idx;
  }

  function rotateQuadrantOn(arrBoard, arrFixed, q, dir) {
    const idx = quadIndices(q);
    const b0 = idx.map(k => arrBoard[k]);
    const f0 = idx.map(k => arrFixed[k]);

    const map = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const from = r * 3 + c;
        const to = (dir === 1) ? (c * 3 + (2 - r)) : ((2 - c) * 3 + r);
        map[to] = from;
      }
    }
    for (let t = 0; t < 9; t++) {
      const from = map[t];
      arrBoard[idx[t]] = b0[from];
      arrFixed[idx[t]] = f0[from];
    }
  }

  function rotateQuadrant(q, dir) {
    rotateQuadrantOn(board, fixed, q, dir);
  }

  // ===== 勝利判定 =====
  function computeWinCells(bd) {
    const res = new Set();
    function addRun(run) { if (run.length >= 5) run.forEach(x => res.add(x)); }

    // 横
    for (let r = 0; r < 6; r++) {
      let runColor = EMPTY, run = [];
      for (let c = 0; c < 6; c++) {
        const idx = r * 6 + c, v = bd[idx];
        if (v !== EMPTY && v === runColor) run.push(idx);
        else { addRun(runColor === EMPTY ? [] : run); runColor = v; run = (v === EMPTY) ? [] : [idx]; }
      }
      addRun(runColor === EMPTY ? [] : run);
    }
    // 縦
    for (let c = 0; c < 6; c++) {
      let runColor = EMPTY, run = [];
      for (let r = 0; r < 6; r++) {
        const idx = r * 6 + c, v = bd[idx];
        if (v !== EMPTY && v === runColor) run.push(idx);
        else { addRun(runColor === EMPTY ? [] : run); runColor = v; run = (v === EMPTY) ? [] : [idx]; }
      }
      addRun(runColor === EMPTY ? [] : run);
    }
    // 斜め（\）
    const diag1Starts = [[0,0],[0,1],[1,0]];
    for (const [sr, sc] of diag1Starts) {
      let r = sr, c = sc, runColor = EMPTY, run = [];
      while (r < 6 && c < 6) {
        const idx = r * 6 + c, v = bd[idx];
        if (v !== EMPTY && v === runColor) run.push(idx);
        else { addRun(runColor === EMPTY ? [] : run); runColor = v; run = (v === EMPTY) ? [] : [idx]; }
        r++; c++;
      }
      addRun(runColor === EMPTY ? [] : run);
    }
    // 斜め（/）
    const diag2Starts = [[0,5],[0,4],[1,5]];
    for (const [sr, sc] of diag2Starts) {
      let r = sr, c = sc, runColor = EMPTY, run = [];
      while (r < 6 && c >= 0) {
        const idx = r * 6 + c, v = bd[idx];
        if (v !== EMPTY && v === runColor) run.push(idx);
        else { addRun(runColor === EMPTY ? [] : run); runColor = v; run = (v === EMPTY) ? [] : [idx]; }
        r++; c--;
      }
      addRun(runColor === EMPTY ? [] : run);
    }
    return res;
  }

  // ===== Eval（改良版） =====
  function all5Windows() {
    // 6x6 上で「連続5」の窓（方向4つ）
    const wins = [];

    // 横：各行で開始列0..1
    for (let r = 0; r < 6; r++) {
      for (let c0 = 0; c0 <= 1; c0++) {
        wins.push([0,1,2,3,4].map(k => r*6 + (c0+k)));
      }
    }
    // 縦：各列で開始行0..1
    for (let c = 0; c < 6; c++) {
      for (let r0 = 0; r0 <= 1; r0++) {
        wins.push([0,1,2,3,4].map(k => (r0+k)*6 + c));
      }
    }
    // 斜め \ ：開始 (r0,c0) で r0 0..1, c0 0..1
    for (let r0 = 0; r0 <= 1; r0++) {
      for (let c0 = 0; c0 <= 1; c0++) {
        wins.push([0,1,2,3,4].map(k => (r0+k)*6 + (c0+k)));
      }
    }
    // 斜め / ：開始 (r0,c0) で r0 0..1, c0 4..5
    for (let r0 = 0; r0 <= 1; r0++) {
      for (let c0 = 4; c0 <= 5; c0++) {
        wins.push([0,1,2,3,4].map(k => (r0+k)*6 + (c0-k)));
      }
    }

    return wins;
  }
  const WINDOWS5 = all5Windows();

  function windowScoreForColor(bd, color) {
    const opp = (color === BLACK ? WHITE : BLACK);
    // 連の強さ（5は勝ち扱いなので超大きい）
    const W = [0, 2, 10, 45, 220, 1000000];

    let score = 0;
    for (const w of WINDOWS5) {
      let my = 0, op = 0, emp = 0;
      for (const idx of w) {
        const v = bd[idx];
        if (v === color) my++;
        else if (v === opp) op++;
        else emp++;
      }
      if (my > 0 && op > 0) continue;      // 混ざってる窓は無価値
      if (my > 0 && op === 0) score += W[my] + (emp === 0 ? 0 : 0);
      if (op > 0 && my === 0) score -= W[op];
    }
    return score;
  }

  function listEmptyCells(bd, fx) {
    const res = [];
    for (let i = 0; i < 36; i++) if (!fx[i] && bd[i] === EMPTY) res.push(i);
    return res;
  }

  function simulateMoveOn(bd0, fx0, color, placeIdx, q, dir) {
    const bd = bd0.slice();
    const fx = fx0.slice();
    bd[placeIdx] = color;
    fx[placeIdx] = true;
    rotateQuadrantOn(bd, fx, q, dir);
    const wins = computeWinCells(bd);
    return { bd, fx, wins };
  }

  function countWinningMovesNext(bd0, fx0, color, limitEmpty = 36) {
    const empties = listEmptyCells(bd0, fx0);
    const cap = Math.min(limitEmpty, empties.length);
    let count = 0;

    for (let e = 0; e < cap; e++) {
      const idx = empties[e];
      for (let q = 0; q < 4; q++) {
        for (const d of [-1, 1]) {
          const sim = simulateMoveOn(bd0, fx0, color, idx, q, d);
          if (sim.wins.size > 0) count++;
        }
      }
    }
    return count;
  }

  function evalPositionBlackPerspective() {
    // pending も「仮に確定したら」評価したいので、仮盤を作る
    const bd0 = board.slice();
    const fx0 = fixed.slice();
    if (pendingIndex >= 0 && pendingColor !== EMPTY) {
      bd0[pendingIndex] = pendingColor;
      fx0[pendingIndex] = true;
      // 回転はまだ未確定なので、ここでは回転なしで“置いた瞬間”の評価だけ入れる
      // （確定後の評価は commit 後に自然に更新される）
    }

    // 形の評価（黒優勢が+）
    let score = 0;
    score += windowScoreForColor(bd0, BLACK);
    // windowScoreForColor は「相手窓をマイナス」で含むので、黒だけで見ればOK

    // 次の1手で勝てる手の数（回転込み）を強めに加点
    // 重くなりすぎないように、候補空きマスを最大26まで見る
    const blackWins = countWinningMovesNext(board, fixed, BLACK, 26);
    const whiteWins = countWinningMovesNext(board, fixed, WHITE, 26);

    score += 500 * (blackWins - whiteWins);

    // 表示は見やすいレンジに丸める
    // （とりあえず整数のまま表示）
    return Math.trunc(score);
  }

  // ===== AI（ローカルのみ） =====
  function aiChooseMoveHumanLike(my) {
    const empties = listEmptyCells(board, fixed);
    if (empties.length === 0) return null;

    const candidates = [];
    for (const idx of empties) {
      for (let q = 0; q < 4; q++) {
        for (const d of [-1, 1]) {
          const sim = simulateMoveOn(board, fixed, my, idx, q, d);

          if (sim.wins.size > 0) {
            candidates.push({ idx, q, d, score: 1e12 });
            continue;
          }

          const score = windowScoreForColor(sim.bd, my);
          candidates.push({ idx, q, d, score });
        }
      }
    }

    candidates.sort((a,b)=>b.score-a.score);
    const top = candidates.slice(0, 8);
    const pick = top[Math.floor(Math.random() * Math.min(3, top.length))];
    return pick || candidates[0];
  }

  function maybeAIMove() {
    if (room) return; // オンラインはAI停止
    if (!cbAiWhite || !cbAiWhite.checked) return;
    if (winCells.size > 0) return;

    const ai = aiColorLocal();
    if (turn !== ai) return;
    if (phase !== "place") return;
    if (pendingIndex >= 0) return;

    const mv = aiChooseMoveHumanLike(ai);
    if (!mv) return;

    pendingIndex = mv.idx;
    pendingColor = ai;
    phase = "rotate";
    selectedQuad = mv.q;
    selectedDir = mv.d;

    render();
    setTimeout(commitMove, 200);
  }

  // ===== 描画 =====
  function render() {
    if (elTurnText) elTurnText.textContent = (turn === BLACK ? "黒の手番" : "白の手番");
    if (elPhaseText) elPhaseText.textContent = phase;

    if (elEvalText) elEvalText.textContent = String(evalPositionBlackPerspective());

    const { b, w } = countBW(board);
    if (elBWText) elBWText.textContent = `${b} / ${w}`;
    if (elRoomLabel) elRoomLabel.textContent = room ? room : "—";

    let you = "—";
    if (room) you = seat || "—";
    else you = (humanColor === BLACK ? "B" : "W");
    if (elSeatLabel) elSeatLabel.textContent = you;

    quadBtns.forEach(btn => btn.classList.toggle("selected", Number(btn.dataset.q) === selectedQuad));
    dirBtns.forEach(btn => btn.classList.toggle("selected", Number(btn.dataset.d) === selectedDir));

    if (elBoard) {
      const cells = elBoard.children;
      for (let i = 0; i < 36; i++) {
        const c = cells[i];
        if (!c) continue;

        let v = board[i];
        if (i === pendingIndex && pendingColor !== EMPTY) v = pendingColor;

        c.dataset.mark = String(v);
        c.classList.toggle("fixed", !!fixed[i]);
        c.classList.toggle("pending", i === pendingIndex && pendingColor !== EMPTY);
        c.classList.toggle("win", winCells.has(i));
      }
    }

    if (btnCommit) btnCommit.disabled = (pendingIndex < 0) || !canHumanActNow();
    if (btnUndo) btnUndo.disabled = (history.length === 0);
  }

  // ===== 操作 =====
  function onCellClick(i) {
    if (winCells.size > 0) return;
    if (!canHumanActNow()) return;

    if (fixed[i]) return;
    if (board[i] !== EMPTY) return;

    pendingIndex = i;
    pendingColor = turn;
    phase = "rotate";
    setStatus("回転を選んで「回転して確定」");
    render();
    syncToOnline();
  }

  function selectQuad(q) {
    if (phase !== "rotate" && phase !== "place") return;
    selectedQuad = q;
    render();
    syncToOnline();
  }

  function selectDir(d) {
    if (phase !== "rotate" && phase !== "place") return;
    selectedDir = d;
    render();
    syncToOnline();
  }

  // ===== Undo/Reset =====
  function snapshot() {
    return {
      board: board.slice(),
      fixed: fixed.slice(),
      turn,
      phase,
      pendingIndex,
      pendingColor,
      selectedQuad,
      selectedDir,
      win: Array.from(winCells)
    };
  }

  function restore(s) {
    board = s.board.slice();
    fixed = s.fixed.slice();
    turn = s.turn;
    phase = s.phase;
    pendingIndex = s.pendingIndex;
    pendingColor = s.pendingColor;
    selectedQuad = s.selectedQuad;
    selectedDir = s.selectedDir;
    winCells = new Set(s.win || []);
  }

  function pushHistory() {
    history.push(snapshot());
    if (history.length > 50) history.shift();
  }

  function undo() {
    if (history.length === 0) return;
    restore(history.pop());
    setStatus("Undoしました");
    render();
    syncToOnline();
    maybeAIMove();
  }

  function reset() {
    board = Array(36).fill(EMPTY);
    fixed = Array(36).fill(false);
    turn = BLACK;
    phase = "place";
    pendingIndex = -1;
    pendingColor = EMPTY;
    selectedQuad = 0;
    selectedDir = 1;
    winCells = new Set();
    history = [];
    setStatus("リセットしました");
    render();
    syncToOnline();
    maybeAIMove();
  }

  function applyHumanColorFromUI() {
    if (room) return;
    humanColor = (rbHumanWhite && rbHumanWhite.checked) ? WHITE : BLACK;
    reset();
  }

  function commitMove() {
    if (winCells.size > 0) return;
    if (room && !canHumanActNow()) return;

    if (pendingIndex < 0 || pendingColor === EMPTY) {
      setStatus("先にマスをタップして仮置きしてください");
      return;
    }

    pushHistory();

    board[pendingIndex] = pendingColor;
    fixed[pendingIndex] = true;

    rotateQuadrant(selectedQuad, selectedDir);

    winCells = computeWinCells(board);
    if (winCells.size > 0) {
      setStatus("勝利ライン！");
      render();
      syncToOnline();
      return;
    }

    pendingIndex = -1;
    pendingColor = EMPTY;
    phase = "place";
    turn = (turn === BLACK ? WHITE : BLACK);
    setStatus("仮置き：マスをタップ（置き直しOK）");

    render();
    syncToOnline();
    maybeAIMove();
  }

  // ===== イベント =====
  function bindEvents() {
    quadBtns.forEach(b => b.addEventListener("click", () => selectQuad(Number(b.dataset.q))));
    dirBtns.forEach(b => b.addEventListener("click", () => selectDir(Number(b.dataset.d))));

    if (btnCommit) btnCommit.addEventListener("click", commitMove);
    if (btnUndo) btnUndo.addEventListener("click", undo);
    if (btnReset) btnReset.addEventListener("click", reset);

    if (btnApplyRoom) {
      btnApplyRoom.addEventListener("click", async () => {
        const r = (elRoomCode ? elRoomCode.value : "").trim();
        await setRoom(r);
      });
    }

    if (btnCopyLink) {
      btnCopyLink.addEventListener("click", async () => {
        const r = room || (elRoomCode ? elRoomCode.value.trim() : "");
        if (!r) { setStatus("room番号を入れてから共有URLを押してください"); return; }
        const u = new URL(location.href);
        u.searchParams.set("room", r);
        try { await navigator.clipboard.writeText(u.toString()); setStatus("共有URLをコピーしました"); }
        catch { setStatus("コピーできませんでした（手動でURLを共有してください）"); }
      });
    }

    if (rbHumanBlack) rbHumanBlack.addEventListener("change", applyHumanColorFromUI);
    if (rbHumanWhite) rbHumanWhite.addEventListener("change", applyHumanColorFromUI);

    if (cbAiWhite) cbAiWhite.addEventListener("change", () => { maybeAIMove(); });

    window.addEventListener("error", (ev) => {
      try {
        const msg = ev && ev.message ? ev.message : "Unknown error";
        setStatus("JSエラー: " + msg);
      } catch {}
    });
  }

  // ===== オンライン設定 =====
  async function setRoom(r) {
    // 上で定義済み（同名なので、ここは無いと困る）
    // ※既に上に実装してるので何もしない
  }

  // ↑の同名問題を避けるため、ここで関数参照を保持しておく
  const setRoomFn = setRoom;

  // ここから “本物の setRoom” を置き換え（JSの同名上書き）
  setRoom = async function (r) {
    room = (r || "").trim();

    if (!room) {
      detachOnlineListeners();
      seat = "";
      if (elRoomLabel) elRoomLabel.textContent = "—";
      updateURLRoom("");
      lockLocalOnlyUI(false);
      setStatus("Room未設定：ローカルで遊べます");
      render();
      maybeAIMove();
      return;
    }

    if (elRoomLabel) elRoomLabel.textContent = room;
    updateURLRoom(room);

    if (!onlineEnabled || !db) {
      lockLocalOnlyUI(false);
      setStatus("Firebase未接続：ローカルで遊べます（Room同期不可）");
      render();
      maybeAIMove();
      return;
    }

    lockLocalOnlyUI(true);
    setStatus("Room参加中：席を確保しています…");

    await claimSeatTransaction();

    setStatus(
      seat === "B" ? "黒で参加（先攻）" :
      seat === "W" ? "白で参加（後攻）" :
      "観戦中（席が埋まっています）"
    );

    attachOnlineListeners();

    try {
      await stateRef().transaction((cur) => {
        if (cur) return cur;
        return {
          ts: Date.now(),
          board: Array(36).fill(EMPTY),
          fixed: Array(36).fill(false),
          turn: BLACK,
          phase: "place",
          pendingIndex: -1,
          pendingColor: EMPTY,
          selectedQuad: 0,
          selectedDir: 1
        };
      });
    } catch {}

    render();
  };

  function lockLocalOnlyUI(isOnline) {
    if (rbHumanBlack) rbHumanBlack.disabled = isOnline;
    if (rbHumanWhite) rbHumanWhite.disabled = isOnline;
    if (cbAiWhite) {
      cbAiWhite.disabled = isOnline;
      if (isOnline) cbAiWhite.checked = false;
    }
  }

  // ===== 起動 =====
  async function boot() {
    makeBoardUI();
    initFirebaseMaybe();

    humanColor = (rbHumanWhite && rbHumanWhite.checked) ? WHITE : BLACK;

    const r = parseRoomFromURL();
    if (r) {
      if (elRoomCode) elRoomCode.value = r;
      await setRoom(r);
    } else {
      if (elRoomLabel) elRoomLabel.textContent = "—";
      lockLocalOnlyUI(false);
      setStatus("仮置き：マスをタップ（置き直しOK）");
    }

    bindEvents();
    winCells = computeWinCells(board);
    render();
    maybeAIMove();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { boot(); });
  } else {
    boot();
  }
})();
