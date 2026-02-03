(() => {
  "use strict";

  // ===== 定数 =====
  const EMPTY = 0, BLACK = 1, WHITE = 2;

  // ===== DOM =====
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

  // ===== ゲーム状態 =====
  let board = Array(36).fill(EMPTY);
  let fixed = Array(36).fill(false);

  let turn = BLACK;
  let phase = "place";        // "place" | "rotate"
  let pendingIndex = -1;      // 仮置き位置
  let pendingColor = EMPTY;

  let selectedQuad = 0;       // 0=左上,1=右上,2=左下,3=右下
  let selectedDir = 1;        // -1=左, 1=右

  let history = [];
  let winCells = new Set();

  // ===== ローカル用：先攻/後攻 =====
  let humanColor = BLACK; // default
  function aiColorLocal() { return (humanColor === BLACK ? WHITE : BLACK); }

  // ===== Firebase（オンライン） =====
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

  // オンライン席
  // seat: "B" | "W" | "S"(spectator) | ""
  let seat = "";

  // クライアントID（同一端末なら固定）
  const clientId = (() => {
    const key = "pentago_client_id";
    let v = localStorage.getItem(key);
    if (!v) {
      v = "c_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
      localStorage.setItem(key, v);
    }
    return v;
  })();

  // listeners
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

      if (!black) {
        cur.black = clientId;
        cur.tBlack = Date.now();
        return cur;
      }
      if (!white) {
        cur.white = clientId;
        cur.tWhite = Date.now();
        return cur;
      }
      return cur; // 観戦
    });

    const val = result && result.snapshot ? result.snapshot.val() : null;
    if (!val) { seat = "S"; return; }

    if (val.black === clientId) seat = "B";
    else if (val.white === clientId) seat = "W";
    else seat = "S";

    // presence + onDisconnect
    try {
      const p = presenceRef();
      p.set({ seat, ts: Date.now() });
      p.onDisconnect().remove();

      // 自分の席は切断時に開放（簡易）
      if (seat === "B") ref.child("black").onDisconnect().remove();
      if (seat === "W") ref.child("white").onDisconnect().remove();
    } catch {}
  }

  function lockLocalOnlyUI(isOnline) {
    // オンライン中：先攻/後攻のラジオは無効（席は自動）
    if (rbHumanBlack) rbHumanBlack.disabled = isOnline;
    if (rbHumanWhite) rbHumanWhite.disabled = isOnline;

    // オンライン中：AIも無効（競合防止）
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
      // ローカルAIの再評価
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

    // state初期化（存在しなければ作る）
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

  // ===== 盤UI生成 =====
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

  // ===== 簡易評価表示 =====
  function countBW(arr) {
    let b = 0, w = 0;
    for (const v of arr) {
      if (v === BLACK) b++;
      else if (v === WHITE) w++;
    }
    return { b, w };
  }

  function currentEvalSimple() {
    const { b, w } = countBW(board);
    let v = (b - w);
    if (pendingIndex >= 0 && pendingColor !== EMPTY) v += (pendingColor === BLACK ? 1 : -1);
    return v;
  }

  // ===== 入力可否 =====
  function canHumanActNow() {
    if (room) {
      if (seat === "B" && turn === BLACK) return true;
      if (seat === "W" && turn === WHITE) return true;
      return false;
    } else {
      return turn === humanColor;
    }
  }

  // ===== 描画 =====
  function render() {
    if (elTurnText) elTurnText.textContent = (turn === BLACK ? "黒の手番" : "白の手番");
    if (elPhaseText) elPhaseText.textContent = phase;
    if (elEvalText) elEvalText.textContent = String(currentEvalSimple());

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

  // ===== マスクリック：仮置き（選び直しOK） =====
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

  // ===== Undo / Reset =====
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
    maybeAIMove(); // ★ローカルAI再評価
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
    maybeAIMove(); // ★ローカルAI再評価
  }

  // ===== ローカル：人間色の切替 =====
  function applyHumanColorFromUI() {
    if (room) return; // オンラインでは無効
    humanColor = (rbHumanWhite && rbHumanWhite.checked) ? WHITE : BLACK;
    reset();          // reset内でmaybeAIMoveも呼ばれる
  }

  // ===== “人間っぽいAI”（軽量） =====
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
    for (let r = 0; r < 6; r++) lines.push(Array.from({ length: 6 }, (_, c) => r * 6 + c));
    for (let c = 0; c < 6; c++) lines.push(Array.from({ length: 6 }, (_, r) => r * 6 + c));
    lines.push([0, 7, 14, 21, 28, 35]);
    lines.push([5, 10, 15, 20, 25, 30]);

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

          // 相手の次の即勝ち脅威を軽く数える
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

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, 8);
    const pick = top[Math.floor(Math.random() * Math.min(3, top.length))];
    return pick || candidates[0];
  }

  function maybeAIMove() {
    // ★オンライン中はAI停止
    if (room) return;
    if (!cbAiWhite || !cbAiWhite.checked) return;
    if (winCells.size > 0) return;

    const ai = aiColorLocal();
    if (turn !== ai) return;               // AIの番だけ動く
    if (phase !== "place") return;         // まだ確定前の操作中なら待つ
    if (pendingIndex >= 0) return;         // 仮置きが残ってたら待つ

    const mv = aiChooseMoveHumanLike(ai);
    if (!mv) return;

    // AIは置いて回して確定まで自動
    pendingIndex = mv.idx;
    pendingColor = ai;
    phase = "rotate";
    selectedQuad = mv.q;
    selectedDir = mv.d;

    render();
    // commitは少し遅らせて見た目が追えるように
    setTimeout(commitMove, 200);
  }

  // ===== 確定処理 =====
  function commitMove() {
    if (winCells.size > 0) return;
    if (!canHumanActNow() && !(!room && cbAiWhite && cbAiWhite.checked && turn === aiColorLocal())) {
      // ローカルAIが呼ぶ場合も通すための保険
      // （オンラインはcanHumanActNowだけ）
      if (room) return;
    }

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
    maybeAIMove(); // ★ローカルAI再評価（相手番なら動く）
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
        try {
          await navigator.clipboard.writeText(u.toString());
          setStatus("共有URLをコピーしました");
        } catch {
          setStatus("コピーできませんでした（手動でURLを共有してください）");
        }
      });
    }

    if (rbHumanBlack) rbHumanBlack.addEventListener("change", applyHumanColorFromUI);
    if (rbHumanWhite) rbHumanWhite.addEventListener("change", applyHumanColorFromUI);

    if (cbAiWhite) {
      cbAiWhite.addEventListener("change", () => {
        // ローカルだけ：AIをONにした瞬間、AIの番なら動く
        maybeAIMove();
      });
    }

    window.addEventListener("error", (ev) => {
      try {
        const msg = ev && ev.message ? ev.message : "Unknown error";
        setStatus("JSエラー: " + msg);
      } catch {}
    });
  }

  // ===== 起動 =====
  async function boot() {
    makeBoardUI();
    initFirebaseMaybe();

    // ローカル人間色（UI反映）
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
    maybeAIMove(); // ★開始時にAIの番なら動く
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { boot(); });
  } else {
    boot();
  }

})();
