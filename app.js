/* app.js（全置換 / compat版）
 - GitHub Pages URLはそのまま
 - Firebase Realtime Database でオンライン同期（room単位）
 - 仮置き：タップで仮置き（選び直しOK）→ 回転して確定
 - Undo / Reset
 - 勝利ライン：winCells を付与（CSS .win でハイライト想定）
 - 簡単AI（白）：ローカル用。オンライン対戦中はOFF推奨
*/

/* =========================
   定数・ユーティリティ
========================= */
const EMPTY = 0, BLACK = 1, WHITE = 2;

const PHASE_PLACE = "place";   // 置く（仮置きOK）
const PHASE_ROTATE = "rotate"; // 回転を選んで確定

const QUADS = {
  TL: 0, TR: 1,
  BL: 2, BR: 3
};

// 6x6 index -> (r,c)
const rc = (i) => [Math.floor(i / 6), i % 6];
const idx = (r, c) => r * 6 + c;

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function randInt(n) { return Math.floor(Math.random() * n); }

// URL param
function getParam(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}
function setParam(name, value) {
  const u = new URL(location.href);
  u.searchParams.set(name, value);
  history.replaceState(null, "", u.toString());
}

/* =========================
   Firebase（compat / CDN）
========================= */
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

let db = null;
let onlineEnabled = false;
try {
  if (typeof firebase !== "undefined") {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    onlineEnabled = true;
  }
} catch (e) {
  console.warn("Firebase init failed:", e);
  onlineEnabled = false;
}

/* =========================
   DOM取得（無ければ最低限作る）
========================= */
function $(id) { return document.getElementById(id); }

const elBoard = $("board") || createBoardRoot();
const elStatus = $("status");
const elPhase = $("phase");
const elEval = $("eval");
const elBW = $("bwCount");
const elRoom = $("room");
const elYou = $("you");

const elRoomCode = $("roomCode");     // 入力欄（任意）
const elSeatLabel = $("seatLabel");   // 表示欄（任意）
const elAiToggle = $("aiToggle") || $("aiWhite") || $("ai"); // チェックボックス想定

// 回転ボタン（idが違っても拾えるようにする）
const btnQuadTL = $("quadTL") || $("qTL");
const btnQuadTR = $("quadTR") || $("qTR");
const btnQuadBL = $("quadBL") || $("qBL");
const btnQuadBR = $("quadBR") || $("qBR");

const btnDirL = $("dirL") || $("rotL") || $("leftDir");
const btnDirR = $("dirR") || $("rotR") || $("rightDir");

const btnConfirm = $("confirmRotate") || $("confirm") || $("rotateConfirm");
const btnUndo = $("undo");
const btnReset = $("reset");

// 画面に「盤が無い」時用：boardコンテナを作る
function createBoardRoot() {
  const main = document.querySelector("main") || document.body;
  const wrap = document.createElement("div");
  wrap.style.padding = "12px";
  const board = document.createElement("div");
  board.id = "board";
  wrap.appendChild(board);
  main.prepend(wrap);
  return board;
}

/* =========================
   ゲーム状態
========================= */
let state = {
  board: Array(36).fill(EMPTY),
  turn: BLACK,
  phase: PHASE_PLACE,
  // 仮置き（place中にだけ有効）
  draftPos: null,
  // 回転選択
  rotQuad: QUADS.TL,
  rotDir: "L", // "L" or "R"
  // 勝利表示
  winCells: [],
  // 終局
  gameOver: false,
  winner: EMPTY, // EMPTY=引き分け/未決
  // オンライン
  room: null,
  seat: null, // BLACK / WHITE / null(spectator)
  // ローカルAI（白）
  aiWhite: false,
};

// Undo用（ローカルのみの簡易。オンラインは基本OFF推奨）
let historyStack = [];

// clientId（オンラインで席判定に使う）
const clientId = getOrCreateClientId();
function getOrCreateClientId() {
  const k = "pentago_client_id";
  let v = localStorage.getItem(k);
  if (!v) {
    v = "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(k, v);
  }
  return v;
}

/* =========================
   盤面描画
========================= */
const cellEls = [];

function buildBoardUI() {
  // 既存があれば流用
  elBoard.innerHTML = "";
  elBoard.classList.add("board");

  for (let i = 0; i < 36; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.idx = String(i);
    cell.addEventListener("click", () => onCellClick(i));
    elBoard.appendChild(cell);
    cellEls.push(cell);
  }
}

