/* Pentago-like Rotation 5-in-a-row
   - 6x6 board split into 4 quadrants (3x3 each), rotate 90 degrees
   - Features:
     * Big turn display
     * Evaluation display
     * Win-line highlight
     * Undo / Reset
     * AI (White) "human-like" via biased evaluation (center / L-shapes / fear opponent)
     * "Temp placement" (仮置き): you can reselect the cell until you confirm by rotation
*/

const EMPTY = 0, BLACK = 1, WHITE = 2;

// Game state
let board = newBoard();
let player = BLACK;
let phase = "place";        // "place" only (temp placement) -> rotate+finalize inside button
let selectedQ = null;       // 0..3
let selectedD = null;       // "L" or "R"
let finished = false;
let winCells = [];
let history = [];

// Temp placement (仮置き)
let tempMove = null;

// AI
let aiEnabled = false;      // White is AI when true
let aiThinking = false;

// DOM
const elBoard   = document.getElementById("board");
const elStatus  = document.getElementById("status");
const elPhase   = document.getElementById("phase");
const elTurnBig = document.getElementById("turnBig");
const elEval    = document.getElementById("eval");
const elEval2   = document.getElementById("eval2");

const btnRotate = document.getElementById("rotate");
const btnReset  = document.getElementById("reset");
const btnUndo   = document.getElementById("undo");
const chkAiOn   = document.getElementById("aiOn");

// -------------------- Init --------------------

chkAiOn.addEventListener("change", ()=>{
  aiEnabled = chkAiOn.checked;
  maybeAIMove();
});

document.querySelectorAll(".quad button").forEach(b=>{
  b.addEventListener("click", ()=>{
    if (finished || aiThinking) return;
    if (aiEnabled && player === WHITE) return;

    selectedQ = Number(b.dataset.q);
    setButtonsSelected();
  });
});

document.querySelectorAll(".dir button").forEach(b=>{
  b.addEventListener("click", ()=>{
    if (finished || aiThinking) return;
    if (aiEnabled && player === WHITE) return;

    selectedD = b.dataset.d;
    setButtonsSelected();
  });
});

btnRotate.addEventListener("click", rotateAndCommit);
btnReset.addEventListener("click", resetGame);
btnUndo.addEventListener("click", undoMove);

// -------------------- Render --------------------

function render(){
  elBoard.innerHTML = "";

  for (let r=0; r<6; r++){
    for (let c=0; c<6; c++){
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.r = r;
      cell.dataset.c = c;

      // Determine what to show: real board or temp placement
      let mark = board[r][c];
      if (tempMove && tempMove.r === r && tempMove.c === c){
        mark = player;               // show temp stone as current player's
        cell.style.opacity = "0.6";  // visual hint that it's not committed yet
      }
      cell.dataset.mark = String(mark);

      if (isWinCell(r,c)) cell.classList.add("win");

      cell.addEventListener("click", onCellTap);
      elBoard.appendChild(cell);
    }
  }

  // Big turn display
  if (finished){
    elTurnBig.textContent = "終了";
  } else {
    elTurnBig.textContent = (player === BLACK) ? "黒(●)の手番" : "白(○)の手番";
  }

  // Phase display (we keep UI text compatible)
  elPhase.textContent = "① 置く（仮）→ ② 回転で確定";

  // Evaluation display (board only; temp placement not included)
  const bScore = evaluate(board, BLACK);
  const wScore = evaluate(board, WHITE);
  elEval.textContent = String(bScore - wScore);
  elEval2.textContent = `${bScore} / ${wScore}`;

  // Status
  if (finished){
    // keep final message
  } else if (aiThinking){
    elStatus.textContent = "AIが考えています…";
  } else {
    if (aiEnabled && player === WHITE){
      elStatus.textContent = "AI（白）の番です。";
    } else {
      elStatus.textContent = tempMove
        ? "回転（小盤＋方向）を選んで「回転して確定」。別マスをタップして選び直しOK。"
        : "マスをタップして仮置き（何度でも選び直し可）。";
    }
  }
}

