/* app.js（復旧版：まず盤を必ず表示して動かす。Firebaseなし）
  - 6x6盤（4つの3x3小盤）
  - 仮置き：タップで仮置き（選び直しOK）→ 回転して確定
  - 勝利ライン：5連をハイライト（.win付与）
  - Eval：簡易評価（+有利 / -不利）
  - AI（白）：ローカル練習用の簡単AI
*/

const EMPTY = 0, BLACK = 1, WHITE = 2;

const elBoard = document.getElementById("board");
const elTurnBig = document.getElementById("turnBig");
const elPhase = document.getElementById("phase");
const elEval = document.getElementById("eval");
const elBW = document.getElementById("bw");
const elRoom = document.getElementById("roomCode"); // 使わないが表示は維持
const elSeat = document.getElementById("seatLabel"); // 使わないが表示は維持
const elStatus = document.getElementById("status");

const chkAiWhite = document.getElementById("aiWhite");

const btnCommit = document.getElementById("commit");
const btnUndo = document.getElementById("undo");
const btnReset = document.getElementById("reset");

const quadBtns = Array.from(document.querySelectorAll(".qbtn"));
const dirBtns  = Array.from(document.querySelectorAll(".dbtn"));

let board = new Array(36).fill(EMPTY);
let phase = "place"; // "place" -> "rotate"
let turn = BLACK;

let pendingIndex = -1;    // 仮置きしているマス（1個だけ）
let pendingColor = EMPTY; // 仮置きの色
let selQuad = -1;         // 0:左上 1:右上 2:左下 3:右下
let selDir = 0;           // -1:左(反時計)  +1:右(時計)

let bwCount = { b: 0, w: 0 };

let history = []; // {board, turn, phase, pendingIndex, pendingColor, selQuad, selDir, bwCount}

function idx(r, c) { return r * 6 + c; }

function cloneState() {
  return {
    board: board.slice(),
    turn,
    phase,
    pendingIndex,
    pendingColor,
    selQuad,
    selDir,
    bwCount: { ...bwCount },
  };
}
function pushHistory() { history.push(cloneState()); }
function popHistory() {
  const s = history.pop();
  if (!s) return;
  board = s.board;
  turn = s.turn;
  phase = s.phase;
  pendingIndex = s.pendingIndex;
  pendingColor = s.pendingColor;
  selQuad = s.selQuad;
  selDir = s.selDir;
  bwCount = s.bwCount;
  render();
}

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

function onCellClick(i) {
  if (isGameOver()) return;

  // placeフェーズ：仮置きを置く（置き直しOK）
  if (phase !== "place") return;

  if (board[i] !== EMPTY) return; // 既に確定石がある場所には置けない

  // 仮置きがまだなら置く、あるなら移動（選び直し）
  pendingIndex = i;
  pendingColor = turn;
  render();
}

function applyPendingToBoard() {
  if (pendingIndex < 0) return;
  // 仮置きを確定として盤に置く
  board[pendingIndex] = pendingColor;
  if (pendingColor === BLACK) bwCount.b++;
  if (pendingColor === WHITE) bwCount.w++;
  pendingIndex = -1;
  pendingColor = EMPTY;
}

function rotateQuadrant(q, dir) {
  // q: 0 左上,1右上,2左下,3右下
  // dir: +1 時計回り, -1 反時計回り
  const r0 = (q >= 2) ? 3 : 0;
  const c0 = (q % 2 === 1) ? 3 : 0;

  // 3x3を取り出し
  const m = [];
  for (let r = 0; r < 3; r++) {
    m[r] = [];
    for (let c = 0; c < 3; c++) {
      m[r][c] = board[idx(r0 + r, c0 + c)];
    }
  }

  const out = [];
  for (let r = 0; r < 3; r++) out[r] = [0,0,0];

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (dir === +1) {
        out[c][2 - r] = m[r][c];     // 時計回り
      } else {
        out[2 - c][r] = m[r][c];     // 反時計回り
      }
    }
  }

  // 書き戻し
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      board[idx(r0 + r, c0 + c)] = out[r][c];
    }
  }
}