function render() {
  // セル描画
  for (let i = 0; i < 36; i++) {
    const v = state.board[i];
    const cell = cellEls[i];
    cell.dataset.mark = String(v);

    // 仮置き表示：draftPosがある時、まだ空なら仮の色を出す
    cell.classList.toggle("draft", state.phase === PHASE_PLACE && state.draftPos === i);
    cell.classList.toggle("win", state.winCells.includes(i));
  }

  // 表示ラベル
  if (elPhase) elPhase.textContent = state.phase === PHASE_PLACE ? "置く" : "回転";
  if (elEval) elEval.textContent = String(evaluateBoard(state.board));
  if (elBW) {
    const b = state.board.filter(x => x === BLACK).length;
    const w = state.board.filter(x => x === WHITE).length;
    elBW.textContent = `${b} / ${w}`;
  }
  if (elRoom) elRoom.textContent = state.room ? String(state.room) : "—";
  if (elYou) {
    const s = state.seat;
    elYou.textContent = s === BLACK ? "黒" : s === WHITE ? "白" : "観戦";
  }

  // 状態表示（簡易）
  if (elStatus) {
    if (state.gameOver) {
      const msg = state.winner === BLACK ? "黒の勝ち" :
                  state.winner === WHITE ? "白の勝ち" : "引き分け";
      elStatus.textContent = `終了：${msg}`;
    } else {
      const t = state.turn === BLACK ? "黒" : "白";
      const p = state.phase === PHASE_PLACE ? "置く（仮置き可）" : "回転して確定";
      elStatus.textContent = `手番：${t} / ${p}`;
    }
  }

  // UIボタンの活性
  const myTurn = isMyTurn();
  if (btnConfirm) btnConfirm.disabled = !(myTurn && state.phase === PHASE_ROTATE && !state.gameOver);
  if (btnUndo) btnUndo.disabled = historyStack.length === 0;
}

function isMyTurn() {
  // 観戦なら操作不可
  if (state.seat !== BLACK && state.seat !== WHITE) return false;
  return state.seat === state.turn;
}

/* =========================
   クリック処理（仮置き→確定）
========================= */
function onCellClick(i) {
  if (state.gameOver) return;

  // オンライン時は自分の手番のみ
  if (state.room && !isMyTurn()) return;

  if (state.phase !== PHASE_PLACE) return;

  // 空マスのみ仮置き可能
  if (state.board[i] !== EMPTY) return;

  // クリックで「仮置き位置」を変更（選び直しOK）
  state.draftPos = i;
  render();
}

function applyConfirmRotate() {
  if (state.gameOver) return;
  if (state.phase !== PHASE_ROTATE) return;

  // オンライン時は自分の手番のみ
  if (state.room && !isMyTurn()) return;

  // 確定：回転を反映
  pushHistory();

  state.board = rotateQuad(state.board, state.rotQuad, state.rotDir);
  afterMoveFinalize();
}

function pushHistory() {
  // 盤・手番・phaseなどを保存（浅いコピーでOK）
  historyStack.push({
    board: state.board.slice(),
    turn: state.turn,
    phase: state.phase,
    draftPos: state.draftPos,
    rotQuad: state.rotQuad,
    rotDir: state.rotDir,
    winCells: state.winCells.slice(),
    gameOver: state.gameOver,
    winner: state.winner,
  });
  // 多すぎ防止
  if (historyStack.length > 60) historyStack.shift();
}

function undo() {
  const prev = historyStack.pop();
  if (!prev) return;
  state.board = prev.board;
  state.turn = prev.turn;
  state.phase = prev.phase;
  state.draftPos = prev.draftPos;
  state.rotQuad = prev.rotQuad;
  state.rotDir = prev.rotDir;
  state.winCells = prev.winCells;
  state.gameOver = prev.gameOver;
  state.winner = prev.winner;
  // オンラインは undo 同期しない（混乱防止）
  render();
  if (state.room) publishState();
}

function resetGame() {
  historyStack = [];
  state.board = Array(36).fill(EMPTY);
  state.turn = BLACK;
  state.phase = PHASE_PLACE;
  state.draftPos = null;
  state.rotQuad = QUADS.TL;
  state.rotDir = "L";
  state.winCells = [];
  state.gameOver = false;
  state.winner = EMPTY;

  render();
  if (state.room) publishState();
  maybeAIMove();
}