function setButtonsSelected(){
  document.querySelectorAll(".quad button").forEach(b=>{
    b.classList.toggle("selected", Number(b.dataset.q) === selectedQ);
  });
  document.querySelectorAll(".dir button").forEach(b=>{
    b.classList.toggle("selected", b.dataset.d === selectedD);
  });
}

function isWinCell(r,c){
  return winCells.some(p => p[0] === r && p[1] === c);
}

// -------------------- Player interaction (Temp placement) --------------------

function onCellTap(e){
  if (finished || aiThinking) return;
  if (aiEnabled && player === WHITE) return;

  const r = Number(e.currentTarget.dataset.r);
  const c = Number(e.currentTarget.dataset.c);

  if (board[r][c] !== EMPTY) return;

  // Temp placement: just move the temp marker
  winCells = [];
  tempMove = {r,c};
  render();
}

function rotateAndCommit(){
  if (finished || aiThinking) return;
  if (aiEnabled && player === WHITE) return;

  if (!tempMove){
    elStatus.textContent = "先にマスをタップして仮置きしてください。";
    return;
  }
  if (selectedQ === null || (selectedD !== "L" && selectedD !== "R")){
    elStatus.textContent = "回転する小盤（左上/右上/左下/右下）と方向（左/右）を選んでください。";
    return;
  }

  // Commit the placement
  board[tempMove.r][tempMove.c] = player;
  tempMove = null;

  // Rotate and finalize
  applyRotationAndFinalize(selectedQ, selectedD === "R");
}

// -------------------- Reset / Undo --------------------

function resetGame(){
  board = newBoard();
  player = BLACK;
  selectedQ = null;
  selectedD = null;
  finished = false;
  winCells = [];
  history = [];
  tempMove = null;
  aiThinking = false;
  setButtonsSelected();
  elStatus.textContent = "";
  render();
  maybeAIMove();
}

function undoMove(){
  if (history.length === 0) return;

  history.pop();

  if (history.length === 0){
    board = newBoard();
    player = BLACK;
  } else {
    const last = history[history.length - 1];
    board = cloneBoard(last.board);
    player = (last.player === BLACK) ? WHITE : BLACK;
  }

  selectedQ = null;
  selectedD = null;
  finished = false;
  winCells = [];
  tempMove = null;
  aiThinking = false;
  setButtonsSelected();
  render();
  maybeAIMove();
}

// -------------------- Finalization (Rotate -> Judge -> Switch turn) --------------------

function applyRotationAndFinalize(q, cw){
  rotateQuadrant(board, q, cw);

  const blackLine = findFiveLine(board, BLACK);
  const whiteLine = findFiveLine(board, WHITE);

  const blackWin = blackLine.length > 0;
  const whiteWin = whiteLine.length > 0;

  if (blackWin && whiteWin){
    finished = true;
    winCells = [];
    elStatus.textContent = "同時成立：引き分け";
  } else if (blackWin){
    finished = true;
    winCells = blackLine;
    elStatus.textContent = "黒(●)の勝ち";
  } else if (whiteWin){
    finished = true;
    winCells = whiteLine;
    elStatus.textContent = "白(○)の勝ち";
  } else if (boardFull(board)){
    finished = true;
    winCells = [];
    elStatus.textContent = "盤面が埋まった：引き分け";
  } else {
    // Save snapshot after full move
    history.push({ board: cloneBoard(board), player });

    // Next player
    player = (player === BLACK) ? WHITE : BLACK;
  }

  // Clear rotation selection for next turn
  selectedQ = null;
  selectedD = null;
  setButtonsSelected();

  render();
  maybeAIMove();
}

// -------------------- Board helpers --------------------

function newBoard(){
  return Array.from({length:6}, () => Array.from({length:6}, () => EMPTY));
}

