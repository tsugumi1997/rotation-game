/* app.js（全置換）
  - 盤は必ず表示（Firebaseが壊れててもローカル対局は動く）
  - オンラインは Firebase Realtime Database（compat）で同期
  - 仮置き：セルをタップすると置き/解除できる（確定前は選び直しOK）
  - 「回転して確定」で 1手（置く→回転→勝敗判定）
  - AI（白）はローカル用（オンライン中は自動で無効扱い）
*/

const EMPTY = 0, BLACK = 1, WHITE = 2;

// ===== Firebase 設定（あなたの値）=====
// ※ ここは “import” しない。compat なので window.firebase を使う。
const firebaseConfig = {
  apiKey: "AIzaSyBuV-7S_1LuPiTKVdkFjyOvtKUaN136rPE",
  authDomain: "pentago-online.firebaseapp.com",
  databaseURL: "https://pentago-online-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "pentago-online",
  storageBucket: "pentago-online.firebasestorage.app",
  messagingSenderId: "205747321779",
  appId: "1:205747321779:web:a553a1a01d2bfec98da9c6",
  measurementId: "G-F1BSS16ZQ9",
};

// ===== DOM =====
const elBoard = document.getElementById("board");
const elTurnBig = document.getElementById("turnBig");
const elPhase = document.getElementById("phase");
const elEval = document.getElementById("eval");
const elBW = document.getElementById("bw");
const elRoomLabel = document.getElementById("roomLabel");
const elSeatLabel = document.getElementById("seatLabel");
const elStatus = document.getElementById("status");

const elRoomCode = document.getElementById("roomCode");
const btnJoinRoom = document.getElementById("joinRoom");
const btnCopyLink = document.getElementById("copyLink");

const btnCommit = document.getElementById("commit");
const btnUndo = document.getElementById("undo");
const btnReset = document.getElementById("reset");

const aiWhite = document.getElementById("aiWhite");

// ===== ゲーム状態 =====
let board = makeEmptyBoard(); // 6x6
let turn = BLACK;             // 次に置く色
let phase = "place";          // "place" | "rotate" | "ended"
let pending = null;           // {r,c,color} 仮置き
let selectedQ = null;         // 0..3
let selectedDir = null;       // "L" or "R"
let winCells = new Set();     // "r,c"
let winner = 0;               // 0 none, 1 black, 2 white, 3 both

// Undo用（ローカルのみ）
let history = [];

// ===== オンライン（任意）=====
let firebaseOK = false;
let db = null;
let room = null;
let clientId = getOrCreateClientId();
let seat = "local"; // "black" | "white" | "spectator" | "local"
let roomRef = null;
let stateRef = null;
let seatsRef = null;
let unsubOnline = null;
let applyingRemote = false;

// ===== 初期化 =====
buildBoardDOM();
wireUI();
initFromURL();
tryInitFirebase();
renderAll();

function makeEmptyBoard() {
  return Array.from({ length: 6 }, () => Array(6).fill(EMPTY));
}

function cloneBoard(b) {
  return b.map(row => row.slice());
}

function buildBoardDOM() {
  // 6x6のセルを作る（style.cssの有無に関係なく表示される）
  elBoard.innerHTML = "";
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cell.addEventListener("click", onCellClick);
      elBoard.appendChild(cell);
    }
  }
}

function wireUI() {
  // 小盤
  document.getElementById("quadBtns").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-q]");
    if (!b) return;
    if (phase !== "rotate") return;
    selectedQ = Number(b.dataset.q);
    renderAll();
  });

  // 方向
  document.getElementById("dirBtns").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-d]");
    if (!b) return;
    if (phase !== "rotate") return;
    selectedDir = b.dataset.d;
    renderAll();
  });

  btnCommit.addEventListener("click", onCommit);
  btnUndo.addEventListener("click", onUndo);
  btnReset.addEventListener("click", onReset);

  btnJoinRoom.addEventListener("click", () => {
    const code = (elRoomCode.value || "").trim();
    if (!/^\d{3,12}$/.test(code)) {
      setStatus("roomは数字で（例: 123456）");
      return;
    }
    goRoom(code);
  });

  btnCopyLink.addEventListener("click", async () => {
    const url = makeRoomURL(room || (elRoomCode.value || "").trim() || "");
    try {
      await navigator.clipboard.writeText(url);
      setStatus("リンクをコピーしました");
    } catch {
      setStatus("コピーできない場合はURLを手動で共有してください");
    }
  });

  aiWhite.addEventListener("change", () => {
    renderAll();
    maybeAIMove();
  });
}

