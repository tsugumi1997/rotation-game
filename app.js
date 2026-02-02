/* app.js（全置換）
   - 盤は必ず表示（Firebaseが失敗しても落ちない）
   - 仮置き：置き直しOK →「回転して確定」で確定
   - オンライン：Realtime Database（同じroomで同期）
   - 簡単AI（白）：ローカル用（オンライン中はOFF推奨）
*/

(() => {
  "use strict";

  // ===== 定数 =====
  const EMPTY = 0, BLACK = 1, WHITE = 2;

  // 盤は 6x6、回転小盤は 3x3 を4つ（0:左上 1:右上 2:左下 3:右下）
  const SIZE = 6;

  // ===== DOM =====
  const elBoard = document.getElementById("board");
  const elTurnText = document.getElementById("turnText");
  const elPhaseText = document.getElementById("phaseText");
  const elEvalText = document.getElementById("evalText");
  const elBwText = document.getElementById("bwText");
  const elRoomLabel = document.getElementById("roomLabel");
  const elSeatLabel = document.getElementById("seatLabel");
  const elStatusText = document.getElementById("statusText");

  const elAiWhite = document.getElementById("aiWhite");

  const elCommit = document.getElementById("commit");
  const elUndo = document.getElementById("undo");
  const elReset = document.getElementById("reset");

  const elRoomCode = document.getElementById("roomCode");
  const elApplyRoom = document.getElementById("applyRoom");
  const elCopyLink = document.getElementById("copyLink");

  // qbtn / dbtn
  const qButtons = Array.from(document.querySelectorAll(".qbtn"));
  const dButtons = Array.from(document.querySelectorAll(".dbtn"));

  // ===== 状態 =====
  let board = new Array(SIZE * SIZE).fill(EMPTY);

  // phase: "place"（仮置き）→ "rotate"（回転選択）→ commitで確定して相手手番へ
  let phase = "place";
  let turn = BLACK;

  // 仮置き（置き直しOK）
  let pendingIndex = -1;
  let pendingColor = EMPTY;

  // 回転選択
  let selQuad = -1;    // 0..3
  let selDir = 0;      // -1 or +1

  // Undo用（ローカル）
  let history = [];

  // 勝利ライン表示
  let winCells = new Set(); // index集合

  // AI（白）
  let aiEnabled = false;

  // オンライン
  let room = "";
  let seat = "";     // "B" or "W"（自分の色）
  let online = false;
  let db = null;
  let roomRef = null;
  let unsub = null;
  let clientId = Math.random().toString(16).slice(2);

  // ===== 盤UI生成 =====
  function makeBoardUI() {
    if (!elBoard) return;
    elBoard.innerHTML = "";
    for (let i = 0; i < SIZE * SIZE; i++) {
      const d = document.createElement("div");
      d.className = "cell";
      d.dataset.i = String(i);
      d.dataset.mark = "0";
      d.addEventListener("click", () => onCellClick(i));
      elBoard.appendChild(d);
    }
  }

  // ===== 表示更新 =====
  function render() {
    // 盤面（確定石）
    for (let i = 0; i < SIZE * SIZE; i++) {
      const cell = elBoard.children[i];
      let v = board[i];
      cell.dataset.mark = String(v);  // CSSで色が付く想定

      cell.classList.remove("pending", "win", "selected");
      if (winCells.has(i)) cell.classList.add("win");
    }

    // 仮置き表示
    if (pendingIndex >= 0 && pendingColor !== EMPTY) {
      const cell = elBoard.children[pendingIndex];
      // dataset.mark は確定石の色なので、仮置きはclassで上書き表示
      cell.classList.add("pending");
      cell.dataset.mark = String(pendingColor);
    }

    // HUD
    elTurnText.textContent = (turn === BLACK) ? "黒の手番" : "白の手番";
    elPhaseText.textContent = phase;
    elEvalText.textContent = String(evaluate());
    const bw = countBW();
    elBwText.textContent = `${bw.b} / ${bw.w}`;
    elRoomLabel.textContent = room ? room : "—";
    elSeatLabel.textContent = seat ? seat : "—";

    // 選択状態（回転小盤・方向）
    qButtons.forEach(b => {
      const q = Number(b.dataset.q);
      b.classList.toggle("selected", q === selQuad);
    });
    dButtons.forEach(b => {
      const d = Number(b.dataset.d);
      b.classList.toggle("selected", d === selDir);
    });

    // 状態文
    if (isGameOver()) {
      elStatusText.textContent = winnerText();
    } else {
      elStatusText.textContent =
        phase === "place" ? "仮置き：マスをタップ（置き直しOK）" :
        phase === "rotate" ? "回転：小盤と方向を選んで「回転して確定」" :
        "—";
    }
  }

  function countBW() {
    let b = 0, w = 0;
    for (const v of board) {
      if (v === BLACK) b++;
      else if (v === WHITE) w++;
    }
    // pendingは数に入れない（確定ではないため）
    return { b, w };
  }

  // ===== クリック：マス =====
  function onCellClick(i) {
    if (isGameOver()) return;
    if (!canActNow()) return;

    // placeフェーズのみ
    if (phase !== "place") return;

    // 確定石があるマスは置けない
    if (board[i] !== EMPTY) return;

    // 仮置き：置き直しOK（前の仮置きを消して移動）
    pendingIndex = i;
    pendingColor = turn;

    // 次は回転選択へ
    phase = "rotate";
    winCells.clear();
    render();
    syncIfOnline();
  }

  // ===== 回転選択 =====
  function selectQuad(q) {
    if (isGameOver()) return;
    if (!canActNow()) return;
    if (phase !== "rotate") return;
    selQuad = q;
    render();
  }

  function selectDir(d) {
    if (isGameOver()) return;
    if (!canActNow()) return;
    if (phase !== "rotate") return;
    selDir = d;
    render();
  }

  // ===== 確定（回転） =====
  function commitMove() {
    if (isGameOver()) return;
    if (!canActNow()) return;

    if (phase !== "rotate") return;
    if (pendingIndex < 0 || pendingColor === EMPTY) return;
    if (selQuad < 0 || (selDir !== -1 && selDir !== 1)) return;

    // Undo用に保存（オンライン中は簡易で無効化推奨だが動かす）
    history.push(snapshotState());

    // 1) 仮置きを確定石として置く
    board[pendingIndex] = pendingColor;

    // 2) 回転
    rotateQuad(selQuad, selDir);

    // 3) 仮置き解除
    pendingIndex = -1;
    pendingColor = EMPTY;
    selQuad = -1;
    selDir = 0;

    // 4) 勝敗判定
    winCells = findWinCells();
    if (!isGameOver()) {
      // 手番交代
      turn = (turn === BLACK) ? WHITE : BLACK;
      phase = "place";
    }

    render();
    syncIfOnline();

    // AI（白）の番なら打つ
    if (!online && aiEnabled && turn === WHITE && !isGameOver()) {
      setTimeout(aiMove, 150);
    }
  }

  // ===== Undo / Reset =====
  function undo() {
    if (history.length === 0) return;
    if (!canActNow()) return;

    const s = history.pop();
    restoreState(s);
    render();
    syncIfOnline();
  }

  function resetGame() {
    history = [];
    board = new Array(SIZE * SIZE).fill(EMPTY);
    phase = "place";
    turn = BLACK;
    pendingIndex = -1;
    pendingColor = EMPTY;
    selQuad = -1;
    selDir = 0;
    winCells.clear();
    render();
    syncIfOnline();
  }

  function snapshotState() {
    return {
      board: board.slice(),
      phase,
      turn,
      pendingIndex,
      pendingColor,
      selQuad,
      selDir
    };
  }

  function restoreState(s) {
    board = s.board.slice();
    phase = s.phase;
    turn = s.turn;
    pendingIndex = s.pendingIndex;
    pendingColor = s.pendingColor;
    selQuad = s.selQuad;
    selDir = s.selDir;
    winCells = findWinCells();
  }

  // ===== 回転処理 =====
  function rotateQuad(q, dir) {
    // q: 0..3, dir: -1(左) or +1(右)
    const r0 = (q < 2) ? 0 : 3;
    const c0 = (q % 2) * 3;

    // 3x3を取り出す
    const tmp = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        tmp.push(board[(r0 + r) * SIZE + (c0 + c)]);
      }
    }

    // 回転
    const out = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const src = r * 3 + c;
        let rr, cc;
        if (dir === 1) {        // 右回転
          rr = c;
          cc = 2 - r;
        } else {                // 左回転
          rr = 2 - c;
          cc = r;
        }
        out[rr * 3 + cc] = tmp[src];
      }
    }

    // 書き戻し
    let k = 0;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        board[(r0 + r) * SIZE + (c0 + c)] = out[k++];
      }
    }
  }

  // ===== 勝敗判定（5連） =====
  function findWinCells() {
    // 5連（横/縦/斜め）を見つけたら、そのindexをSetで返す（複数可）
    const wins = new Set();

    const lines = [];
    // 横
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c <= SIZE - 5; c++) {
        lines.push([idx(r,c), idx(r,c+1), idx(r,c+2), idx(r,c+3), idx(r,c+4)]);
      }
    }
    // 縦
    for (let c = 0; c < SIZE; c++) {
      for (let r = 0; r <= SIZE - 5; r++) {
        lines.push([idx(r,c), idx(r+1,c), idx(r+2,c), idx(r+3,c), idx(r+4,c)]);
      }
    }
    // 斜め（\）
    for (let r = 0; r <= SIZE - 5; r++) {
      for (let c = 0; c <= SIZE - 5; c++) {
        lines.push([idx(r,c), idx(r+1,c+1), idx(r+2,c+2), idx(r+3,c+3), idx(r+4,c+4)]);
      }
    }
    // 斜め（/）
    for (let r = 0; r <= SIZE - 5; r++) {
      for (let c = 4; c < SIZE; c++) {
        lines.push([idx(r,c), idx(r+1,c-1), idx(r+2,c-2), idx(r+3,c-3), idx(r+4,c-4)]);
      }
    }

    for (const line of lines) {
      const a = board[line[0]];
      if (a === EMPTY) continue;
      let ok = true;
      for (let k = 1; k < 5; k++) {
        if (board[line[k]] !== a) { ok = false; break; }
      }
      if (ok) line.forEach(i => wins.add(i));
    }
    return wins;

    function idx(r,c){ return r*SIZE + c; }
  }

  function isGameOver() {
    winCells = winCells.size ? winCells : findWinCells();
    return winCells.size > 0;
  }

  function winnerText() {
    // 勝ち色は winCells のどれかの石色で判定（同時勝ちは表示簡略）
    let b = false, w = false;
    for (const i of winCells) {
      if (board[i] === BLACK) b = true;
      if (board[i] === WHITE) w = true;
    }
    if (b && w) return "同時勝利（引き分け扱い）";
    if (b) return "黒の勝ち！";
    if (w) return "白の勝ち！";
    return "終了";
  }

  // ===== 評価（超簡易） =====
  // 白が有利なら +、黒が有利なら -（表示用）
  function evaluate() {
    // 盤上の白黒差 + 連続数の軽いボーナス
    let score = 0;
    for (const v of board) {
      if (v === WHITE) score += 1;
      else if (v === BLACK) score -= 1;
    }
    score += linePotential(WHITE) * 2;
    score -= linePotential(BLACK) * 2;
    return score;
  }

  function linePotential(color) {
    // 「5連候補の中で、相手石が混ざっていないラインの最大石数」を雑に足す
    const opp = (color === BLACK) ? WHITE : BLACK;
    let sum = 0;

    // 全セルを起点に4方向だけチェック（長さ5）
    const dirs = [
      [0,1],[1,0],[1,1],[1,-1]
    ];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        for (const [dr,dc] of dirs) {
          const cells = [];
          for (let k = 0; k < 5; k++) {
            const rr = r + dr*k;
            const cc = c + dc*k;
            if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) { cells.length = 0; break; }
            cells.push(rr*SIZE + cc);
          }
          if (cells.length !== 5) continue;
          let hasOpp = false;
          let cnt = 0;
          for (const i of cells) {
            if (board[i] === opp) { hasOpp = true; break; }
            if (board[i] === color) cnt++;
          }
          if (!hasOpp) sum += cnt;
        }
      }
    }
    return sum;
  }

  // ===== AI（白）：勝てる手 > 防ぐ手 > 雑に評価最大 =====
  function aiMove() {
    if (online) return;
    if (!aiEnabled) return;
    if (turn !== WHITE) return;
    if (isGameOver()) return;

    // ルール上：place→rotate をまとめて決める必要がある
    // 全合法手を列挙して、勝てるなら勝ち手、なければ防御、なければスコア最大
    const moves = enumerateMoves(WHITE);

    // 1) 即勝ち
    for (const m of moves) {
      if (m.resultWinWhite) { applyMove(m); return; }
    }
    // 2) 相手の即勝ちを潰す（次手で黒が勝てる状況を避ける）
    let best = null;
    let bestScore = -1e9;
    for (const m of moves) {
      const danger = blackCanWinNext(m.boardAfter);
      if (danger) continue; // できるだけ避ける
      if (m.score > bestScore) { bestScore = m.score; best = m; }
    }
    if (!best) {
      // どうしても避けられないならスコア最大
      for (const m of moves) {
        if (m.score > bestScore) { bestScore = m.score; best = m; }
      }
    }
    applyMove(best);
  }

  function enumerateMoves(color) {
    const res = [];
    for (let i = 0; i < SIZE*SIZE; i++) {
      if (board[i] !== EMPTY) continue;

      for (let q = 0; q < 4; q++) {
        for (const d of [-1, 1]) {
          const b2 = board.slice();
          b2[i] = color;
          rotateQuadOn(b2, q, d);

          const win = findWinCellsOn(b2);
          let winWhite = false;
          if (win.size) {
            for (const idx of win) {
              if (b2[idx] === WHITE) { winWhite = true; break; }
            }
          }

          res.push({
            place: i, quad: q, dir: d,
            boardAfter: b2,
            resultWinWhite: winWhite,
            score: evalOn(b2)
          });
        }
      }
    }
    return res;
  }

  function applyMove(m) {
    if (!m) return;
    // 自分のローカル状態に反映（ユーザー操作と同じ順）
    history.push(snapshotState());

    board[m.place] = WHITE;
    rotateQuad(m.quad, m.dir);

    pendingIndex = -1;
    pendingColor = EMPTY;
    selQuad = -1;
    selDir = 0;

    winCells = findWinCells();
    if (!isGameOver()) {
      turn = BLACK;
      phase = "place";
    }
    render();
  }

  function rotateQuadOn(arr, q, dir) {
    const r0 = (q < 2) ? 0 : 3;
    const c0 = (q % 2) * 3;
    const tmp = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) tmp.push(arr[(r0+r)*SIZE + (c0+c)]);
    const out = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const src = r*3 + c;
      let rr, cc;
      if (dir === 1) { rr = c; cc = 2-r; } else { rr = 2-c; cc = r; }
      out[rr*3 + cc] = tmp[src];
    }
    let k = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) arr[(r0+r)*SIZE + (c0+c)] = out[k++];
  }

  function findWinCellsOn(arr) {
    const wins = new Set();
    const lines = [];
    const idx = (r,c)=> r*SIZE + c;

    for (let r=0;r<SIZE;r++) for (let c=0;c<=SIZE-5;c++) lines.push([idx(r,c),idx(r,c+1),idx(r,c+2),idx(r,c+3),idx(r,c+4)]);
    for (let c=0;c<SIZE;c++) for (let r=0;r<=SIZE-5;r++) lines.push([idx(r,c),idx(r+1,c),idx(r+2,c),idx(r+3,c),idx(r+4,c)]);
    for (let r=0;r<=SIZE-5;r++) for (let c=0;c<=SIZE-5;c++) lines.push([idx(r,c),idx(r+1,c+1),idx(r+2,c+2),idx(r+3,c+3),idx(r+4,c+4)]);
    for (let r=0;r<=SIZE-5;r++) for (let c=4;c<SIZE;c++) lines.push([idx(r,c),idx(r+1,c-1),idx(r+2,c-2),idx(r+3,c-3),idx(r+4,c-4)]);

    for (const line of lines) {
      const a = arr[line[0]];
      if (a === EMPTY) continue;
      let ok = true;
      for (let k=1;k<5;k++) if (arr[line[k]] !== a) { ok=false; break; }
      if (ok) line.forEach(i=>wins.add(i));
    }
    return wins;
  }

  function evalOn(arr) {
    let s = 0;
    for (const v of arr) {
      if (v === WHITE) s += 1;
      else if (v === BLACK) s -= 1;
    }
    return s;
  }

  function blackCanWinNext(arrAfterWhite) {
    // 黒の合法手で即勝ちがあるか
    // ここは簡易：空きマスに置いて回転して勝ちができるか
    for (let i=0;i<SIZE*SIZE;i++) {
      if (arrAfterWhite[i] !== EMPTY) continue;
      for (let q=0;q<4;q++) for (const d of [-1,1]) {
        const b2 = arrAfterWhite.slice();
        b2[i] = BLACK;
        rotateQuadOn(b2, q, d);
        const win = findWinCellsOn(b2);
        if (win.size) {
          for (const idx of win) {
            if (b2[idx] === BLACK) return true;
          }
        }
      }
    }
    return false;
  }

  // ===== 入力制御（オンライン時の手番） =====
  function canActNow() {
    if (!online) return true;
    // seat が未確定なら操作不可
    if (seat !== "B" && seat !== "W") return false;
    if (turn === BLACK && seat !== "B") return false;
    if (turn === WHITE && seat !== "W") return false;
    return true;
  }

  // ===== オンライン（Firebase compat） =====
  function initFirebaseMaybe() {
    try {
      if (!window.firebase || !firebase.initializeApp) {
        setStatus("Firebase未読込（同期はOFF）");
        return false;
      }

      // ★あなたの設定（既に貼ってくれた値をそのまま入れています）
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

      // 二重初期化防止
      if (!firebase.apps || firebase.apps.length === 0) firebase.initializeApp(firebaseConfig);

      db = firebase.database();
      return true;
    } catch (e) {
      setStatus("Firebase初期化エラー: " + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  function setStatus(msg) {
    if (elStatusText) elStatusText.textContent = msg;
  }

  function parseRoomFromURL() {
    const u = new URL(location.href);
    return (u.searchParams.get("room") || "").trim();
  }

  function setRoom(newRoom) {
    room = (newRoom || "").trim();
    online = !!room;

    if (online) {
      // AIはオンラインでは混線しやすいので自動OFF
      aiEnabled = false;
      if (elAiWhite) elAiWhite.checked = false;

      elRoomLabel.textContent = room;
      connectRoom();
    } else {
      disconnectRoom();
      elRoomLabel.textContent = "—";
      seat = "";
    }
    render();
  }

  function disconnectRoom() {
    try {
      if (unsub) { unsub(); unsub = null; }
      roomRef = null;
      online = false;
    } catch {}
  }

  function connectRoom() {
    if (!db) {
      // Firebaseが無いならオンラインは実質不可
      setStatus("Firebaseが使えないためオンライン同期できません");
      online = false;
      room = "";
      seat = "";
      return;
    }

    roomRef = db.ref("rooms").child(room);

    // seat割当（先着：B→W）
    roomRef.child("presence").child(clientId).set({ t: Date.now() });
    roomRef.child("presence").child(clientId).onDisconnect().remove();

    roomRef.child("seats").transaction((cur) => {
      cur = cur || {};
      // すでに自分が入っているならそのまま
      for (const k of ["B","W"]) {
        if (cur[k] === clientId) return cur;
      }
      if (!cur.B) cur.B = clientId;
      else if (!cur.W) cur.W = clientId;
      return cur;
    }, (err, committed, snap) => {
      if (err) {
        setStatus("seat割当エラー: " + err.message);
        return;
      }
      const seats = snap && snap.val ? snap.val() : {};
      seat = (seats.B === clientId) ? "B" : (seats.W === clientId) ? "W" : "";
      render();
    });

    // 盤同期購読
    roomRef.child("state").on("value", (snap) => {
      const s = snap.val();
      if (!s) return;

      // 自分が最後に書いたものでも、ここではそのまま適用（衝突は簡易扱い）
      if (Array.isArray(s.board) && s.board.length === SIZE*SIZE) board = s.board.slice();
      if (typeof s.phase === "string") phase = s.phase;
      if (s.turn === BLACK || s.turn === WHITE) turn = s.turn;
      pendingIndex = (typeof s.pendingIndex === "number") ? s.pendingIndex : -1;
      pendingColor = (s.pendingColor === BLACK || s.pendingColor === WHITE) ? s.pendingColor : EMPTY;
      selQuad = (typeof s.selQuad === "number") ? s.selQuad : -1;
      selDir = (s.selDir === -1 || s.selDir === 1) ? s.selDir : 0;

      winCells = findWinCells();
      render();
    });

    // 初期stateが無いなら作る
    roomRef.child("state").once("value", (snap) => {
      if (!snap.exists()) syncIfOnline(true);
    });
  }

  function syncIfOnline(force = false) {
    if (!online || !roomRef) return;
    if (!db) return;

    const state = {
      board: board.slice(),
      phase,
      turn,
      pendingIndex,
      pendingColor,
      selQuad,
      selDir,
      updatedAt: Date.now(),
      by: clientId
    };

    // forceのときだけ必ず書く。通常も書く（簡易実装）
    try {
      roomRef.child("state").set(state);
    } catch (e) {
      setStatus("同期エラー: " + (e && e.message ? e.message : String(e)));
    }
  }

  // ===== イベント =====
  function bindEvents() {
    qButtons.forEach(b => b.addEventListener("click", () => selectQuad(Number(b.dataset.q))));
    dButtons.forEach(b => b.addEventListener("click", () => selectDir(Number(b.dataset.d))));

    elCommit.addEventListener("click", commitMove);
    elUndo.addEventListener("click", undo);
    elReset.addEventListener("click", resetGame);

    elAiWhite.addEventListener("change", () => {
      aiEnabled = !!elAiWhite.checked;
      render();
      if (!online && aiEnabled && turn === WHITE && !isGameOver()) setTimeout(aiMove, 150);
    });

    elApplyRoom.addEventListener("click", () => {
      const r = (elRoomCode.value || "").trim();
      if (!r) { setRoom(""); return; }
      // URLも更新して共有しやすく
      const u = new URL(location.href);
      u.searchParams.set("room", r);
      historyReplace(u.toString());
      setRoom(r);
    });

    elCopyLink.addEventListener("click", async () => {
      const r = (room || (elRoomCode.value || "").trim());
      const u = new URL(location.href);
      if (r) u.searchParams.set("room", r);
      const text = u.toString();
      try {
        await navigator.clipboard.writeText(text);
        setStatus("共有URLをコピーしました");
      } catch {
        // クリップボードが使えない場合は表示だけ
        setStatus("共有URL: " + text);
      }
    });
  }

  function historyReplace(url) {
    try { window.history.replaceState(null, "", url); } catch {}
  }

  // ===== 起動 =====
  function boot() {
    // 盤UIは最初に必ず作る（ここで出ないならJS自体が動いていない）
    makeBoardUI();

    // Firebaseは失敗しても落とさない
    initFirebaseMaybe();

    // URL room を反映
    const r = parseRoomFromURL();
    if (r) {
      // room inputにも入れておく
      if (elRoomCode) elRoomCode.value = r;
      setRoom(r);
    }

    bindEvents();
    render();
  }

  // windowレベルのエラーをHUDに出す（iPhoneで原因特定しやすくする）
  window.addEventListener("error", (ev) => {
    try {
      const msg = ev && ev.message ? ev.message : "Unknown error";
      setStatus("JSエラー: " + msg);
    } catch {}
  });

  // DOM準備後に起動
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