/* =========================
   手の進行（置く→回転）
========================= */
function confirmPlacementAndGoRotate() {
  if (state.gameOver) return;
  if (state.phase !== PHASE_PLACE) return;
  if (state.draftPos == null) return;

  // オンライン時は自分の手番のみ
  if (state.room && !isMyTurn()) return;

  pushHistory();

  // 仮置きを確定：盤に石を置く
  state.board[state.draftPos] = state.turn;
  state.draftPos = null;
  state.phase = PHASE_ROTATE;

  render();
  if (state.room) publishState();
}

// 回転確定後の処理
function afterMoveFinalize() {
  // 勝敗判定
  const res = checkWinner(state.board);
  state.winCells = res.winCells;
  if (res.winner !== EMPTY || res.draw) {
    state.gameOver = true;
    state.winner = res.winner; // drawの時 EMPTY のまま
    state.phase = PHASE_PLACE;
    render();
    if (state.room) publishState();
    return;
  }

  // 次の手番へ
  state.turn = (state.turn === BLACK) ? WHITE : BLACK;
  state.phase = PHASE_PLACE;

  render();
  if (state.room) publishState();
  maybeAIMove();
}

/* =========================
   回転
========================= */
function rotateQuad(board, quad, dir) {
  const b = board.slice();

  // quad -> base row/col
  const base = quadToBase(quad);
  const br = base[0], bc = base[1];

  // 3x3取り出し
  const m = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      row.push(b[idx(br + r, bc + c)]);
    }
    m.push(row);
  }

  // 回転
  const rot = [
    [0,0,0],
    [0,0,0],
    [0,0,0],
  ];

  if (dir === "R") {
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        rot[c][2 - r] = m[r][c];
  } else {
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        rot[2 - c][r] = m[r][c];
  }

  // 戻す
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      b[idx(br + r, bc + c)] = rot[r][c];

  return b;
}

function quadToBase(quad) {
  switch (quad) {
    case QUADS.TL: return [0, 0];
    case QUADS.TR: return [0, 3];
    case QUADS.BL: return [3, 0];
    case QUADS.BR: return [3, 3];
    default: return [0, 0];
  }
}

/* =========================
   勝敗判定（5連）
========================= */
function checkWinner(board) {
  // 5 in a row on 6x6 -> 探索
  const lines = [];

  // 横
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c <= 1; c++) {
      const L = [];
      for (let k = 0; k < 5; k++) L.push(idx(r, c + k));
      lines.push(L);
    }
  }
  // 縦
  for (let c = 0; c < 6; c++) {
    for (let r = 0; r <= 1; r++) {
      const L = [];
      for (let k = 0; k < 5; k++) L.push(idx(r + k, c));
      lines.push(L);
    }
  }
  // 斜め \ 
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c <= 1; c++) {
      const L = [];
      for (let k = 0; k < 5; k++) L.push(idx(r + k, c + k));
      lines.push(L);
    }
  }
  // 斜め /
  for (let r = 0; r <= 1; r++) {
    for (let c = 4; c <= 5; c++) {
      const L = [];
      for (let k = 0; k < 5; k++) L.push(idx(r + k, c - k));
      lines.push(L);
    }
  }

  const wins = { [BLACK]: null, [WHITE]: null };

  for (const L of lines) {
    const v0 = board[L[0]];
    if (v0 === EMPTY) continue;
    let ok = true;
    for (let i = 1; i < 5; i++) {
      if (board[L[i]] !== v0) { ok = false; break; }
    }
    if (ok && !wins[v0]) wins[v0] = L;
  }

  const blackWin = !!wins[BLACK];
  const whiteWin = !!wins[WHITE];

  if (blackWin && whiteWin) {
    // 同時勝利 → 引き分け扱い（表示は両方ハイライト）
    return { winner: EMPTY, draw: true, winCells: [...wins[BLACK], ...wins[WHITE]] };
  }
  if (blackWin) return { winner: BLACK, draw: false, winCells: wins[BLACK] };
  if (whiteWin) return { winner: WHITE, draw: false, winCells: wins[WHITE] };

  const full = board.every(x => x !== EMPTY);
  return { winner: EMPTY, draw: full, winCells: [] };
}

