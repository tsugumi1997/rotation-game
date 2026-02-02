/* rotation-game (Pentago-like helper)
   - 6x6 board
   - Place stone (preview allowed; can reselect before commit)
   - Choose quadrant (0=左上,1=右上,2=左下,3=右下) and direction (L/R)
   - Commit = rotate quadrant then finalize move
   - Undo / Reset
   - Optional simple AI for White
   - Optional online sync via Firebase Realtime Database when ?room=xxxx is present
*/

/* ---------- Firebase config (compat) ---------- */
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
let roomId = null;
let clientId = null;
let seat = null; // "B" or "W" in online mode

/* ---------- UI refs ---------- */
const elBoard = document.getElementById("board");
const elTurnBig = document.getElementById("turnBig");
const elPhase = document.getElementById("phase");
const elEval = document.getElementById("eval");
const elBW = document.getElementById("bw");
const elRoom = document.getElementById("roomLabel");
const elYou = document.getElementById("youLabel");
const elStatus = document.getElementById("status");

const btnCommit = document.getElementById("commit");
const btnUndo = document.getElementById("undo");
const btnReset = document.getElementById("reset");
const cbAIWhite = document.getElementById("aiWhite");

/* ---------- Game state ---------- */
const SIZE = 6;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

let board = Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
let turn = BLACK; // whose turn
let phase = "place"; // "place" or "rotate"
let preview = null; // {r,c} while placing
let selQ = null; // 0..3
let selD = null; // "L" or "R"
let history = []; // stack of {board,turn,phase,preview,selQ,selD}
let winLine = []; // list of [r,c] cells highlighted
let score = 0;

/* ---------- Helpers ---------- */
function deepCopyBoard(b) { return b.map(row => row.slice()); }
function setStatus(s) { elStatus.textContent = s; }

function parseRoom() {
  const url = new URL(window.location.href);
  const r = url.searchParams.get("room");
  if (r && String(r).trim() !== "") return String(r).trim();
  return null;
}

function ensureClientId() {
  const key = "rotationGameClientId";
  let v = localStorage.getItem(key);
  if (!v) {
    v = "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, v);
  }
  return v;
}

/* ---------- Rendering ---------- */
function render() {
  // HUD
  elPhase.textContent = phase;
  const bCount = countStones(BLACK);
  const wCount = countStones(WHITE);
  elBW.textContent = `${bCount} / ${wCount}`;
  elEval.textContent = String(score);
  elRoom.textContent = roomId ? roomId : "—";
  elYou.textContent = seat ? seat : "—";

  if (turn === BLACK) elTurnBig.textContent = "黒の手番";
  else elTurnBig.textContent = "白の手番";

  // Board DOM
  elBoard.innerHTML = "";
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const d = document.createElement("div");
      d.className = "cell";
      d.dataset.r = String(r);
      d.dataset.c = String(c);
      d.dataset.mark = String(board[r][c]);

      // preview
      if (preview && preview.r === r && preview.c === c) d.classList.add("preview");

      // win highlight
      if (winLine.some(p => p[0] === r && p[1] === c)) d.classList.add("win");

      d.addEventListener("click", onCellClick);
      elBoard.appendChild(d);
    }
  }

  // Buttons state
  btnCommit.disabled = !(preview && selQ !== null && selD !== null);
  btnUndo.disabled = (history.length === 0);
}

/* ---------- Counting & evaluation ---------- */
function countStones(color) {
  let n = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (board[r][c] === color) n++;
  return n;
}

// Simple heuristic: (open 4/3/2 lines diff) + immediate win threat
function evaluate() {
  const lines = allLines();
  let sc = 0;
  for (const line of lines) {
    const b = line.filter(v => v === BLACK).length;
    const w = line.filter(v => v === WHITE).length;
    const e = line.filter(v => v === EMPTY).length;
    if (b > 0 && w > 0) continue; // blocked
    // favor longer
    if (b > 0) sc += (b === 4 && e === 1 ? 40 : b === 3 && e === 2 ? 8 : b === 2 && e === 3 ? 2 : 0);
    if (w > 0) sc -= (w === 4 && e === 1 ? 40 : w === 3 && e === 2 ? 8 : w === 2 && e === 3 ? 2 : 0);
  }
  score = sc;
}

