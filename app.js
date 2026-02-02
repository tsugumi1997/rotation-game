/* Rotation 5-in-a-row (Pentago-like)
   - 6x6 board, 4 quadrants rotate 90deg
   - UI: tap to place, choose quadrant + direction, rotate to finalize
   - Features:
     * Big turn display
     * Evaluation display
     * Win-line highlight
     * Undo / Reset
     * Simple AI (White) with 2-ply minimax + pruning (iPhone-friendly)
*/

const EMPTY = 0, BLACK = 1, WHITE = 2;

// Game state
let board = newBoard();
let player = BLACK;
let phase = "place";     // "place" -> "rotate"
let selectedQ = null;    // 0..3
let selectedD = null;    // "L" or "R"
let finished = false;

// Win line cells (array of [r,c])
let winCells = [];

// Undo history: snapshot after each completed turn (after rotation)
let history = [];

// AI
let aiEnabled = false;   // White is AI if true
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

// -------------------- Init / UI wiring --------------------

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

btnRotate.addEventListener("click", ()=>{
  if (finished || aiThinking) return;
  if (phase !== "rotate") return;
  if (aiEnabled && player === WHITE) return;

  if (selectedQ === null || (selectedD !== "L" && selectedD !== "R")){
    elStatus.textContent = "小盤と回転方向を選んでください。";
    return;
  }

  applyRotationAndFinalize(selectedQ, selectedD === "R");
});

btnReset.addEventListener("click", ()=>{
  board = newBoard();
  player = BLACK;
  phase = "place";
  selectedQ = null;
  selectedD = null;
  finished = false;
  winCells = [];
  history = [];
  aiThinking = false;
  setButtonsSelected();
  elStatus.textContent = "";
  render();
  maybeAIMove();
});

btnUndo.addEventListener("click", ()=>{
  if (history.length === 0) return;

  history.pop();

  if (history.length === 0){
    board = newBoard();
    player = BLACK;
  } else {
    const last = history[history.length - 1];
    board = cloneBoard(last.board);
    // last.player made the move stored; next is opposite
    player = (last.player === BLACK) ? WHITE : BLACK;
  }

  phase = "place";
  selectedQ = null;
  selectedD = null;
  finished = false;
  winCells = [];
  aiThinking = false;
  setButtonsSelected();
  render();
  maybeAIMove();
});

// -------------------- Core rendering --------------------