function initFromURL() {
  const u = new URL(location.href);
  const qRoom = u.searchParams.get("room");
  if (qRoom && /^\d{3,12}$/.test(qRoom)) {
    goRoom(qRoom, false);
  } else {
    // ローカル
    setStatus("ローカル対局");
  }
}

function makeRoomURL(code) {
  const base = location.origin + location.pathname;
  if (!code) return base;
  return `${base}?room=${encodeURIComponent(code)}`;
}

function goRoom(code, pushState = true) {
  room = code;
  elRoomLabel.textContent = code;
  elRoomCode.value = code;
  if (pushState) {
    const u = new URL(location.href);
    u.searchParams.set("room", code);
    history.replaceState(null, "", u.toString());
  }
  setStatus("オンライン準備中…");
  if (firebaseOK) joinOnlineRoom();
}

function tryInitFirebase() {
  try {
    if (!window.firebase) {
      firebaseOK = false;
      setStatus("Firebaseなし（ローカル動作）");
      return;
    }
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    firebaseOK = true;

    // もしURLにroomがあれば参加
    if (room) joinOnlineRoom();
  } catch (e) {
    firebaseOK = false;
    setStatus("Firebase初期化で停止（ローカル動作）");
    // Firebaseが壊れても盤は表示されるように、例外は握りつぶす
    console.error(e);
  }
}

function joinOnlineRoom() {
  if (!firebaseOK || !db || !room) return;

  // 既存の購読があれば解除
  if (unsubOnline) {
    unsubOnline();
    unsubOnline = null;
  }

  roomRef = db.ref(`rooms/${room}`);
  stateRef = roomRef.child("state");
  seatsRef = roomRef.child("seats");

  // seat割当（transaction）
  seatsRef.transaction((cur) => {
    cur = cur || {};
    if (!cur.black) cur.black = null;
    if (!cur.white) cur.white = null;

    // すでに自分が入っているなら維持
    if (cur.black === clientId) return cur;
    if (cur.white === clientId) return cur;

    if (!cur.black) cur.black = clientId;
    else if (!cur.white) cur.white = clientId;
    // どっちも埋まってたら spectator
    return cur;
  }, (err) => {
    if (err) {
      setStatus("seat割当失敗（ルールを確認）");
      console.error(err);
      seat = "spectator";
      updateSeatLabel();
    } else {
      // seatsの実値を読む
      seatsRef.once("value").then((snap) => {
        const s = snap.val() || {};
        if (s.black === clientId) seat = "black";
        else if (s.white === clientId) seat = "white";
        else seat = "spectator";
        updateSeatLabel();
      });
    }
  });

  // state購読
  const onValue = (snap) => {
    const st = snap.val();
    if (!st) {
      // 初回：空なら初期状態を作る（黒番）
      const initial = packState();
      initial.turn = BLACK;
      initial.phase = "place";
      initial.pending = null;
      initial.selectedQ = null;
      initial.selectedDir = null;
      initial.winner = 0;
      initial.winCells = [];
      stateRef.set(initial);
      return;
    }
    applyingRemote = true;
    applyPackedState(st);
    applyingRemote = false;
    renderAll();
  };

  stateRef.on("value", onValue);
  unsubOnline = () => stateRef.off("value", onValue);

  setStatus("オンライン同期中");
}

function updateSeatLabel() {
  if (seat === "black") elSeatLabel.textContent = "黒";
  else if (seat === "white") elSeatLabel.textContent = "白";
  else if (seat === "spectator") elSeatLabel.textContent = "観戦";
  else elSeatLabel.textContent = "—";
}

function setStatus(msg) {
  elStatus.textContent = msg;
}

