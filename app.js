// Pentago-like minimal engine for iPhone Safari
const EMPTY = 0, BLACK = 1, WHITE = 2;

let board = newBoard();
let player = BLACK;
let phase = "place"; // "place" -> "rotate"
let selectedQ = null; // 0..3
let selectedD = null; // "L" or "R"
let finished = false;

// undo: store snapshots after each completed turn (after rotation)
let history = [];

const elBoard = document.getElementById("board");
const elStatus = document.getElementById("status");
const elPhase = document.getElementById("phase");
const btnRotate = document.getElementById("rotate");
const btnReset = document.getElementById("reset");
const btnUndo = document.getElementById("undo");

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
      cell.addEventListener("click", onCellTap);
      elBoard.appendChild(cell);
    }
  }
  const who = (player===BLACK) ? "黒(●)" : "白(○)";
  const phaseText = (phase==="place") ? "① 置く" : "② 回す";
  elPhase.textContent = phaseText;

  if(finished){
    // status already set
  }else{
    elStatus.textContent = `${who}の手番。${phase==="place" ? "マスをタップして置く。" : "小盤と方向を選び「回転して確定」。"}`;
  }
}

function onCellTap(e){
  if(finished) return;
  if(phase !== "place") return;

  const r = Number(e.currentTarget.dataset.r);
  const c = Number(e.currentTarget.dataset.c);

  if(board[r][c] !== EMPTY) return;
  board[r][c] = player;
  phase = "rotate";
  render();
}

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
    selectedQ = Number(b.dataset.q);
    setButtonsSelected();
  });
});
document.querySelectorAll(".dir button").forEach(b=>{
  b.addEventListener("click", ()=>{
    if(finished) return;
    selectedD = b.dataset.d;
    setButtonsSelected();
  });
});

btnRotate.addEventListener("click", ()=>{
  if(finished) return;
  if(phase !== "rotate") return;
  if(selectedQ===null || (selectedD!=="L" && selectedD!=="R")){
    elStatus.textContent = "小盤（左上/右上/左下/右下）と回転方向（左/右）を選んでください。";
    return;
  }

  rotateQuadrant(selectedQ, selectedD==="R");

  // judge after rotation
  const blackWin = hasFive(BLACK);
  const whiteWin = hasFive(WHITE);

  if(blackWin && whiteWin){
    finished = true;
    elStatus.textContent = "同時成立：引き分け";
  }else if(blackWin){
    finished = true;
    elStatus.textContent = "黒(●)の勝ち";
  }else if(whiteWin){
    finished = true;
    elStatus.textContent = "白(○)の勝ち";
  }else if(boardFull()){
    finished = true;
    elStatus.textContent = "盤面が埋まった：引き分け";
  }else{
    // save snapshot for undo (after full move)
    history.push({ board: cloneBoard(board), player, selectedQ, selectedD });

    // next player
    player = (player===BLACK) ? WHITE : BLACK;
    phase = "place";
  }

  // clear selection (optional)
  selectedQ = null; selectedD = null;
  setButtonsSelected();
  render();
});

btnReset.addEventListener("click", ()=>{
  board = newBoard();
  player = BLACK;
  phase = "place";
  selectedQ = null; selectedD = null;
  finished = false;
  history = [];
  setButtonsSelected();
  elStatus.textContent = "";
  render();
});

btnUndo.addEventListener("click", ()=>{
  if(history.length===0) return;

  // undo returns to previous completed turn state and sets phase to place of that player
  history.pop();
  if(history.length===0){
    board = newBoard();
    player = BLACK;
  }else{
    const last = history[history.length-1];
    board = cloneBoard(last.board);
    player = (last.player===BLACK) ? WHITE : BLACK; // because last.player was the mover stored before switch
  }
  phase = "place";
  finished = false;
  selectedQ = null; selectedD = null;
  setButtonsSelected();
  render();
});

// Rotation (3x3) mapping into 6x6
function rotateQuadrant(q, cw){
  const base = {
    0:[0,0],
    1:[0,3],
    2:[3,0],
    3:[3,3]
  };
  const [br, bc] = base[q];

  const old = Array.from({length:3}, (_,i)=>
    Array.from({length:3}, (_,j)=> board[br+i][bc+j])
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
      board[br+i][bc+j] = neu[i][j];
    }
  }
}

function boardFull(){
  for(let r=0;r<6;r++){
    for(let c=0;c<6;c++){
      if(board[r][c]===EMPTY) return false;
    }
  }
  return true;
}

function hasFive(p){
  const dirs = [[0,1],[1,0],[1,1],[-1,1]];
  for(let r=0;r<6;r++){
    for(let c=0;c<6;c++){
      if(board[r][c]!==p) continue;
      for(const [dr,dc] of dirs){
        let rr=r, cc=c, count=0;
        while(rr>=0 && rr<6 && cc>=0 && cc<6 && board[rr][cc]===p){
          count++;
          if(count>=5) return true;
          rr+=dr; cc+=dc;
        }
      }
    }
  }
  return false;
}

// init
render();
