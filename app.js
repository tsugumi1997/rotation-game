const EMPTY = 0, BLACK = 1, WHITE = 2;

let board = newBoard();
let player = BLACK;
let phase = "place"; // "place" -> "rotate"
let selectedQ = null; // 0..3
let selectedD = null; // "L" or "R"
let finished = false;

// 勝利ライン（座標の配列）
let winCells = [];

// undo: snapshots after each completed turn
let history = [];

// AI
let aiEnabled = false;     // 白をAIに
let aiThinking = false;

const elBoard  = document.getElementById("board");
const elStatus = document.getElementById("status");
const elPhase  = document.getElementById("phase");
const elTurnBig = document.getElementById("turnBig");
const elEval = document.getElementById("eval");
const elEval2 = document.getElementById("eval2");

const btnRotate = document.getElementById("rotate");
const btnReset  = document.getElementById("reset");
const btnUndo   = document.getElementById("undo");
const chkAiOn   = document.getElementById("aiOn");

chkAiOn.addEventListener("change", ()=>{
  aiEnabled = chkAiOn.checked;
  // AIオンにした瞬間が白番なら、そのままAIに打たせる
  maybeAIMove();
});

function newBoard(){
  return Array.from({length:6}, () => Array.from({length:6}, () => EMPTY));
}
function cloneBoard(b){
  return b.map(row => row.slice());
}

function render(){
  elBoard.innerHTML = "";

  for(let r=0;r<6;r++){
    for(let c=0;c<6;c++){
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.dataset.mark = String(board[r][c]);
      if(isWinCell(r,c)) cell.classList.add("win");
      cell.addEventListener("click", onCellTap);
      elBoard.appendChild(cell);
    }
  }

  const who = (player===BLACK) ? "黒(●)" : "白(○)";
  elTurnBig.textContent = finished ? "終了" : `${who}の手番`;

  elPhase.textContent = (phase==="place") ? "① 置く" : "② 回す";

  // 評価表示
  const bScore = evaluate(board, BLACK);
  const wScore = evaluate(board, WHITE);
  elEval.textContent = String(bScore - wScore);
  elEval2.textContent = `${bScore} / ${wScore}`;

  if(finished){
    // status already set
  }else{
    if(aiThinking){
      elStatus.textContent = "AIが考えています…";
    }else{
      if(phase==="place"){
        elStatus.textContent = `${who}の手番。マスをタップして置く。`;
      }else{
        elStatus.textContent = `${who}の手番。小盤と方向を選び「回転して確定」。`;
      }
    }
  }
}

function isWinCell(r,c){
  return winCells.some(p => p[0]===r && p[1]===c);
}

function clearWin(){
  winCells = [];
}

function onCellTap(e){
  if(finished) return;
  if(phase !== "place") return;
  if(aiEnabled && player===WHITE) return; // AIの番は触らせない
  if(aiThinking) return;

  const r = Number(e.currentTarget.dataset.r);
  const c = Number(e.currentTarget.dataset.c);

  if(board[r][c] !== EMPTY) return;

  clearWin();
  board[r][c] = player;
  phase = "rotate";
  render();
}

// ボタン選択表示
function setButtonsSelected(){
  document.querySelectorAll(".quad button").forEach(b=>{
    b.classList.toggle("selected", Number(b.dataset.q)===selectedQ);
  });
  document.querySelectorAll(".dir button").forEach(b=>{
    b.classList.toggle("selected", b.dataset.d===selectedD);
  });
}

document.querySelectorAll(".quad button").forEach(b=>{
  b.addEventListener("click", ()=>{
    if(finished) return;
    if(aiEnabled && player===WHITE) return;
    if(aiThinking) return;
    selectedQ = Number(b.dataset.q);
    setButtonsSelected();
  });
});
document.querySelectorAll(".dir button").forEach(b=>{
  b.addEventListener("click", ()=>{
    if(finished) return;
    if(aiEnabled && player===WHITE) return;
    if(aiThinking) return;
    selectedD = b.dataset.d;
    setButtonsSelected();
  });
});

btnRotate.addEventListener("click", ()=>{
  if(finished) return;
  if(phase !== "rotate") return;
  if(aiEnabled && player===WHITE) return;
  if(aiThinking) return;

  if(selectedQ===null || (selectedD!=="L" && selectedD!=="R")){
    elStatus.textContent = "小盤と回転方向を選んでください。";
    return;
  }

  applyRotationAndFinalize(selectedQ, selectedD==="R");
});

