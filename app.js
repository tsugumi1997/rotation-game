/* app.js（全置換）
  - 小盤(3x3)をDOMでも4分割：各小盤が独立して回転アニメ
  - 小盤選択ボタンを盤の近くに配置（indexのnearControls）
  - AIの手番をゆっくり（思考→置く→回す→確定）
  - 置き直しOK：仮置きはいつでも差し替え可能
*/

(() => {
  const EMPTY = 0, BLACK = 1, WHITE = 2;

  // ===== Firebase 設定（あなたの値） =====
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

  // ===== DOM =====
  const elBoard = document.getElementById("board");
  const elTurnText = document.getElementById("turnText");
  const elPhaseText = document.getElementById("phaseText");
  const elEvalText = document.getElementById("evalText");
  const elBWText = document.getElementById("bwText");
  const elRoomLabel = document.getElementById("roomLabel");
  const elSeatLabel = document.getElementById("seatLabel");
  const elStatus = document.getElementById("statusText");

  const elCommit = document.getElementById("commit");
  const elUndo = document.getElementById("undo");
  const elReset = document.getElementById("reset");

  const elRoomCode = document.getElementById("roomCode");
  const elApplyRoom = document.getElementById("applyRoom");
  const elCopyLink = document.getElementById("copyLink");
  const elJoinBlack = document.getElementById("joinBlack");
  const elJoinWhite = document.getElementById("joinWhite");

  const elLocalBlack = document.getElementById("localBlack");
  const elLocalWhite = document.getElementById("localWhite");

  const elAiOn = document.getElementById("aiOn");

  const qBtns = Array.from(document.querySelectorAll(".qbtn"));
  const dBtns = Array.from(document.querySelectorAll(".dbtn"));

  // ===== State =====
  let board = Array(36).fill(EMPTY);

  // place: 仮置き / rotate: 回転選択
  let phase = "place";
  let turn = BLACK;

  let pendingIndex = -1;
  let pendingColor = EMPTY;

  let selectedQuad = 0;  // 0:左上 1:右上 2:左下 3:右下
  let selectedDir = -1;  // -1:左 1:右

  let winCells = new Set();

  // local/online
  let room = "";
  let online = false;
  let seat = ""; // "B" or "W" or ""(spectator)
  let localSeat = "B"; // ローカル時の自分

  let animLock = false;

  // ===== Utils =====
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function setStatus(msg) {
    if (elStatus) elStatus.textContent = msg;
  }
  function turnText(t) { return t === BLACK ? "黒の手番" : "白の手番"; }
  function seatText(s) { return s === "B" ? "B" : (s === "W" ? "W" : "—"); }

  function parseRoomFromURL() {
    try {
      const u = new URL(location.href);
      const r = u.searchParams.get("room");
      return (r && r.trim()) ? r.trim() : "";
    } catch { return ""; }
  }

  function countBW(bd) {
    let b = 0, w = 0;
    for (const v of bd) { if (v === BLACK) b++; else if (v === WHITE) w++; }
    return { b, w };
  }

  function canActNow() {
    if (!online) return true;
    if (!seat) return false;
    const myColor = seat === "B" ? BLACK : WHITE;
    return myColor === turn;
  }

  function isGameOver() {
    if (winCells && winCells.size >= 5) return true;
    return board.every(v => v !== EMPTY);
  }

  // ===== Board UI（小盤4分割） =====
  const quadEls = []; // 0..3
  function makeBoardUI() {
    elBoard.innerHTML = "";
    quadEls.length = 0;

    for (let q = 0; q < 4; q++) {
      const qb = document.createElement("div");
      qb.className = "quadBoard";
      qb.dataset.q = String(q);

      // 小盤自体をタップして選択できるようにする（近くに配置の補助）
      qb.addEventListener("click", (ev) => {
        // セルクリックは別で処理するので、セル以外をタップした時のみ小盤選択
        if (ev.target && ev.target.classList && ev.target.classList.contains("cell")) return;
        selectQuad(q);
      });

      // 9セル生成
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const idx = quadLocalToGlobal(q, r, c);

          const cell = document.createElement("div");
          cell.className = "cell";
          cell.dataset.i = String(idx);
          cell.dataset.mark = "0";
          cell.addEventListener("click", (e) => {
            e.stopPropagation();
            onCellClick(idx);
          });

          qb.appendChild(cell);
        }
      }

      elBoard.appendChild(qb);
      quadEls.push(qb);
    }
  }

  function quadLocalToGlobal(q, r, c) {
    const r0 = (q < 2) ? 0 : 3;
    const c0 = (q % 2 === 0) ? 0 : 3;
    return (r0 + r) * 6 + (c0 + c);
  }

  function quadIndices(q) {
    const r0 = (q < 2) ? 0 : 3;
    const c0 = (q % 2 === 0) ? 0 : 3;
    const idx = [];
    for (let r = r0; r < r0 + 3; r++) {
      for (let c = c0; c < c0 + 3; c++) idx.push(r * 6 + c);
    }
    return idx;
  }

  function cellEl(i) {
    return elBoard.querySelector(`.cell[data-i="${i}"]`);
  }

  function renderSelections() {
    qBtns.forEach(b => b.classList.toggle("selected", Number(b.dataset.q) === selectedQuad));
    dBtns.forEach(b => b.classList.toggle("selected", Number(b.dataset.d) === selectedDir));

    quadEls.forEach((qb, i) => qb.classList.toggle("selected", i === selectedQuad));
  }

  function render() {
    const { b, w } = countBW(board);
    elBWText.textContent = `${b} / ${w}`;
    elPhaseText.textContent = phase;
    elTurnText.textContent = turnText(turn);
    elRoomLabel.textContent = room ? room : "—";

    if (online) elSeatLabel.textContent = seatText(seat);
    else elSeatLabel.textContent = localSeat;

    renderSelections();

    // 表示用 marks（pendingはプレビュー）
    const marks = board.slice();
    if (pendingIndex >= 0 && pendingColor !== EMPTY) marks[pendingIndex] = pendingColor;

    // マス描画
    for (let i = 0; i < 36; i++) {
      const c = cellEl(i);
      if (!c) continue;
      c.dataset.mark = String(marks[i]);
      c.classList.toggle("pending", i === pendingIndex && pendingColor !== EMPTY);
      c.classList.toggle("win", winCells.has(i));
    }

    elEvalText.textContent = String(evaluate(board, turn));

    // 状態表示
    if (isGameOver()) {
      if (winCells.size >= 5) setStatus("ゲーム終了：勝利ライン！");
      else setStatus("ゲーム終了：引き分け");
    } else if (!canActNow()) {
      setStatus("相手の操作待ち（または観戦）");
    } else if (animLock) {
      setStatus("演出中…");
    } else if (phase === "place") {
      setStatus("仮置き：マスをタップ（置き直しOK）");
    } else {
      setStatus("回転を選んで「回転して確定」");
    }

    // ボタン無効
    elCommit.disabled = (!canActNow() || animLock || phase !== "rotate" || pendingIndex < 0 || selectedDir !== -1 && selectedDir !== 1);
    elUndo.disabled = online; // オンラインは安全のため無効
  }

  // ===== Rules =====
  function onCellClick(i) {
    if (isGameOver()) return;
    if (!canActNow()) return;
    if (animLock) return;

    // place中でもrotate中でも「仮置きの置き直し」を許可
    if (board[i] !== EMPTY) return;

    pendingIndex = i;
    pendingColor = turn;

    // 置いた感（少しだけ強調）
    const c = cellEl(i);
    if (c) {
      c.classList.add("justPlaced");
      setTimeout(() => c.classList.remove("justPlaced"), 320);
    }

    phase = "rotate";
    winCells.clear();

    render();
    syncIfOnline();
  }

  function selectQuad(q) {
    if (animLock) return;
    selectedQuad = q;
    render();
    syncIfOnline();
  }

  function selectDir(d) {
    if (animLock) return;
    selectedDir = d;
    render();
    syncIfOnline();
  }

  function rotateInPlace(bd, q, dir) {
    const idx = quadIndices(q);
    const m = idx.map(i => bd[i]);
    const out = m.slice();

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const src = r * 3 + c;
        let rr, cc;
        if (dir === 1) { rr = c; cc = 2 - r; }
        else { rr = 2 - c; cc = r; }
        const dst = rr * 3 + cc;
        out[dst] = m[src];
      }
    }
    for (let k = 0; k < 9; k++) bd[idx[k]] = out[k];
  }

  function animateQuadRotation(q, dir) {
    return new Promise((resolve) => {
      const qb = quadEls[q];
      if (!qb) { resolve(); return; }

      const cls = (dir === 1) ? "rotCW" : "rotCCW";
      qb.classList.remove("rotCW", "rotCCW");
      // reflow
      void qb.offsetWidth;
      qb.classList.add(cls);

      const done = () => {
        qb.classList.remove("rotCW", "rotCCW");
        qb.removeEventListener("animationend", done);
        resolve();
      };
      qb.addEventListener("animationend", done);
      // 保険
      setTimeout(done, 800);
    });
  }

  async function commitMove() {
    if (isGameOver()) return;
    if (!canActNow()) return;
    if (animLock) return;
    if (phase !== "rotate") return;
    if (pendingIndex < 0 || pendingColor === EMPTY) return;
    if (selectedDir !== -1 && selectedDir !== 1) return;

    animLock = true;
    render();

    // 1) 仮置きを確定（ここで盤面が確定するので、見やすく一拍）
    board[pendingIndex] = pendingColor;
    render();
    syncIfOnline();
    await sleep(260);

    // 2) 小盤だけ回すアニメ
    await animateQuadRotation(selectedQuad, selectedDir);

    // 3) ロジックの回転を反映
    rotateInPlace(board, selectedQuad, selectedDir);

    // 4) 勝利判定
    winCells = findWinCells(board);

    // 5) 次へ
    pendingIndex = -1;
    pendingColor = EMPTY;

    phase = "place";
    turn = (turn === BLACK) ? WHITE : BLACK;

    animLock = false;
    render();
    syncIfOnline();

    // ローカルAI
    maybeAiMove();
  }

  function resetGame() {
    if (online) {
      setStatus("オンライン中はResetは推奨しません（Roomを外してから）");
      return;
    }
    board = Array(36).fill(EMPTY);
    phase = "place";
    turn = BLACK;
    pendingIndex = -1;
    pendingColor = EMPTY;
    selectedQuad = 0;
    selectedDir = -1;
    winCells.clear();
    animLock = false;
    render();
    maybeAiMove();
  }

  function undoMove() {
    setStatus("Undoはこの版では未実装です（必要なら復活します）");
  }

  // ===== Win =====
  function findWinCells(bd) {
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    const res = new Set();

    function inBounds(r,c){ return r>=0 && r<6 && c>=0 && c<6; }

    for (let r=0;r<6;r++){
      for (let c=0;c<6;c++){
        const v = bd[r*6+c];
        if (v===EMPTY) continue;

        for (const [dr,dc] of dirs){
          const cells = [];
          let rr=r, cc=c;
          while (inBounds(rr,cc) && bd[rr*6+cc]===v){
            cells.push(rr*6+cc);
            rr+=dr; cc+=dc;
          }
          if (cells.length>=5){
            for (let i=0;i<5;i++) res.add(cells[i]);
            return res;
          }
        }
      }
    }
    return res;
  }

  // ===== Eval（簡易） =====
  function evaluate(bd, perspectiveTurn) {
    const me = perspectiveTurn;
    const op = me === BLACK ? WHITE : BLACK;

    const lines = allFiveLines();

    const scoreSide = (color) => {
      let s = 0;
      const centers = [14,15,20,21];
      for (const i of centers) if (bd[i] === color) s += 2;

      for (const line of lines) {
        let mine=0, opp=0;
        for (const i of line){
          if (bd[i] === color) mine++;
          else if (bd[i] !== EMPTY) opp++;
        }
        if (opp === 0){
          if (mine===1) s += 1;
          else if (mine===2) s += 3;
          else if (mine===3) s += 7;
          else if (mine===4) s += 18;
          else if (mine>=5) s += 999;
        }
      }
      return s;
    };

    return scoreSide(me) - scoreSide(op);
  }

  function allFiveLines() {
    const lines = [];
    for (let r=0;r<6;r++) for (let c=0;c<=1;c++) lines.push([0,1,2,3,4].map(k=>r*6+(c+k)));
    for (let c=0;c<6;c++) for (let r=0;r<=1;r++) lines.push([0,1,2,3,4].map(k=>(r+k)*6+c));
    for (let r=0;r<=1;r++) for (let c=0;c<=1;c++) lines.push([0,1,2,3,4].map(k=>(r+k)*6+(c+k)));
    for (let r=0;r<=1;r++) for (let c=4;c<=5;c++) lines.push([0,1,2,3,4].map(k=>(r+k)*6+(c-k)));
    return lines;
  }

  // ===== AI（ローカルのみ：ゆっくり） =====
  async function maybeAiMove() {
    if (online) return;
    if (!elAiOn.checked) return;
    if (isGameOver()) return;
    if (animLock) return;

    const myColor = (localSeat === "B") ? BLACK : WHITE;
    const aiColor = (myColor === BLACK) ? WHITE : BLACK;

    if (turn !== aiColor) return;

    animLock = true;
    setStatus("AI思考中…");
    render();
    await sleep(850);

    // AI: (placeIdx, quad, dir) を選ぶ
    const mv = pickAiMove(board.slice(), aiColor);
    if (!mv) { animLock = false; render(); return; }

    // 置く（見やすく）
    pendingIndex = mv.place;
    pendingColor = aiColor;
    phase = "rotate";
    selectedQuad = mv.quad;
    selectedDir = mv.dir;
    render();
    syncIfOnline();
    await sleep(620);

    // 確定（回転も含めてゆっくり）
    animLock = false;
    await commitMove();
  }

  function pickAiMove(bd, aiColor) {
    const empties = [];
    for (let i=0;i<36;i++) if (bd[i]===EMPTY) empties.push(i);
    if (empties.length===0) return null;

    let bestScore = -1e18;
    let best = [];

    for (const p of empties) {
      for (let q=0;q<4;q++){
        for (const d of [-1,1]){
          const sim = bd.slice();
          sim[p] = aiColor;
          rotateInPlace(sim, q, d);

          const win = findWinCells(sim);
          let sc = 0;

          if (win.size>=5) sc = 1e9;
          else {
            sc = evaluate(sim, aiColor);

            const op = aiColor===BLACK ? WHITE : BLACK;
            if (opponentImmediateWin(sim, op)) sc -= 5000;

            sc += (Math.random()-0.5)*2.0;
          }

          if (sc > bestScore + 1e-9){
            bestScore = sc;
            best = [{ place:p, quad:q, dir:d }];
          } else if (Math.abs(sc-bestScore) < 2.0) {
            best.push({ place:p, quad:q, dir:d });
          }
        }
      }
    }
    return best[Math.floor(Math.random()*best.length)];
  }

  function opponentImmediateWin(bd, opColor) {
    const empties = [];
    for (let i=0;i<36;i++) if (bd[i]===EMPTY) empties.push(i);

    for (const p of empties){
      for (let q=0;q<4;q++){
        for (const d of [-1,1]){
          const sim = bd.slice();
          sim[p] = opColor;
          rotateInPlace(sim, q, d);
          if (findWinCells(sim).size>=5) return true;
        }
      }
    }
    return false;
  }

  // ===== Firebase Online Sync（簡易） =====
  let db = null;
  let roomRef = null;

  const clientId = (() => {
    const k = "rotationGameClientId";
    const v = localStorage.getItem(k);
    if (v) return v;
    const nv = Math.random().toString(16).slice(2) + Date.now().toString(16);
    localStorage.setItem(k, nv);
    return nv;
  })();

  function initFirebaseMaybe() {
    try {
      if (!window.firebase || !firebase.initializeApp) return;
      if (!firebase.apps || firebase.apps.length === 0) firebase.initializeApp(firebaseConfig);
      db = firebase.database();
    } catch {}
  }

  function syncIfOnline() {
    if (!online || !db || !roomRef) return;
    const payload = {
      board,
      phase,
      turn,
      pendingIndex,
      pendingColor,
      selectedQuad,
      selectedDir,
      updatedAt: Date.now()
    };
    roomRef.child("state").set(payload);
  }

  function startRoomListener() {
    if (!db || !room) return;
    online = true;
    roomRef = db.ref(`rooms/${room}`);

    // state
    roomRef.child("state").on("value", (snap) => {
      const v = snap.val();
      if (!v) return;

      if (Array.isArray(v.board) && v.board.length===36) board = v.board.slice();
      if (typeof v.phase==="string") phase = v.phase;
      if (v.turn===BLACK || v.turn===WHITE) turn = v.turn;

      if (typeof v.pendingIndex==="number") pendingIndex = v.pendingIndex;
      if (v.pendingColor===EMPTY || v.pendingColor===BLACK || v.pendingColor===WHITE) pendingColor = v.pendingColor;

      if (typeof v.selectedQuad==="number") selectedQuad = v.selectedQuad;
      if (v.selectedDir===-1 || v.selectedDir===1) selectedDir = v.selectedDir;

      winCells = findWinCells(board);
      render();
    });

    // seats
    roomRef.child("seats").on("value", (snap) => {
      const seats = snap.val() || {};
      let mySeat = "";
      for (const k of Object.keys(seats)) if (seats[k] === clientId) mySeat = k;
      seat = mySeat;
      render();
    });

    // 初期state作成
    roomRef.child("state").get().then((snap) => {
      if (!snap.exists()) {
        roomRef.child("state").set({
          board: Array(36).fill(EMPTY),
          phase: "place",
          turn: BLACK,
          pendingIndex: -1,
          pendingColor: EMPTY,
          selectedQuad: 0,
          selectedDir: -1,
          updatedAt: Date.now()
        });
      }
    });
  }

  async function joinSeat(want) {
    if (!online || !roomRef) return;
    const seatsRef = roomRef.child("seats");
    const snap = await seatsRef.get();
    const seats = snap.val() || {};

    if (!seats[want] || seats[want] === clientId) {
      seats[want] = clientId;
      const other = want === "B" ? "W" : "B";
      if (seats[other] === clientId) delete seats[other];
      await seatsRef.set(seats);
      seat = want;
      render();
      return;
    }
    setStatus(`その席（${want}）は埋まっています`);
  }

  function setRoom(r) {
    room = (r || "").trim();
    elRoomLabel.textContent = room ? room : "—";
    if (elRoomCode) elRoomCode.value = room;

    try {
      const u = new URL(location.href);
      if (room) u.searchParams.set("room", room);
      else u.searchParams.delete("room");
      history.replaceState(null, "", u.toString());
    } catch {}

    if (room && db) startRoomListener();
    render();
  }

  // ===== Events =====
  function bindEvents() {
    qBtns.forEach(b => b.addEventListener("click", () => selectQuad(Number(b.dataset.q))));
    dBtns.forEach(b => b.addEventListener("click", () => selectDir(Number(b.dataset.d))));

    elCommit.addEventListener("click", () => { commitMove(); });
    elUndo.addEventListener("click", undoMove);
    elReset.addEventListener("click", resetGame);

    elLocalBlack.addEventListener("click", () => {
      localSeat = "B";
      elLocalBlack.classList.add("selected");
      elLocalWhite.classList.remove("selected");
      render();
      maybeAiMove();
    });
    elLocalWhite.addEventListener("click", () => {
      localSeat = "W";
      elLocalWhite.classList.add("selected");
      elLocalBlack.classList.remove("selected");
      render();
      maybeAiMove();
    });

    elAiOn.addEventListener("change", () => { render(); maybeAiMove(); });

    elApplyRoom.addEventListener("click", () => {
      const r = (elRoomCode.value || "").trim();
      if (!r) { setStatus("room番号を入れてください"); return; }
      setRoom(r);
    });

    elCopyLink.addEventListener("click", async () => {
      const r = (elRoomCode.value || room || "").trim();
      const u = new URL(location.href);
      if (r) u.searchParams.set("room", r);
      else u.searchParams.delete("room");
      try {
        await navigator.clipboard.writeText(u.toString());
        setStatus("共有URLをコピーしました");
      } catch {
        setStatus("コピーに失敗：手動でURLを共有してください");
      }
    });

    elJoinBlack.addEventListener("click", () => joinSeat("B"));
    elJoinWhite.addEventListener("click", () => joinSeat("W"));
  }

  // ===== Boot =====
  function boot() {
    makeBoardUI();
    initFirebaseMaybe();
    bindEvents();

    selectQuad(0);
    selectDir(-1);

    const r = parseRoomFromURL();
    if (r && db) {
      setRoom(r);
    } else {
      room = r || "";
      elRoomLabel.textContent = room ? room : "—";
      if (room && elRoomCode) elRoomCode.value = room;
      render();
      maybeAiMove();
    }
  }

  window.addEventListener("error", (ev) => {
    try {
      const msg = ev && ev.message ? ev.message : "Unknown error";
      setStatus("JSエラー: " + msg);
    } catch {}
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