function onCellClick(e) {
  const r = Number(e.currentTarget.dataset.r);
  const c = Number(e.currentTarget.dataset.c);

  if (phase === "ended") return;
  if (!canActNow()) return;

  if (phase !== "place") return;

  // すでに埋まっているマスは不可
  if (board[r][c] !== EMPTY) return;

  // 仮置き：同じセルを押すと解除、別セルなら移動
  if (pending && pending.r === r && pending.c === c) {
    pending = null;
  } else {
    pending = { r, c, color: turn };
  }
  renderAll();
}

function onCommit() {
  if (phase === "ended") return;
  if (!canActNow()) return;

  // place -> rotateに進めるには pendingが必要
  if (phase === "place") {
    if (!pending) {
      setStatus("まず石を仮置きしてください");
      return;
    }
    // 仮置きを盤に反映して rotate フェーズへ
    pushHistoryIfLocal();
    board[pending.r][pending.c] = pending.color;
    pending = null;
    phase = "rotate";
    selectedQ = null;
    selectedDir = null;
    setStatus("回転を選んで確定");
    renderAll();
    return;
  }

  // rotate確定
  if (phase === "rotate") {
    if (selectedQ == null || !selectedDir) {
      setStatus("小盤と方向を選んでください");
      return;
    }
    pushHistoryIfLocal();

    board = rotateQuadrant(board, selectedQ, selectedDir);
    selectedQ = null;
    selectedDir = null;

    // 勝敗判定
    const res = checkWinner(board);
    winner = res.winner;
    winCells = res.winCells;

    if (winner !== 0) {
      phase = "ended";
      setStatus(winnerText(winner));
    } else {
      // 次手へ
      turn = (turn === BLACK) ? WHITE : BLACK;
      phase = "place";
      setStatus("仮置き→回転");
    }

    // オンラインなら送信
    publishIfOnline();

    renderAll();
    maybeAIMove();
  }
}

function onUndo() {
  if (room) {
    setStatus("オンライン中はUndo無効");
    return;
  }
  if (history.length === 0) return;
  const prev = history.pop();
  applyPackedState(prev);
  setStatus("Undo");
  renderAll();
}

function onReset() {
  if (!confirm("リセットしますか？")) return;

  board = makeEmptyBoard();
  turn = BLACK;
  phase = "place";
  pending = null;
  selectedQ = null;
  selectedDir = null;
  winCells = new Set();
  winner = 0;
  history = [];

  setStatus(room ? "オンライン：初期化" : "ローカル：初期化");
  publishIfOnline();
  renderAll();
  maybeAIMove();
}

function pushHistoryIfLocal() {
  if (room) return; // オンラインはローカルundoしない
  history.push(packState());
  if (history.length > 200) history.shift();
}

function canActNow() {
  // オンライン：観戦は操作不可、手番以外は不可
  if (room) {
    if (seat === "spectator") return false;
    const myColor = (seat === "black") ? BLACK : WHITE;
    return (turn === myColor);
  }
  return true;
}

function publishIfOnline() {
  if (!room || !firebaseOK || !stateRef) return;
  if (applyingRemote) return;

  // 盤面が変わったら状態を保存
  const st = packState();
  st.updatedAt = Date.now();
  st.updatedBy = clientId;
  stateRef.set(st);
}

function packState() {
  return {
    board: board.flat(), // 36
    turn,
    phase,
    pending,
    selectedQ,
    selectedDir,
    winner,
    winCells: [...winCells].map(s => s), // array
  };
}

function applyPackedState(st) {
  // board
  const flat = st.board || Array(36).fill(EMPTY);
  board = [];
  for (let r = 0; r < 6; r++) {
    board.push(flat.slice(r * 6, r * 6 + 6));
  }

  turn = st.turn ?? BLACK;
  phase = st.phase ?? "place";
  pending = st.pending ?? null;
  selectedQ = (st.selectedQ ?? null);
  selectedDir = (st.selectedDir ?? null);
  winner = st.winner ?? 0;

  winCells = new Set((st.winCells || []).map(String));
}