function render(){
  elBoard.innerHTML = "";

  for (let r=0; r<6; r++){
    for (let c=0; c<6; c++){
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.dataset.mark = String(board[r][c]);
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

  // Phase display
  elPhase.textContent = (phase === "place") ? "① 置く" : "② 回す";

  // Evaluation display
  const bScore = evaluate(board, BLACK);
  const wScore = evaluate(board, WHITE);
  elEval.textContent = String(bScore - wScore);
  elEval2.textContent = `${bScore} / ${wScore}`;

  // Status text
  if (finished){
    // keep whatever message was set on finish
  } else if (aiThinking){
    elStatus.textContent = "AIが考えています…";
  } else {
    const who = (player === BLACK) ? "黒(●)" : "白(○)";
    if (phase === "place"){
      elStatus.textContent = `${who}の手番。マスをタップして置く。`;
    } else {
      elStatus.textContent = `${who}の手番。小盤と方向を選び「回転して確定」。`;
    }
  }
}

function onCellTap(e){
  if (finished || aiThinking) return;
  if (phase !== "place") return;
  if (aiEnabled && player === WHITE) return;

  const r = Number(e.currentTarget.dataset.r);
  const c = Number(e.currentTarget.dataset.c);

  if (board[r][c] !== EMPTY) return;

  winCells = [];
  board[r][c] = player;
  phase = "rotate";
  render();
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

// -------------------- Turn finalization --------------------

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
    // Save snapshot after a completed move (after rotation)
    history.push({ board: cloneBoard(board), player });

    // Next player
    player = (player === BLACK) ? WHITE : BLACK;
    phase = "place";
  }

  // clear selections
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

// q: 0=LT,1=RT,2=LB,3=RB
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

// Find a single 5-in-a-row line (first found), return 5 coords, else []
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

// -------------------- Evaluation (for display + AI) --------------------

function countRuns(b, p){
  const dirs = [[0,1],[1,0],[1,1],[-1,1]];
  let two=0, three=0, four=0, five=0;

  for (let r=0; r<6; r++){
    for (let c=0; c<6; c++){
      if (b[r][c] !== p) continue;

      for (const [dr,dc] of dirs){
        // Count only if (r,c) is the start of a run in that direction
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

  // Weights: tweak freely
  const score =
    10000*my.five + 180*my.four + 35*my.three + 6*my.two + 3*centerCount
    - (10000*op.five + 160*op.four + 30*op.three + 5*op.two);

  return score;
}

// -------------------- Stronger AI (2-ply minimax + pruning) --------------------
// White AI: choose move maximizing worst-case after Black best reply.

const AI = {
  // Higher = stronger but heavier.
  // If iPhone feels slow, try TOP_K_ROOT: 10, TOP_K_REPLY: 8
  TOP_K_ROOT: 14,   // White candidate moves kept
  TOP_K_REPLY: 12,  // Black reply candidate moves kept
  THINK_DELAY_MS: 60
};

function maybeAIMove(){
  if (!aiEnabled) return;
  if (finished) return;
  if (player !== WHITE) return;
  if (aiThinking) return;

  // If user hasn't placed (phase should be place)
  if (phase !== "place") return;

  aiThinking = true;
  render();

  setTimeout(()=>{
    const best = chooseBestMoveMinimax2(board);
    if (!best){
      aiThinking = false;
      render();
      return;
    }

    // Apply AI move: place
    winCells = [];
    board[best.r][best.c] = WHITE;
    phase = "rotate";

    // For UI (optional)
    selectedQ = best.q;
    selectedD = best.cw ? "R" : "L";
    setButtonsSelected();

    // Finalize (rotate + judge + switch turn)
    applyRotationAndFinalize(best.q, best.cw);

    aiThinking = false;
    render();
  }, AI.THINK_DELAY_MS);
}

// Candidate empty cells near existing stones (radius 2)
function candidateCellsForAI(b){
  let hasAny = false;
  for (let r=0; r<6; r++){
    for (let c=0; c<6; c++){
      if (b[r][c] !== EMPTY) { hasAny = true; break; }
    }
    if (hasAny) break;
  }

  if (!hasAny){
    return [[2,2],[2,3],[3,2],[3,3],[2,1],[1,2],[3,4],[4,3],[1,3],[3,1]];
  }

  const set = new Set();
  for (let r=0; r<6; r++){
    for (let c=0; c<6; c++){
      if (b[r][c] === EMPTY) continue;
      for (let dr=-2; dr<=2; dr++){
        for (let dc=-2; dc<=2; dc++){
          const rr = r + dr;
          const cc = c + dc;
          if (rr<0 || rr>=6 || cc<0 || cc>=6) continue;
          if (b[rr][cc] !== EMPTY) continue;
          set.add(rr + "," + cc);
        }
      }
    }
  }

  const out = [];
  for (const key of set){
    const [r,c] = key.split(",").map(Number);
    out.push([r,c]);
  }

  if (out.length === 0){
    for (let r=0; r<6; r++){
      for (let c=0; c<6; c++){
        if (b[r][c] === EMPTY) out.push([r,c]);
      }
    }
  }
  return out;
}

function takeTopK(moves, k){
  if (moves.length <= k) return moves;
  moves.sort((a,b)=> b.score - a.score);
  return moves.slice(0, k);
}

// Generate scored moves for a mover (place+rotate). score is quick heuristic.
function generateScoredMoves(b, mover){
  const cells = candidateCellsForAI(b);
  const moves = [];

  for (const [r,c] of cells){
    if (b[r][c] !== EMPTY) continue;

    for (let q=0; q<4; q++){
      for (const cw of [true,false]){
        const tmp = cloneBoard(b);
        tmp[r][c] = mover;
        rotateQuadrant(tmp, q, cw);

        // Immediate win gets huge score
        if (findFiveLine(tmp, mover).length > 0){
          moves.push({r,c,q,cw, score: 1e9});
          continue;
        }

        // Quick heuristic score from mover's perspective
        const s = evaluate(tmp, mover);
        moves.push({r,c,q,cw, score: s});
      }
    }
  }

  return moves;
}

// 2-ply minimax: choose White move maximizing (min over Black replies of evaluate(for WHITE))
function chooseBestMoveMinimax2(b){
  // Root: white candidates
  let rootMoves = generateScoredMoves(b, WHITE);
  rootMoves = takeTopK(rootMoves, AI.TOP_K_ROOT);

  // If any immediate win exists among considered moves, take it
  for (const m of rootMoves){
    if (m.score >= 1e9) return {r:m.r, c:m.c, q:m.q, cw:m.cw};
  }

  let best = null;
  let bestValue = -Infinity;

  for (const m of rootMoves){
    const afterWhite = cloneBoard(b);
    afterWhite[m.r][m.c] = WHITE;
    rotateQuadrant(afterWhite, m.q, m.cw);

    // Black replies
    let replyMoves = generateScoredMoves(afterWhite, BLACK);
    replyMoves = takeTopK(replyMoves, AI.TOP_K_REPLY);

    // If black has an immediate win reply, this white move is very bad
    let worstForWhite = Infinity;

    for (const rpl of replyMoves){
      if (rpl.score >= 1e9){
        worstForWhite = -1e9;
        break;
      }

      const afterBlack = cloneBoard(afterWhite);
      afterBlack[rpl.r][rpl.c] = BLACK;
      rotateQuadrant(afterBlack, rpl.q, rpl.cw);

      // Evaluate from White POV (higher is better for White)
      const value = evaluate(afterBlack, WHITE);

      if (value < worstForWhite) worstForWhite = value;

      // Alpha-like cutoff: if already not beating current best, stop exploring replies
      if (worstForWhite <= bestValue) break;
    }

    if (worstForWhite > bestValue){
      bestValue = worstForWhite;
      best = {r:m.r, c:m.c, q:m.q, cw:m.cw};
    }
  }

  return best;
}

// -------------------- Start --------------------
render();
maybeAIMove();