function cloneBoard(b){
  return b.map(row => row.slice());
}

function boardFull(b){
  for (let r=0; r<6; r++){
    for (let c=0; c<6; c++){
      if (b[r][c] === EMPTY) return false;
    }
  }
  return true;
}

// Rotate 3x3 quadrant
function rotateQuadrant(b, q, cw){
  const base = { 0:[0,0], 1:[0,3], 2:[3,0], 3:[3,3] };
  const [br, bc] = base[q];

  const old = Array.from({length:3}, (_,i)=>
    Array.from({length:3}, (_,j)=> b[br+i][bc+j])
  );

  const neu = Array.from({length:3}, ()=> Array.from({length:3}, ()=> EMPTY));

  if (cw){
    for (let i=0; i<3; i++){
      for (let j=0; j<3; j++){
        neu[i][j] = old[2 - j][i];
      }
    }
  } else {
    for (let i=0; i<3; i++){
      for (let j=0; j<3; j++){
        neu[i][j] = old[j][2 - i];
      }
    }
  }

  for (let i=0; i<3; i++){
    for (let j=0; j<3; j++){
      b[br+i][bc+j] = neu[i][j];
    }
  }
}

// Find a single 5-in-a-row line (first found)
function findFiveLine(b, p){
  const dirs = [[0,1],[1,0],[1,1],[-1,1]];
  for (let r=0; r<6; r++){
    for (let c=0; c<6; c++){
      if (b[r][c] !== p) continue;

      for (const [dr,dc] of dirs){
        const coords = [[r,c]];
        let rr = r + dr;
        let cc = c + dc;

        while (rr>=0 && rr<6 && cc>=0 && cc<6 && b[rr][cc] === p){
          coords.push([rr,cc]);
          if (coords.length >= 5) return coords.slice(0,5);
          rr += dr;
          cc += dc;
        }
      }
    }
  }
  return [];
}

// -------------------- Human-like evaluation --------------------
// Biases:
//  - likes center control
//  - likes simple "L" shapes (setup)
//  - fears opponent's 3+ threats (over-defensive)

function evaluate(b, p){
  const opp = (p === BLACK) ? WHITE : BLACK;

  // Center 2x2 control
  const centers = [[2,2],[2,3],[3,2],[3,3]];
  let centerCount = 0;
  for (const [r,c] of centers){
    if (b[r][c] === p) centerCount++;
  }

  const my = countRuns(b, p);
  const op = countRuns(b, opp);

  // Human-like weights
  let score = 0;

  // Win threats / progress
  score += 10000*my.five + 180*my.four + 28*my.three + 5*my.two;

  // Fear opponent (a bit over-defensive)
  score -= 10000*op.five + 220*op.four + 70*op.three + 6*op.two;

  // Center preference
  score += 8 * centerCount;

  // L-shape preference (setup bias)
  score += 18 * countLShapes(b, p);

  return score;
}

function countRuns(b, p){
  const dirs = [[0,1],[1,0],[1,1],[-1,1]];
  let two=0, three=0, four=0, five=0;

  for (let r=0; r<6; r++){
    for (let c=0; c<6; c++){
      if (b[r][c] !== p) continue;

      for (const [dr,dc] of dirs){
        // start of run only (reduce duplicates)
        const pr = r - dr;
        const pc = c - dc;
        if (pr>=0 && pr<6 && pc>=0 && pc<6 && b[pr][pc] === p) continue;

        let len = 0;
        let rr = r;
        let cc = c;

        while (rr>=0 && rr<6 && cc>=0 && cc<6 && b[rr][cc] === p){
          len++;
          rr += dr;
          cc += dc;
        }

        if (len >= 5) five++;
        else if (len === 4) four++;
        else if (len === 3) three++;
        else if (len === 2) two++;
      }
    }
  }

  return {two, three, four, five};
}

