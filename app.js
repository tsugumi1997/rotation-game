/* app.js（全置換）
  - 6x6 を 3x3×4の“小盤”に分割して描画（小盤ごとに回転アニメ）
  - 仮置きは「placeフェーズ中なら置き直しOK」
  - 小盤選択ボタンは選択状態が光る（rotateフェーズで必須）
  - ローカル：先攻/後攻を選べる、AI（白/ローカルのみ）対応
  - オンライン：Room + 先攻/後攻（席取り） + 同期
*/

(() => {
  // ===== 定数 =====
  const EMPTY = 0, BLACK = 1, WHITE = 2;

  // 回転方向 data-d: -1=左(反時計回り), 1=右(時計回り)
  const DIR_LEFT = -1, DIR_RIGHT = 1;

  // ===== Firebase 設定（あなたの値に置換済み：必要ならここだけ差し替え）=====
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

  const elTurnText  = document.getElementById("turnText");
  const elPhaseText = document.getElementById("phaseText");
  const elEvalText  = document.getElementById("evalText");
  const elBwText    = document.getElementById("bwText");
  const elRoomLabel = document.getElementById("roomLabel");
  const elSeatLabel = document.getElementById("seatLabel");
  const elStatus    = document.getElementById("statusText");

  const elAiWhite   = document.getElementById("aiWhite");

  const elCommit = document.getElementById("commit");
  const elUndo   = document.getElementById("undo");
  const elReset  = document.getElementById("reset");

  const elPlayAsBlack = document.getElementById("playAsBlack");
  const elPlayAsWhite = document.getElementById("playAsWhite");

  const elRoomCode = document.getElementById("roomCode");
  const elApplyRoom = document.getElementById("applyRoom");
  const elCopyLink  = document.getElementById("copyLink");

  const elJoinBlack = document.getElementById("joinBlack");
  const elJoinWhite = document.getElementById("joinWhite");
  const elLeaveRoom = document.getElementById("leaveRoom");

  const qbtns = Array.from(document.querySelectorAll(".qbtn"));
  const dbtns = Array.from(document.querySelectorAll(".dbtn"));

  // ===== 状態（ローカル/オンライン共通）=====
  let board = Array(36).fill(EMPTY);

  // place: 仮置き（置き直しOK）
  // rotate: 回転小盤と方向を選ぶ
  let phase = "place";
  let turn = BLACK;

  let pendingIndex = -1;     // 仮置きの場所
  let pendingColor = EMPTY;  // 仮置きの色（通常=turn）
  let selectedQ = -1;        // 0..3
  let selectedD = 0;         // -1 or 1

  // 直前の着手を強調（見やすく）
  let lastPlacedIndex = -1;
  let lastRotatedQ = -1;

  // 勝利ハイライト
  let winCells = new Set();

  // Undo（ローカル専用、オンライン中は無効）
  let history = [];

  // ===== ローカル設定 =====
  let localHuman = BLACK;     // あなたが操作する色（ローカル）
  let localAIEnabled = false; // AI（白/ローカルのみチェック）
  let aiThinking = false;

  // ===== オンライン =====
  let fbOk = false;
  let db = null;
  let room = "";              // room code
  let roomRef = null;
  let stateRef = null;
  let presenceRef = null;
  let unsubscribe = null;

  // seat: オンラインで自分が黒/白どっちの席か（未参加なら ""）
  let onlineSeat = ""; // "B" or "W" or ""
  const clientId = (() => {
    const k = "rotation_game_client_id";
    const v = localStorage.getItem(k);
    if (v) return v;
    const nv = Math.random().toString(16).slice(2) + Date.now().toString(16);
    localStorage.setItem(k, nv);
    return nv;
  })();

  // ===== ユーティリティ =====
  const idxRC = (r, c) => r * 6 + c;

  function setStatus(msg) {
    if (elStatus) elStatus.textContent = msg;
  }

  function countBW(arr) {
    let b = 0, w = 0;
    for (const v of arr) {
      if (v === BLACK) b++;
      else if (v === WHITE) w++;
    }
    return { b, w };
  }

  // Eval：簡易（白-黒）。強くはないが「目安」にはなる
  function evalBoard(arr) {
    const { b, w } = countBW(arr);
    return (w - b);
  }

  function isHumanTurn() {
    if (room) return onlineSeat && ((turn === BLACK && onlineSeat === "B") || (turn === WHITE && onlineSeat === "W"));
    return (turn === localHuman);
  }

  function other(color) {
    return color === BLACK ? WHITE : BLACK;
  }

  function isGameOver() {
    return winCells.size > 0;
  }

  // ===== 勝利判定（5 in a row）=====
  function computeWinCells(arr) {
    // 6x6 で 5連をチェック
    const wins = [];
    const dirs = [
      [0, 1], [1, 0], [1, 1], [1, -1]
    ];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        const v = arr[idxRC(r, c)];
        if (v === EMPTY) continue;
        for (const [dr, dc] of dirs) {
          const cells = [];
          for (let k = 0; k < 5; k++) {
            const rr = r + dr * k;
            const cc = c + dc * k;
            if (rr < 0 || rr >= 6 || cc < 0 || cc >= 6) { cells.length = 0; break; }
            const ii = idxRC(rr, cc);
            if (arr[ii] !== v) { cells.length = 0; break; }
            cells.push(ii);
          }
          if (cells.length === 5) wins.push(cells);
        }
      }
    }
    // 複数勝ち筋があればまとめて光らせる
    const set = new Set();
    for (const line of wins) for (const i of line) set.add(i);
    return set;
  }

  // ===== 盤 UI（小盤4つに分割して回転アニメ）=====
  // 小盤の配置:
  // q=0: rows 0-2, cols 0-2
  // q=1: rows 0-2, cols 3-5
  // q=2: rows 3-5, cols 0-2
  // q=3: rows 3-5, cols 3-5
  const quadBaseRC = [
    [0, 0], [0, 3], [3, 0], [3, 3]
  ];

  let quadEls = [];     // quadrant containers
  let cellEls = [];     // 36 cell elements

  function buildBoardUI() {
    if (!elBoard) return;

    elBoard.innerHTML = "";
    elBoard.classList.add("superBoardRoot");

    quadEls = [];
    cellEls = Array(36).fill(null);

    for (let q = 0; q < 4; q++) {
      const quad = document.createElement("div");
      quad.className = "quadrant";
      quad.dataset.q = String(q);

      // 3x3 cells inside
      const [br, bc] = quadBaseRC[q];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const rr = br + r;
          const cc = bc + c;
          const i = idxRC(rr, cc);

          const d = document.createElement("div");
          d.className = "cell";
          d.dataset.i = String(i);
          d.dataset.mark = "0";
          d.addEventListener("click", () => onCellClick(i));

          quad.appendChild(d);
          cellEls[i] = d;
        }
      }

      elBoard.appendChild(quad);
      quadEls.push(quad);
    }
  }

  // ===== 回転（データ）=====
  function rotateQuadData(arr, q, dir) {
    const out = arr.slice();
    const [br, bc] = quadBaseRC[q];

    // 3x3 を抜き出し
    const m = [];
    for (let r = 0; r < 3; r++) {
      const row = [];
      for (let c = 0; c < 3; c++) row.push(arr[idxRC(br + r, bc + c)]);
      m.push(row);
    }

    // 回転
    const rot = [
      [0,0,0],
      [0,0,0],
      [0,0,0]
    ];

    if (dir === DIR_RIGHT) {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) rot[c][2 - r] = m[r][c];
    } else {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) rot[2 - c][r] = m[r][c];
    }

    // 戻す
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[idxRC(br + r, bc + c)] = rot[r][c];

    return out;
  }

  // ===== 回転（アニメ）=====
  function animateRotateQuad(q, dir) {
    return new Promise((resolve) => {
      const quad = quadEls[q];
      if (!quad) return resolve();

      const deg = dir === DIR_RIGHT ? 90 : -90;

      // アニメ中はクリック防止
      elBoard.classList.add("animating");

      quad.classList.add("rotating");
      quad.style.setProperty("--rot", `${deg}deg`);

      const done = () => {
        quad.removeEventListener("transitionend", done);
        quad.classList.remove("rotating");
        quad.style.removeProperty("--rot");
        elBoard.classList.remove("animating");
        resolve();
      };
      quad.addEventListener("transitionend", done, { once: true });

      // もし transitionend が来ない場合の保険
      setTimeout(() => {
        try { done(); } catch {}
      }, 600);
    });
  }

  // ===== UI更新 =====
  function setSelectedButtons() {
    // 小盤
    for (const b of qbtns) {
      const q = Number(b.dataset.q);
      b.classList.toggle("selected", q === selectedQ);
      b.disabled = (phase !== "rotate") || isGameOver() || !isHumanTurn();
    }
    // 方向
    for (const b of dbtns) {
      const d = Number(b.dataset.d);
      b.classList.toggle("selected", d === selectedD);
      b.disabled = (phase !== "rotate") || isGameOver() || !isHumanTurn();
    }

    // commitは rotate で選択が揃ってる時だけ
    if (elCommit) {
      elCommit.disabled = !(phase === "rotate" && selectedQ >= 0 && (selectedD === DIR_LEFT || selectedD === DIR_RIGHT) && isHumanTurn() && !isGameOver());
    }
  }

  function renderBoard() {
    for (let i = 0; i < 36; i++) {
      const el = cellEls[i];
      if (!el) continue;

      const v = board[i];
      el.dataset.mark = String(v);

      // pending
      const isPending = (i === pendingIndex);
      el.classList.toggle("pending", isPending);

      // last move highlight
      el.classList.toggle("last", i === lastPlacedIndex);

      // win highlight
      el.classList.toggle("win", winCells.has(i));

      // iPhoneでも反応良く
      el.style.pointerEvents = (isHumanTurn() && !isGameOver() && phase === "place" && !elBoard.classList.contains("animating")) ? "auto" : "auto";
    }

    // 3x3境界の強調（CSSでやってるが、選択中の小盤も軽く強調）
    for (let q = 0; q < 4; q++) {
      const quad = quadEls[q];
      if (!quad) continue;
      quad.classList.toggle("activeQuad", (phase === "rotate" && q === selectedQ));
      quad.classList.toggle("lastRot", (q === lastRotatedQ));
    }
  }

  function renderHUD() {
    const t = (turn === BLACK) ? "黒の手番" : "白の手番";
    elTurnText.textContent = t;

    elPhaseText.textContent = phase;
    elEvalText.textContent = String(evalBoard(board));
    const { b, w } = countBW(board);
    elBwText.textContent = `${b} / ${w}`;

    elRoomLabel.textContent = room ? room : "—";
    if (room) {
      elSeatLabel.textContent = onlineSeat ? onlineSeat : "—";
    } else {
      elSeatLabel.textContent = (localHuman === BLACK) ? "B" : "W";
    }

    // Status
    if (isGameOver()) {
      setStatus("勝利ラインができました（Resetで再開）");
      return;
    }

    if (room && !onlineSeat) {
      setStatus("オンライン：先攻/後攻ボタンで席を取ってください");
      return;
    }

    if (!isHumanTurn()) {
      setStatus("相手の手番です");
      return;
    }

    if (phase === "place") {
      setStatus("仮置き：マスをタップ（置き直しOK）");
    } else {
      setStatus("回転を選んで「回転して確定」");
    }
  }

  function renderAll() {
    winCells = computeWinCells(effectiveBoardForWin(board));
    renderBoard();
    setSelectedButtons();
    renderHUD();
  }

  // 仮置きがある状態を勝利判定に含めるか？
  // Pentagoは「置いてから回す」ので、勝利判定は“確定後”が自然。
  // ただUI的には確定後に勝ちが見えれば十分なので、ここはそのまま board を使う。
  function effectiveBoardForWin(arr) {
    return arr;
  }

  // ===== クリック：マス =====
  function onCellClick(i) {
    if (elBoard.classList.contains("animating")) return;
    if (isGameOver()) return;
    if (!isHumanTurn()) return;
    if (phase !== "place") return;

    // オンラインで席未取得なら動けない
    if (room && !onlineSeat) return;

    // 既に確定石があるマスは置けない
    if (board[i] !== EMPTY) return;

    // 仮置きの置き直しOK：前のpendingを消して新しい場所へ
    if (pendingIndex >= 0) {
      board[pendingIndex] = EMPTY;
    }

    pendingIndex = i;
    pendingColor = turn;
    board[i] = pendingColor;

    lastPlacedIndex = i;
    selectedQ = -1;
    selectedD = 0;

    // 次は回転選択へ
    phase = "rotate";

    pushHistoryIfLocal();

    syncIfOnline();
    renderAll();
  }

  // ===== 回転選択 =====
  function selectQuad(q) {
    if (isGameOver()) return;
    if (!isHumanTurn()) return;
    if (phase !== "rotate") return;
    selectedQ = q;
    renderAll();
    syncIfOnline();
  }

  function selectDir(d) {
    if (isGameOver()) return;
    if (!isHumanTurn()) return;
    if (phase !== "rotate") return;
    selectedD = d;
    renderAll();
    syncIfOnline();
  }

  // ===== 確定（回転してターン交代）=====
  async function commitMove() {
    if (isGameOver()) return;
    if (!isHumanTurn()) return;
    if (phase !== "rotate") return;
    if (pendingIndex < 0) return;
    if (!(selectedQ >= 0 && (selectedD === DIR_LEFT || selectedD === DIR_RIGHT))) {
      setStatus("回転する小盤と方向を選んでください");
      return;
    }

    pushHistoryIfLocal();

    // 回転アニメ（見やすいように少し遅め）
    await animateRotateQuad(selectedQ, selectedD);

    // データ回転
    board = rotateQuadData(board, selectedQ, selectedD);
    lastRotatedQ = selectedQ;

    // 仮置きを確定（pendingを解除）
    pendingIndex = -1;
    pendingColor = EMPTY;

    // 勝利判定（確定後）
    winCells = computeWinCells(board);

    // 次の手番へ
    if (!isGameOver()) {
      turn = other(turn);
      phase = "place";
      selectedQ = -1;
      selectedD = 0;
    }

    syncIfOnline(true);
    renderAll();

    // ローカルAI（白）: あなたが黒で、AIが白、かつローカル時のみ
    maybeAiMove();
  }

  function resetAll() {
    board = Array(36).fill(EMPTY);
    phase = "place";
    turn = BLACK;

    pendingIndex = -1;
    pendingColor = EMPTY;
    selectedQ = -1;
    selectedD = 0;

    lastPlacedIndex = -1;
    lastRotatedQ = -1;
    winCells = new Set();
    history = [];

    if (room) {
      // ルーム状態も初期化（席は維持）
      writeRoomState({
        board, phase, turn,
        pendingIndex, pendingColor,
        selectedQ, selectedD,
        lastPlacedIndex, lastRotatedQ,
        updatedAt: Date.now()
      }, true);
    }

    renderAll();
    maybeAiMove(true);
  }

  function pushHistoryIfLocal() {
    // オンライン中は競合が面倒なのでUndo無効（UIは押しても何もしない）
    if (room) return;

    history.push({
      board: board.slice(),
      phase, turn,
      pendingIndex, pendingColor,
      selectedQ, selectedD,
      lastPlacedIndex, lastRotatedQ
    });
    if (history.length > 50) history.shift();
  }

  function undoOnce() {
    if (room) {
      setStatus("オンライン中のUndoは無効です");
      return;
    }
    const prev = history.pop();
    if (!prev) return;

    board = prev.board.slice();
    phase = prev.phase;
    turn = prev.turn;
    pendingIndex = prev.pendingIndex;
    pendingColor = prev.pendingColor;
    selectedQ = prev.selectedQ;
    selectedD = prev.selectedD;
    lastPlacedIndex = prev.lastPlacedIndex;
    lastRotatedQ = prev.lastRotatedQ;

    winCells = computeWinCells(board);
    renderAll();
  }

  // ===== AI（ローカルのみ）=====
  function setLocalHuman(color) {
    localHuman = color;
    // ローカルは「あなたの色で seat 表示」を出すだけ（実際は isHumanTurn で判定）
    // AIは白のトグル（あなたが白でもAI白は意味が薄いので、内部で補正）
    renderAll();
    maybeAiMove(true);
  }

  function maybeAiMove(force = false) {
    // ルーム中はAIを動かさない
    if (room) return;

    localAIEnabled = !!(elAiWhite && elAiWhite.checked);

    // “AI（白）”なので、AIは WHITE 固定
    if (!localAIEnabled) return;
    if (isGameOver()) return;

    const aiColor = WHITE;

    // あなたが白を選んだ場合：AI（白）は同色になるので動かない
    if (localHuman === WHITE) return;

    // AIの手番じゃないなら終了
    if (turn !== aiColor) return;

    if (aiThinking && !force) return;
    aiThinking = true;

    // 見やすいように少し待つ
    setStatus("AI思考中…");
    renderAll();

    setTimeout(async () => {
      try {
        // 1) place：空きマスから「雑に」良さそうなところを選ぶ（簡易）
        if (phase === "place") {
          const empties = [];
          for (let i = 0; i < 36; i++) if (board[i] === EMPTY) empties.push(i);

          // なるべく中央寄りを優先
          empties.sort((a, b) => distToCenter(a) - distToCenter(b));

          const pick = empties[0] ?? -1;
          if (pick >= 0) {
            // 仮置き（AIは置き直ししない）
            pendingIndex = pick;
            pendingColor = aiColor;
            board[pick] = aiColor;
            lastPlacedIndex = pick;
            phase = "rotate";
          }
          renderAll();
          await sleep(350);
        }

        // 2) rotate：回転はとりあえずランダム（でも見た目ゆっくり）
        if (phase === "rotate") {
          selectedQ = Math.floor(Math.random() * 4);
          selectedD = (Math.random() < 0.5) ? DIR_LEFT : DIR_RIGHT;
          renderAll();
          await sleep(350);

          await commitMove(); // commitMoveの中でアニメも入る
        }
      } finally {
        aiThinking = false;
      }
    }, 600);
  }

  function distToCenter(i) {
    const r = Math.floor(i / 6), c = i % 6;
    return Math.abs(r - 2.5) + Math.abs(c - 2.5);
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ===== オンライン：初期化 =====
  function initFirebase() {
    try {
      firebase.initializeApp(firebaseConfig);
      db = firebase.database();
      fbOk = true;
      return true;
    } catch (e) {
      fbOk = false;
      setStatus("Firebase初期化に失敗しました（ローカルは遊べます）");
      return false;
    }
  }

  function parseRoomFromURL() {
    const u = new URL(location.href);
    const r = u.searchParams.get("room");
    if (!r) return "";
    return String(r).trim();
  }

  function setURLRoom(r) {
    const u = new URL(location.href);
    if (r) u.searchParams.set("room", r);
    else u.searchParams.delete("room");
    historyReplace(u.toString());
  }
  function historyReplace(url) {
    try { window.history.replaceState(null, "", url); } catch {}
  }

  function roomPath(r) { return `rooms/${r}`; }

  async function joinRoom(r) {
    if (!fbOk) initFirebase();
    if (!fbOk) return;

    room = r;
    elRoomLabel.textContent = room;
    setURLRoom(room);

    roomRef = db.ref(roomPath(room));
    stateRef = db.ref(`${roomPath(room)}/state`);
    presenceRef = db.ref(`${roomPath(room)}/presence/${clientId}`);

    // presence
    try {
      presenceRef.onDisconnect().remove();
      presenceRef.set({ at: Date.now() });
    } catch {}

    // state listen
    if (unsubscribe) {
      try { stateRef.off("value", unsubscribe); } catch {}
      unsubscribe = null;
    }

    unsubscribe = (snap) => {
      const s = snap.val();
      if (!s) return;

      // state適用
      if (Array.isArray(s.board) && s.board.length === 36) board = s.board.slice();
      if (s.phase) phase = s.phase;
      if (s.turn) turn = s.turn;

      pendingIndex = (typeof s.pendingIndex === "number") ? s.pendingIndex : -1;
      pendingColor = (typeof s.pendingColor === "number") ? s.pendingColor : EMPTY;
      selectedQ = (typeof s.selectedQ === "number") ? s.selectedQ : -1;
      selectedD = (typeof s.selectedD === "number") ? s.selectedD : 0;

      lastPlacedIndex = (typeof s.lastPlacedIndex === "number") ? s.lastPlacedIndex : -1;
      lastRotatedQ = (typeof s.lastRotatedQ === "number") ? s.lastRotatedQ : -1;

      renderAll();
    };
    stateRef.on("value", unsubscribe);

    // 初回：stateが空なら作る（席は別）
    const cur = await stateRef.get();
    if (!cur.exists()) {
      await stateRef.set({
        board: Array(36).fill(EMPTY),
        phase: "place",
        turn: BLACK,
        pendingIndex: -1,
        pendingColor: EMPTY,
        selectedQ: -1,
        selectedD: 0,
        lastPlacedIndex: -1,
        lastRotatedQ: -1,
        updatedAt: Date.now()
      });
    }

    onlineSeat = "";
    renderAll();
    setStatus("Roomに接続しました。先攻/後攻で席を取ってください");
  }

  async function leaveRoom() {
    if (!room) return;
    try {
      if (presenceRef) presenceRef.remove();
    } catch {}

    if (stateRef && unsubscribe) {
      try { stateRef.off("value", unsubscribe); } catch {}
    }
    unsubscribe = null;

    room = "";
    onlineSeat = "";
    roomRef = null;
    stateRef = null;
    presenceRef = null;

    setURLRoom("");

    // ローカルに戻す（盤は維持していいが、混乱するのでリセット）
    resetAll();
    renderAll();
    setStatus("ローカルに戻りました");
  }

  async function claimSeat(want) {
    if (!roomRef) return;

    const playersRef = db.ref(`${roomPath(room)}/players`);
    // players: { B: clientId or "", W: clientId or "" }
    await playersRef.transaction((cur) => {
      cur = cur || { B: "", W: "" };

      // 既に自分が座ってるなら維持
      if (cur.B === clientId) return cur;
      if (cur.W === clientId) return cur;

      if (want === "B") {
        if (!cur.B) cur.B = clientId;
      } else {
        if (!cur.W) cur.W = clientId;
      }

      return cur;
    });

    const p = (await playersRef.get()).val() || { B: "", W: "" };
    if (p.B === clientId) onlineSeat = "B";
    else if (p.W === clientId) onlineSeat = "W";
    else onlineSeat = "";

    renderAll();
    if (!onlineSeat) setStatus("その席は埋まっています。もう一方を試してください");
    else setStatus(`席を取りました：${onlineSeat}`);
  }

  async function releaseSeat() {
    if (!roomRef) return;
    const playersRef = db.ref(`${roomPath(room)}/players`);
    await playersRef.transaction((cur) => {
      cur = cur || { B: "", W: "" };
      if (cur.B === clientId) cur.B = "";
      if (cur.W === clientId) cur.W = "";
      return cur;
    });
    onlineSeat = "";
    renderAll();
    setStatus("席を解除しました");
  }

  function syncIfOnline(isFinal = false) {
    if (!room || !stateRef) return;
    writeRoomState({
      board,
      phase,
      turn,
      pendingIndex,
      pendingColor,
      selectedQ,
      selectedD,
      lastPlacedIndex,
      lastRotatedQ,
      updatedAt: Date.now(),
      isFinal: !!isFinal
    }, false);
  }

  function writeRoomState(obj, force) {
    if (!stateRef) return;
    // forceがtrueなら上書き、falseなら普通にset（簡略）
    try {
      stateRef.set(obj);
    } catch {}
  }

  // ===== イベント =====
  function bind() {
    // 回転小盤ボタン
    qbtns.forEach((b) => {
      b.addEventListener("click", () => selectQuad(Number(b.dataset.q)));
    });
    dbtns.forEach((b) => {
      b.addEventListener("click", () => selectDir(Number(b.dataset.d)));
    });

    elCommit.addEventListener("click", commitMove);
    elUndo.addEventListener("click", undoOnce);
    elReset.addEventListener("click", resetAll);

    // ローカル先後
    elPlayAsBlack.addEventListener("click", () => {
      elPlayAsBlack.classList.add("selected");
      elPlayAsWhite.classList.remove("selected");
      setLocalHuman(BLACK);
      // 黒を人間にしたら、AI白がONなら白手番でだけ動く（最初は黒手番）
      renderAll();
    });
    elPlayAsWhite.addEventListener("click", () => {
      elPlayAsWhite.classList.add("selected");
      elPlayAsBlack.classList.remove("selected");
      setLocalHuman(WHITE);
      renderAll();
    });

    // AIトグル
    elAiWhite.addEventListener("change", () => {
      localAIEnabled = !!elAiWhite.checked;
      renderAll();
      maybeAiMove(true);
    });

    // オンライン
    elApplyRoom.addEventListener("click", async () => {
      const r = String(elRoomCode.value || "").trim();
      if (!r) { setStatus("room番号を入れてください"); return; }
      await joinRoom(r);
      renderAll();
    });

    elCopyLink.addEventListener("click", async () => {
      const r = room || String(elRoomCode.value || "").trim();
      if (!r) { setStatus("room番号がありません"); return; }
      const u = new URL(location.href);
      u.searchParams.set("room", r);
      try {
        await navigator.clipboard.writeText(u.toString());
        setStatus("共有URLをコピーしました");
      } catch {
        setStatus("コピーできませんでした（手動でURLを共有してください）");
      }
    });

    elJoinBlack.addEventListener("click", async () => {
      if (!room) {
        const r = String(elRoomCode.value || "").trim();
        if (!r) { setStatus("room番号を入れてください"); return; }
        await joinRoom(r);
      }
      await claimSeat("B");
    });

    elJoinWhite.addEventListener("click", async () => {
      if (!room) {
        const r = String(elRoomCode.value || "").trim();
        if (!r) { setStatus("room番号を入れてください"); return; }
        await joinRoom(r);
      }
      await claimSeat("W");
    });

    elLeaveRoom.addEventListener("click", async () => {
      if (room) {
        await releaseSeat();
        await leaveRoom();
      }
    });

    // クリックが効かない/JSエラーが見つけづらい対策：HUDに出す
    window.addEventListener("error", (ev) => {
      const msg = ev && ev.message ? ev.message : "Unknown error";
      setStatus("JSエラー: " + msg);
    });
  }

  // ===== 起動 =====
  function boot() {
    buildBoardUI();

    // 初期：ローカルは先攻（黒）
    elPlayAsBlack.classList.add("selected");
    elPlayAsWhite.classList.remove("selected");
    localHuman = BLACK;

    // Firebaseは失敗してもローカルで動くようにする
    initFirebase();

    // URL room を反映
    const r = parseRoomFromURL();
    if (r) {
      elRoomCode.value = r;
      joinRoom(r).catch(() => {
        setStatus("Roomに接続できませんでした（ローカルで遊べます）");
      });
    }

    bind();
    renderAll();
    maybeAiMove(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();