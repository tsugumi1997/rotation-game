/* app.js（全置換：オンライン保持 / 盤2×2 / 小盤だけ回転 / 置き直しOK / AIゆっくり） */
(() => {
  const EMPTY = 0, BLACK = 1, WHITE = 2;

  // ===== Firebase 設定（あなたの値） =====
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

  // ===== DOM =====
  const $ = (id) => document.getElementById(id);

  const elBoard = $("board");
  const elTurn = $("turnText");
  const elPhase = $("phaseText");
  const elEval = $("evalText");
  const elBW = $("bwText");
  const elRoomLabel = $("roomLabel");
  const elSeatLabel = $("seatLabel");
  const elStatus = $("statusText");

  const elAiWhite = $("aiWhite");

  const elCommit = $("commit");
  const elUndo = $("undo");
  const elReset = $("reset");

  const elPlayAsBlack = $("playAsBlack");
  const elPlayAsWhite = $("playAsWhite");

  const elRoomCode = $("roomCode");
  const elApplyRoom = $("applyRoom");
  const elCopyLink = $("copyLink");
  const elJoinBlack = $("joinBlack");
  const elJoinWhite = $("joinWhite");
  const elLeaveRoom = $("leaveRoom");

  const qBtns = Array.from(document.querySelectorAll(".qbtn"));
  const dBtns = Array.from(document.querySelectorAll(".dbtn"));

  // ===== State =====
  let board = Array(36).fill(EMPTY);
  let turn = BLACK;
  let phase = "place"; // "place" or "rotate"

  let pendingIndex = -1;
  let pendingColor = EMPTY;

  let selectedQuad = 0; // 0 TL,1 TR,2 BL,3 BR
  let selectedDir = -1; // -1 left, +1 right

  let winCells = new Set();
  let lastPlaced = -1;

  let animLock = false;

  // local / online
  let localSeat = "B"; // "B" or "W" (ローカル時の自分)
  let online = false;
  let room = "";
  let seat = ""; // "B","W","" (オンライン参加状況)

  // Firebase
  let db = null;
  let roomRef = null;

  const clientId = (() => {
    const k = "rotation_game_client_id";
    try {
      const v = localStorage.getItem(k);
      if (v) return v;
      const nv = "c_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
      localStorage.setItem(k, nv);
      return nv;
    } catch {
      return "c_" + Math.random().toString(16).slice(2);
    }
  })();

  // UI refs
  const subBoards = []; // 0..3
  const cellEls = new Array(36).fill(null);

  // ===== Helpers =====
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function setStatus(msg){ if (elStatus) elStatus.textContent = msg; }
  function setRoomLabel(v){ if (elRoomLabel) elRoomLabel.textContent = v ? v : "—"; }
  function setSeatLabel(v){ if (elSeatLabel) elSeatLabel.textContent = v ? v : "—"; }

  function turnText(t){ return t === BLACK ? "黒の手番" : "白の手番"; }

  function parseRoomFromURL(){
    try {
      const u = new URL(location.href);
      const r = u.searchParams.get("room");
      return r ? r.trim() : "";
    } catch { return ""; }
  }

  function updateURLRoom(r){
    try{
      const u = new URL(location.href);
      if (r) u.searchParams.set("room", r);
      else u.searchParams.delete("room");
      history.replaceState(null, "", u.toString());
    } catch {}
  }

  function canActNow(){
    if (!online) return true;
    if (!seat) return false;
    const my = seat === "B" ? BLACK : WHITE;
    return my === turn;
  }

  function countBW(){
    let b=0,w=0;
    for (const v of board){ if (v===BLACK) b++; else if (v===WHITE) w++; }
    return {b,w};
  }

  // ===== Build Board (2×2 of 3×3) =====
  function quadLocalToGlobal(q, r, c){
    const r0 = (q < 2) ? 0 : 3;
    const c0 = (q % 2 === 0) ? 0 : 3;
    return (r0 + r) * 6 + (c0 + c);
  }

  function quadIndices(q){
    const idx = [];
    const r0 = (q < 2) ? 0 : 3;
    const c0 = (q % 2 === 0) ? 0 : 3;
    for (let r=r0;r<r0+3;r++){
      for (let c=c0;c<c0+3;c++){
        idx.push(r*6+c);
      }
    }
    return idx;
  }

  function buildBoardUI(){
    elBoard.innerHTML = "";
    subBoards.length = 0;

    for (let q=0;q<4;q++){
      const sb = document.createElement("div");
      sb.className = "subBoard";
      sb.dataset.q = String(q);

      // 小盤タップでも選択できる（セル以外）
      sb.addEventListener("click", (ev) => {
        if (ev.target && ev.target.classList && ev.target.classList.contains("cell")) return;
        selectQuad(q);
      });

      for (let r=0;r<3;r++){
        for (let c=0;c<3;c++){
          const i = quadLocalToGlobal(q, r, c);
          const cell = document.createElement("div");
          cell.className = "cell";
          cell.dataset.i = String(i);
          cell.dataset.mark = "0";
          cell.addEventListener("click", (e) => {
            e.stopPropagation();
            onCellClick(i);
          });
          sb.appendChild(cell);
          cellEls[i] = cell;
        }
      }

      elBoard.appendChild(sb);
      subBoards[q] = sb;
    }
  }

  // ===== Rendering =====
  function renderSelections(){
    qBtns.forEach(b => b.classList.toggle("selected", Number(b.dataset.q) === selectedQuad));
    dBtns.forEach(b => b.classList.toggle("selected", Number(b.dataset.d) === selectedDir));
    subBoards.forEach((sb, idx) => sb.classList.toggle("selected", idx === selectedQuad));
  }

  function render(){
    const {b,w} = countBW();
    elBW.textContent = `${b} / ${w}`;
    elPhase.textContent = phase;
    elTurn.textContent = turnText(turn);
    elEval.textContent = String(evaluate(board, turn));
    renderSelections();

    // 表示用（pendingを上書き）
    const marks = board.slice();
    if (pendingIndex >= 0 && pendingColor !== EMPTY) marks[pendingIndex] = pendingColor;

    for (let i=0;i<36;i++){
      const c = cellEls[i];
      if (!c) continue;
      c.dataset.mark = String(marks[i]);
      c.classList.toggle("pending", i === pendingIndex && pendingColor !== EMPTY);
      c.classList.toggle("win", winCells.has(i));
      c.classList.toggle("justPlaced", i === lastPlaced);
    }

    // justPlacedはすぐ解除
    if (lastPlaced >= 0){
      const keep = lastPlaced;
      setTimeout(() => {
        const c = cellEls[keep];
        if (c) c.classList.remove("justPlaced");
      }, 220);
    }

    // ボタン可否
    elCommit.disabled = (!canActNow() || animLock || phase !== "rotate" || pendingIndex < 0 || ![ -1, 1 ].includes(selectedDir));
    elUndo.disabled = online; // オンラインは簡略化のためUndo無効
  }

  // ===== Game Logic =====
  function onCellClick(i){
    if (!canActNow()) return;
    if (animLock) return;
    if (winCells.size) return;

    // place中のみ配置（仮置きは置き直しOK）
    if (phase !== "place") return;

    if (board[i] !== EMPTY) return;

    pendingIndex = i;
    pendingColor = turn;
    lastPlaced = i;

    phase = "rotate";
    winCells.clear();

    render();
    syncIfOnline();
    setStatus("回転する小盤と方向を選んで『回転して確定』");
  }

  function selectQuad(q){
    if (animLock) return;
    selectedQuad = q;
    render();
    syncIfOnline();
  }

  function selectDir(d){
    if (animLock) return;
    selectedDir = d;
    render();
    syncIfOnline();
  }

  function rotateInPlace(bd, q, dir){
    const idx = quadIndices(q);
    const m = idx.map(i => bd[i]);
    const out = m.slice();

    for (let r=0;r<3;r++){
      for (let c=0;c<3;c++){
        const src = r*3+c;
        let rr, cc;
        if (dir === 1){ rr = c; cc = 2-r; }      // CW
        else { rr = 2-c; cc = r; }               // CCW
        const dst = rr*3+cc;
        out[dst] = m[src];
      }
    }
    for (let k=0;k<9;k++) bd[idx[k]] = out[k];
  }

  async function animateQuadRotation(q, dir){
    const sb = subBoards[q];
    if (!sb) return;
    sb.classList.remove("rotCW","rotCCW");
    void sb.offsetWidth;
    sb.classList.add(dir === 1 ? "rotCW" : "rotCCW");
    await sleep(520);
    sb.classList.remove("rotCW","rotCCW");
  }

  async function commitMove(){
    if (!canActNow()) return;
    if (animLock) return;
    if (winCells.size) return;

    if (phase !== "rotate") { setStatus("先にマスをタップして仮置きしてください"); return; }
    if (pendingIndex < 0) { setStatus("仮置きがありません"); phase="place"; render(); return; }
    if (![ -1, 1 ].includes(selectedDir)) { setStatus("方向（左/右）を選んでください"); return; }

    animLock = true;
    render();
    syncIfOnline();

    // 1) 仮置きを確定
    board[pendingIndex] = pendingColor;
    render();
    syncIfOnline();
    await sleep(260);

    // 2) アニメ → 実回転
    await animateQuadRotation(selectedQuad, selectedDir);
    rotateInPlace(board, selectedQuad, selectedDir);

    // 3) 勝利判定
    winCells = findWinCells(board);

    // 4) 次へ
    pendingIndex = -1;
    pendingColor = EMPTY;
    phase = "place";
    turn = (turn === BLACK) ? WHITE : BLACK;

    animLock = false;
    render();
    syncIfOnline();

    if (winCells.size) {
      setStatus("ゲーム終了：勝利ライン！");
      return;
    }

    setStatus(canActNow() ? "仮置き：マスをタップ（置き直しOK）" : "相手の操作待ち");
    maybeAiMove();
  }

  function resetLocal(){
    board = Array(36).fill(EMPTY);
    turn = BLACK;
    phase = "place";
    pendingIndex = -1;
    pendingColor = EMPTY;
    selectedQuad = 0;
    selectedDir = -1;
    winCells = new Set();
    lastPlaced = -1;
    animLock = false;
    render();
  }

  // ===== Win =====
  function findWinCells(bd){
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    const res = new Set();

    const inBounds = (r,c) => r>=0 && r<6 && c>=0 && c<6;

    for (let r=0;r<6;r++){
      for (let c=0;c<6;c++){
        const v = bd[r*6+c];
        if (v===EMPTY) continue;

        for (const [dr,dc] of dirs){
          const cells = [];
          let rr=r, cc=c;
          while (inBounds(rr,cc) && bd[rr*6+cc]===v){
            cells.push(rr*6+cc);
            rr+=dr; cc+=dc;
          }
          if (cells.length>=5){
            for (let i=0;i<5;i++) res.add(cells[i]);
            return res;
          }
        }
      }
    }
    return res;
  }

  // ===== Eval（簡易） =====
  function allFiveLines(){
    const lines=[];
    for (let r=0;r<6;r++) for (let c=0;c<=1;c++) lines.push([0,1,2,3,4].map(k=>r*6+(c+k)));
    for (let c=0;c<6;c++) for (let r=0;r<=1;r++) lines.push([0,1,2,3,4].map(k=>(r+k)*6+c));
    for (let r=0;r<=1;r++) for (let c=0;c<=1;c++) lines.push([0,1,2,3,4].map(k=>(r+k)*6+(c+k)));
    for (let r=0;r<=1;r++) for (let c=4;c<=5;c++) lines.push([0,1,2,3,4].map(k=>(r+k)*6+(c-k)));
    return lines;
  }

  function evaluate(bd, perspectiveTurn){
    const me = perspectiveTurn;
    const op = me === BLACK ? WHITE : BLACK;
    const lines = allFiveLines();

    const scoreSide = (color) => {
      let s=0;
      const centers=[14,15,20,21];
      for (const i of centers) if (bd[i]===color) s+=2;

      for (const line of lines){
        let mine=0, opp=0;
        for (const i of line){
          if (bd[i]===color) mine++;
          else if (bd[i]!==EMPTY) opp++;
        }
        if (opp===0){
          if (mine===1) s+=1;
          else if (mine===2) s+=3;
          else if (mine===3) s+=7;
          else if (mine===4) s+=18;
          else if (mine>=5) s+=999;
        }
      }
      return s;
    };
    return scoreSide(me) - scoreSide(op);
  }

  // ===== AI（ローカルのみ / 白） =====
  async function maybeAiMove(){
    if (online) return;                 // オンラインではAI動かさない
    if (!elAiWhite.checked) return;     // AI OFF
    if (winCells.size) return;
    if (animLock) return;
    if (turn !== WHITE) return;         // AIは白固定
    if (localSeat === "W") return;      // 自分が白を選んでるならAIは止める

    animLock = true;
    setStatus("AI思考中…");
    render();
    await sleep(850);

    // AI手：簡単探索
    const mv = pickAiMove(board.slice(), WHITE);
    if (!mv){ animLock=false; render(); return; }

    // 仮置き→ゆっくり見せる
    pendingIndex = mv.place;
    pendingColor = WHITE;
    lastPlaced = mv.place;
    phase = "rotate";
    selectedQuad = mv.quad;
    selectedDir = mv.dir;
    render();
    await sleep(620);

    animLock = false;
    await commitMove();
  }

  function pickAiMove(bd, aiColor){
    const empties=[];
    for (let i=0;i<36;i++) if (bd[i]===EMPTY) empties.push(i);
    if (!empties.length) return null;

    let bestScore = -1e18;
    let best=[];

    for (const p of empties){
      for (let q=0;q<4;q++){
        for (const d of [-1,1]){
          const sim = bd.slice();
          sim[p]=aiColor;
          rotateInPlace(sim, q, d);

          const win = findWinCells(sim);
          let sc = 0;

          if (win.size>=5) sc = 1e9;
          else {
            sc = evaluate(sim, aiColor);
            sc += (Math.random()-0.5)*2.0; // 人間っぽい揺らぎ
          }

          if (sc > bestScore + 1e-9){
            bestScore = sc;
            best = [{place:p, quad:q, dir:d}];
          } else if (Math.abs(sc-bestScore) < 2.0){
            best.push({place:p, quad:q, dir:d});
          }
        }
      }
    }
    return best[Math.floor(Math.random()*best.length)];
  }

  // ===== Firebase Online =====
  function initFirebase(){
    try{
      if (!window.firebase || !firebase.initializeApp) return false;
      if (!firebase.apps || firebase.apps.length===0) firebase.initializeApp(firebaseConfig);
      db = firebase.database();
      return true;
    } catch {
      return false;
    }
  }

  function startRoom(r){
    room = r.trim();
    setRoomLabel(room);
    if (elRoomCode) elRoomCode.value = room;
    updateURLRoom(room);

    if (!db) return;

    online = true;
    roomRef = db.ref(`rooms/${room}`);

    // state listener
    roomRef.child("state").on("value", (snap) => {
      const v = snap.val();
      if (!v) return;

      if (Array.isArray(v.board) && v.board.length===36) board = v.board.slice();
      if (v.turn===BLACK || v.turn===WHITE) turn = v.turn;
      if (typeof v.phase==="string") phase = v.phase;
      if (typeof v.pendingIndex==="number") pendingIndex = v.pendingIndex;
      if (v.pendingColor===EMPTY || v.pendingColor===BLACK || v.pendingColor===WHITE) pendingColor = v.pendingColor;
      if (typeof v.selectedQuad==="number") selectedQuad = v.selectedQuad;
      if (v.selectedDir===-1 || v.selectedDir===1) selectedDir = v.selectedDir;
      if (Array.isArray(v.winCells)) winCells = new Set(v.winCells);

      render();
      setStatus(canActNow() ? "あなたの手番です" : "相手の操作待ち");
    });

    // seats listener
    roomRef.child("seats").on("value", (snap) => {
      const seats = snap.val() || {};
      let mySeat = "";
      for (const k of Object.keys(seats)){
        if (seats[k] === clientId) mySeat = k;
      }
      seat = mySeat; // "B" or "W" or ""
      setSeatLabel(seat || "—");
      render();
    });

    // 初期stateが無ければ作る
    roomRef.child("state").get().then((snap) => {
      if (!snap.exists()){
        roomRef.child("state").set({
          board: Array(36).fill(EMPTY),
          turn: BLACK,
          phase: "place",
          pendingIndex: -1,
          pendingColor: EMPTY,
          selectedQuad: 0,
          selectedDir: -1,
          winCells: []
        });
      }
    });
  }

  function syncIfOnline(){
    if (!online || !roomRef) return;
    // seatが無い（観戦）なら書き込まない
    if (!seat) return;

    roomRef.child("state").set({
      board,
      turn,
      phase,
      pendingIndex,
      pendingColor,
      selectedQuad,
      selectedDir,
      winCells: Array.from(winCells)
    });
  }

  async function joinSeat(want){
    if (!online || !roomRef) return;
    const seatsRef = roomRef.child("seats");
    const snap = await seatsRef.get();
    const seats = snap.val() || {};

    // 空いていれば取る（同端末の反対側は外す）
    if (!seats[want] || seats[want] === clientId){
      seats[want] = clientId;
      const other = want === "B" ? "W" : "B";
      if (seats[other] === clientId) delete seats[other];
      await seatsRef.set(seats);
      seat = want;
      setSeatLabel(want);
      setStatus(`参加：${want==="B" ? "先攻（黒）" : "後攻（白）"}`);
      return;
    }
    setStatus("その席は埋まっています");
  }

  async function leaveRoom(){
    if (!online || !roomRef) return;
    try{
      const seatsRef = roomRef.child("seats");
      const snap = await seatsRef.get();
      const seats = snap.val() || {};
      for (const k of Object.keys(seats)){
        if (seats[k] === clientId) delete seats[k];
      }
      await seatsRef.set(seats);
    } catch {}
    seat = "";
    setSeatLabel("—");
    setStatus("Roomを抜けました（観戦）");
    render();
  }

  // ===== Events =====
  function bind(){
    // 小盤/方向
    qBtns.forEach(b => b.addEventListener("click", () => selectQuad(Number(b.dataset.q))));
    dBtns.forEach(b => b.addEventListener("click", () => selectDir(Number(b.dataset.d))));

    // 操作
    elCommit.addEventListener("click", () => commitMove());
    elUndo.addEventListener("click", () => setStatus("Undoはオンライン互換のため無効です"));
    elReset.addEventListener("click", () => {
      if (online) { setStatus("オンライン中はResetは非推奨（Roomを抜けてから）"); return; }
      resetLocal();
      setStatus("リセットしました");
      maybeAiMove();
    });

    // ローカル先後
    elPlayAsBlack.addEventListener("click", () => {
      if (online) { setStatus("オンライン中はローカル先後は無効です"); return; }
      localSeat = "B";
      elPlayAsBlack.classList.add("selected");
      elPlayAsWhite.classList.remove("selected");
      resetLocal();
      setSeatLabel("B");
      setStatus("ローカル：あなたは先攻（黒）");
      maybeAiMove();
    });

    elPlayAsWhite.addEventListener("click", () => {
      if (online) { setStatus("オンライン中はローカル先後は無効です"); return; }
      localSeat = "W";
      elPlayAsWhite.classList.add("selected");
      elPlayAsBlack.classList.remove("selected");
      resetLocal();
      setSeatLabel("W");
      setStatus("ローカル：あなたは後攻（白）");
      maybeAiMove();
    });

    // AI
    elAiWhite.addEventListener("change", () => {
      if (online) {
        setStatus("オンライン中はAIは動きません（ローカル専用）");
        return;
      }
      setStatus(elAiWhite.checked ? "AI（白）ON" : "AI OFF");
      maybeAiMove();
    });

    // Room
    elApplyRoom.addEventListener("click", () => {
      if (!db) { setStatus("Firebase初期化に失敗しています"); return; }
      const r = (elRoomCode.value || "").trim();
      if (!r) { setStatus("room番号を入れてください"); return; }
      startRoom(r);
      setStatus("Roomに接続しました。先攻/後攻で参加してください");
    });

    elCopyLink.addEventListener("click", async () => {
      const r = (elRoomCode.value || room || "").trim();
      const u = new URL(location.href);
      if (r) u.searchParams.set("room", r);
      else u.searchParams.delete("room");
      try{
        await navigator.clipboard.writeText(u.toString());
        setStatus("共有URLをコピーしました");
      } catch {
        setStatus("コピーに失敗：URLを手動で共有してください");
      }
    });

    elJoinBlack.addEventListener("click", () => joinSeat("B"));
    elJoinWhite.addEventListener("click", () => joinSeat("W"));
    elLeaveRoom.addEventListener("click", () => leaveRoom());
  }

  // ===== Boot =====
  function boot(){
    buildBoardUI();

    // 初期：ローカル先攻
    setSeatLabel("B");
    elPlayAsBlack.classList.add("selected");
    elPlayAsWhite.classList.remove("selected");

    const ok = initFirebase();
    if (!ok) setStatus("Firebase初期化に失敗（ローカルは動きます）");

    const r = parseRoomFromURL();
    if (r && ok){
      if (elRoomCode) elRoomCode.value = r;
      startRoom(r);
      setStatus("Roomに接続しました。先攻/後攻で参加してください");
    } else {
      setRoomLabel("");
      setStatus("仮置き：マスをタップ（置き直しOK）");
    }

    bind();
    render();
    maybeAiMove();
  }

  window.addEventListener("error", (ev) => {
    const msg = ev && ev.message ? ev.message : "Unknown error";
    setStatus("JSエラー: " + msg);
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

})();