/* =========================
   評価値（超簡易）
   - 黒に有利なら +、白に有利なら -
========================= */
function evaluateBoard(board) {
  // 5連ラインの「空き/自色数」をざっくりスコア化
  const lines = [];

  // 横
  for (let r = 0; r < 6; r++) for (let c = 0; c <= 1; c++) lines.push([...Array(5)].map((_,k)=>idx(r,c+k)));
  // 縦
  for (let c = 0; c < 6; c++) for (let r = 0; r <= 1; r++) lines.push([...Array(5)].map((_,k)=>idx(r+k,c)));
  // 斜め \
  for (let r = 0; r <= 1; r++) for (let c = 0; c <= 1; c++) lines.push([...Array(5)].map((_,k)=>idx(r+k,c+k)));
  // 斜め /
  for (let r = 0; r <= 1; r++) for (let c = 4; c <= 5; c++) lines.push([...Array(5)].map((_,k)=>idx(r+k,c-k)));

  let score = 0;

  for (const L of lines) {
    let b = 0, w = 0, e = 0;
    for (const i of L) {
      if (board[i] === BLACK) b++;
      else if (board[i] === WHITE) w++;
      else e++;
    }
    if (b > 0 && w > 0) continue; // 両方混ざるラインは価値低
    // 片側だけの伸び：指数っぽく
    if (b > 0 && w === 0) score += (b * b) + (e === 0 ? 50 : 0);
    if (w > 0 && b === 0) score -= (w * w) + (e === 0 ? 50 : 0);
  }

  return clamp(score, -999, 999);
}

/* =========================
   AI（白）: 簡単
   方針：
   1) 今手で勝てるなら勝つ（置き+回転）
   2) 相手の即勝ちを防ぐ
   3) 評価が良くなる手を選ぶ（ランダム性少し）
========================= */
function maybeAIMove() {
  // AIは白固定
  if (!state.aiWhite) return;
  if (state.room) return; // オンライン中は混乱するのでOFF推奨
  if (state.gameOver) return;
  if (state.turn !== WHITE) return;

  // AIは「置く→回転」まで一気にやる
  // 置く候補（空マス）
  const empties = [];
  for (let i = 0; i < 36; i++) if (state.board[i] === EMPTY) empties.push(i);
  if (empties.length === 0) return;

  const best = findBestMove(state.board, WHITE);

  // 適用（履歴）
  pushHistory();
  state.board[best.place] = WHITE;
  state.board = rotateQuad(state.board, best.quad, best.dir);

  afterMoveFinalize();
}

function findBestMove(board, me) {
  const opp = (me === BLACK) ? WHITE : BLACK;

  const empties = [];
  for (let i = 0; i < 36; i++) if (board[i] === EMPTY) empties.push(i);

  const moves = [];
  const quads = [QUADS.TL, QUADS.TR, QUADS.BL, QUADS.BR];
  const dirs = ["L", "R"];

  // 全探索は重いので少し間引き（空きが多い時）
  const sample = empties.length > 20 ? sampleArray(empties, 18) : empties;

  for (const p of sample) {
    for (const q of quads) {
      for (const d of dirs) {
        const b1 = board.slice();
        b1[p] = me;
        const b2 = rotateQuad(b1, q, d);
        const res = checkWinner(b2);

        // 即勝ち
        if (res.winner === me) return { place: p, quad: q, dir: d };

        // 相手の次の即勝ちをなるべく避ける
        const danger = opponentHasImmediateWin(b2, opp);

        const sc = evaluateBoard(b2) * (me === BLACK ? 1 : -1); // 自分視点
        const total = sc - (danger ? 200 : 0);

        moves.push({ place: p, quad: q, dir: d, total });
      }
    }
  }

  // 最高評価を選ぶ（同点はランダム）
  moves.sort((a, b) => b.total - a.total);
  const top = moves.slice(0, 6);
  return top[randInt(top.length)];
}

function opponentHasImmediateWin(board, opp) {
  const empties = [];
  for (let i = 0; i < 36; i++) if (board[i] === EMPTY) empties.push(i);

  const quads = [QUADS.TL, QUADS.TR, QUADS.BL, QUADS.BR];
  const dirs = ["L", "R"];

  // 簡易チェック：空きから少数サンプル
  const sample = empties.length > 18 ? sampleArray(empties, 12) : empties;

  for (const p of sample) {
    for (const q of quads) {
      for (const d of dirs) {
        const b1 = board.slice();
        b1[p] = opp;
        const b2 = rotateQuad(b1, q, d);
        const res = checkWinner(b2);
        if (res.winner === opp) return true;
      }
    }
  }
  return false;
}