function selectQuad(q) {
  selQuad = q;
  quadBtns.forEach(b => b.classList.toggle("selected", Number(b.dataset.q) === q));
  render();
}
function selectDir(d) {
  selDir = d;
  dirBtns.forEach(b => b.classList.toggle("selected", Number(b.dataset.d) === d));
  render();
}

function nextPhaseAfterPlace() {
  phase = "rotate";
  if (elStatus) elStatus.textContent = "回転を選んで「回転して確定」";
}

function commitMove() {
  if (isGameOver()) return;

  if (phase === "place") {
    if (pendingIndex < 0) return;
    pushHistory();
    nextPhaseAfterPlace();
    render();
    return;
  }

  // rotate フェーズ：回転して確定
  if (phase === "rotate") {
    if (selQuad < 0) return;

    pushHistory();

    // 1) 仮置きを確定
    applyPendingToBoard();

    // 2) 回転
    rotateQuadrant(selQuad, selDir);

    // 3) 勝敗判定
    // （同時勝ちなど細かいルールは簡略：勝ちが出たら終了表示）
    const win = getWinLines(board);
    if (win.lines.length > 0) {
      phase = "gameover";
      if (elStatus) elStatus.textContent = (win.winner === BLACK ? "黒の勝ち" : "白の勝ち");
    } else if (bwCount.b + bwCount.w >= 36) {
      phase = "gameover";
      if (elStatus) elStatus.textContent = "引き分け";
    } else {
      // 次の手番へ
      turn = (turn === BLACK) ? WHITE : BLACK;
      phase = "place";
      selQuad = -1;
      quadBtns.forEach(b => b.classList.remove("selected"));
      if (elStatus) elStatus.textContent = "石を仮置き（選び直しOK）";
    }

    render();

    // AI（白）をONにしていて、次が白なら自動で打つ
    if (!isGameOver() && chkAiWhite && chkAiWhite.checked && turn === WHITE) {
      setTimeout(aiMoveWhite, 200);
    }
  }
}

function isGameOver() { return phase === "gameover"; }

function getWinLines(bd) {
  // 5連以上を検出。最初に見つかった勝者をwinnerとする。
  const dirs = [
    [0,1], [1,0], [1,1], [1,-1]
  ];
  const lines = [];
  let winner = EMPTY;

  function inBounds(r,c){ return r>=0 && r<6 && c>=0 && c<6; }

  for (let r=0;r<6;r++){
    for (let c=0;c<6;c++){
      const v = bd[idx(r,c)];
      if (v === EMPTY) continue;
      for (const [dr,dc] of dirs){
        // 先頭判定（前が同色ならスキップ）
        const pr = r - dr, pc = c - dc;
        if (inBounds(pr,pc) && bd[idx(pr,pc)] === v) continue;

        let rr=r, cc=c;
        const cells = [];
        while (inBounds(rr,cc) && bd[idx(rr,cc)] === v){
          cells.push(idx(rr,cc));
          rr += dr; cc += dc;
        }
        if (cells.length >= 5){
          lines.push({ color: v, cells: cells.slice(0,5) }); // まず5個だけハイライト
          if (winner === EMPTY) winner = v;
        }
      }
    }
  }
  return { winner, lines };
}

function evalBoard(bd) {
  // 超簡易：黒の「連の長さ合計」- 白の「連の長さ合計」
  function scoreFor(color){
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    let s = 0;
    function inBounds(r,c){ return r>=0 && r<6 && c>=0 && c<6; }
    for (let r=0;r<6;r++){
      for (let c=0;c<6;c++){
        if (bd[idx(r,c)] !== color) continue;
        for (const [dr,dc] of dirs){
          const pr = r - dr, pc = c - dc;
          if (inBounds(pr,pc) && bd[idx(pr,pc)] === color) continue; // 先頭だけ数える
          let len=0, rr=r, cc=c;
          while (inBounds(rr,cc) && bd[idx(rr,cc)] === color){
            len++; rr+=dr; cc+=dc;
          }
          if (len>=2) s += len;
        }
      }
    }
    return s;
  }
  return scoreFor(BLACK) - scoreFor(WHITE);
}