function allLines() {
  // all 5-length lines on 6x6: horizontal, vertical, diag down-right, diag down-left
  const res = [];
  // horiz
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c <= SIZE - 5; c++) res.push([0,1,2,3,4].map(i => board[r][c+i]));
  }
  // vert
  for (let c = 0; c < SIZE; c++) {
    for (let r = 0; r <= SIZE - 5; r++) res.push([0,1,2,3,4].map(i => board[r+i][c]));
  }
  // diag \
  for (let r = 0; r <= SIZE - 5; r++) {
    for (let c = 0; c <= SIZE - 5; c++) res.push([0,1,2,3,4].map(i => board[r+i][c+i]));
  }
  // diag /
  for (let r = 0; r <= SIZE - 5; r++) {
    for (let c = 4; c < SIZE; c++) res.push([0,1,2,3,4].map(i => board[r+i][c-i]));
  }
  return res;
}

/* ---------- Win detection ---------- */
function findWin() {
  // return {winner: BLACK/WHITE, cells:[[r,c]...]} or null
  // check all 5-in-a-row lines
  // horiz
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c <= SIZE - 5; c++) {
      const cells = [0,1,2,3,4].map(i => [r, c+i]);
      const vals = cells.map(([rr,cc]) => board[rr][cc]);
      const w = winnerOf(vals);
      if (w) return { winner: w, cells };
    }
  }
  // vert
  for (let c = 0; c < SIZE; c++) {
    for (let r = 0; r <= SIZE - 5; r++) {
      const cells = [0,1,2,3,4].map(i => [r+i, c]);
      const vals = cells.map(([rr,cc]) => board[rr][cc]);
      const w = winnerOf(vals);
      if (w) return { winner: w, cells };
    }
  }
  // diag \
  for (let r = 0; r <= SIZE - 5; r++) {
    for (let c = 0; c <= SIZE - 5; c++) {
      const cells = [0,1,2,3,4].map(i => [r+i, c+i]);
      const vals = cells.map(([rr,cc]) => board[rr][cc]);
      const w = winnerOf(vals);
      if (w) return { winner: w, cells };
    }
  }
  // diag /
  for (let r = 0; r <= SIZE - 5; r++) {
    for (let c = 4; c < SIZE; c++) {
      const cells = [0,1,2,3,4].map(i => [r+i, c-i]);
      const vals = cells.map(([rr,cc]) => board[rr][cc]);
      const w = winnerOf(vals);
      if (w) return { winner: w, cells };
    }
  }
  return null;
}

function winnerOf(vals) {
  if (vals.every(v => v === BLACK)) return BLACK;
  if (vals.every(v => v === WHITE)) return WHITE;
  return null;
}

/* ---------- Rotation ---------- */
function rotateQuadrant(b, q, dir) {
  // q mapping (2x2 of 3x3 blocks):
  // 0=左上, 1=右上, 2=左下, 3=右下
  const r0 = (q >= 2) ? 3 : 0;
  const c0 = (q % 2 === 1) ? 3 : 0;

  // extract 3x3
  const m = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => b[r0+i][c0+j]));
  const out = Array.from({ length: 3 }, () => Array(3).fill(0));

  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    if (dir === "R") out[j][2 - i] = m[i][j];
    else out[2 - j][i] = m[i][j];
  }
  // put back
  const nb = deepCopyBoard(b);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) nb[r0+i][c0+j] = out[i][j];
  return nb;
}

/* ---------- Input handling ---------- */
function pushHistory() {
  history.push({
    board: deepCopyBoard(board),
    turn,
    phase,
    preview: preview ? { ...preview } : null,
    selQ,
    selD,
    winLine: winLine.slice(),
    score
  });
  if (history.length > 60) history.shift();
}

function clearSelection() {
  preview = null;
  selQ = null;
  selD = null;
  // unselect buttons
  document.querySelectorAll("button.selected").forEach(b => b.classList.remove("selected"));
}

function onCellClick(ev) {
  if (seat && ((turn === BLACK && seat !== "B") || (turn === WHITE && seat !== "W"))) {
    return; // not your turn online
  }
  if (phase !== "place") return;

  const r = Number(ev.currentTarget.dataset.r);
  const c = Number(ev.currentTarget.dataset.c);

  // allow reselect preview freely
  if (board[r][c] !== EMPTY) return;

  preview = { r, c };
  setStatus(`preview: (${r+1},${c+1})`);
  render();
}