function applyRotationAndFinalize(q, cw){
  rotateQuadrant(board, q, cw);

  // 判定（回転後）
  const blackLine = findFiveLine(board, BLACK);
  const whiteLine = findFiveLine(board, WHITE);

  const blackWin = blackLine.length>0;
  const whiteWin = whiteLine.length>0;

  if(blackWin && whiteWin){
    finished = true;
    winCells = []; // 同時はハイライトなし（混乱しやすいので）
    elStatus.textContent = "同時成立：引き分け";
  }else if(blackWin){
    finished = true;
    winCells = blackLine;
    elStatus.textContent = "黒(●)の勝ち";
  }else if(whiteWin){
    finished = true;
    winCells = whiteLine;
    elStatus.textContent = "白(○)の勝ち";
  }else if(boardFull(board)){
    finished = true;
    winCells = [];
    elStatus.textContent = "盤面が埋まった：引き分け";
  }else{
    // save snapshot for undo (after full move)
    history.push({ board: cloneBoard(board), player });

    // next player
    player = (player===BLACK) ? WHITE : BLACK;
    phase = "place";
  }

  // clear rotation selection
  selectedQ = null; selectedD = null;
  setButtonsSelected();
  render();

  // AIが次の手番なら動かす
  maybeAIMove();
}

btnReset.addEventListener("click", ()=>{
  board = newBoard();
  player = BLACK;
  phase = "place";
  selectedQ = null; selectedD = null;
  finished = false;
  history = [];
  clearWin();
  aiThinking = false;
  setButtonsSelected();
  elStatus.textContent = "";
  render();
});

btnUndo.addEventListener("click", ()=>{
  if(history.length===0) return;

  history.pop();
  if(history.length===0){
    board = newBoard();
    player = BLACK;
  }else{
    const last = history[history.length-1];
    board = cloneBoard(last.board);
    // last.playerが打ったあとに手番交代しているので、次は逆
    player = (last.player===BLACK) ? WHITE : BLACK;
  }
  phase = "place";
  finished = false;
  clearWin();
  aiThinking = false;
  selectedQ = null; selectedD = null;
  setButtonsSelected();
  render();

  maybeAIMove();
});

// 3×3の回転（q=0..3）
function rotateQuadrant(b, q, cw){
  const base = { 0:[0,0], 1:[0,3], 2:[3,0], 3:[3,3] };
  const [br, bc] = base[q];

  const old = Array.from({length:3}, (_,i)=>
    Array.from({length:3}, (_,j)=> b[br+i][bc+j])
  );
  const neu = Array.from({length:3}, ()=> Array.from({length:3}, ()=> EMPTY));

  if(cw){
    for(let i=0;i<3;i++){
      for(let j=0;j<3;j++){
        neu[i][j] = old[2-j][i];
      }
    }
  }else{
    for(let i=0;i<3;i++){
      for(let j=0;j<3;j++){
        neu[i][j] = old[j][2-i];
      }
    }
  }
  for(let i=0;i<3;i++){
    for(let j=0;j<3;j++){
      b[br+i][bc+j] = neu[i][j];
    }
  }
}

function boardFull(b){
  for(let r=0;r<6;r++){
    for(let c=0;c<6;c++){
      if(b[r][c]===EMPTY) return false;
    }
  }
  return true;
}

/* 勝利ライン探索：見つかったら 5マスの座標配列を返す（なければ []） */
function findFiveLine(b, p){
  const dirs = [[0,1],[1,0],[1,1],[-1,1]];
  for(let r=0;r<6;r++){
    for(let c=0;c<6;c++){
      if(b[r][c]!==p) continue;
      for(const [dr,dc] of dirs){
        let coords = [[r,c]];
        let rr=r+dr, cc=c+dc;
        while(rr>=0 && rr<6 && cc>=0 && cc<6 && b[rr][cc]===p){
          coords.push([rr,cc]);
          if(coords.length>=5){
            return coords.slice(0,5);
          }
          rr+=dr; cc+=dc;
        }
      }
    }
  }
  return [];
}

/* 評価関数（簡単）：
  - 5連：大
  - 4連/3連/2連：中
  - 中央2×2：小
  回転で形が変わるので「今の盤面の特徴量」を雑に数値化する用途。
*/
function evaluate(b, p){
  const opp = (p===BLACK) ? WHITE : BLACK;

  // 中央2×2
  const centers = [[2,2],[2,3],[3,2],[3,3]];
  let centerCount = 0;
  for(const [r,c] of centers) if(b[r][c]===p) centerCount++;

  const my = countRuns(b, p);
  const op = countRuns(b, opp);

  // 重み（好みで変えてOK）
  const score =
    10000*my.five + 180*my.four + 35*my.three + 6*my.two + 3*centerCount
    - (10000*op.five + 160*op.four + 30*op.three + 5*op.two);

  return score;
}

