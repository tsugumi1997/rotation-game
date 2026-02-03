/* app.js（全置換：先攻/後攻選択 + 人間っぽいAI）
 - ローカル時：人間の色を選べる（先攻=黒 / 後攻=白）
 - AIは「人間の反対色」を担当
 - オンライン（roomあり）は席管理が厳密でないため、まずローカル優先
*/

(() => {
  "use strict";

  const EMPTY = 0, BLACK = 1, WHITE = 2;

  // DOM
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

  // State
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

  // Human/AI roles（ローカル用）
  let humanColor = BLACK; // 先攻=黒
  function aiColor() { return (humanColor === BLACK ? WHITE : BLACK); }

  // Firebase（同期は維持）
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
  let seat = "";
  let onValueHandler = null;
  let lastLocalTs = 0;

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

  function roomRef() { return db.ref(`rooms/${room}`); }

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
      if (r) u.searchParams.set("room", r); else u.searchParams.delete("room");
      window.history.replaceState(null, "", u.toString());
    } catch {}
  }

  function makeSeatIfNeeded() {
    if (seat === "B" || seat === "W") return;
    seat = (Math.random() < 0.5) ? "B" : "W";
  }

  function detachRoomListener() {
    if (!onlineEnabled || !db || !room || !onValueHandler) return;
    try { roomRef().off("value", onValueHandler); } catch {}
    onValueHandler = null;
  }

  function attachRoomListener() {
    detachRoomListener();
    if (!onlineEnabled || !db || !room) return;

    const handler = (snap) => {
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

    onValueHandler = handler;
    roomRef().on("value", handler);
    setStatus("Room同期中（同じroomを開くと反映）");
  }

  function syncToOnline() {
    if (!onlineEnabled || !db || !room) return;
    try {
      lastLocalTs = Date.now();
      roomRef().set({
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

  function setRoom(r) {
    room = (r || "").trim();
    if (!room) {
      detachRoomListener();
      if (elRoomLabel) elRoomLabel.textContent = "—";
      updateURLRoom("");
      setStatus("Room未設定：ローカルで遊べます");
      render();
      return;
    }
    if (elRoomLabel) elRoomLabel.textContent = room;
    updateURLRoom(room);

    makeSeatIfNeeded();
    if (elSeatLabel) elSeatLabel.textContent = seat;

    if (!onlineEnabled || !db) {
      setStatus("Firebase未接続：ローカルで遊べます");
      render();
      return;
    }

    attachRoomListener();
    syncToOnline();
    render();
  }

  // ===== UI =====
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

  function countBW(arr) {
    let b = 0, w = 0;
    for (const v of arr) { if (v === BLACK) b++; else if (v === WHITE) w++; }
    return { b, w };
  }

  function currentEvalSimple() {
    const { b, w } = countBW(board);
    let v = (b - w);
    if (pendingIndex >= 0 && pendingColor !== EMPTY) v += (pendingColor === BLACK ? 1 : -1);
    return v;
  }

  function render() {
    if (elTurnText) {
      elTurnText.textContent = (turn === BLACK ? "黒の手番" : "白の手番");
      elTurnText.classList.toggle("isBlack", turn === BLACK);
      elTurnText.classList.toggle("isWhite", turn === WHITE);
    }
    if (elPhaseText) elPhaseText.textContent = phase;
    if (elEvalText) elEvalText.textContent = String(currentEvalSimple());

    const { b, w } = countBW(board);
    if (elBWText) elBWText.textContent = `${b} / ${w}`;
    if (elRoomLabel) elRoomLabel.textContent = room ? room : "—";
    if (elSeatLabel) elSeatLabel.textContent = room ? seat : (humanColor === BLACK ? "B" : "W");

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

    if (btnCommit) btnCommit.disabled = (pendingIndex < 0);
    if (btnUndo) btnUndo.disabled = (history.length === 0);
  }

  // ===== 入力制限（ローカル：自分の番だけ置ける） =====
  function canHumanActNow() {
    if (room) return true; // オンラインは簡易なので制限しない
    return turn === humanColor;
  }

  function onCellClick(i) {
    if (winCells.size > 0) return;
    if (!canHumanActNow()) return; // ★自分の番以外は操作しない
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
      turn, phase, pendingIndex, pendingColor, selectedQuad, selectedDir,
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

    // 後攻（白）を選んでいたら、リセット直後にAIが先に打つ
    maybeAIMove();
  }

  // ===== 回転処理 =====
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

  // ===== 勝利判定（5連以上） =====
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

  // ===== 人間っぽいAI（軽量） =====
  function listEmptyCells(bd, fx) {
    const res = [];
    for (let i = 0; i < 36; i++) if (!fx[i] && bd[i] === EMPTY) res.push(i);
    return res;
  }

  function simulateMove(color, placeIdx, q, dir) {
    const bd = board.slice();
    const fx = fixed.slice();
    bd[placeIdx] = color; fx[placeIdx] = true;
    rotateQuadrantOn(bd, fx, q, dir);
    return { bd, fx, wins: computeWinCells(bd) };
  }

  function scorePosition(bd, myColor) {
    const opp = (myColor === BLACK ? WHITE : BLACK);
    const lines = [];

    for (let r = 0; r < 6; r++) lines.push(Array.from({length:6},(_,c)=>r*6+c));
    for (let c = 0; c < 6; c++) lines.push(Array.from({length:6},(_,r)=>r*6+c));
    lines.push([0,7,14,21,28,35]);
    lines.push([5,10,15,20,25,30]);

    let score = 0;
    for (const line of lines) {
      let my = 0, op = 0;
      for (const idx of line) {
        if (bd[idx] === myColor) my++;
        else if (bd[idx] === opp) op++;
      }
      if (my > 0 && op > 0) continue;
      if (my > 0 && op === 0) score += my * my * 3;
      if (op > 0 && my === 0) score -= op * op * 2;
    }
    return score;
  }

  function aiChooseMoveHumanLike(my) {
    const opp = (my === BLACK ? WHITE : BLACK);
    const empties = listEmptyCells(board, fixed);
    if (empties.length === 0) return null;

    const candidates = [];
    for (const idx of empties) {
      for (let q = 0; q < 4; q++) {
        for (const d of [-1, 1]) {
          const sim = simulateMove(my, idx, q, d);

          // 即勝ち
          if (sim.wins.size > 0) {
            candidates.push({ idx, q, d, score: 1e9 });
            continue;
          }

          // 相手の次の即勝ち脅威を軽く数える（サンプル）
          let oppThreat = 0;
          const empt2 = listEmptyCells(sim.bd, sim.fx).slice(0, 26);
          for (const j of empt2) {
            let found = false;
            for (let qq = 0; qq < 4 && !found; qq++) {
              for (const dd of [-1, 1]) {
                const bd2 = sim.bd.slice();
                const fx2 = sim.fx.slice();
                bd2[j] = opp; fx2[j] = true;
                rotateQuadrantOn(bd2, fx2, qq, dd);
                if (computeWinCells(bd2).size > 0) { oppThreat++; found = true; break; }
              }
            }
          }

          const shape = scorePosition(sim.bd, my);
          const score = shape - oppThreat * 70;
          candidates.push({ idx, q, d, score });
        }
      }
    }

    candidates.sort((a,b)=>b.score-a.score);

    // 人間っぽいブレ：上位3からランダム
    const top = candidates.slice(0, 8);
    const pick = top[Math.floor(Math.random() * Math.min(3, top.length))];
    return pick || candidates[0];
  }

  function maybeAIMove() {
    if (room) return; // オンライン中は自動AIを止める（混乱防止）
    if (!cbAiWhite || !cbAiWhite.checked) return;

    // AI担当色が手番なら打つ
    const ai = aiColor();
    if (turn !== ai) return;

    const mv = aiChooseMoveHumanLike(ai);
    if (!mv) return;

    pendingIndex = mv.idx;
    pendingColor = ai;
    phase = "rotate";
    selectedQuad = mv.q;
    selectedDir = mv.d;

    render();
    setTimeout(commitMove, 180);
  }

  function commitMove() {
    if (winCells.size > 0) return;
    if (pendingIndex < 0 || pendingColor === EMPTY) { setStatus("先にマスをタップしてください"); return; }

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

  // ===== 先攻/後攻の切替 =====
  function applyHumanColorFromUI() {
    if (room) return; // オンライン中は混乱しやすいので固定
    const want = (rbHumanWhite && rbHumanWhite.checked) ? WHITE : BLACK;
    humanColor = want;

    // リセットして手番も整える（先攻は黒固定）
    reset();

    // 白（後攻）を選んだなら、開始直後にAI（黒）が動く
    maybeAIMove();
  }

  // ===== events =====
  function bindEvents() {
    quadBtns.forEach(b => b.addEventListener("click", () => selectQuad(Number(b.dataset.q))));
    dirBtns.forEach(b => b.addEventListener("click", () => selectDir(Number(b.dataset.d))));

    if (btnCommit) btnCommit.addEventListener("click", commitMove);
    if (btnUndo) btnUndo.addEventListener("click", undo);
    if (btnReset) btnReset.addEventListener("click", reset);

    if (btnApplyRoom) btnApplyRoom.addEventListener("click", () => setRoom((elRoomCode ? elRoomCode.value : "").trim()));

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

    // 先攻/後攻ラジオ
    if (rbHumanBlack) rbHumanBlack.addEventListener("change", applyHumanColorFromUI);
    if (rbHumanWhite) rbHumanWhite.addEventListener("change", applyHumanColorFromUI);

    // AIチェックが切り替わったら必要ならAIが動く
    if (cbAiWhite) cbAiWhite.addEventListener("change", () => {
      if (!room) maybeAIMove();
    });

    window.addEventListener("error", (ev) => {
      try { setStatus("JSエラー: " + (ev && ev.message ? ev.message : "Unknown error")); } catch {}
    });
  }

  function boot() {
    makeBoardUI();
    initFirebaseMaybe();

    makeSeatIfNeeded();
    if (elSeatLabel) elSeatLabel.textContent = seat;

    // 初期humanColor（UIに合わせる）
    humanColor = (rbHumanWhite && rbHumanWhite.checked) ? WHITE : BLACK;

    const r = parseRoomFromURL();
    if (r) {
      if (elRoomCode) elRoomCode.value = r;
      setRoom(r);
    } else {
      if (elRoomLabel) elRoomLabel.textContent = "—";
      setStatus("仮置き：マスをタップ（置き直しOK）");
    }

    bindEvents();
    winCells = computeWinCells(board);
    render();

    // 後攻選択なら開始直後にAIが先に打つ
    maybeAIMove();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

})();