function renderAll() {
  // HUD
  elPhase.textContent = phase;
  elRoomLabel.textContent = room ? String(room) : "—";
  if (!room) elSeatLabel.textContent = "—";
  updateSeatLabel();

  // 大きい手番表示
  const t = (turn === BLACK) ? "黒の手番" : "白の手番";
  if (phase === "ended") elTurnBig.textContent = "終了";
  else elTurnBig.textContent = t;

  // Eval & counts
  const counts = countBW(board);
  elBW.textContent = `${counts.b} / ${counts.w}`;
  elEval.textContent = String(evaluate(board).toFixed(0));

  // ボタン有効/無効
  btnUndo.disabled = !!room;
  aiWhite.disabled = !!room; // オンライン中はAI無効扱い

  // board描画
  const cells = elBoard.querySelectorAll(".cell");
  cells.forEach((cell) => {
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    let v = board[r][c];

    // pending表示
    const isPending = pending && pending.r === r && pending.c === c;
    if (isPending) v = pending.color;

    cell.dataset.mark = String(v);

    // 勝利ラインハイライト
    const key = `${r},${c}`;
    if (winCells.has(key)) cell.classList.add("win");
    else cell.classList.remove("win");

    // placeフェーズで自分が触れるセルだけ少し強調（CSSがなくてもOK）
    if (phase === "place" && canActNow() && board[r][c] === EMPTY) {
      cell.disabled = false;
    } else {
      cell.disabled = false; // 見えなくなるのを避けて無効化はしない
    }
  });

  // 選択中の回転UI（CSSがあれば見た目で分かる）
  document.querySelectorAll("#quadBtns .qbtn").forEach(b => {
    b.classList.toggle("selected", Number(b.dataset.q) === selectedQ);
  });
  document.querySelectorAll("#dirBtns .dbtn").forEach(b => {
    b.classList.toggle("selected", b.dataset.d === selectedDir);
  });

  // 状態メッセージ
  if (winner !== 0) setStatus(winnerText(winner));
}

function countBW(bd) {
  let b = 0, w = 0;
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      if (bd[r][c] === BLACK) b++;
      if (bd[r][c] === WHITE) w++;
    }
  }
  return { b, w };
}

function rotateQuadrant(bd, q, dir) {
  // q: 0 左上, 1 右上, 2 左下, 3 右下
  const r0 = (q >= 2) ? 3 : 0;
  const c0 = (q % 2 === 1) ? 3 : 0;

  const sub = Array.from({ length: 3 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) => bd[r0 + i][c0 + j])
  );

  const rot = Array.from({ length: 3 }, () => Array(3).fill(EMPTY));

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (dir === "R") rot[j][2 - i] = sub[i][j];
      else rot[2 - j][i] = sub[i][j];
    }
  }

  const out = cloneBoard(bd);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[r0 + i][c0 + j] = rot[i][j];
    }
  }
  return out;
}

function checkWinner(bd) {
  // 5-in-row（Pentago相当）: 黒/白それぞれチェック
  const lines = [];
  const dirs = [
    [0, 1], [1, 0], [1, 1], [1, -1],
  ];

  function inBounds(r, c) { return r >= 0 && r < 6 && c >= 0 && c < 6; }

  const winB = new Set();
  const winW = new Set();

  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 6; c++) {
      for (const [dr, dc] of dirs) {
        // 長さ5を作れる起点だけ
        const r2 = r + dr * 4;
        const c2 = c + dc * 4;
        if (!inBounds(r2, c2)) continue;

        let bCount = 0;
        let wCount = 0;
        const cells = [];

        for (let k = 0; k < 5; k++) {
          const rr = r + dr * k;
          const cc = c + dc * k;
          cells.push([rr, cc]);
          if (bd[rr][cc] === BLACK) bCount++;
          if (bd[rr][cc] === WHITE) wCount++;
        }

        if (bCount === 5) cells.forEach(([rr, cc]) => winB.add(`${rr},${cc}`));
        if (wCount === 5) cells.forEach(([rr, cc]) => winW.add(`${rr},${cc}`));
      }
    }
  }

  const bWin = winB.size > 0;
  const wWin = winW.size > 0;

  let winner = 0;
  if (bWin && wWin) winner = 3;
  else if (bWin) winner = BLACK;
  else if (wWin) winner = WHITE;

  const merged = new Set([...winB, ...winW]);
  return { winner, winCells: merged };
}

