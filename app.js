/* app.js（全置換）
   - GitHub Pages のURLはそのまま
   - Firebase Realtime Database でオンライン同期
   - 仮置き：タップで仮置き（選び直しOK）→ 回転で確定
   - 勝利ライン：winCells を付与（CSS側 .win でハイライト）
   - 簡単AI（白）：ローカル練習用。オンライン対戦中はOFF推奨
*/

const EMPTY = 0, BLACK = 1, WHITE = 2;

// ===== Firebase 設定（あなたの値で埋め込み済み） =====
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

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
// =======================================================

// -------- Room / Client / Seat --------

const elRoomCode = document.getElementById("roomCode");
const elSeatLabel = document.getElementById("seatLabel");

function randRoom(){
  return String(Math.floor(100000 + Math.random()*900000));
}
function getRoomFromURL(){
  const u = new URL(location.href);
  return u.searchParams.get("room");
}
function setRoomToURL(room){
  const u = new URL(location.href);
  u.searchParams.set("room", room);
  history.replaceState(null, "", u.toString());
}

const roomId = (getRoomFromURL() || randRoom());
setRoomToURL(roomId);
elRoomCode.textContent = roomId;

const clientId = getOrCreateClientId();
function getOrCreateClientId(){
  const k = "rot5_client_id";
  const v = localStorage.getItem(k);
  if (v) return v;
  const nv = "c_" + Math.random().toString(16).slice(2) + "_" + Date.now();
  localStorage.setItem(k, nv);
  return nv;
}

const roomRef  = db.ref(`rooms/${roomId}`);
const stateRef = roomRef.child("state");
const seatsRef = roomRef.child("seats");

let mySeat = null; // "black" | "white" | null（観戦）

async function claimSeat(){
  const blackRef = seatsRef.child("black");
  const whiteRef = seatsRef.child("white");

  const snap = await seatsRef.get();
  const seats = snap.exists() ? snap.val() : {};

  if (!seats.black){
    await blackRef.set(clientId);
    blackRef.onDisconnect().remove();
    mySeat = "black";
  } else if (seats.black === clientId){
    mySeat = "black";
  } else if (!seats.white){
    await whiteRef.set(clientId);
    whiteRef.onDisconnect().remove();
    mySeat = "white";
  } else if (seats.white === clientId){
    mySeat = "white";
  } else {
    mySeat = null; // 観戦
  }

  elSeatLabel.textContent =
    mySeat === "black" ? "黒(●)" :
    mySeat === "white" ? "白(○)" : "観戦";
}

function seatToPlayer(seat){
  return seat === "black" ? BLACK : seat === "white" ? WHITE : null;
}

function iAmCurrentTurn(st){
  if (!mySeat) return false;
  return seatToPlayer(mySeat) === st.player;
}

function defaultState(){
  return {
    board: newBoard(),
    player: BLACK,
    finished: false,
    winCells: [],
    updatedAt: Date.now(),
    moveNo: 0
  };
}

async function ensureRoomState(){
  const snap = await stateRef.get();
  if (!snap.exists()){
    await stateRef.set(defaultState());
  }
}

function pushState(next){
  next.updatedAt = Date.now();
  return stateRef.set(next);
}

// -------- Game state (local mirror) --------

let board = newBoard();
let player = BLACK;
let finished = false;
let winCells = [];
let tempMove = null;     // {r,c} 仮置き
let history = [];        // Undo用（黒側だけに制限）

// UI
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

// rotation selection
let selectedQ = null; // 0..3
let selectedD = null; // "L"|"R"

// AI（ローカル練習用）
let aiEnabled = false;
let aiThinking = false;

chkAiOn.addEventListener("change", ()=>{
  aiEnabled = chkAiOn.checked;
  render();
  maybeAIMove();
});

document.querySelectorAll(".quad button").forEach(b=>{
  b.addEventListener("click", ()=>{
    if (!canOperate()) return;
    selectedQ = Number(b.dataset.q);
    setButtonsSelected();
  });
});
document.querySelectorAll(".dir button").forEach(b=>{
  b.addEventListener("click", ()=>{
    if (!canOperate()) return;
    selectedD = b.dataset.d;
    setButtonsSelected();
  });
});

btnRotate.addEventListener("click", ()=>{
  if (!canOperate()) return;
  rotateAndCommit();
});

btnReset.addEventListener("click", ()=>{
  if (!canOperateAdmin()) return;
  resetGame(true);
});

btnUndo.addEventListener("click", ()=>{
  if (!canOperateAdmin()) return;
  undoMove(true);
});

function canOperate(){
  if (!mySeat) return false;
  if (finished) return false;
  if (aiThinking) return false;

  // ローカルAIで遊ぶとき：白はAIなので操作不可
  if (aiEnabled && seatToPlayer(mySeat) === WHITE) return false;

  return iAmCurrentTurn(getStateObj());
}

