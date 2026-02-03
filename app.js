/* app.js（全置換・安定版）
 - 盤は必ず生成（JSが動けば必ず表示）
 - place中は「仮置き」：空マスなら選び直しOK
 - rotate選択（小盤/方向）は place中でもrotate中でもOK
 - 「回転して確定」で：仮置き→盤へ反映→回転→確定
 - Firebase Realtime Database は “動けば同期”、失敗してもローカルで遊べる
*/

(() => {
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

  // 回転ボタン
  const quadBtns = Array.from(document.querySelectorAll(".qbtn"));
  const dirBtns = Array.from(document.querySelectorAll(".dbtn"));

  // ===== ゲーム状態 =====
  let board = Array(36).fill(EMPTY); // 確定石
  let fixed = Array(36).fill(false); // 確定石フラグ（trueなら触れない）

  let turn = BLACK;                 // 次に確定する色
  let phase = "place";              // place -> rotate
  let pendingIndex = -1;            // 仮置き位置（-1なし）
  let pendingColor = EMPTY;         // 仮置き色（BLACK/WHITE）

  let selectedQuad = 0;             // 0..3
  let selectedDir = 1;              // -1(left) / +1(right)

  let history = [];                 // undo用（ローカルのみ）

  // 勝利ライン強調（必要ならCSSで .win ）
  let winCells = new Set();

  // ===== オンライン（Firebase） =====
  // ※あなたの設定値（貼ってくれたやつ）をそのまま入れています
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

  let room = "";       // 例: "123456"
  let seat = "";       // "B" or "W"（簡易）
  let unsub = null;    // 監視解除（compatではon/off）

  function setStatus(s) {
    if (elStatus) elStatus.textContent = s;
  }

  function initFirebaseMaybe() {
    try {
      if (!window.firebase || !firebase.initializeApp) {
        setStatus("Firebase未読込：ローカルで遊べます");
        return;
      }
      firebase.initializeApp(firebaseConfig);
      db = firebase.database();
      onlineEnabled = true;
      setStatus("Firebase接続OK（Room同期可）");
    } catch (e) {
      onlineEnabled = false;
      db = null;
      setStatus("Firebase初期化失敗：ローカルで遊べます");
    }
  }

  function parseRoomFromURL() {
    try {
      const u = new URL(location.href);
      const r = u.searchParams.get("room");
      return r && r.trim() ? r.trim() : "";
    } catch {
      return "";
    }
  }

  function updateURLRoom(r) {
    try {
      const u = new URL(location.href);
      if (r) u.searchParams.set("room", r);
      else u.searchParams.delete("room");
      historyReplace(u.toString());
    } catch {}
  }

  function historyReplace(url) {
    try { window.history.replaceState(null, "", url); } catch {}
  }

  function makeSeatIfNeeded() {
    // 既にseatがあれば維持。なければランダムでB/W
    if (seat === "B" || seat === "W") return;
    seat = (Math.random() < 0.5) ? "B" : "W";
  }

  function setRoom(r) {
    room = (r || "").trim();
    if (!room) {
      if (elRoomLabel) elRoomLabel.textContent = "—";
      setStatus("Room未設定：ローカルで遊べます");
      detachRoomListener();
      return;
    }
    if (elRoomLabel) elRoomLabel.textContent = room;
    updateURLRoom(room);

    makeSeatIfNeeded();
    if (elSeatLabel) elSeatLabel.textContent = seat;

    if (!onlineEnabled || !db) {
      setStatus("Firebase未接続：ローカルで遊べます");
      return;
    }

    attachRoomListener();
    syncToOnline(); // 初回書き込み（空なら作る）
  }

  function roomRef() {
    return db.ref(`rooms/${room}`);
  }

  function detachRoomListener() {
    if (!onlineEnabled || !db || !room || !unsub) return;
    try {
      roomRef().off("value", unsub);
    } catch {}
    unsub = null;
  }

  function attachRoomListener() {
    detachRoomListener();
    if (!onlineEnabled || !db || !room) return;

    const handler = (snap) => {
      const data = snap.val();
      if (!data) return;

      // dataの方が新しければ反映（簡易：ts比較）
      if (typeof data.ts === "number" && typeof lastLocalTs === "number") {
        if (data.ts < lastLocalTs) return;
      }

      if (Array.isArray(data.board) && data.board.length === 36) {
        board = data.board.slice();
      }
      if (Array.isArray(data.fixed) && data.fixed.length === 36) {
        fixed = data.fixed.slice();
      }
      if (typeof data.turn === "number") turn = data.turn;
      if (typeof data.phase === "string") phase = data.phase;
      if (typeof data.pendingIndex === "number") pendingIndex = data.pendingIndex;
      if (typeof data.pendingColor === "number") pendingColor = data.pendingColor;
      if (typeof data.selectedQuad === "number") selectedQuad = data.selectedQuad;
      if (typeof data.selectedDir === "number") selectedDir = data.selectedDir;

      // seatはローカル優先でOK（対戦の厳密管理は省略）
      render();
    };

    unsub = handler;
    roomRef().on("value", handler);
    setStatus("Room同期中（同じroomを開くと反映）");
  }

  let lastLocalTs = 0;
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

  // ===== 描画 =====
  function countBW(arr) {
    let b = 0, w = 0;
    for (const v of arr) {
      if (v === BLACK) b++;
      else if (v === WHITE) w++;
    }
    return { b, w };
  }

  function currentEvalSimple() {
    // 超簡易評価（差分）
    const { b, w } = countBW(board);
    const v = (b - w);
    // 仮置き分を軽く反映
    if (pendingIndex >= 0 && pendingColor !== EMPTY) {
      if (pendingColor === BLACK) return v + 1;
      if (pendingColor === WHITE) return v - 1;
    }
    return v;
  }

  function render() {
    // HUD
    if (elTurnText) elTurnText.textContent = (turn === BLACK ? "黒の手番" : "白の手番");
    if (elPhaseText) elPhaseText.textContent = phase;
    if (elEvalText) elEvalText.textContent = String(currentEvalSimple());

    const { b, w } = countBW(board);
    if (elBWText) elBWText.textContent = `${b} / ${w}`;
    if (elRoomLabel) elRoomLabel.textContent = room ? room : "—";
    if (elSeatLabel) elSeatLabel.textContent = seat ? seat : "—";

    // 回転ボタンの選択表示（CSSが無くても押し間違い防止）
    quadBtns.forEach(btn => {
      const q = Number(btn.dataset.q);
      btn.classList.toggle("selected", q === selectedQuad);
    });
    dirBtns.forEach(btn => {
      const d = Number(btn.dataset.d);
      btn.classList.toggle("selected", d === selectedDir);
    });

    // 盤
    if (!elBoard) return;
    const cells = elBoard.children;
    for (let i = 0; i < 36; i++) {
      const c = cells[i];
      if (!c) continue;

      let v = board[i];
      // 仮置きは上書き表示
      if (i === pendingIndex && pendingColor !== EMPTY) v = pendingColor;

      c.dataset.mark = String(v); // CSSがmarkで色付けしてる想定
      c.classList.toggle("fixed", !!fixed[i]);
      c.classList.toggle("pending", i === pendingIndex && pendingColor !== EMPTY);
      c.classList.toggle("win", winCells.has(i));
    }

    // ボタン有効/無効
    if (btnCommit) btnCommit.disabled = (pendingIndex < 0);
    if (btnUndo) btnUndo.disabled = (history.length === 0);
  }

  // ===== クリック：マス =====
  function onCellClick(i) {
    if (isGameOver()) return;

    // 確定石があるマスは触れない（置き直しは「仮置き」だけ）
    if (fixed[i]) return;

    // 空マスかどうか（確定石が無い、かつ board が EMPTY）
    if (board[i] !== EMPTY) return;

    // 仮置き：空マスなら何度でも選び直しOK
    pendingIndex = i;
    pendingColor = turn;

    // rotateフェーズへ進めたい場合はここで rotate にする
    phase = "rotate";
    winCells.clear();
    setStatus("回転を選んで「回転して確定」");
    pushHistoryIfLocal(); // “今の状態”を戻せるように
    render();
    syncToOnline();
  }

  // ===== 回転選択 =====
  function selectQuad(q) {
    // place中でもrotate中でも選べる
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

  // ===== 回転して確定 =====
  function commitMove() {
    if (isGameOver()) return;
    if (pendingIndex < 0 || pendingColor === EMPTY) {
      setStatus("先にマスをタップして仮置きしてください");
      return;
    }

    // 1) 仮置きを確定石として board に入れる
    board[pendingIndex] = pendingColor;
    fixed[pendingIndex] = true;

    // 2) 選ばれた小盤を回転
    rotateQuadrant(selectedQuad, selectedDir);

    // 3) 勝利判定
    winCells = computeWinCells();
    if (winCells.size > 0) {
      setStatus("勝利ラインあり！");
      render();
      syncToOnline();
      return;
    }

    // 4) 次の手番へ
    pendingIndex = -1;
    pendingColor = EMPTY;
    phase = "place";
    turn = (turn === BLACK ? WHITE : BLACK);
    setStatus("仮置き：マスをタップ（置き直しOK）");

    render();
    syncToOnline();

    // AI（白）なら実行（ローカルでのみ）
    if (cbAiWhite && cbAiWhite.checked && turn === WHITE) {
      setTimeout(() => aiMoveSimple(), 200);
    }
  }

  // ===== 回転処理 =====
  // 小盤の index リストを返す（3x3）
  function quadIndices(q) {
    // 6x6 を 3x3 で4分割
    // q: 0=左上, 1=右上, 2=左下, 3=右下
    const rowBase = (q === 0 || q === 1) ? 0 : 3;
    const colBase = (q === 0 || q === 2) ? 0 : 3;
    const idx = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const rr = rowBase + r;
        const cc = colBase + c;
        idx.push(rr * 6 + cc);
      }
    }
    return idx; // 長さ9
  }

  function rotateQuadrant(q, dir) {
    const idx = quadIndices(q);

    // 3x3 をコピー
    const b0 = idx.map(k => board[k]);
    const f0 = idx.map(k => fixed[k]);

    // 回転後の位置
    // right(clockwise): (r,c)->(c,2-r)
    // left(counter):    (r,c)->(2-c,r)
    const map = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const from = r * 3 + c;
        const to = (dir === 1)
          ? (c * 3 + (2 - r))
          : ((2 - c) * 3 + r);
        map[to] = from;
      }
    }

    // 反映
    for (let t = 0; t < 9; t++) {
      const from = map[t];
      board[idx[t]] = b0[from];
      fixed[idx[t]] = f0[from];
    }
  }

  // ===== 勝利判定（超簡易：5連以上があれば勝ちとしてハイライト） =====
  function computeWinCells() {
    const res = new Set();

    const lines = [];
    // 横
    for (let r = 0; r < 6; r++) {
      const arr = [];
      for (let c = 0; c < 6; c++) arr.push(r * 6 + c);
      lines.push(arr);
    }
    // 縦
    for (let c = 0; c < 6; c++) {
      const arr = [];
      for (let r = 0; r < 6; r++) arr.push(r * 6 + c);
      lines.push(arr);
    }
    // 斜め（\）
    for (let start = 0; start <= 1; start++) {
      const arr = [];
      for (let k = 0; k < 6; k++) arr.push((start + k) * 6 + k);
      lines.push(arr);
    }
    // 斜め（/）
    for (let start = 0; start <= 1; start++) {
      const arr = [];
      for (let k = 0; k < 6; k++) arr.push((start + k) * 6 + (5 - k));
      lines.push(arr);
    }

    function collectRuns(line) {
      let runColor = EMPTY;
      let run = [];
      for (const idx of line) {
        const v = board[idx];
        if (v !== EMPTY && v === runColor) {
          run.push(idx);
        } else {
          if (runColor !== EMPTY && run.length >= 5) run.forEach(x => res.add(x));
          runColor = v;
          run = (v === EMPTY) ? [] : [idx];
        }
      }
      if (runColor !== EMPTY && run.length >= 5) run.forEach(x => res.add(x));
    }

    lines.forEach(collectRuns);
    return res;
  }

  function isGameOver() {
    return winCells.size > 0;
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
      winCells: new Set([...winCells])
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
    winCells = new Set([...s.winCells]);
  }

  function pushHistoryIfLocal() {
    // オンライン同期中は「相手の操作も混ざる」ので、undoはローカル用途に限定
    // ただし、今は簡易なので常に保存してOK（困ったらUndoで戻れる）
    history.push(snapshot());
    if (history.length > 50) history.shift();
  }

  function undo() {
    if (history.length === 0) return;
    const s = history.pop();
    restore(s);
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

  // ===== AI（超簡単） =====
  function aiMoveSimple() {
    if (isGameOver()) return;
    if (turn !== WHITE) return;

    // 空マスからランダム（確定石のないEMPTY）
    const empties = [];
    for (let i = 0; i < 36; i++) {
      if (!fixed[i] && board[i] === EMPTY) empties.push(i);
    }
    if (empties.length === 0) return;

    const i = empties[Math.floor(Math.random() * empties.length)];
    pendingIndex = i;
    pendingColor = WHITE;
    phase = "rotate";

    // 回転もランダム
    selectedQuad = Math.floor(Math.random() * 4);
    selectedDir = (Math.random() < 0.5) ? -1 : 1;

    render();
    syncToOnline();
    setTimeout(() => commitMove(), 200);
  }

  // ===== イベント =====
  function bindEvents() {
    quadBtns.forEach(b => {
      b.addEventListener("click", () => selectQuad(Number(b.dataset.q)));
    });
    dirBtns.forEach(b => {
      b.addEventListener("click", () => selectDir(Number(b.dataset.d)));
    });

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
        if (!r) {
          setStatus("room番号を入れてから共有URLを押してください");
          return;
        }
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

    // iPhoneで原因を見つけやすいようにHUDへ
    window.addEventListener("error", (ev) => {
      try {
        const msg = ev && ev.message ? ev.message : "Unknown error";
        setStatus("JSエラー: " + msg);
      } catch {}
    });
  }

  // ===== 起動 =====
  function boot() {
    // 盤UIは最初に必ず作る（ここで出ないならJSが動いていない）
    makeBoardUI();

    // Firebaseは失敗しても落とさない
    initFirebaseMaybe();

    // URL room を反映
    const r = parseRoomFromURL();
    if (r) {
      if (elRoomCode) elRoomCode.value = r;
      setRoom(r);
    } else {
      // roomなしでも遊べる
      if (elRoomLabel) elRoomLabel.textContent = "—";
      makeSeatIfNeeded();
      if (elSeatLabel) elSeatLabel.textContent = seat;
      setStatus("仮置き：マスをタップ（置き直しOK）");
    }

    bindEvents();
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