function winnerText(w) {
  if (w === BLACK) return "黒の勝ち";
  if (w === WHITE) return "白の勝ち";
  if (w === 3) return "同時勝利（引き分け）";
  return "—";
}

function evaluate(bd) {
  // 超簡易評価：5連の「届きそうさ」を数える（白-黒）
  // 強くしすぎない目的。数字は目安。
  const scoreW = potential(bd, WHITE);
  const scoreB = potential(bd, BLACK);
  return scoreW - scoreB;
}

function potential(bd, color) {
  const opp = (color === BLACK) ? WHITE : BLACK;
  const dirs = [[0,1],[1,0],[1,1],[1,-1]];
  function inBounds(r,c){ return r>=0&&r<6&&c>=0&&c<6; }
  let s = 0;

  for (let r=0;r<6;r++){
    for (let c=0;c<6;c++){
      for (const [dr,dc] of dirs){
        const r2=r+dr*4, c2=c+dc*4;
        if(!inBounds(r2,c2)) continue;

        let mine=0, empty=0, blocked=false;
        for(let k=0;k<5;k++){
          const rr=r+dr*k, cc=c+dc*k;
          const v=bd[rr][cc];
          if(v===opp){ blocked=true; break; }
          if(v===color) mine++;
          if(v===EMPTY) empty++;
        }
        if(blocked) continue;
        // 例: mine=4 empty=1 はかなり高い
        if(mine===4 && empty===1) s+=200;
        else if(mine===3 && empty===2) s+=40;
        else if(mine===2 && empty===3) s+=10;
        else if(mine===1 && empty===4) s+=2;
      }
    }
  }
  return s;
}

function maybeAIMove() {
  // ローカルで、白番で、AIがON、placeフェーズのときだけ
  if (room) return;
  if (!aiWhite.checked) return;
  if (phase !== "place") return;
  if (turn !== WHITE) return;
  if (winner !== 0) return;

  // ちょい人間っぽい簡易AI：
  // 1) 置いて即勝ちがあれば置く
  // 2) 相手の即勝ちを1手で止められるなら止める（仮置きのみ）
  // 3) それ以外は、評価が良い場所をランダム混ぜで選ぶ

  const moves = [];
  for (let r=0;r<6;r++){
    for (let c=0;c<6;c++){
      if(board[r][c]===EMPTY) moves.push([r,c]);
    }
  }
  if (moves.length === 0) return;

  // helper: place-only test (rotationはまだ)
  const testPlace = (r,c,color) => {
    const b2 = cloneBoard(board);
    b2[r][c] = color;
    return checkWinner(b2).winner;
  };

  // 1) 即勝ち置き
  for (const [r,c] of moves){
    const w = testPlace(r,c,WHITE);
    if (w === WHITE || w === 3) {
      pending = { r, c, color: WHITE };
      renderAll();
      // 人間の操作と同じ：commitでrotateへ進む
      setTimeout(() => onCommit(), 150);
      return;
    }
  }

  // 2) 黒の即勝ちを防ぐ置き（rotation前）
  for (const [r,c] of moves){
    const w = testPlace(r,c,BLACK);
    if (w === BLACK || w === 3) {
      pending = { r, c, color: WHITE };
      renderAll();
      setTimeout(() => onCommit(), 150);
      return;
    }
  }

  // 3) 評価ベースで候補作り
  const scored = moves.map(([r,c]) => {
    const b2 = cloneBoard(board);
    b2[r][c] = WHITE;
    const sc = evaluate(b2);
    return { r, c, sc };
  });
  scored.sort((a,b)=> b.sc - a.sc);

  // 上位からランダム（人間っぽさ）
  const top = scored.slice(0, Math.min(6, scored.length));
  const pick = top[Math.floor(Math.random()*top.length)];
  pending = { r: pick.r, c: pick.c, color: WHITE };
  renderAll();
  setTimeout(() => onCommit(), 150);
}

// ===== util =====
function getOrCreateClientId() {
  const k = "rtg_client_id";
  let v = localStorage.getItem(k);
  if (v) return v;
  v = "c_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  localStorage.setItem(k, v);
  return v;
}