document.querySelectorAll(".qbtn").forEach(btn => {
  btn.addEventListener("click", () => {
    selQ = Number(btn.dataset.q);
    document.querySelectorAll(".qbtn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    render();
  });
});
document.querySelectorAll(".dbtn").forEach(btn => {
  btn.addEventListener("click", () => {
    selD = btn.dataset.d;
    document.querySelectorAll(".dbtn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    render();
  });
});

btnCommit.addEventListener("click", () => {
  if (!(preview && selQ !== null && selD !== null)) return;
  if (seat && ((turn === BLACK && seat !== "B") || (turn === WHITE && seat !== "W"))) return;

  pushHistory();

  // place
  board[preview.r][preview.c] = turn;

  // rotate
  board = rotateQuadrant(board, selQ, selD);

  // clear temporary selections
  const movedTurn = turn;
  clearSelection();
  phase = "place";

  // win check
  const w = findWin();
  winLine = w ? w.cells : [];

  // next turn
  turn = (turn === BLACK) ? WHITE : BLACK;

  evaluate();
  render();
  maybeSync();

  // AI move if enabled and it's white's turn
  if (cbAIWhite.checked && !seat) {
    if (turn === WHITE) setTimeout(() => aiMove(), 250);
  }

  if (w) setStatus((w.winner === BLACK ? "黒の勝ち" : "白の勝ち") + "！");
  else setStatus(`${movedTurn === BLACK ? "黒" : "白"} 確定`);
});

btnUndo.addEventListener("click", () => {
  if (history.length === 0) return;
  if (seat) return; // keep online simple: no undo online
  const s = history.pop();
  board = deepCopyBoard(s.board);
  turn = s.turn;
  phase = s.phase;
  preview = s.preview ? { ...s.preview } : null;
  selQ = s.selQ;
  selD = s.selD;
  winLine = s.winLine.slice();
  score = s.score;
  setStatus("undo");
  // restore button highlights
  document.querySelectorAll("button.selected").forEach(b => b.classList.remove("selected"));
  if (selQ !== null) document.querySelector(`.qbtn[data-q="${selQ}"]`)?.classList.add("selected");
  if (selD) document.querySelector(`.dbtn[data-d="${selD}"]`)?.classList.add("selected");
  render();
});

btnReset.addEventListener("click", () => {
  if (seat) return; // keep online simple
  board = Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
  turn = BLACK;
  phase = "place";
  history = [];
  clearSelection();
  winLine = [];
  score = 0;
  setStatus("reset");
  render();
});

/* ---------- Simple AI (White) ---------- */
function aiMove() {
  if (turn !== WHITE) return;
  // choose best by shallow search: try all placements (empty) with all rotations (4*2), maximize evaluation for white (minimize score)
  let best = null;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    if (board[r][c] !== EMPTY) continue;
    for (let q = 0; q < 4; q++) {
      for (const d of ["L","R"]) {
        const b1 = deepCopyBoard(board);
        b1[r][c] = WHITE;
        const b2 = rotateQuadrant(b1, q, d);
        // immediate win?
        const w = checkWinOn(b2);
        let val;
        if (w === WHITE) val = -9999;
        else if (w === BLACK) val = 9999;
        else val = evalBoard(b2);
        if (!best || val < best.val) best = { r, c, q, d, val };
      }
    }
  }
  if (!best) return;

  // apply best move
  pushHistory();
  board[best.r][best.c] = WHITE;
  board = rotateQuadrant(board, best.q, best.d);

  const w = findWin();
  winLine = w ? w.cells : [];
  turn = BLACK;
  clearSelection();
  phase = "place";
  evaluate();
  render();
  if (w) setStatus("白(AI)の勝ち！");
  else setStatus("白(AI) 確定");
}

function evalBoard(b) {
  // same heuristic but computed on b
  const lines = [];
  // horiz
  for (let r = 0; r < SIZE; r++) for (let c = 0; c <= SIZE-5; c++) lines.push([0,1,2,3,4].map(i => b[r][c+i]));
  // vert
  for (let c = 0; c < SIZE; c++) for (let r = 0; r <= SIZE-5; r++) lines.push([0,1,2,3,4].map(i => b[r+i][c]));
  // diag \
  for (let r = 0; r <= SIZE-5; r++) for (let c = 0; c <= SIZE-5; c++) lines.push([0,1,2,3,4].map(i => b[r+i][c+i]));
  // diag /
  for (let r = 0; r <= SIZE-5; r++) for (let c = 4; c < SIZE; c++) lines.push([0,1,2,3,4].map(i => b[r+i][c-i]));

  let sc = 0;
  for (const line of lines) {
    const bb = line.filter(v => v === BLACK).length;
    const ww = line.filter(v => v === WHITE).length;
    const ee = line.filter(v => v === EMPTY).length;
    if (bb > 0 && ww > 0) continue;
    if (bb > 0) sc += (bb === 4 && ee === 1 ? 40 : bb === 3 && ee === 2 ? 8 : bb === 2 && ee === 3 ? 2 : 0);
    if (ww > 0) sc -= (ww === 4 && ee === 1 ? 40 : ww === 3 && ee === 2 ? 8 : ww === 2 && ee === 3 ? 2 : 0);
  }
  return sc;
}

function checkWinOn(b) {
  const winOf5 = (vals) => {
    if (vals.every(v => v === BLACK)) return BLACK;
    if (vals.every(v => v === WHITE)) return WHITE;
    return null;
  };
  // horiz/vert/diag
  for (let r = 0; r < SIZE; r++) for (let c = 0; c <= SIZE-5; c++) {
    const w = winOf5([0,1,2,3,4].map(i => b[r][c+i])); if (w) return w;
  }
  for (let c = 0; c < SIZE; c++) for (let r = 0; r <= SIZE-5; r++) {
    const w = winOf5([0,1,2,3,4].map(i => b[r+i][c])); if (w) return w;
  }
  for (let r = 0; r <= SIZE-5; r++) for (let c = 0; c <= SIZE-5; c++) {
    const w = winOf5([0,1,2,3,4].map(i => b[r+i][c+i])); if (w) return w;
  }
  for (let r = 0; r <= SIZE-5; r++) for (let c = 4; c < SIZE; c++) {
    const w = winOf5([0,1,2,3,4].map(i => b[r+i][c-i])); if (w) return w;
  }
  return null;
}

/* ---------- Online sync (simple) ---------- */
function initOnlineIfRoom() {
  roomId = parseRoom();
  if (!roomId) {
    setStatus("local mode");
    return;
  }
  elRoom.textContent = roomId;
  clientId = ensureClientId();

  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
  } catch (e) {
    // already initialized
    db = firebase.database();
  }

  const roomRef = db.ref(`rooms/${roomId}`);

  // seat assignment (very simple)
  const seatRef = roomRef.child("seats").child(clientId);
  seatRef.set(true);

  // determine seat by ordering
  roomRef.child("seats").on("value", snap => {
    const seats = snap.val() || {};
    const ids = Object.keys(seats).sort();
    if (ids.length === 0) return;
    const idx = ids.indexOf(clientId);
    seat = (idx === 0) ? "B" : "W";
    elYou.textContent = seat;
    setStatus("online: " + seat);
    render();
  });

  // listen state
  roomRef.child("state").on("value", snap => {
    const s = snap.val();
    if (!s) return;
    board = s.board;
    turn = s.turn;
    winLine = s.winLine || [];
    score = s.score || 0;
    // online: disable local selections
    preview = null;
    selQ = null;
    selD = null;
    document.querySelectorAll("button.selected").forEach(b => b.classList.remove("selected"));
    render();
  });

  // if no state yet, publish initial
  roomRef.child("state").get().then(snap => {
    if (!snap.exists()) {
      maybeSync(true);
    }
  }).catch(() => {});
}

function maybeSync(force=false) {
  if (!db || !roomId) return;
  if (!force && seat) {
    // allow only current player to write
    if ((turn === BLACK && seat !== "B") || (turn === WHITE && seat !== "W")) return;
  }
  const roomRef = db.ref(`rooms/${roomId}`);
  roomRef.child("state").set({
    board,
    turn,
    winLine,
    score,
    t: Date.now()
  });
}

/* ---------- Boot ---------- */
function boot() {
  setStatus("boot");
  evaluate();
  render();
  initOnlineIfRoom();
}
boot();