function aiMoveWhite() {
  if (isGameOver()) return;
  if (turn !== WHITE) return;
  if (phase !== "place") return;

  // 候補：空マスに仮置き→回転4*2の全探索（超軽量）
  let best = null;
  let bestScore = Infinity;

  for (let i=0;i<36;i++){
    if (board[i] !== EMPTY) continue;

    for (let q=0;q<4;q++){
      for (const d of [+1,-1]){
        // シミュレート
        const tmp = board.slice();
        tmp[i] = WHITE;

        // 回転
        const saved = board;
        board = tmp;
        rotateQuadrant(q, d);
        const after = board.slice();
        board = saved;

        const win = getWinLines(after);
        if (win.winner === WHITE) {
          best = { i, q, d, score: -9999 };
          bestScore = -9999;
          continue;
        }
        if (win.winner === BLACK) {
          // 相手勝ちになる手は避けたい
          continue;
        }

        const sc = evalBoard(after); // 黒有利が + なので、白は小さい方が良い
        if (sc < bestScore) {
          bestScore = sc;
          best = { i, q, d, score: sc };
        }
      }
    }
  }

  if (!best) {
    // 置けるところがない/全部悪手
    return;
  }

  // 実際に手を打つ（人と同じ手順に合わせる）
  pendingIndex = best.i;
  pendingColor = WHITE;
  nextPhaseAfterPlace();
  selectQuad(best.q);
  selectDir(best.d);
  commitMove();
}

function render() {
  // 表示ラベル
  if (elTurnBig) elTurnBig.textContent = (turn === BLACK ? "黒の手番" : "白の手番");
  if (elPhase) elPhase.textContent = phase;
  if (elBW) elBW.textContent = `${bwCount.b} / ${bwCount.w}`;
  if (elRoom) elRoom.textContent = "-";
  if (elSeat) elSeat.textContent = "-";

  // 盤面描画（確定石）
  const cells = elBoard.querySelectorAll(".cell");
  cells.forEach((cell, i) => {
    cell.classList.remove("win");
    const v = board[i];
    cell.dataset.mark = String(v);
  });

  // 仮置きを見た目に反映（確定石と区別したいならCSSで[data-pending="1"]などにする）
  if (pendingIndex >= 0 && phase === "place") {
    const cell = cells[pendingIndex];
    if (cell) cell.dataset.mark = String(pendingColor);
  }

  // 勝利ラインのハイライト
  const win = getWinLines(board);
  if (win.lines.length > 0) {
    win.lines[0].cells.forEach(i => cells[i]?.classList.add("win"));
  }

  // Eval
  if (elEval) elEval.textContent = String(evalBoard(board));

  // ステータス
  if (elStatus && !elStatus.textContent) elStatus.textContent = "石を仮置き（選び直しOK）";
}

/* イベント */
btnCommit?.addEventListener("click", commitMove);
btnUndo?.addEventListener("click", () => popHistory());
btnReset?.addEventListener("click", () => {
  history = [];
  board = new Array(36).fill(EMPTY);
  turn = BLACK;
  phase = "place";
  pendingIndex = -1;
  pendingColor = EMPTY;
  selQuad = -1;
  selDir = +1;
  bwCount = { b: 0, w: 0 };
  quadBtns.forEach(b => b.classList.remove("selected"));
  dirBtns.forEach(b => b.classList.remove("selected"));
  if (elStatus) elStatus.textContent = "石を仮置き（選び直しOK）";
  render();
});

quadBtns.forEach(b => b.addEventListener("click", () => selectQuad(Number(b.dataset.q))));
dirBtns.forEach(b => b.addEventListener("click", () => selectDir(Number(b.dataset.d))));

/* 初期化 */
makeBoardUI();
selectDir(+1);
render();
