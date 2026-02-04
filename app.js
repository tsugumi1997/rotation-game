/* app.js（全置換）
 - GitHub PagesのURLはそのまま
 - Firebase Realtime Databaseでオンライン同期（room）
 - 置き直しOK：place中は何度でも仮置き変更 → 回転して確定
 - 3×3強調、置く/回転アニメ、pending強化、盤と操作を近く（CSS側）
 - AI（ローカルのみ）：人間っぽく（少しランダム＋簡易1手読み）
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

  // place: 仮置き（置き直しOK） / rotate: 回転選択 → commit
  let phase = "place";
  let turn = BLACK;

  let pendingIndex = -1;     // 仮置き位置
  let pendingColor = EMPTY;  // 仮置き色（基本 turn と同じ）

  let selectedQuad = 0; // 0:左上 1:右上 2:左下 3:右下
  let selectedDir = -1; // -1:左 1:右

  let winCells = new Set();

  // local/online
  let room = "";
  let online = false;
  let seat = ""; // "B" or "W" or ""(spectator)
  let localSeat = "B"; // ローカル時の自分の色

  // history（ローカルのみ）
  const history = [];
  function pushHistory() {
    history.push({
      board: board.slice(),
      phase,
      turn,
      pendingIndex,
      pendingColor,
      selectedQuad,
      selectedDir,
      winCells: new Set(Array.from(winCells))
    });
    if (history.length > 60) history.shift();
  }
  function popHistory() {
    const s = history.pop();
    if (!s) return;
    board = s.board.slice();
    phase = s.phase;
    turn = s.turn;
    pendingIndex = s.pendingIndex;
    pendingColor = s.pendingColor;
    selectedQuad = s.selectedQuad;
    selectedDir = s.selectedDir;
    winCells = new Set(Array.from(s.winCells));
  }

  // ===== Utils =====
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function setStatus(msg) {
    if (elStatus) elStatus.textContent = msg;
  }

  function turnText(t) {
    return t === BLACK ? "黒の手番" : "白の手番";
  }

  function seatText(s) {
    if (!s) return "—";
    return s === "B" ? "B" : "W";
  }

  function countBW(bd) {
    let b = 0, w = 0;
    for (const v of bd) { if (v === BLACK) b++; else if (v === WHITE) w++; }
    return { b, w };
  }

  function parseRoomFromURL() {
    try {
      const u = new URL(location.href);
      const r = u.searchParams.get("room");
      return (r && r.trim()) ? r.trim() : "";
    } catch {
      return "";
    }
  }

  function setRoomLabel() {
    elRoomLabel.textContent = room ? room : "—";
  }

  function setSeatLabel() {
    if (online) elSeatLabel.textContent = seatText(seat);
    else elSeatLabel.textContent = localSeat;
  }

  function canActNow() {
    if (!online) return true;
    if (!seat) return false; // spectator
    // seat = "B"/"W" は turn (BLACK/WHITE) に対応
    const myColor = seat === "B" ? BLACK : WHITE;
    return myColor === turn;
  }

  function isGameOver() {
    // どちらか勝利ラインがあれば終了扱い
    if (winCells && winCells.size >= 5) return true;
    // 盤が埋まっている場合も終了
    return board.every(v => v !== EMPTY);
  }

  // ===== Board UI =====
  function makeBoardUI() {
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

  function cellEl(i) {
    return elBoard.querySelector(`.cell[data-i="${i}"]`);
  }

  function quadIndices(q) {
    // 6x6: each 3x3 block
    // q0: rows 0-2 cols 0-2
    // q1: rows 0-2 cols 3-5
    // q2: rows 3-5 cols 0-2
    // q3: rows 3-5 cols 3-5
    const r0 = (q < 2) ? 0 : 3;
    const c0 = (q % 2 === 0) ? 0 : 3;
    const idx = [];
    for (let r = r0; r < r0 + 3; r++) {
      for (let c = c0; c < c0 + 3; c++) {
        idx.push(r * 6 + c);
      }
    }
    return idx;
  }

  function applyPendingPreviewToMarks(marks) {
    // marksは表示用（boardを汚さない）
    if (pendingIndex >= 0 && pendingColor !== EMPTY) {
      marks[pendingIndex] = pendingColor;
    }
  }

  function renderSelections() {
    qBtns.forEach(b => b.classList.toggle("selected", Number(b.dataset.q) === selectedQuad));
    dBtns.forEach(b => b.classList.toggle("selected", Number(b.dataset.d) === selectedDir));
  }

  function highlightQuad() {
    const all = elBoard.querySelectorAll(".cell");
    all.forEach(c => c.classList.remove("quadSel"));
    // rotate中だけ強調（見失い防止）
    if (phase !== "rotate") return;
    const idx = quadIndices(selectedQuad);
    for (const i of idx) {
      const c = cellEl(i);
      if (c) c.classList.add("quadSel");
    }
  }

  function render() {
    setSeatLabel();

    const marks = board.slice();
    applyPendingPreviewToMarks(marks);

    const { b, w } = countBW(board);
    elBWText.textContent = `${b} / ${w}`;
    elPhaseText.textContent = phase;
    elTurnText.textContent = turnText(turn);

    setRoomLabel();
    renderSelections();
    highlightQuad();

    // 盤面
    for (let i = 0; i < 36; i++) {
      const c = cellEl(i);
      if (!c) continue;

      c.dataset.mark = String(marks[i]);

      c.classList.toggle("pending", i === pendingIndex && pendingColor !== EMPTY);
      c.classList.toggle("win", winCells.has(i));
    }

    // eval（簡易）
    elEvalText.textContent = String(evaluate(board, turn));

    // status
    if (isGameOver()) {
      if (winCells.size >= 5) setStatus("ゲーム終了：勝利ライン！");
      else setStatus("ゲーム終了：引き分け");
    } else if (!canActNow()) {
      setStatus("相手の操作待ち（または観戦）");
    } else if (phase === "place") {
      setStatus("仮置き：マスをタップ（置き直しOK）");
    } else {
      setStatus("回転を選んで「回転して確定」");
    }
  }

  // ===== Rules =====
  function onCellClick(i) {
    if (isGameOver()) return;
    if (!canActNow()) return;

    if (phase !== "place") return;

    // 確定石があるマスは置けない
    if (board[i] !== EMPTY) return;

    // 仮置きは何度でも置き直しOK
    pendingIndex = i;
    pendingColor = turn;

    // “置いた”の視認性：少しだけアニメ（クラス一瞬）
    const c = cellEl(i);
    if (c) {
      c.classList.add("justPlaced");
      setTimeout(() => c.classList.remove("justPlaced"), 260);
    }

    // 置いたら回転フェーズへ（でも見失わないように少し待つ）
    phase = "rotate";
    winCells.clear();

    render();
    syncIfOnline();
  }

  function selectQuad(q) {
    selectedQuad = q;
    render();
    syncIfOnline();
  }

  function selectDir(d) {
    selectedDir = d;
    render();
    syncIfOnline();
  }

  function rotateInPlace(bd, q, dir) {
    // dir: -1 left(CCW), 1 right(CW)
    const idx = quadIndices(q);

    // idxは行優先の 3x3: [0..8]
    const m = idx.map(i => bd[i]);
    const out = m.slice();

    // 3x3回転
    // 元 (r,c) -> CW: (c,2-r) / CCW: (2-c,r)
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

  function commitMove() {
    if (isGameOver()) return;
    if (!canActNow()) return;
    if (phase !== "rotate") return;
    if (pendingIndex < 0 || pendingColor === EMPTY) return;

    // ローカルはundo用に履歴
    if (!online) pushHistory();

    // まず仮置きを確定
    board[pendingIndex] = pendingColor;

    // 回転（見やすいように一瞬アニメ）
    elBoard.style.setProperty("--rot", (selectedDir === 1 ? "12deg" : "-12deg"));
    elBoard.classList.add("rotating");
    setTimeout(() => elBoard.classList.remove("rotating"), 380);

    rotateInPlace(board, selectedQuad, selectedDir);

    // 勝利判定（簡易：5連）
    winCells = findWinCells(board);
    pendingIndex = -1;
    pendingColor = EMPTY;

    // 次手へ（見失い防止に少しだけ遅延）
    phase = "place";
    turn = (turn === BLACK) ? WHITE : BLACK;

    render();
    syncIfOnline();

    // ローカルAI
    maybeAiMove();
  }

  function resetGame() {
    if (online) {
      // オンラインは「自分だけ」ではなく共有なので、強制リセットしない（事故防止）
      setStatus("オンライン中はResetはローカルのみ推奨です（Roomを外してから）");
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
    history.length = 0;
    render();
    maybeAiMove();
  }

  function undoMove() {
    if (online) {
      setStatus("オンライン中のUndoは無効です（同期事故防止）");
      return;
    }
    popHistory();
    render();
  }

  // ===== Win (5 in a row) =====
  function findWinCells(bd) {
    // 5連以上を見つけたら、そのうち5個を返す（表示用）
    const dirs = [
      [0, 1],   // →
      [1, 0],   // ↓
      [1, 1],   // ↘
      [1, -1],  // ↙
    ];
    const res = new Set();

    function inBounds(r, c) { return r >= 0 && r < 6 && c >= 0 && c < 6; }

    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        const v = bd[r * 6 + c];
        if (v === EMPTY) continue;

        for (const [dr, dc] of dirs) {
          const cells = [];
          let rr = r, cc = c;
          while (inBounds(rr, cc) && bd[rr * 6 + cc] === v) {
            cells.push(rr * 6 + cc);
            rr += dr; cc += dc;
          }
          if (cells.length >= 5) {
            // 最初の5個を採用
            for (let i = 0; i < 5; i++) res.add(cells[i]);
            return res;
          }
        }
      }
    }
    return res;
  }

  // ===== Eval (簡易) =====
  function evaluate(bd, perspectiveTurn) {
    // とても簡易：自分の“伸び” - 相手の“伸び”
    // 直線方向の連結数＋中央寄りを少し加点
    const me = perspectiveTurn;
    const op = me === BLACK ? WHITE : BLACK;

    const scoreSide = (color) => {
      let s = 0;

      // 中央寄り
      const centers = [14, 15, 20, 21]; // だいたい中央
      for (const i of centers) if (bd[i] === color) s += 2;

      // 連のポテンシャル（5連候補ラインの点数）
      const lines = allFiveLines();
      for (const line of lines) {
        let mine = 0, opp = 0;
        for (const i of line) {
          if (bd[i] === color) mine++;
          else if (bd[i] !== EMPTY) opp++;
        }
        if (opp === 0) {
          // 相手がいなければ伸びる
          if (mine === 1) s += 1;
          else if (mine === 2) s += 3;
          else if (mine === 3) s += 7;
          else if (mine === 4) s += 18;
          else if (mine >= 5) s += 999;
        }
      }
      return s;
    };

    return scoreSide(me) - scoreSide(op);
  }

  function allFiveLines() {
    // 6x6 の 5連ラインを全部生成
    const lines = [];
    // 横
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c <= 1; c++) {
        lines.push([0,1,2,3,4].map(k => r*6 + (c+k)));
      }
    }
    // 縦
    for (let c = 0; c < 6; c++) {
      for (let r = 0; r <= 1; r++) {
        lines.push([0,1,2,3,4].map(k => (r+k)*6 + c));
      }
    }
    // 斜め↘
    for (let r = 0; r <= 1; r++) {
      for (let c = 0; c <= 1; c++) {
        lines.push([0,1,2,3,4].map(k => (r+k)*6 + (c+k)));
      }
    }
    // 斜め↙
    for (let r = 0; r <= 1; r++) {
      for (let c = 4; c <= 5; c++) {
        lines.push([0,1,2,3,4].map(k => (r+k)*6 + (c-k)));
      }
    }
    return lines;
  }

  // ===== AI（ローカルのみ） =====
  async function maybeAiMove() {
    if (online) return;
    if (!elAiOn.checked) return;

    const myColor = (localSeat === "B") ? BLACK : WHITE;
    const aiColor = (myColor === BLACK) ? WHITE : BLACK;

    if (turn !== aiColor) return;
    if (isGameOver()) return;

    // AIは “place → rotate → commit” を自動でやる
    // 人間っぽく：少し考える時間
    setStatus("AI思考中…");
    await sleep(450);

    const best = pickAiMove(board.slice(), aiColor);
    if (!best) return;

    // place
    pendingIndex = best.place;
    pendingColor = aiColor;
    phase = "rotate";
    selectedQuad = best.quad;
    selectedDir = best.dir;

    render();
    await sleep(380);

    // commit
    commitMove();
  }

  function pickAiMove(bd, aiColor) {
    // 1手読み（place+rotate）をざっくり探索
    // 全空点×(4×2)=最大 36*8=288 なので軽い
    const empties = [];
    for (let i = 0; i < 36; i++) if (bd[i] === EMPTY) empties.push(i);
    if (empties.length === 0) return null;

    let bestScore = -1e18;
    let bestMoves = [];

    for (const p of empties) {
      for (let q = 0; q < 4; q++) {
        for (const d of [-1, 1]) {
          const sim = bd.slice();
          sim[p] = aiColor;
          rotateInPlace(sim, q, d);

          const win = findWinCells(sim);
          let sc = 0;
          if (win.size >= 5) sc = 1e9; // 即勝ち
          else {
            sc = evaluate(sim, aiColor);

            // “人間っぽさ”：相手の即勝ちを強く嫌う（簡易ブロック）
            const op = aiColor === BLACK ? WHITE : BLACK;
            const danger = opponentImmediateWin(sim, op);
            if (danger) sc -= 5000;

            // ちょいランダム（同点を揺らす）
            sc += (Math.random() - 0.5) * 2.0;
          }

          if (sc > bestScore + 1e-9) {
            bestScore = sc;
            bestMoves = [{ place: p, quad: q, dir: d }];
          } else if (Math.abs(sc - bestScore) < 2.0) {
            bestMoves.push({ place: p, quad: q, dir: d });
          }
        }
      }
    }

    // 同点候補からランダム（人間っぽい）
    return bestMoves[Math.floor(Math.random() * bestMoves.length)];
  }

  function opponentImmediateWin(bd, opColor) {
    // 相手が次に “place+rotate” で即勝てるか軽くチェック
    const empties = [];
    for (let i = 0; i < 36; i++) if (bd[i] === EMPTY) empties.push(i);

    for (const p of empties) {
      for (let q = 0; q < 4; q++) {
        for (const d of [-1, 1]) {
          const sim = bd.slice();
          sim[p] = opColor;
          rotateInPlace(sim, q, d);
          const win = findWinCells(sim);
          if (win.size >= 5) return true;
        }
      }
    }
    return false;
  }

  // ===== Firebase Online Sync =====
  let app = null, db = null;
  let roomRef = null;
  let unsubValue = null;

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
      if (!firebase || !firebase.initializeApp) return;
      app = firebase.initializeApp(firebaseConfig);
      db = firebase.database();
    } catch (e) {
      // Firebaseが失敗してもローカルは動かす
    }
  }

  function roomPath() {
    return `rooms/${room}`;
  }

  function syncIfOnline() {
    if (!online || !db || !room) return;
    if (!roomRef) return;

    // “状態” を丸ごと送る（簡単同期）
    const payload = {
      board,
      phase,
      turn,
      pendingIndex,
      pendingColor,
      selectedQuad,
      selectedDir,
      updatedAt: Date.now(),
    };
    roomRef.child("state").set(payload);
  }

  function startRoomListener() {
    if (!db || !room) return;
    online = true;
    setRoomLabel();

    roomRef = db.ref(roomPath());

    // state監視
    const stateRef = roomRef.child("state");
    stateRef.on("value", (snap) => {
      const v = snap.val();
      if (!v) return;

      // 受信して反映
      if (Array.isArray(v.board) && v.board.length === 36) board = v.board.slice();
      if (typeof v.phase === "string") phase = v.phase;
      if (v.turn === BLACK || v.turn === WHITE) turn = v.turn;

      if (typeof v.pendingIndex === "number") pendingIndex = v.pendingIndex;
      if (v.pendingColor === EMPTY || v.pendingColor === BLACK || v.pendingColor === WHITE) pendingColor = v.pendingColor;

      if (typeof v.selectedQuad === "number") selectedQuad = v.selectedQuad;
      if (v.selectedDir === -1 || v.selectedDir === 1) selectedDir = v.selectedDir;

      winCells = findWinCells(board);

      render();
    });

    // seats監視（自分の座席表示用）
    roomRef.child("seats").on("value", (snap) => {
      const seats = snap.val() || {};
      // 自分がどの席を保持してるか
      let mySeat = "";
      for (const k of Object.keys(seats)) {
        if (seats[k] === clientId) mySeat = k; // "B" or "W"
      }
      seat = mySeat;
      setSeatLabel();
      render();
    });
  }

  function leaveRoom() {
    if (!db || !roomRef) return;
    roomRef.child("state").off();
    roomRef.child("seats").off();
    roomRef = null;
    online = false;
    seat = "";
    render();
  }

  async function joinSeat(want) {
    if (!online || !db || !roomRef) return;

    const seatsRef = roomRef.child("seats");
    const snap = await seatsRef.get();
    const seats = snap.val() || {};

    // その席が空いてるなら取る
    if (!seats[want] || seats[want] === clientId) {
      seats[want] = clientId;

      // 反対席に自分が入ってたら外す
      const other = want === "B" ? "W" : "B";
      if (seats[other] === clientId) delete seats[other];

      await seatsRef.set(seats);
      seat = want;
      render();
      return;
    }

    setStatus(`その席（${want}）は埋まっています`);
  }

  // ===== Events =====
  function bindEvents() {
    qBtns.forEach(b => b.addEventListener("click", () => selectQuad(Number(b.dataset.q))));
    dBtns.forEach(b => b.addEventListener("click", () => selectDir(Number(b.dataset.d))));

    elCommit.addEventListener("click", commitMove);
    elUndo.addEventListener("click", undoMove);
    elReset.addEventListener("click", resetGame);

    // ローカル先後
    elLocalBlack.addEventListener("click", () => {
      localSeat = "B";
      elLocalBlack.classList.add("selected");
      elLocalWhite.classList.remove("selected");
      render();
      // もしAI ONで、いまAIの手番なら動く
      maybeAiMove();
    });
    elLocalWhite.addEventListener("click", () => {
      localSeat = "W";
      elLocalWhite.classList.add("selected");
      elLocalBlack.classList.remove("selected");
      render();
      maybeAiMove();
    });

    // AI
    elAiOn.addEventListener("change", () => {
      render();
      maybeAiMove();
    });

    // room操作
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
        setStatus("コピーに失敗：手動でURL末尾に ?room=123456 を付けて共有してください");
      }
    });

    elJoinBlack.addEventListener("click", () => joinSeat("B"));
    elJoinWhite.addEventListener("click", () => joinSeat("W"));
  }

  function setRoom(r) {
    // 既にオンラインなら一旦離脱
    if (online) {
      leaveRoom();
    }
    room = r;
    if (elRoomCode) elRoomCode.value = room;
    setRoomLabel();

    // URLにも反映（ページを変えずに）
    try {
      const u = new URL(location.href);
      u.searchParams.set("room", room);
      history.replaceState(null, "", u.toString());
    } catch {}

    // オンライン開始
    startRoomListener();

    // 初回: stateが無いなら初期状態を作る
    if (roomRef) {
      roomRef.child("state").get().then((snap) => {
        if (!snap.exists()) {
          const init = {
            board: Array(36).fill(EMPTY),
            phase: "place",
            turn: BLACK,
            pendingIndex: -1,
            pendingColor: EMPTY,
            selectedQuad: 0,
            selectedDir: -1,
            updatedAt: Date.now(),
          };
          roomRef.child("state").set(init);
        }
      });
    }

    render();
  }

  // ===== 起動 =====
  function boot() {
    makeBoardUI();
    initFirebaseMaybe();
    bindEvents();

    // デフォルト選択表示
    selectQuad(0);
    selectDir(-1);

    // URL room を反映
    const r = parseRoomFromURL();
    if (r) {
      if (elRoomCode) elRoomCode.value = r;
      setRoom(r);
    }

    winCells = findWinCells(board);
    render();
    maybeAiMove();
  }

  // iPhoneで原因特定しやすいように window error をHUDに出す
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