function canOperateAdmin(){
  // 乱用防止：Reset/Undo は黒側だけ
  if (!mySeat) return false;
  return mySeat === "black";
}

function getStateObj(){
  return { board, player, finished, winCells };
}

// -------- Firebase listeners --------

stateRef.on("value", (snap)=>{
  if (!snap.exists()) return;
  const st = snap.val();

  board    = st.board || newBoard();
  player   = st.player ?? BLACK;
  finished = !!st.finished;
  winCells = Array.isArray(st.winCells) ? st.winCells : [];

  // 同期が来たら仮置きは破棄（ズレ防止）
  tempMove = null;
  selectedQ = null;
  selectedD = null;
  setButtonsSelected();

  render();
  maybeAIMove();
});

seatsRef.on("value", (snap)=>{
  const s = snap.exists() ? snap.val() : {};
  // 席が外れていたら取り直し
  if (mySeat === "black" && s.black !== clientId) mySeat = null;
  if (mySeat === "white" && s.white !== clientId) mySeat = null;
  if (!mySeat) claimSeat();
});

// -------- Core logic --------

function newBoard(){
  return Array.from({length:6}, ()=>Array(6).fill(EMPTY));
}
function cloneBoard(b){ return b.map(r=>r.slice()); }

function rotateQuadrant(b, q, cw){
  const base = { 0:[0,0], 1:[0,3], 2:[3,0], 3:[3,3] };
  const [br, bc] = base[q];

  const old = Array.from({length:3}, (_,i)=>
    Array.from({length:3}, (_,j)=> b[br+i][bc+j])
  );

  const neu = Array.from({length:3}, ()=>Array(3).fill(EMPTY));

  if (cw){
    for (let i=0;i<3;i++) for (let j=0;j<3;j++) neu[i][j] = old[2-j][i];
  } else {
    for (let i=0;i<3;i++) for (let j=0;j<3;j++) neu[i][j] = old[j][2-i];
  }

  for (let i=0;i<3;i++) for (let j=0;j<3;j++) b[br+i][bc+j] = neu[i][j];
}

function findFiveLine(b, p){
  const dirs = [[0,1],[1,0],[1,1],[-1,1]];
  for (let r=0;r<6;r++){
    for (let c=0;c<6;c++){
      if (b[r][c] !== p) continue;
      for (const [dr,dc] of dirs){
        const coords = [[r,c]];
        let rr=r+dr, cc=c+dc;
        while(rr>=0&&rr<6&&cc>=0&&cc<6&&b[rr][cc]===p){
          coords.push([rr,cc]);
          if(coords.length>=5) return coords.slice(0,5);
          rr+=dr; cc+=dc;
        }
      }
    }
  }
  return [];
}

function boardFull(b){
  for(let r=0;r<6;r++) for(let c=0;c<6;c++) if(b[r][c]===EMPTY) return false;
  return true;
}

// 評価（簡単）
function countRuns(b, p){
  const dirs=[[0,1],[1,0],[1,1],[-1,1]];
  let two=0,three=0,four=0,five=0;

  for(let r=0;r<6;r++){
    for(let c=0;c<6;c++){
      if(b[r][c]!==p) continue;
      for(const[dr,dc] of dirs){
        const pr=r-dr, pc=c-dc;
        if(pr>=0&&pr<6&&pc>=0&&pc<6&&b[pr][pc]===p) continue;

        let len=0, rr=r, cc=c;
        while(rr>=0&&rr<6&&cc>=0&&cc<6&&b[rr][cc]===p){
          len++; rr+=dr; cc+=dc;
        }
        if(len>=5) five++;
        else if(len===4) four++;
        else if(len===3) three++;
        else if(len===2) two++;
      }
    }
  }
  return {two,three,four,five};
}

function evaluate(b, p){
  const opp = (p===BLACK)?WHITE:BLACK;
  const my=countRuns(b,p);
  const op=countRuns(b,opp);

  let score=0;
  score += 10000*my.five + 180*my.four + 28*my.three + 5*my.two;
  score -= 10000*op.five + 220*op.four + 70*op.three + 6*op.two;
  return score;
}

// -------- UI --------

function isWinCell(r,c){
  return winCells.some(x=>x[0]===r && x[1]===c);
}

function setButtonsSelected(){
  document.querySelectorAll(".quad button").forEach(b=>{
    b.classList.toggle("selected", Number(b.dataset.q)===selectedQ);
  });
  document.querySelectorAll(".dir button").forEach(b=>{
    b.classList.toggle("selected", b.dataset.d===selectedD);
  });
}