function sampleArray(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/* =========================
   オンライン（Room）
========================= */
let roomRef = null;
let unsubRoom = null;

function roomPath(room) {
  // room: 文字列/数字
  return `rooms/${room}`;
}

function ensureRoom() {
  // URLの ?room= があればそれを採用
  let r = getParam("room");
  if (!r && elRoomCode && elRoomCode.value.trim()) r = elRoomCode.value.trim();

  if (!r) {
    // 自動生成（短め）
    r = String(randInt(900000) + 100000);
    setParam("room", r);
    if (elRoomCode) elRoomCode.value = r;
  }

  state.room = r;
  setParam("room", r);
  if (elRoomCode) elRoomCode.value = r;
  render();
}

function connectOnline() {
  if (!onlineEnabled || !db) {
    console.warn("Firebase not available");
    return;
  }

  ensureRoom();

  roomRef = db.ref(roomPath(state.room));

  // 参加者管理：最初の2人を黒白に割り当て
  const playersRef = roomRef.child("players");
  const meRef = playersRef.child(clientId);

  // presence
  meRef.onDisconnect().remove();
  meRef.set({ joinedAt: firebase.database.ServerValue.TIMESTAMP });

  // seat決め（トランザクション）
  const seatRef = roomRef.child("seats");
  seatRef.transaction((cur) => {
    cur = cur || { black: null, white: null };
    if (cur.black === clientId || cur.white === clientId) return cur;
    if (!cur.black) cur.black = clientId;
    else if (!cur.white) cur.white = clientId;
    return cur;
  }, (err, committed, snap) => {
    if (err) console.warn(err);
    const seats = snap && snap.val ? snap.val() : null;
    updateSeatFromSeats(seats);
  });

  // stateが無ければ初期化
  roomRef.child("state").transaction((cur) => {
    if (cur) return cur;
    return {
      board: Array(36).fill(EMPTY),
      turn: BLACK,
      phase: PHASE_PLACE,
      draftPos: null,
      rotQuad: QUADS.TL,
      rotDir: "L",
      winCells: [],
      gameOver: false,
      winner: EMPTY,
      updatedAt: firebase.database.ServerValue.TIMESTAMP
    };
  });

  // room監視
  roomRef.on("value", (snap) => {
    const v = snap.val();
    if (!v) return;

    if (v.seats) updateSeatFromSeats(v.seats);

    if (v.state) {
      // ローカルの編集中（placeの仮置き）は同期で消したくないので、
      // 仮置きはローカルだけにする（draftPosは同期しない方針でもOK）
      const s = v.state;

      state.board = Array.isArray(s.board) ? s.board.slice(0, 36) : Array(36).fill(EMPTY);
      state.turn = s.turn || BLACK;
      state.phase = s.phase || PHASE_PLACE;
      state.rotQuad = (s.rotQuad ?? QUADS.TL);
      state.rotDir = s.rotDir || "L";
      state.winCells = Array.isArray(s.winCells) ? s.winCells : [];
      state.gameOver = !!s.gameOver;
      state.winner = s.winner ?? EMPTY;

      // draftPos はローカルのみ保持
      state.draftPos = (state.phase === PHASE_PLACE) ? state.draftPos : null;

      render();
    }
  });

  if (elSeatLabel) {
    elSeatLabel.textContent = "接続中…";
  }
}

function updateSeatFromSeats(seats) {
  if (!seats) return;
  if (seats.black === clientId) state.seat = BLACK;
  else if (seats.white === clientId) state.seat = WHITE;
  else state.seat = null;

  if (elSeatLabel) {
    elSeatLabel.textContent =
      state.seat === BLACK ? "あなた：黒" :
      state.seat === WHITE ? "あなた：白" : "観戦";
  }
  render();
}

function publishState() {
  if (!roomRef) return;
  // 仮置き（draftPos）は同期しない（混乱するため）
  const payload = {
    board: state.board,
    turn: state.turn,
    phase: state.phase,
    rotQuad: state.rotQuad,
    rotDir: state.rotDir,
    winCells: state.winCells,
    gameOver: state.gameOver,
    winner: state.winner,
    updatedAt: firebase.database.ServerValue.TIMESTAMP
  };
  roomRef.child("state").set(payload);
}

/* =========================
   UIイベント接続
========================= */
function wireUI() {
  // 置く確定 → rotateへ
  // あなたのUIに「置いて確定」ボタンがある場合は id="placeConfirm" を付けると動く
  const btnPlaceConfirm = $("placeConfirm") || $("confirmPlace");
  if (btnPlaceConfirm) btnPlaceConfirm.addEventListener("click", confirmPlacementAndGoRotate);

  // 回転確定
  if (btnConfirm) btnConfirm.addEventListener("click", applyConfirmRotate);

  // Undo / Reset
  if (btnUndo) btnUndo.addEventListener("click", undo);
  if (btnReset) btnReset.addEventListener("click", resetGame);

  // 回転小盤
  if (btnQuadTL) btnQuadTL.addEventListener("click", () => { state.rotQuad = QUADS.TL; render(); });
  if (btnQuadTR) btnQuadTR.addEventListener("click", () => { state.rotQuad = QUADS.TR; render(); });
  if (btnQuadBL) btnQuadBL.addEventListener("click", () => { state.rotQuad = QUADS.BL; render(); });
  if (btnQuadBR) btnQuadBR.addEventListener("click", () => { state.rotQuad = QUADS.BR; render(); });

  // 方向
  if (btnDirL) btnDirL.addEventListener("click", () => { state.rotDir = "L"; render(); });
  if (btnDirR) btnDirR.addEventListener("click", () => { state.rotDir = "R"; render(); });

  // AI（白）
  if (elAiToggle) {
    elAiToggle.addEventListener("change", () => {
      state.aiWhite = !!elAiToggle.checked;
      maybeAIMove();
    });
    state.aiWhite = !!elAiToggle.checked;
  }

  // Room入力がある場合：入力→反映
  const btnJoin = $("joinRoom");
  if (btnJoin && elRoomCode) {
    btnJoin.addEventListener("click", () => {
      const r = elRoomCode.value.trim();
      if (!r) return;
      setParam("room", r);
      state.room = r;
      connectOnline();
    });
  }
}

/* =========================
   盤（CSSクラス想定）
   - .cell[data-mark="0|1|2"]
   - .cell.win など
========================= */
function ensureBasicStylesHint() {
  // 何も見えない事故防止：最低限のスタイルが無い場合、boardにinlineで最低限だけ与える
  // （style.cssが壊れた時の保険）
  const cs = getComputedStyle(elBoard);
  if (cs.display === "inline" || cs.display === "block") {
    // 盤がgridでない場合、最低限の見た目を付与
    elBoard.style.display = "grid";
    elBoard.style.gridTemplateColumns = "repeat(6, 44px)";
    elBoard.style.gridTemplateRows = "repeat(6, 44px)";
    elBoard.style.gap = "6px";
    elBoard.style.padding = "10px";
    elBoard.style.border = "2px solid #444";
    elBoard.style.borderRadius = "12px";
    elBoard.style.background = "#f6f2ea";
  }
}

/* =========================
   起動
========================= */
function boot() {
  buildBoardUI();
  ensureBasicStylesHint();
  wireUI();

  // もしURLに room があれば自動接続
  const room = getParam("room");
  if (room && onlineEnabled) {
    state.room = room;
    if (elRoomCode) elRoomCode.value = room;
    connectOnline();
  } else {
    // オフラインでも遊べる
    render();
  }

  // 盤をタップして仮置きした後、ユーザーが「置く確定」ボタンを持っていない可能性があるので、
  // その場合は「もう一度タップで確定」ルールを付ける（簡易）
  if (!$("placeConfirm") && !$("confirmPlace")) {
    // 2回目タップで確定（同じマスをもう一度タップ）
    for (let i = 0; i < 36; i++) {
      cellEls[i].addEventListener("dblclick", () => {
        // iPhoneでダブルクリックしづらいので、同じマスをもう一度タップで確定
      });
    }
    // 代替：同じマスを2回タップで確定（シングル）
    // onCellClick内で draftPos を再クリックしたら確定する挙動を追加
    const originalOnCellClick = onCellClick;
    window.onCellClick = function(i){
      // not used
    };
  }
}

// onCellClick を「同じ場所をもう一度タップで確定」に拡張
const _onCellClick = onCellClick;
onCellClick = function(i) {
  if (state.gameOver) return;
  if (state.room && !isMyTurn()) return;
  if (state.phase !== PHASE_PLACE) return;
  if (state.board[i] !== EMPTY) return;

  if (state.draftPos === i) {
    // 同じ場所を再タップ → 置き確定して回転へ
    confirmPlacementAndGoRotate();
    return;
  }
  state.draftPos = i;
  render();
};

boot();