// 連続数のざっくりカウント（重複は気にしすぎない：研究用の指標）
function countRuns(b, p){
  const dirs = [[0,1],[1,0],[1,1],[-1,1]];
  let two=0, three=0, four=0, five=0;

  for(let r=0;r<6;r++){
    for(let c=0;c<6;c++){
      if(b[r][c]!==p) continue;

      for(const [dr,dc] of dirs){
        // 起点が「その方向での先頭」だけ数える（重複減らす）
        const pr=r-dr, pc=c-dc;
        if(pr>=0 && pr<6 && pc>=0 && pc<6 && b[pr][pc]===p) continue;

        let len=0;
        let rr=r, cc=c;
        while(rr>=0 && rr<6 && cc>=0 && cc<6 && b[rr][cc]===p){
          len++; rr+=dr; cc+=dc;
        }
        if(len>=5) five++;
        else if(len===4) four++;
        else if(len===3) three++;
        else if(len===2) two++;
      }
    }
  }
  return {two, three, four, five};
}

/* 簡単AI：白の番だけ動く
   全手（置く×回転×向き）を試して、評価(白)が最大の手を選ぶ
   重いので、最初は「候補マスを絞る」工夫も入れてある（近傍優先）。
*/
function maybeAIMove(){
  if(!aiEnabled) return;
  if(finished) return;
  if(player !== WHITE) return;
  if(aiThinking) return;

  aiThinking = true;
  render();

  // UIが固まらないように少し遅らせて実行
  setTimeout(()=>{
    const move = chooseBestMove(board);
    if(!move){
      aiThinking = false;
      render();
      return;
    }
    // AIの手を適用（置く→回転）
    clearWin();
    board[move.r][move.c] = WHITE;
    phase = "rotate";
    selectedQ = move.q;
    selectedD = move.cw ? "R" : "L";
    setButtonsSelected();

    // 回転して確定
    applyRotationAndFinalize(move.q, move.cw);

    aiThinking = false;
    render();
  }, 50);
}

// 近傍優先で候補マスを作る（全部空マスは重いので）
function candidateCells(b){
  const empties = [];
  let hasAny = false;
  for(let r=0;r<6;r++){
    for(let c=0;c<6;c++){
      if(b[r][c]!==EMPTY) hasAny = true;
    }
  }
  // 初手は中央寄り
  if(!hasAny){
    return [[2,2],[2,3],[3,2],[3,3],[2,1],[1,2],[3,4],[4,3]];
  }

  // 既存石の周囲1マス以内の空きを候補に
  const set = new Set();
  for(let r=0;r<6;r++){
    for(let c=0;c<6;c++){
      if(b[r][c]===EMPTY) continue;
      for(let dr=-1; dr<=1; dr++){
        for(let dc=-1; dc<=1; dc++){
          const rr=r+dr, cc=c+dc;
          if(rr<0||rr>=6||cc<0||cc>=6) continue;
          if(b[rr][cc]!==EMPTY) continue;
          set.add(rr+","+cc);
        }
      }
    }
  }
  for(const key of set){
    const [r,c] = key.split(",").map(Number);
    empties.push([r,c]);
  }
  // 万一候補が空なら全空きを使う
  if(empties.length===0){
    for(let r=0;r<6;r++) for(let c=0;c<6;c++) if(b[r][c]===EMPTY) empties.push([r,c]);
  }
  return empties;
}

function chooseBestMove(b){
  const cells = candidateCells(b);
  let best = null;
  let bestScore = -Infinity;

  for(const [r,c] of cells){
    if(b[r][c]!==EMPTY) continue;

    for(let q=0;q<4;q++){
      for(const cw of [true,false]){
        const tmp = cloneBoard(b);
        tmp[r][c] = WHITE;
        rotateQuadrant(tmp, q, cw);

        // すぐ勝てるなら最優先
        if(findFiveLine(tmp, WHITE).length>0){
          return {r,c,q,cw};
        }

        const score = evaluate(tmp, WHITE);

        if(score > bestScore){
          bestScore = score;
          best = {r,c,q,cw};
        }
      }
    }
  }
  return best;
}

// init
render();