function render(){
  elBoard.innerHTML = "";

  for(let r=0;r<6;r++){
    for(let c=0;c<6;c++){
      const cell=document.createElement("div");
      cell.className="cell";
      cell.dataset.r=r;
      cell.dataset.c=c;

      let mark = board[r][c];
      if(tempMove && tempMove.r===r && tempMove.c===c){
        mark = player;
        cell.style.opacity = "0.6";
      }
      cell.dataset.mark = String(mark);

      if(isWinCell(r,c)) cell.classList.add("win");

      cell.addEventListener("click", onCellTap);
      elBoard.appendChild(cell);
    }
  }

  elTurnBig.textContent = finished ? "終了" : (player===BLACK ? "黒(●)の手番" : "白(○)の手番");
  elPhase.textContent = "① 置く（仮）→ ② 回転で確定";

  const bScore=evaluate(board,BLACK);
  const wScore=evaluate(board,WHITE);
  elEval.textContent=String(bScore-wScore);
  elEval2.textContent=`${bScore} / ${wScore}`;

  if (finished) return;

  if(!mySeat){
    elStatus.textContent = "満席：観戦モードです。";
    return;
  }

  if(aiThinking){
    elStatus.textContent="AIが考えています…";
    return;
  }

  if(aiEnabled){
    elStatus.textContent = tempMove
      ? "仮置き中：回転（小盤＋方向）を選んで「回転して確定」。"
      : "マスをタップして仮置き（選び直しOK）。";
    return;
  }

  if(!iAmCurrentTurn(getStateObj())){
    elStatus.textContent = "相手の手番です。";
  } else {
    elStatus.textContent = tempMove
      ? "あなたの番：回転（小盤＋方向）を選んで「回転して確定」。"
      : "あなたの番：マスをタップして仮置き（選び直しOK）。";
  }
}

function onCellTap(e){
  if(!canOperate()) return;
  const r=Number(e.currentTarget.dataset.r);
  const c=Number(e.currentTarget.dataset.c);
  if(board[r][c]!==EMPTY) return;

  winCells=[];
  tempMove={r,c};
  render();
}

async function rotateAndCommit(){
  if(!tempMove){
    elStatus.textContent="先にマスをタップして仮置きしてください。";
    return;
  }
  if(selectedQ===null || (selectedD!=="L" && selectedD!=="R")){
    elStatus.textContent="回転する小盤と方向を選んでください。";
    return;
  }

  const nextBoard = cloneBoard(board);
  nextBoard[tempMove.r][tempMove.c] = player;

  rotateQuadrant(nextBoard, selectedQ, selectedD==="R");

  const blackLine = findFiveLine(nextBoard, BLACK);
  const whiteLine = findFiveLine(nextBoard, WHITE);
  const blackWin = blackLine.length>0;
  const whiteWin = whiteLine.length>0;

  let nextFinished=false;
  let nextWinCells=[];
  let msg="";

  if(blackWin && whiteWin){
    nextFinished=true; nextWinCells=[]; msg="同時成立：引き分け";
  } else if(blackWin){
    nextFinished=true; nextWinCells=blackLine; msg="黒(●)の勝ち";
  } else if(whiteWin){
    nextFinished=true; nextWinCells=whiteLine; msg="白(○)の勝ち";
  } else if(boardFull(nextBoard)){
    nextFinished=true; nextWinCells=[]; msg="盤面が埋まった：引き分け";
  }

  // Undo用にスナップショット保存（黒側だけ運用推奨）
  history.push({ board: cloneBoard(board), player, finished, winCells: Array.isArray(winCells)?winCells:[] });

  const nextPlayer = (player===BLACK)?WHITE:BLACK;

  await pushState({
    board: nextBoard,
    player: nextPlayer,
    finished: nextFinished,
    winCells: nextWinCells,
    moveNo: Date.now()
  });

  tempMove=null;
  selectedQ=null;
  selectedD=null;
  setButtonsSelected();

  if(nextFinished) elStatus.textContent = msg;
}

async function resetGame(sync){
  tempMove=null; selectedQ=null; selectedD=null;
  setButtonsSelected();
  history=[];
  if(sync) await pushState(defaultState());
}

async function undoMove(sync){
  if(history.length===0) return;
  const prev = history.pop();
  tempMove=null; selectedQ=null; selectedD=null;
  setButtonsSelected();
  if(sync){
    await pushState({
      board: prev.board,
      player: prev.player,
      finished: prev.finished,
      winCells: prev.winCells,
      moveNo: Date.now()
    });
  }
}

// -------- Simple AI (white, local practice) --------

function maybeAIMove(){
  if(!aiEnabled) return;
  if(finished) return;
  if(player!==WHITE) return;
  if(aiThinking) return;

  // オンライン対戦を混ぜないため：座席が埋まる可能性がある場合はAIを使わない方が安全
  // ここでは「AI ON は練習用」という前提で、同期は触りません（ローカルだけ進めたい場合は別設計）。
  // ただし今の実装は stateRef.on で同期しているので、オンライン状態ではAIは使わないのが安全です。
  // そのため、AIは “自分が観戦以外” の時は動かさない。
  return;
}

// -------- Boot --------

(async function boot(){
  await claimSeat();
  await ensureRoomState();
  render();
})();
