/* app.js（全置換：AI後攻OK / AI回転OK / アニメ遅く / AI手番も演出あり） */
(() => {
  const EMPTY = 0, BLACK = 1, WHITE = 2;
  const DIR_LEFT = -1, DIR_RIGHT = 1;

  // ======== ここで速度を調整できます（好みで） ========
  const ROTATE_MS = 900;        // 回転アニメの長さ（ゆっくり）
  const AI_THINK_MS = 650;      // AIが「考えてる」待ち
  const AI_PLACE_MS = 520;      // AIが置いたのが見える待ち
  const AI_PICKROT_MS = 520;    // AIが回転選択したのが見える待ち
  // =====================================================

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

  // ===== 状態 =====
  let board = Array(36).fill(EMPTY);

  let phase = "place";     // place -> rotate
  let turn = BLACK;

  let pendingIndex = -1;
  let pendingColor = EMPTY;
  let selectedQ = -1;
  let selectedD = 0;

  let lastPlacedIndex = -1;
  let lastRotatedQ = -1;

  let winCells = new Set();
  let history = [];

  // ===== ローカル（AI） =====
  let localHuman = BLACK;
  let localAIEnabled = false;
  let aiThinking = false;

  // AIが担当する色（←ここが重要：あなたの選択に合わせて変える）
  // 「AI（白）」チェックは “AIと対戦する” の意味として扱い、AI色は「あなたの反対色」にします。
  function aiColor() {
    return other(localHuman);
  }

  // ===== オンライン =====
  let fbOk = false;
  let db = null;
  let room = "";
  let roomRef = null;
  let stateRef = null;
  let presenceRef = null;
  let unsubscribe = null;

  let onlineSeat = ""; // "B" or "W" or ""
  const clientId = (() => {
    const k = "rotation_game_client_id";
    const v = localStorage.getItem(k);
    if (v) return v;
    const nv = Math.random().toString(16).slice(2) + Date.now().toString(16);
    localStorage.setItem(k, nv);
    return nv;
  })();

  // ===== util =====
  const idxRC = (r, c) => r * 6 + c;

  function setStatus(msg) {
    if (elStatus) elStatus.textContent = msg;
  }

  function other(color) {
    return color === BLACK ? WHITE : BLACK;
  }

  function countBW(arr) {
    let b = 0, w = 0;
    for (const v of arr) {
      if (v === BLACK) b++;
      else if (v === WHITE) w++;
    }
    return { b, w };
  }

  function evalBoard(arr) {
    const { b, w } = countBW(arr);
    return (w - b);
  }

  function isGameOver() {
    return winCells.size > 0;
  }

  function isHumanTurn() {
    if (room) {
      return onlineSeat && ((turn === BLACK && onlineSeat === "B") || (turn === WHITE && onlineSeat === "W"));
    }
    return (turn === localHuman);
  }

  function isAITurnLocal() {
    if (room) return false;                 // オンライン中はAIを動かさない
    if (!localAIEnabled) return false;
    if (isGameOver()) return false;
    return (turn === aiColor());
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ===== 勝利判定（5 in a row）=====
  function computeWinCells(arr) {
    const wins = [];
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        const v = arr[idxRC(r,c)];
        if (v === EMPTY) continue;
        for (const [dr,dc] of dirs) {
          const cells = [];
          for (let k = 0; k < 5; k++) {
            const rr = r + dr*k, cc = c + dc*k;
            if (rr < 0 || rr >= 6 || cc < 0 || cc >= 6) { cells.length = 0; break; }
            const ii = idxRC(rr,cc);
            if (arr[ii] !== v) { cells.length = 0; break; }
            cells.push(ii);
          }
          if (cells.length === 5) wins.push(cells);
        }
      }
    }
    const set = new Set();
    for (const line of wins) for (const i of line) set.add(i);
    return set;
  }

  // ===== 盤UI（4小盤）=====
  const quadBaseRC = [[0,0],[0,3],[3,0],[3,3]];
  let quadEls = [];
  let cellEls = [];

  function buildBoardUI() {
    elBoard.innerHTML = "";
    elBoard.classList.add("superBoardRoot");
    quadEls = [];
    cellEls = Array(36).fill(null);

    for (let q = 0; q < 4; q++) {
      const quad = document.createElement("div");
      quad.className = "quadrant";
      quad.dataset.q = String(q);

      const [br, bc] = quadBaseRC[q];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const i = idxRC(br + r, bc + c);
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

    const m = [];
    for (let r = 0; r < 3; r++) {
      const row = [];
      for (let c = 0; c < 3; c++) row.push(arr[idxRC(br+r, bc+c)]);
      m.push(row);
    }

    const rot = [[0,0,0],[0,0,0],[0,0,0]];
    if (dir === DIR_RIGHT) {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) rot[c][2-r] = m[r][c];
    } else {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) rot[2-c][r] = m[r][c];
    }

    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[idxRC(br+r, bc+c)] = rot[r][c];
    return out;
  }

  // ===== 回転（アニメ）=====
  function animateRotateQuad(q, dir) {
    return new Promise((resolve) => {
      const quad = quadEls[q];
      if (!quad) return resolve();

      const deg = dir === DIR_RIGHT ? 90 : -90;
      elBoard.classList.add("animating");

      quad.classList.add("rotating");
      quad.style.setProperty("--rot", `${deg}deg`);

      const done = () => {
        quad.classList.remove("rotating");
        quad.style.removeProperty("--rot");
        elBoard.classList.remove("animating");
        resolve();
      };

      quad.addEventListener("transitionend", done, { once: true });
      setTimeout(done, ROTATE_MS + 100); // 保険
    });
  }

  // ===== UI =====
  function setSelectedButtons() {
    for (const b of qbtns) {
      const q = Number(b.dataset.q);
      b.classList.toggle("selected", q === selectedQ);
      b.disabled = (phase !== "rotate") || isGameOver() || !isHumanTurn();
    }
    for (const b of dbtns) {
      const d = Number(b.dataset.d);
      b.classList.toggle("selected", d === selectedD);
      b.disabled = (phase !== "rotate") || isGameOver() || !isHumanTurn();
    }
    elCommit.disabled = !(phase === "rotate" && selectedQ >= 0 && (selectedD === DIR_LEFT || selectedD === DIR_RIGHT) && isHumanTurn() && !isGameOver());
  }

  function renderBoard() {
    for (let i = 0; i < 36; i++) {
      const el = cellEls[i];
      if (!el) continue;

      el.dataset.mark = String(board[i]);
      el.classList.toggle("pending", i === pendingIndex);
      el.classList.toggle("last", i === lastPlacedIndex);
      el.classList.toggle("win", winCells.has(i));
    }

    for (let q = 0; q < 4; q++) {
      const quad = quadEls[q];
      if (!quad) continue;
      quad.classList.toggle("activeQuad", (phase === "rotate" && q === selectedQ));
      quad.classList.toggle("lastRot", (q === lastRotatedQ));
    }
  }

  function renderHUD() {
    elTurnText.textContent = (turn === BLACK) ? "黒の手番" : "白の手番";
    elPhaseText.textContent = phase;
    elEvalText.textContent = String(evalBoard(board));
    const { b, w } = countBW(board);
    elBwText.textContent = `${b} / ${w}`;
    elRoomLabel.textContent = room ? room : "—";

    if (room) elSeatLabel.textContent = onlineSeat ? onlineSeat : "—";
    else elSeatLabel.textContent = (localHuman === BLACK) ? "B" : "W";

    if (isGameOver()) {
      setStatus("勝利ラインができました（Resetで再開）");
      return;
    }
    if (room && !onlineSeat) {
      setStatus("オンライン：先攻/後攻ボタンで席を取ってください");
      return;
    }
    if (!isHumanTurn()) {
      if (room) setStatus("相手の手番です");
      else setStatus("AIの手番です…");
      return;
    }
    if (phase === "place") setStatus("仮置き：マスをタップ（置き直しOK）");
    else setStatus("回転を選んで「回転して確定」");
  }

  function renderAll() {
    winCells = computeWinCells(board);
    renderBoard();
    setSelectedButtons();
    renderHUD();
  }

  // ===== ヒト操作 =====
  function onCellClick(i) {
    if (elBoard.classList.contains("animating")) return;
    if (isGameOver()) return;
    if (!isHumanTurn()) return;
    if (phase !== "place") return;
    if (room && !onlineSeat) return;
    if (board[i] !== EMPTY) return;

    // 置き直しOK
    if (pendingIndex >= 0) board[pendingIndex] = EMPTY;

    pendingIndex = i;
    pendingColor = turn;
    board[i] = pendingColor;

    lastPlacedIndex = i;
    selectedQ = -1;
    selectedD = 0;

    phase = "rotate";
    pushHistoryIfLocal();
    syncIfOnline();
    renderAll();
  }

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

  // ===== 確定 =====
  async function commitMove(force = false) {
    // force=true のときは AI が呼ぶ（人間制限を回避）
    if (!force) {
      if (isGameOver()) return;
      if (!isHumanTurn()) return;
      if (phase !== "rotate") return;
    } else {
      if (isGameOver()) return;
      if (phase !== "rotate") return;
    }

    if (pendingIndex < 0) return;
    if (!(selectedQ >= 0 && (selectedD === DIR_LEFT || selectedD === DIR_RIGHT))) return;

    pushHistoryIfLocal();

    // アニメ
    await animateRotateQuad(selectedQ, selectedD);

    // データ反映
    board = rotateQuadData(board, selectedQ, selectedD);
    lastRotatedQ = selectedQ;

    pendingIndex = -1;
    pendingColor = EMPTY;

    winCells = computeWinCells(board);

    if (!isGameOver()) {
      turn = other(turn);
      phase = "place";
      selectedQ = -1;
      selectedD = 0;
    }

    syncIfOnline(true);
    renderAll();

    // ローカルならAI続行
    maybeAiMove(true);
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
      writeRoomState({
        board, phase, turn,
        pendingIndex, pendingColor,
        selectedQ, selectedD,
        lastPlacedIndex, lastRotatedQ,
        updatedAt: Date.now()
      });
    }

    renderAll();
    maybeAiMove(true);
  }

  function pushHistoryIfLocal() {
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
    if (room) { setStatus("オンライン中のUndoは無効です"); return; }
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

  // ===== ローカル：先後 =====
  function setLocalHuman(color) {
    localHuman = color;
    renderAll();
    maybeAiMove(true);
  }

  // ===== AI（ローカル）=====
  async function maybeAiMove(force = false) {
    if (!isAITurnLocal()) return;
    if (aiThinking && !force) return;

    aiThinking = true;
    setStatus("AI思考中…");
    renderAll();

    try {
      await sleep(AI_THINK_MS);

      // 1) place（AIの仮置き：置き直しはしない）
      if (phase === "place" && turn === aiColor()) {
        const empties = [];
        for (let i = 0; i < 36; i++) if (board[i] === EMPTY) empties.push(i);
        if (empties.length === 0) return;

        // 中央寄り優先
        empties.sort((a,b) => distToCenter(a) - distToCenter(b));
        const pick = empties[0];

        pendingIndex = pick;
        pendingColor = turn;
        board[pick] = pendingColor;
        lastPlacedIndex = pick;

        phase = "rotate";
        selectedQ = -1;
        selectedD = 0;

        renderAll();
        await sleep(AI_PLACE_MS);
      }

      // 2) rotate（AIが選ぶ様子を見せる）
      if (phase === "rotate" && turn === aiColor()) {
        selectedQ = pickReasonableQuad();
        selectedD = (Math.random() < 0.5) ? DIR_LEFT : DIR_RIGHT;

        renderAll();
        await sleep(AI_PICKROT_MS);

        // 3) commit（force=trueで人間制限を回避して必ず回転する）
        await commitMove(true);
      }
    } finally {
      aiThinking = false;
    }
  }

  function distToCenter(i) {
    const r = Math.floor(i / 6), c = i % 6;
    return Math.abs(r - 2.5) + Math.abs(c - 2.5);
  }

  function pickReasonableQuad() {
    // pendingIndexがある小盤を優先（自然に見える）
    if (pendingIndex >= 0) {
      const r = Math.floor(pendingIndex / 6);
      const c = pendingIndex % 6;
      if (r < 3 && c < 3) return 0;
      if (r < 3 && c >= 3) return 1;
      if (r >= 3 && c < 3) return 2;
      return 3;
    }
    return Math.floor(Math.random() * 4);
  }

  // ===== Firebase =====
  function initFirebase() {
    try {
      firebase.initializeApp(firebaseConfig);
      db = firebase.database();
      fbOk = true;
      return true;
    } catch {
      fbOk = false;
      setStatus("Firebase初期化に失敗しました（ローカルは遊べます）");
      return false;
    }
  }

  function parseRoomFromURL() {
    const u = new URL(location.href);
    const r = u.searchParams.get("room");
    return r ? String(r).trim() : "";
  }

  function setURLRoom(r) {
    const u = new URL(location.href);
    if (r) u.searchParams.set("room", r);
    else u.searchParams.delete("room");
    try { window.history.replaceState(null, "", u.toString()); } catch {}
  }

  function roomPath(r) { return `rooms/${r}`; }

  async function joinRoom(r) {
    if (!fbOk) initFirebase();
    if (!fbOk) return;

    room = r;
    setURLRoom(room);

    roomRef = db.ref(roomPath(room));
    stateRef = db.ref(`${roomPath(room)}/state`);
    presenceRef = db.ref(`${roomPath(room)}/presence/${clientId}`);

    try {
      presenceRef.onDisconnect().remove();
      presenceRef.set({ at: Date.now() });
    } catch {}

    if (unsubscribe) {
      try { stateRef.off("value", unsubscribe); } catch {}
      unsubscribe = null;
    }

    unsubscribe = (snap) => {
      const s = snap.val();
      if (!s) return;

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
    try { if (presenceRef) presenceRef.remove(); } catch {}

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

    resetAll();
    setStatus("ローカルに戻りました");
  }

  async function claimSeat(want) {
    if (!roomRef) return;
    const playersRef = db.ref(`${roomPath(room)}/players`);
    await playersRef.transaction((cur) => {
      cur = cur || { B: "", W: "" };
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
    if (!onlineSeat) setStatus("その席は埋まっています");
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

  function syncIfOnline() {
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
      updatedAt: Date.now()
    });
  }

  function writeRoomState(obj) {
    try { stateRef.set(obj); } catch {}
  }

  // ===== イベント =====
  function bind() {
    qbtns.forEach((b) => b.addEventListener("click", () => selectQuad(Number(b.dataset.q))));
    dbtns.forEach((b) => b.addEventListener("click", () => selectDir(Number(b.dataset.d))));

    elCommit.addEventListener("click", () => commitMove(false));
    elUndo.addEventListener("click", undoOnce);
    elReset.addEventListener("click", resetAll);

    elPlayAsBlack.addEventListener("click", () => {
      elPlayAsBlack.classList.add("selected");
      elPlayAsWhite.classList.remove("selected");
      setLocalHuman(BLACK);
      // 後攻→先攻に変えた時もAIが正常に動く
      maybeAiMove(true);
    });

    elPlayAsWhite.addEventListener("click", () => {
      elPlayAsWhite.classList.add("selected");
      elPlayAsBlack.classList.remove("selected");
      setLocalHuman(WHITE);
      // あなたが後攻（白）ならAIは黒として先に動く
      maybeAiMove(true);
    });

    elAiWhite.addEventListener("change", () => {
      localAIEnabled = !!elAiWhite.checked;
      renderAll();
      maybeAiMove(true);
    });

    elApplyRoom.addEventListener("click", async () => {
      const r = String(elRoomCode.value || "").trim();
      if (!r) { setStatus("room番号を入れてください"); return; }
      await joinRoom(r);
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
        setStatus("コピーできませんでした（手動で共有してください）");
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
      if (!room) return;
      await releaseSeat();
      await leaveRoom();
    });

    window.addEventListener("error", (ev) => {
      const msg = ev && ev.message ? ev.message : "Unknown error";
      setStatus("JSエラー: " + msg);
    });
  }

  // ===== 起動 =====
  function boot() {
    buildBoardUI();

    // 初期：ローカル先攻（黒）
    elPlayAsBlack.classList.add("selected");
    elPlayAsWhite.classList.remove("selected");
    localHuman = BLACK;

    initFirebase();

    const r = parseRoomFromURL();
    if (r) {
      elRoomCode.value = r;
      joinRoom(r).catch(() => setStatus("Roomに接続できませんでした（ローカルで遊べます）"));
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