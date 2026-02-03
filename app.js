/* app.js（全置換・人間っぽいAI版）
 - 基本仕様は前の安定版と同じ
 - AI（白）は「勝つ/防ぐ/伸ばす」を優先する軽量ヒューリスティック
*/

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
    if (elSeatLabel) elSeatLabel.textContent = seat ? seat : "—";

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

  function onCellClick(i) {
    if (winCells.size > 0) return;
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

  // ===== 勝利判定（5連） =====
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

  // ===== AI（人間っぽい：勝つ/防ぐ/伸ばす） =====
  function listEmptyCells(bd, fx) {
    const res = [];
    for (let i = 0; i < 36; i++) if (!fx[i] && bd[i] === EMPTY) res.push(i);
    return res;
  }

  function simulateMove(color, placeIdx, q, dir) {
    const bd = board.slice();
    const fx = fixed.slice();

    bd[placeIdx] = color;
    fx[placeIdx] = true;
    rotateQuadrantOn(bd, fx, q, dir);

    const wins = computeWinCells(bd);
    return { bd, fx, wins };
  }

  function scorePosition(bd, myColor) {
    // 軽量：ライン内の連結長っぽいものを雑に加点（人間っぽい）
    // 連結数を厳密には数えず、「自色が多いライン」を優先するだけ
    const opp = (myColor === BLACK ? WHITE : BLACK);

    const lines = [];
    for (let r = 0; r < 6; r++) lines.push(Array.from({length:6},(_,c)=>r*6+c));
    for (let c = 0; c < 6; c++) lines.push(Array.from({length:6},(_,r)=>r*6+c));
    lines.push([0,7,14,21,28,35]);
    lines.push([1,8,15,22,29,36].filter(x=>x<36)); // 念のため
    lines.push([6,13,20,27,34].filter(x=>x<36));
    lines.push([5,10,15,20,25,30]);
    lines.push([4,9,14,19,24,29,34].filter(x=>x<36));
    lines.push([11,16,21,26,31].filter(x=>x<36));

    let score = 0;
    for (const line of lines) {
      let my = 0, op = 0;
      for (const idx of line) {
        if (bd[idx] === myColor) my++;
        else if (bd[idx] === opp) op++;
      }
      // 両方混ざってるラインは価値低い
      if (my > 0 && op > 0) continue;

      // 伸びそうなラインを加点
      if (my > 0 && op === 0) score += my * my * 3;   // 2->12, 3->27, 4->48
      if (op > 0 && my === 0) score -= op * op * 2;   // 相手の芽は減点
    }
    return score;
  }

  function aiChooseMoveHumanLike() {
    const my = WHITE;
    const opp = BLACK;

    const empties = listEmptyCells(board, fixed);
    if (empties.length === 0) return null;

    const candidates = [];

    // 候補を作る（置き場所×回転小盤×方向）
    for (const idx of empties) {
      for (let q = 0; q < 4; q++) {
        for (const d of [-1, 1]) {
          const sim = simulateMove(my, idx, q, d);

          // 1) 即勝ちなら最優先
          if (sim.wins.size > 0) {
            candidates.push({ idx, q, d, score: 1e9 });
            continue;
          }

          // 2) 相手の即勝ちをどれだけ潰せるかを見る（次手で相手が勝てる局面を減らす）
          // 相手の「次の一手勝ち」をざっくり検査（全部は重いのでサンプル）
          let oppWinThreat = 0;
          const empt2 = listEmptyCells(sim.bd, sim.fx);
          // 最大30個程度にサンプル（人間っぽい“読みの浅さ”にもなる）
          const sample = empt2.slice(0, 30);

          for (const j of sample) {
            // 相手は回転もあるので、2方向だけ・小盤4で軽く
            for (let qq = 0; qq < 4; qq++) {
              for (const dd of [-1, 1]) {
                const sim2 = (() => {
                  const bd2 = sim.bd.slice();
                  const fx2 = sim.fx.slice();
                  bd2[j] = opp; fx2[j] = true;
                  rotateQuadrantOn(bd2, fx2, qq, dd);
                  return computeWinCells(bd2).size > 0;
                })();
                if (sim2) { oppWinThreat++; qq = 4; break; } // 1個見つかったら強い脅威として数える
              }
            }
          }

          // 3) 盤面の形勢（伸ばす/邪魔する）を雑に評価
          const shapeScore = scorePosition(sim.bd, my);

          // 総合スコア：相手の脅威を減らすほど良い、形勢も少し見る
          const score = shapeScore - oppWinThreat * 60;

          candidates.push({ idx, q, d, score });
        }
      }
    }

    // スコア順
    candidates.sort((a,b)=>b.score-a.score);

    // 人間っぽさ：最善100%だと機械なので、上位から少しブレさせる
    const top = candidates.slice(0, 8);
    const pick = top[Math.floor(Math.random() * Math.min(3, top.length))]; // 上位3からランダム
    return pick || candidates[0];
  }

  function aiMoveHumanLike() {
    if (winCells.size > 0) return;
    if (turn !== WHITE) return;

    const mv = aiChooseMoveHumanLike();
    if (!mv) return;

    pendingIndex = mv.idx;
    pendingColor = WHITE;
    phase = "rotate";
    selectedQuad = mv.q;
    selectedDir = mv.d;

    render();
    syncToOnline();
    setTimeout(commitMove, 180);
  }

  function commitMove() {
    if (winCells.size > 0) return;
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

    // AI（白）: オンライン中は相手とぶつかるのでローカルだけ
    if (cbAiWhite && cbAiWhite.checked && turn === WHITE && !room) {
      setTimeout(aiMoveHumanLike, 200);
    }
  }

  function bindEvents() {
    quadBtns.forEach(b => b.addEventListener("click", () => selectQuad(Number(b.dataset.q))));
    dirBtns.forEach(b => b.addEventListener("click", () => selectDir(Number(b.dataset.d))));

    if (btnCommit) btnCommit.addEventListener("click", commitMove);
    if (btnUndo) btnUndo.addEventListener("click", undo);
    if (btnReset) btnReset.addEventListener("click", reset);

    if (btnApplyRoom) {
      btnApplyRoom.addEventListener("click", () => {
        const r = (elRoomCode ? elRoomCode.value : "").trim();
        setRoom(r);
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

    window.addEventListener("error", (ev) => {
      try { setStatus("JSエラー: " + (ev && ev.message ? ev.message : "Unknown error")); } catch {}
    });
  }

  function boot() {
    makeBoardUI();
    initFirebaseMaybe();

    makeSeatIfNeeded();
    if (elSeatLabel) elSeatLabel.textContent = seat;

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
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // ===== ここから下は undo/reset =====
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
  }
})();
