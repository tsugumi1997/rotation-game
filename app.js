/* app.js（全置換：盤が崩れない / 3×3独立 / 回転アニメ / 置き直しOK / AIゆっくり / オンライン同期） */

(() => {
  const EMPTY = 0, BLACK = 1, WHITE = 2;

  // ===== DOM =====
  const elBoard = document.getElementById("board");
  const elTurnText = document.getElementById("turnText");
  const elPhaseText = document.getElementById("phaseText");
  const elEvalText = document.getElementById("evalText");
  const elBwText = document.getElementById("bwText");
  const elRoomLabel = document.getElementById("roomLabel");
  const elSeatLabel = document.getElementById("seatLabel");
  const elStatusText = document.getElementById("statusText");

  const elAiWhite = document.getElementById("aiWhite");

  const elCommit = document.getElementById("commit");
  const elUndo = document.getElementById("undo");
  const elReset = document.getElementById("reset");

  const elRoomCode = document.getElementById("roomCode");
  const elApplyRoom = document.getElementById("applyRoom");
  const elCopyLink = document.getElementById("copyLink");

  const elPlayAsBlack = document.getElementById("playAsBlack");
  const elPlayAsWhite = document.getElementById("playAsWhite");

  const elJoinBlack = document.getElementById("joinBlack");
  const elJoinWhite = document.getElementById("joinWhite");

  const qButtons = Array.from(document.querySelectorAll(".qbtn"));
  const dButtons = Array.from(document.querySelectorAll(".dbtn"));

  // ===== State =====
  let board = new Array(36).fill(EMPTY);
  let turn = BLACK;              // 現在手番
  let phase = "place";           // "place" or "rotate"
  let pendingIndex = -1;         // 仮置き位置
  let pendingColor = EMPTY;      // 仮置き色
  let selQ = -1;                 // 回転小盤 0..3
  let selD = 0;                  // -1(left) or +1(right)
  let winCells = new Set();
  let history = [];

  // ローカル用の自分の色（オンライン時は seat に置き換え）
  let localYou = BLACK;

  // オンライン
  let clientId = makeClientId();
  let room = "";
  let seat = "";                 // "B" or "W" (オンライン参加時)
  let fb = { ok: false, db: null, roomRef: null, stateUnsub: null, seatsRef: null };
  let applyingRemote = false;

  // AI
  let aiEnabled = false;
  const AI_THINK_MS = 650;       // “ゆっくり”
  const AI_ROTATE_MS = 350;

  // 盤UI保持
  let subBoards = [];            // 4つの subBoard div
  let cellEls = [];              // 36個の cell div
  let lastPlaced = -1;

  // ===== Boot =====
  function boot() {
    makeBoardUI();
    bindEvents();

    initFirebaseMaybe();

    const r = parseRoomFromURL();
    if (r) {
      if (elRoomCode) elRoomCode.value = r;
      setRoom(r, false);
    } else {
      setHudRoom("-");
    }

    resetGame(false);
    render();

    setStatus("仮置き：マスをタップ（置き直しOK）");
  }

  // ===== UI Build (重要：2×2のsubBoard) =====
  function makeBoardUI() {
    if (!elBoard) return;

    elBoard.innerHTML = "";
    subBoards = [];
    cellEls = [];

    for (let q = 0; q < 4; q++) {
      const sb = document.createElement("div");
      sb.className = "subBoard";
      sb.dataset.q = String(q);

      for (let k = 0; k < 9; k++) {
        const i = quadLocalToIndex(q, k);
        const d = document.createElement("div");
        d.className = "cell";
        d.dataset.i = String(i);
        d.dataset.mark = "0";
        d.addEventListener("click", () => onCellClick(i));
        sb.appendChild(d);
        cellEls[i] = d;
      }

      subBoards[q] = sb;
      elBoard.appendChild(sb);
    }
  }

  // ===== Events =====
  function bindEvents() {
    // 回転小盤
    qButtons.forEach(b => b.addEventListener("click", () => {
      const q = Number(b.dataset.q);
      selectQuad(q);
    }));

    // 方向
    dButtons.forEach(b => b.addEventListener("click", () => {
      const d = Number(b.dataset.d);
      selectDir(d);
    }));

    elCommit.addEventListener("click", commitRotate);

    elUndo.addEventListener("click", undo);
    elReset.addEventListener("click", () => resetGame(true));

    elAiWhite.addEventListener("change", () => {
      aiEnabled = !!elAiWhite.checked;
      if (aiEnabled) setStatus("AI（白）ON：あなたは黒でプレイ推奨（ローカル）");
      else setStatus("AI OFF");
      maybeAIMove();
    });

    // ローカル先後
    elPlayAsBlack.addEventListener("click", () => {
      localYou = BLACK;
      seat = "";
      setHudSeat("B");
      resetGame(true);
      setStatus("ローカル：あなたは先攻（黒）");
      maybeAIMove();
    });

    elPlayAsWhite.addEventListener("click", () => {
      localYou = WHITE;
      seat = "";
      setHudSeat("W");
      resetGame(true);
      setStatus("ローカル：あなたは後攻（白）");
      maybeAIMove();
    });

    // Room
    elApplyRoom.addEventListener("click", () => {
      const r = (elRoomCode.value || "").trim();
      if (!r) return;
      setRoom(r, true);
    });

    elCopyLink.addEventListener("click", () => {
      const url = buildShareURL(room || (elRoomCode?.value || "").trim());
      copyText(url);
      setStatus("共有URLをコピーしました");
    });

    // オンライン参加
    elJoinBlack.addEventListener("click", () => joinOnline("B"));
    elJoinWhite.addEventListener("click", () => joinOnline("W"));

    // iPhoneで原因特定しやすいようにHUDへ
    window.addEventListener("error", (ev) => {
      try {
        const msg = ev && ev.message ? ev.message : "Unknown error";
        setStatus("JSエラー: " + msg);
      } catch {}
    });
  }

  // ===== Core Click =====
  function onCellClick(i) {
    if (isGameOver()) return;
    if (!canActNow()) return;

    // placeフェーズのみ
    if (phase !== "place") {
      setStatus("いまは回転を選んで「回転して確定」してください");
      return;
    }

    // 確定石があるマスは置けない
    if (board[i] !== EMPTY) return;

    // 仮置きを置き直しOK
    pendingIndex = i;
    pendingColor = turn;
    lastPlaced = i;
    phase = "rotate";
    winCells.clear();

    render();
    syncIfOnline();
    setStatus("回転する小盤と方向を選んで「回転して確定」");
  }

  function selectQuad(q) {
    if (!canActNow()) return;
    selQ = q;
    qButtons.forEach(b => b.classList.toggle("selected", Number(b.dataset.q) === q));
    subBoards.forEach((sb, idx) => sb.classList.toggle("selected", idx === q));
    renderStatusHint();
  }

  function selectDir(d) {
    if (!canActNow()) return;
    selD = d;
    dButtons.forEach(b => b.classList.toggle("selected", Number(b.dataset.d) === d));
    renderStatusHint();
  }

  function renderStatusHint() {
    if (phase !== "rotate") return;
    if (selQ < 0 || selD === 0) {
      setStatus("回転小盤と方向を選んでください");
    } else {
      setStatus("OK：『回転して確定』を押してください");
    }
  }

  // ===== Commit (rotate+fix) =====
  async function commitRotate() {
    if (isGameOver()) return;
    if (!canActNow()) return;

    if (phase !== "rotate") {
      setStatus("先にマスをタップして仮置きしてください");
      return;
    }
    if (pendingIndex < 0) {
      setStatus("仮置きがありません（マスをタップ）");
      phase = "place";
      render();
      return;
    }
    if (selQ < 0 || (selD !== -1 && selD !== 1)) {
      setStatus("回転小盤と方向を選んでください");
      return;
    }

    // 履歴に保存（Undo用）
    history.push(snapshot());

    // 1) 仮置きを確定配置（boardへ）
    board[pendingIndex] = pendingColor;

    // 2) 回転アニメ→回転を反映
    await animateAndApplyRotation(selQ, selD);

    // 3) 勝敗判定
    winCells = getWinCells(board);
    if (winCells.size > 0) {
      render();
      setStatus((turn === BLACK ? "黒" : "白") + "の勝ち！");
      syncIfOnline();
      return;
    }

    // 次手番へ
    pendingIndex = -1;
    pendingColor = EMPTY;
    phase = "place";
    selQ = -1;
    selD = 0;
    clearSelections();

    turn = (turn === BLACK) ? WHITE : BLACK;

    render();
    syncIfOnline();
    setStatus("仮置き：マスをタップ（置き直しOK）");

    maybeAIMove();
  }

  function clearSelections() {
    qButtons.forEach(b => b.classList.remove("selected"));
    dButtons.forEach(b => b.classList.remove("selected"));
    subBoards.forEach(sb => sb.classList.remove("selected"));
  }

  // ===== Rotation =====
  function applyRotationToBoard(q, dir) {
    // q: 0..3, dir: -1 (left/CCW) or +1 (right/CW)
    const idxs = quadIndices(q); // 9 indices in reading order
    const vals = idxs.map(i => board[i]);

    // rotate 3x3
    // vals indices: [0 1 2 / 3 4 5 / 6 7 8]
    const rot = new Array(9);
    if (dir === 1) { // CW
      rot[0]=vals[6]; rot[1]=vals[3]; rot[2]=vals[0];
      rot[3]=vals[7]; rot[4]=vals[4]; rot[5]=vals[1];
      rot[6]=vals[8]; rot[7]=vals[5]; rot[8]=vals[2];
    } else { // CCW
      rot[0]=vals[2]; rot[1]=vals[5]; rot[2]=vals[8];
      rot[3]=vals[1]; rot[4]=vals[4]; rot[5]=vals[7];
      rot[6]=vals[0]; rot[7]=vals[3]; rot[8]=vals[6];
    }

    for (let k=0;k<9;k++) board[idxs[k]] = rot[k];
  }

  async function animateAndApplyRotation(q, dir) {
    const sb = subBoards[q];
    if (!sb) {
      applyRotationToBoard(q, dir);
      return;
    }

    // アニメ用クラス付与
    sb.classList.remove("rotL","rotR");
    // force reflow
    void sb.offsetWidth;

    if (dir === 1) sb.classList.add("rotR");
    else sb.classList.add("rotL");

    // アニメ時間待ち
    await sleep(AI_ROTATE_MS);

    // 回転を反映（配列）
    applyRotationToBoard(q, dir);

    // クラス戻して正しい向きで再描画
    sb.classList.remove("rotL","rotR");
    render();
  }

  // ===== Undo/Reset =====
  function undo() {
    if (!history.length) {
      setStatus("Undoできる履歴がありません");
      return;
    }
    const s = history.pop();
    restore(s);
    setStatus("Undoしました");
    render();
    syncIfOnline();
  }

  function resetGame(announce) {
    board = new Array(36).fill(EMPTY);
    turn = BLACK;
    phase = "place";
    pendingIndex = -1;
    pendingColor = EMPTY;
    selQ = -1;
    selD = 0;
    winCells = new Set();
    history = [];
    lastPlaced = -1;
    clearSelections();

    // 表示上の自分の色
    if (!room) {
      setHudSeat(localYou === BLACK ? "B" : "W");
    }

    if (announce) setStatus("リセットしました");
    syncIfOnline();
  }

  // ===== Render =====
  function render() {
    // HUD
    elTurnText.textContent = (turn === BLACK ? "黒の手番" : "白の手番");
    elPhaseText.textContent = phase;
    elEvalText.textContent = String(evaluate(board));
    const bw = countBW(board);
    elBwText.textContent = `${bw.b} / ${bw.w}`;

    // 盤
    for (let i=0;i<36;i++) {
      const d = cellEls[i];
      if (!d) continue;

      const v = board[i];
      d.dataset.mark = String(v);

      d.classList.remove("pending","win","justPlaced");

      if (i === pendingIndex && phase === "rotate") d.classList.add("pending");
      if (winCells.has(i)) d.classList.add("win");
      if (i === lastPlaced) d.classList.add("justPlaced");
    }

    // justPlacedはすぐ戻す（アニメ用）
    if (lastPlaced >= 0) {
      const keep = lastPlaced;
      setTimeout(() => {
        const d = cellEls[keep];
        if (d) d.classList.remove("justPlaced");
      }, 200);
    }

    // 回転フェーズの誘導
    if (phase === "rotate") renderStatusHint();
  }

  function setStatus(s) {
    if (elStatusText) elStatusText.textContent = s;
  }

  function setHudRoom(s) {
    if (elRoomLabel) elRoomLabel.textContent = s;
  }

  function setHudSeat(s) {
    if (elSeatLabel) elSeatLabel.textContent = s;
  }

  // ===== Helpers =====
  function countBW(bd) {
    let b=0,w=0;
    for (const v of bd) { if (v===BLACK) b++; else if (v===WHITE) w++; }
    return {b,w};
  }

  function isGameOver() {
    return winCells && winCells.size > 0;
  }

  function canActNow() {
    // オンラインなら seat に従う
    if (room && seat) {
      const myColor = (seat === "B") ? BLACK : WHITE;
      if (turn !== myColor) return false;
    }
    return true;
  }

  function snapshot() {
    return {
      board: board.slice(),
      turn,
      phase,
      pendingIndex,
      pendingColor,
      selQ,
      selD,
      winCells: Array.from(winCells),
      localYou,
      seat
    };
  }

  function restore(s) {
    board = s.board.slice();
    turn = s.turn;
    phase = s.phase;
    pendingIndex = s.pendingIndex;
    pendingColor = s.pendingColor;
    selQ = s.selQ;
    selD = s.selD;
    winCells = new Set(s.winCells || []);
    localYou = s.localYou ?? localYou;
    seat = s.seat ?? seat;

    clearSelections();
    if (selQ >= 0) {
      qButtons.forEach(b => b.classList.toggle("selected", Number(b.dataset.q) === selQ));
      subBoards.forEach((sb, idx) => sb.classList.toggle("selected", idx === selQ));
    }
    if (selD !== 0) {
      dButtons.forEach(b => b.classList.toggle("selected", Number(b.dataset.d) === selD));
    }
  }

  // ===== Win check (5 in a row on 6x6) =====
  function getWinCells(bd) {
    const lines = [];
    const addLine = (cells) => lines.push(cells);

    // horizontal
    for (let r=0;r<6;r++){
      for (let c=0;c<=1;c++){
        const cells=[];
        for (let k=0;k<5;k++) cells.push(r*6+(c+k));
        addLine(cells);
      }
    }
    // vertical
    for (let c=0;c<6;c++){
      for (let r=0;r<=1;r++){
        const cells=[];
        for (let k=0;k<5;k++) cells.push((r+k)*6+c);
        addLine(cells);
      }
    }
    // diag down-right
    for (let r=0;r<=1;r++){
      for (let c=0;c<=1;c++){
        const cells=[];
        for (let k=0;k<5;k++) cells.push((r+k)*6+(c+k));
        addLine(cells);
      }
    }
    // diag down-left
    for (let r=0;r<=1;r++){
      for (let c=4;c<=5;c++){
        const cells=[];
        for (let k=0;k<5;k++) cells.push((r+k)*6+(c-k));
        addLine(cells);
      }
    }

    for (const cells of lines) {
      const v0 = bd[cells[0]];
      if (v0 === EMPTY) continue;
      let ok = true;
      for (let i=1;i<cells.length;i++){
        if (bd[cells[i]] !== v0) { ok=false; break; }
      }
      if (ok) return new Set(cells);
    }
    return new Set();
  }

  // ===== Evaluation (軽い指標：人間っぽい雰囲気用) =====
  // +なら黒有利、-なら白有利
  function evaluate(bd) {
    // 5ライン候補に対して「連の強さ」だけ雑にスコア
    const scoreLine = (cells) => {
      let b=0,w=0;
      for (const i of cells){
        if (bd[i]===BLACK) b++;
        else if (bd[i]===WHITE) w++;
      }
      if (b>0 && w>0) return 0; // 混在は価値低
      if (b===0 && w===0) return 0;
      // 1,2,3,4の強さ
      const val = [0, 1, 4, 12, 40, 200];
      if (b>0) return val[b];
      return -val[w];
    };

    let s = 0;

    // 全5ライン
    // horizontal
    for (let r=0;r<6;r++){
      for (let c=0;c<=1;c++){
        const cells=[];
        for (let k=0;k<5;k++) cells.push(r*6+(c+k));
        s += scoreLine(cells);
      }
    }
    // vertical
    for (let c=0;c<6;c++){
      for (let r=0;r<=1;r++){
        const cells=[];
        for (let k=0;k<5;k++) cells.push((r+k)*6+c);
        s += scoreLine(cells);
      }
    }
    // diag down-right
    for (let r=0;r<=1;r++){
      for (let c=0;c<=1;c++){
        const cells=[];
        for (let k=0;k<5;k++) cells.push((r+k)*6+(c+k));
        s += scoreLine(cells);
      }
    }
    // diag down-left
    for (let r=0;r<=1;r++){
      for (let c=4;c<=5;c++){
        const cells=[];
        for (let k=0;k<5;k++) cells.push((r+k)*6+(c-k));
        s += scoreLine(cells);
      }
    }

    return Math.max(-999, Math.min(999, s));
  }

  // ===== AI (白) =====
  function maybeAIMove() {
    if (!aiEnabled) return;

    // オンライン中は AI を推奨しない（混乱防止）
    if (room) return;

    // AIは白担当
    if (turn !== WHITE) return;

    // ローカルで自分が白を選んでるならAIは動かない
    if (localYou === WHITE) return;

    // すでに勝敗
    if (isGameOver()) return;

    // フェーズがplaceのときだけAI開始
    if (phase !== "place") return;

    setStatus("AI考え中…");

    setTimeout(async () => {
      // 1) 置く
      const move = aiChooseMove();
      if (!move) { setStatus("AI: 手が見つかりません"); return; }

      pendingIndex = move.place;
      pendingColor = WHITE;
      lastPlaced = move.place;
      phase = "rotate";

      render();
      await sleep(AI_THINK_MS);

      // 2) 回転選択
      selQ = move.q;
      selD = move.d;
      // UIハイライト反映
      clearSelections();
      qButtons.forEach(b => b.classList.toggle("selected", Number(b.dataset.q) === selQ));
      dButtons.forEach(b => b.classList.toggle("selected", Number(b.dataset.d) === selD));
      subBoards.forEach((sb, idx) => sb.classList.toggle("selected", idx === selQ));
      renderStatusHint();

      await sleep(AI_THINK_MS);

      // 3) 確定
      await commitRotate();

    }, AI_THINK_MS);
  }

  function aiChooseMove() {
    // かなり軽量：全部試して一番evalが良い手（白はevalを最小化）
    let best = null;
    let bestScore = Infinity;

    const empties = [];
    for (let i=0;i<36;i++) if (board[i]===EMPTY) empties.push(i);

    // 少し“人間っぽく”：中央寄り優先の微バイアス
    const centerBonus = (i) => {
      const r = Math.floor(i/6), c = i%6;
      const dr = Math.abs(r-2.5), dc = Math.abs(c-2.5);
      return (dr+dc);
    };

    for (const place of empties) {
      // 仮に置く
      const bd1 = board.slice();
      bd1[place] = WHITE;

      for (let q=0;q<4;q++){
        for (const d of [-1,1]){
          const bd2 = bd1.slice();
          rotateOn(bd2, q, d);

          // 勝てるなら即
          if (getWinCells(bd2).size > 0) {
            return { place, q, d };
          }

          let sc = evaluate(bd2); // +黒有利 / -白有利 なので、白は小さいほど良い
          sc += centerBonus(place) * 0.08; // わずかに中心寄り
          if (sc < bestScore) {
            bestScore = sc;
            best = { place, q, d };
          }
        }
      }
    }
    return best;
  }

  function rotateOn(bd, q, dir) {
    const idxs = quadIndices(q);
    const vals = idxs.map(i => bd[i]);
    const rot = new Array(9);
    if (dir === 1) {
      rot[0]=vals[6]; rot[1]=vals[3]; rot[2]=vals[0];
      rot[3]=vals[7]; rot[4]=vals[4]; rot[5]=vals[1];
      rot[6]=vals[8]; rot[7]=vals[5]; rot[8]=vals[2];
    } else {
      rot[0]=vals[2]; rot[1]=vals[5]; rot[2]=vals[8];
      rot[3]=vals[1]; rot[4]=vals[4]; rot[5]=vals[7];
      rot[6]=vals[0]; rot[7]=vals[3]; rot[8]=vals[6];
    }
    for (let k=0;k<9;k++) bd[idxs[k]] = rot[k];
  }

  // ===== Mapping =====
  function quadIndices(q) {
    // q=0 TL, 1 TR, 2 BL, 3 BR
    const baseR = (q < 2) ? 0 : 3;
    const baseC = (q % 2 === 0) ? 0 : 3;
    const out = [];
    for (let r=0;r<3;r++){
      for (let c=0;c<3;c++){
        out.push((baseR+r)*6 + (baseC+c));
      }
    }
    return out;
  }

  function quadLocalToIndex(q, k) {
    // k: 0..8 reading order inside 3x3
    const baseR = (q < 2) ? 0 : 3;
    const baseC = (q % 2 === 0) ? 0 : 3;
    const r = Math.floor(k/3);
    const c = k % 3;
    return (baseR+r)*6 + (baseC+c);
  }

  // ===== Online (Firebase) =====
  function initFirebaseMaybe() {
    // firebase が無い環境でも動くようにガード
    if (!window.firebase || !firebase.initializeApp) {
      fb.ok = false;
      return;
    }

    try {
      // あなたの設定（提示された値）
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
      fb.db = firebase.database();
      fb.ok = true;
    } catch (e) {
      fb.ok = false;
      setStatus("Firebase初期化に失敗（ローカルはOK）");
    }
  }

  function setRoom(r, updateURL) {
    room = r;
    setHudRoom(room);
    if (updateURL) {
      const url = buildShareURL(room);
      historyReplace(url);
    }

    // オンライン監視
    if (fb.ok) {
      watchRoomState();
      watchSeats();
    }
  }

  function watchRoomState() {
    if (!fb.ok || !room) return;
    if (fb.roomRef) fb.roomRef.off();

    fb.roomRef = fb.db.ref(`rooms/${room}/state`);
    fb.roomRef.on("value", (snap) => {
      const v = snap.val();
      if (!v) return;

      // 自分が書いた直後の反映でバタつかないようガード
      if (applyingRemote) return;

      applyingRemote = true;
      try {
        if (v.board && Array.isArray(v.board) && v.board.length === 36) board = v.board.slice();
        if (v.turn) turn = v.turn;
        if (v.phase) phase = v.phase;
        pendingIndex = (typeof v.pendingIndex === "number") ? v.pendingIndex : -1;
        pendingColor = (typeof v.pendingColor === "number") ? v.pendingColor : EMPTY;
        selQ = (typeof v.selQ === "number") ? v.selQ : -1;
        selD = (typeof v.selD === "number") ? v.selD : 0;
        winCells = new Set(Array.isArray(v.winCells) ? v.winCells : []);
        lastPlaced = (typeof v.lastPlaced === "number") ? v.lastPlaced : -1;

        clearSelections();
        if (selQ >= 0) {
          qButtons.forEach(b => b.classList.toggle("selected", Number(b.dataset.q) === selQ));
          subBoards.forEach((sb, idx) => sb.classList.toggle("selected", idx === selQ));
        }
        if (selD !== 0) {
          dButtons.forEach(b => b.classList.toggle("selected", Number(b.dataset.d) === selD));
        }

        render();
      } finally {
        applyingRemote = false;
      }
    });
  }

  function watchSeats() {
    if (!fb.ok || !room) return;
    fb.seatsRef = fb.db.ref(`rooms/${room}/seats`);
  }

  function joinOnline(want) {
    if (!fb.ok) { setStatus("Firebase未設定（ローカルのみ）"); return; }
    const r = (room || (elRoomCode?.value || "").trim());
    if (!r) { setStatus("room番号を入れてください"); return; }
    if (!room) setRoom(r, true);

    const ref = fb.db.ref(`rooms/${room}/seats/${clientId}`);
    ref.set(want).then(() => {
      seat = want; // "B" or "W"
      setHudSeat(seat);
      setStatus(`オンライン参加：あなたは ${seat}（${seat==="B"?"先攻/黒":"後攻/白"}）`);
      // 初期stateが無ければ作る（先攻黒開始）
      fb.db.ref(`rooms/${room}/state`).once("value").then((snap) => {
        if (!snap.val()) syncIfOnline(true);
      });
    }).catch(() => {
      setStatus("参加に失敗しました");
    });
  }

  function syncIfOnline(forceInit = false) {
    if (!fb.ok || !room) return;

    const payload = {
      board: board.slice(),
      turn,
      phase,
      pendingIndex,
      pendingColor,
      selQ,
      selD,
      winCells: Array.from(winCells),
      lastPlaced
    };

    if (forceInit) {
      fb.db.ref(`rooms/${room}/state`).set(payload);
      return;
    }

    // 参加済みseatがある場合のみ同期（誤爆防止）
    if (seat) fb.db.ref(`rooms/${room}/state`).set(payload);
  }

  // ===== URL helpers =====
  function parseRoomFromURL() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("room") || "";
    } catch { return ""; }
  }

  function buildShareURL(r) {
    const base = location.origin + location.pathname;
    if (!r) return base;
    return `${base}?room=${encodeURIComponent(r)}`;
  }

  function historyReplace(url) {
    try { history.replaceState(null, "", url); } catch {}
  }

  function copyText(t) {
    try {
      navigator.clipboard.writeText(t);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }

  // ===== Misc =====
  function makeClientId() {
    // 端末に保存（同じ端末は同じID）
    const k = "rotation_game_client_id";
    try {
      const v = localStorage.getItem(k);
      if (v) return v;
      const n = "c_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
      localStorage.setItem(k, n);
      return n;
    } catch {
      return "c_" + Math.random().toString(16).slice(2);
    }
  }

  function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
  }

  // ===== Start =====
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