// Count simple L-shapes within any 2x2 block
// Pattern: p at (r,c), (r+1,c), (r,c+1) or rotations thereof.
function countLShapes(b, p){
  let count = 0;
  for (let r=0; r<6; r++){
    for (let c=0; c<6; c++){
      if (b[r][c] !== p) continue;

      // 4 L orientations around (r,c) as a corner
      if (inBounds(r+1,c) && inBounds(r,c+1) && b[r+1][c]===p && b[r][c+1]===p) count++;
      if (inBounds(r+1,c) && inBounds(r,c-1) && b[r+1][c]===p && b[r][c-1]===p) count++;
      if (inBounds(r-1,c) && inBounds(r,c+1) && b[r-1][c]===p && b[r][c+1]===p) count++;
      if (inBounds(r-1,c) && inBounds(r,c-1) && b[r-1][c]===p && b[r][c-1]===p) count++;
    }
  }
  // Each L could be counted multiple times; dampen by integer division
  return Math.floor(count / 2);
}

function inBounds(r,c){
  return r>=0 && r<6 && c>=0 && c<6;
}

// -------------------- Human-like AI (White) --------------------
// Simple: evaluate all legal moves with the human-like evaluation, take best.
// (This is intentionally "human-like": a bit biased, not perfectly calculating.)

const AI = {
  THINK_DELAY_MS: 80,
  // If it ever feels slow, restrict candidate cells radius or sample moves.
};

function maybeAIMove(){
  if (!aiEnabled) return;
  if (finished) return;
  if (player !== WHITE) return;
  if (aiThinking) return;

  // AI should move only when it's "place" phase and no temp move pending
  // (it will decide both placement and rotation itself)
  if (tempMove) return;

  aiThinking = true;
  render();

  setTimeout(()=>{
    const move = chooseHumanLikeMove(board);

    // Apply AI move: commit immediately
    board[move.r][move.c] = WHITE;

    // Rotate + finalize
    applyRotationAndFinalize(move.q, move.cw);

    aiThinking = false;
    render();
  }, AI.THINK_DELAY_MS);
}

function chooseHumanLikeMove(b){
  let best = null;
  let bestScore = -Infinity;

  for (let r=0; r<6; r++){
    for (let c=0; c<6; c++){
      if (b[r][c] !== EMPTY) continue;

      for (let q=0; q<4; q++){
        for (const cw of [true,false]){
          const tmp = cloneBoard(b);
          tmp[r][c] = WHITE;
          rotateQuadrant(tmp, q, cw);

          // Immediate win
          if (findFiveLine(tmp, WHITE).length > 0){
            return {r,c,q,cw};
          }

          // Avoid moves that allow immediate black win (very human "fear")
          // Check a small sample of black replies (fast, human-ish).
          if (allowsImmediateOpponentWin(tmp, BLACK)){
            continue;
          }

          const s = evaluate(tmp, WHITE);
          if (s > bestScore){
            bestScore = s;
            best = {r,c,q,cw};
          }
        }
      }
    }
  }

  // Fallback if everything filtered
  if (!best){
    // pick first legal
    for (let r=0; r<6; r++){
      for (let c=0; c<6; c++){
        if (b[r][c] === EMPTY){
          return {r,c,q:0,cw:true};
        }
      }
    }
  }

  return best;
}

// Quick check: if opponent can win immediately from this position (one move)
// We only check for existence of any winning reply, not full search.
function allowsImmediateOpponentWin(bAfter, opp){
  for (let r=0; r<6; r++){
    for (let c=0; c<6; c++){
      if (bAfter[r][c] !== EMPTY) continue;

      for (let q=0; q<4; q++){
        for (const cw of [true,false]){
          const tmp = cloneBoard(bAfter);
          tmp[r][c] = opp;
          rotateQuadrant(tmp, q, cw);
          if (findFiveLine(tmp, opp).length > 0) return true;
        }
      }
    }
  }
  return false;
}

// -------------------- Start --------------------
render();
maybeAIMove();
