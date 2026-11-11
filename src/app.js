(() => {
  "use strict";
  const T = window.TERRAINS;
  const { cellPieces, piecePos } = window.Autotile;
  const { Solver, bits, popcount } = window.WFC;
  const $ = (id) => document.getElementById(id);
  const KEYS = "1234567890QWERTYUIOPASDJKLZXCVBNM".split("");
  const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 3, 4, 6, 8];
  const STORE = "wfcmap.v1";
  const ROOT = T.findIndex((t) => t.parent < 0);
  const defaultW = T.map((t) => t.weight);

  // 子孫 (つながって見える地形) のビット
  const desc = T.map((_, v) => {
    let m = 0;
    T.forEach((_, u) => {
      for (let p = u; p >= 0; p = T[p].parent) if (p === v) m |= 1 << u;
    });
    return m >>> 0;
  });
  const depth = T.map((t) => {
    let d = 0;
    for (let p = t.parent; p >= 0; p = T[p].parent) d++;
    return d;
  });

  // ---------------------------------------------------------------- 状態
  let W = 64, H = 40;
  const solver = new Solver(T, W, H);
  let sel = Math.max(0, T.findIndex((t) => t.id === "grass"));
  let brush = 1;
  const imgs = [];
  const mapCv = document.createElement("canvas");
  let mctx;
  const cv = $("cv"), ctx = cv.getContext("2d");
  let vw = 0, vh = 0, zoom = 1, ox = 0, oy = 0;
  let hover = null; // { x, y, i, cand }
  let needDraw = true;
  let spaceDown = false, shiftDown = false;
  let drag = null; // { mode: 'pan'|'paint'|'erase', ... }
  let undo = [], redo = [];
  let running = false;
  let flash = null; // { i, until }
  let msgTimer = 0;

  const P = {
    clump: $("pClump"), bias: $("pBias"), scale: $("pScale"), border: $("pBorder"), anim: $("pAnim"),
    grid: $("optGrid"), cand: $("optCand"), manual: $("optManual"), seed: $("seed"), lock: $("seedLock"),
  };

  // ---------------------------------------------------------------- 画像
  function loadImages() {
    return Promise.all(
      T.map(
        (t, i) =>
          new Promise((res) => {
            const im = new Image();
            im.onload = () => res((imgs[i] = im));
            im.onerror = () => res((imgs[i] = null));
            im.src = t.png;
          })
      )
    );
  }

  // ---------------------------------------------------------------- 描画: マップバッファ
  function connected(v, nx, ny) {
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return true;
    const u = solver.cells[ny * W + nx];
    return u < 0 || ((desc[v] >>> u) & 1) === 1;
  }
  function drawCell(x, y) {
    const v = solver.cells[y * W + x], px = x * 32, py = y * 32;
    mctx.clearRect(px, py, 32, 32);
    if (v < 0 || !imgs[v]) return;
    const p = T[v].parent;
    if (p >= 0 && imgs[p]) mctx.drawImage(imgs[p], 128, 0, 32, 32, px, py, 32, 32);
    const ks = cellPieces(x, y, (nx, ny) => connected(v, nx, ny));
    for (let q = 0; q < 4; q++) {
      const [c, r] = piecePos(ks[q]);
      mctx.drawImage(imgs[v], c * 16, r * 16, 16, 16, px + (q & 1) * 16, py + (q >> 1) * 16, 16, 16);
    }
  }
  function rebuildMap() {
    mapCv.width = W * 32;
    mapCv.height = H * 32;
    mctx = mapCv.getContext("2d");
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) drawCell(x, y);
    solver.dirty.clear();
    popup = null;
    needDraw = true;
  }
  function flushDirty() {
    if (!solver.dirty.size) return;
    if (solver.dirty.size > (W * H) / 4) {
      rebuildMap();
      afterChange();
      return;
    }
    const set = new Set();
    for (const i of solver.dirty) {
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) set.add(ny * W + nx);
        }
    }
    solver.dirty.clear();
    for (const j of set) drawCell(j % W, (j / W) | 0);
    afterChange();
  }
  function afterChange() {
    popup = null;
    if (hover) {
      hover.cand = -1;
      hover.inPop = false;
    }
    needDraw = true;
    scheduleSave();
    updateCount();
    updateInfo();
    dimPalette();
  }

  // ---------------------------------------------------------------- 描画: ビュー
  const cs = () => 32 * zoom;
  function resizeView() {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    vw = r.width;
    vh = r.height;
    cv.width = Math.round(vw * dpr);
    cv.height = Math.round(vh * dpr);
    needDraw = true;
  }
  function hasFixedNeighbor(i) {
    for (let k = 0; k < 8; k++) {
      const j = solver.nb[i * 8 + k];
      if (j >= 0 && solver.cells[j] >= 0) return true;
    }
    return false;
  }
  /** 候補を出すセルか */
  function showsCandidates(i) {
    if (!P.cand.checked || solver.cells[i] >= 0) return false;
    const d = solver.dom[i];
    return d !== 0 && d !== solver.ALL && popcount(d) >= 2 && hasFixedNeighbor(i);
  }
  function candLayout(i) {
    const list = [...bits(solver.dom[i])], n = list.length, c = cs();
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const pad = Math.max(1, Math.round(c * 0.05));
    const s = Math.floor((c - pad * (cols + 1)) / cols);
    const oyy = Math.floor((c - (rows * (s + pad) + pad)) / 2);
    const oxx = Math.floor((c - (cols * (s + pad) + pad)) / 2);
    return { list, cols, s, pad, ox: oxx, oy: oyy };
  }
  // 候補パネル: ホバー中の未確定セルの横に出す
  let popup = null;
  const PS = 28, PP = 3, PL = 18;
  function makePopup(i) {
    const list = [...bits(solver.dom[i])], n = list.length;
    const cols = Math.min(n, Math.max(2, Math.ceil(Math.sqrt(n * 1.6))));
    const rows = Math.ceil(n / cols);
    const w = Math.max(84, cols * (PS + PP) + PP), h = rows * (PS + PP) + PP + PL;
    const c = cs(), sx = ox + (i % W) * c, sy = oy + ((i / W) | 0) * c;
    let left = sx + c;
    if (left + w > vw) left = sx - w;
    const top = Math.max(0, Math.min(sy, vh - h));
    return { i, list, cols, left, top, w, h };
  }
  const inPopup = (mx, my) => popup && mx >= popup.left && my >= popup.top && mx < popup.left + popup.w && my < popup.top + popup.h;
  function popupHit(mx, my) {
    const lx = mx - popup.left - PP, ly = my - popup.top - PP;
    if (lx < 0 || ly < 0) return -1;
    const cx = Math.floor(lx / (PS + PP)), cy = Math.floor(ly / (PS + PP));
    if (cx >= popup.cols || lx - cx * (PS + PP) >= PS || ly - cy * (PS + PP) >= PS) return -1;
    const k = cy * popup.cols + cx;
    return k < popup.list.length ? popup.list[k] : -1;
  }

  function draw() {
    needDraw = false;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#111113";
    ctx.fillRect(0, 0, vw, vh);
    const c = cs();
    ctx.fillStyle = "#2a2a2e";
    ctx.fillRect(ox, oy, W * c, H * c);
    ctx.drawImage(mapCv, ox, oy, W * c, H * c);

    const x0 = Math.max(0, Math.floor(-ox / c)), y0 = Math.max(0, Math.floor(-oy / c));
    const x1 = Math.min(W - 1, Math.floor((vw - ox) / c)), y1 = Math.min(H - 1, Math.floor((vh - oy) / c));

    if (P.grid.checked && c >= 8) {
      ctx.strokeStyle = "rgba(0,0,0,0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1 + 1; x++) {
        ctx.moveTo(ox + x * c + 0.5, oy + y0 * c);
        ctx.lineTo(ox + x * c + 0.5, oy + (y1 + 1) * c);
      }
      for (let y = y0; y <= y1 + 1; y++) {
        ctx.moveTo(ox + x0 * c, oy + y * c + 0.5);
        ctx.lineTo(ox + (x1 + 1) * c, oy + y * c + 0.5);
      }
      ctx.stroke();
    }

    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x, sx = ox + x * c, sy = oy + y * c;
        if (solver.cells[i] < 0 && solver.dom[i] === 0) {
          ctx.strokeStyle = "#e0705a";
          ctx.beginPath();
          ctx.moveTo(sx + 4, sy + 4);
          ctx.lineTo(sx + c - 4, sy + c - 4);
          ctx.moveTo(sx + c - 4, sy + 4);
          ctx.lineTo(sx + 4, sy + c - 4);
          ctx.stroke();
          continue;
        }
        if (P.manual.checked && solver.manual[i]) {
          const m = Math.max(2, Math.round(c / 8));
          ctx.fillStyle = "#000";
          ctx.fillRect(sx + 1, sy + 1, m + 2, m + 2);
          ctx.fillStyle = "#fff";
          ctx.fillRect(sx + 2, sy + 2, m, m);
        }
        if (!showsCandidates(i)) continue;
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(sx, sy, c, c);
        if (c < 64) {
          ctx.strokeStyle = "rgba(255,255,255,0.22)";
          if (c >= 12) ctx.strokeRect(sx + 2.5, sy + 2.5, c - 5, c - 5);
          continue;
        }
        const L = candLayout(i);
        L.list.forEach((t, k) => {
          const px = sx + L.ox + L.pad + (k % L.cols) * (L.s + L.pad), py = sy + L.oy + L.pad + Math.floor(k / L.cols) * (L.s + L.pad);
          if (imgs[t]) ctx.drawImage(imgs[t], 128, 0, 32, 32, px, py, L.s, L.s);
        });
      }

    // ホバー: ブラシ範囲
    if (hover && !drag?.pan && !hover.inPop) {
      const r = (brush - 1) >> 1;
      const bx0 = Math.max(0, hover.x - r), by0 = Math.max(0, hover.y - r);
      const bx1 = Math.min(W - 1, hover.x + r), by1 = Math.min(H - 1, hover.y + r);
      const ok = (solver.allowedAt(hover.i) >>> sel) & 1 || solver.cells[hover.i] === sel;
      ctx.strokeStyle = shiftDown ? "#f0b040" : ok ? "#ffffff" : "#e0705a";
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + bx0 * c + 0.5, oy + by0 * c + 0.5, (bx1 - bx0 + 1) * c - 1, (by1 - by0 + 1) * c - 1);
    }
    if (popup && !showsCandidates(popup.i)) popup = null;
    if (popup) {
      const p = popup, x = p.i % W, y = (p.i / W) | 0;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(ox + x * c + 0.5, oy + y * c + 0.5, c - 1, c - 1);
      ctx.fillStyle = "#1b1b1d";
      ctx.fillRect(p.left, p.top, p.w, p.h);
      ctx.strokeStyle = "#6a6a72";
      ctx.strokeRect(p.left + 0.5, p.top + 0.5, p.w - 1, p.h - 1);
      p.list.forEach((t, k) => {
        const px = p.left + PP + (k % p.cols) * (PS + PP), py = p.top + PP + Math.floor(k / p.cols) * (PS + PP);
        if (imgs[t]) ctx.drawImage(imgs[t], 128, 0, 32, 32, px, py, PS, PS);
        if (hover && hover.cand === t) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.strokeRect(px - 1, py - 1, PS + 2, PS + 2);
          ctx.lineWidth = 1;
        }
      });
      ctx.fillStyle = hover && hover.cand >= 0 ? "#e8e8ec" : "#8a8a92";
      ctx.font = "12px system-ui, 'Yu Gothic UI', sans-serif";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(hover && hover.cand >= 0 ? T[hover.cand].name : p.list.length + " 候補", p.left + PP + 1, p.top + p.h - 5);
    }
    if (flash) {
      if (performance.now() > flash.until) flash = null;
      else {
        const x = flash.i % W, y = (flash.i / W) | 0;
        ctx.fillStyle = "rgba(224,112,90,0.45)";
        ctx.fillRect(ox + x * c, oy + y * c, c, c);
        needDraw = true;
      }
    }
  }

  // ---------------------------------------------------------------- ビュー操作
  function setZoom(z, mx = vw / 2, my = vh / 2) {
    const mxm = (mx - ox) / zoom, mym = (my - oy) / zoom;
    zoom = z;
    popup = null;
    ox = Math.round(mx - mxm * zoom);
    oy = Math.round(my - mym * zoom);
    $("zoomLabel").textContent = Math.round(zoom * 100) + "%";
    needDraw = true;
  }
  function zoomStep(dir, mx, my) {
    let k = ZOOMS.indexOf(zoom);
    if (k < 0) k = ZOOMS.findIndex((z) => z > zoom) - 1;
    k = Math.max(0, Math.min(ZOOMS.length - 1, k + dir));
    setZoom(ZOOMS[k], mx, my);
  }
  function fit() {
    popup = null;
    let z = ZOOMS[0];
    for (const zz of ZOOMS) if (W * 32 * zz <= vw - 16 && H * 32 * zz <= vh - 16) z = zz;
    zoom = z;
    ox = Math.round((vw - W * 32 * z) / 2);
    oy = Math.round((vh - H * 32 * z) / 2);
    $("zoomLabel").textContent = Math.round(zoom * 100) + "%";
    needDraw = true;
  }
  /** ポインタ位置のセル (候補パネル上ならその候補も) */
  function cellAt(e) {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    if (!drag && inPopup(mx, my)) {
      const i = popup.i;
      return { x: i % W, y: (i / W) | 0, i, mx, my, cand: popupHit(mx, my), inPop: true };
    }
    const c = cs(), x = Math.floor((mx - ox) / c), y = Math.floor((my - oy) / c);
    if (x < 0 || y < 0 || x >= W || y >= H) {
      popup = null;
      return null;
    }
    const i = y * W + x;
    if (!drag && showsCandidates(i)) {
      if (!popup || popup.i !== i) popup = makePopup(i);
    } else popup = null;
    return { x, y, i, mx, my, cand: -1, inPop: false };
  }

  // ---------------------------------------------------------------- 編集
  function msg(s) {
    $("stMsg").textContent = s;
    clearTimeout(msgTimer);
    if (s) msgTimer = setTimeout(() => ($("stMsg").textContent = ""), 2800);
  }
  function snapshot() {
    return { snap: solver.snapshot() };
  }
  function pushUndo(s = snapshot()) {
    undo.push(s);
    if (undo.length > 120) undo.shift();
    redo = [];
    updateUndoButtons();
  }
  function restore(s) {
    stopGen();
    const resized = s.snap.W !== W || s.snap.H !== H;
    solver.restore(s.snap);
    W = solver.W;
    H = solver.H;
    if (resized) {
      $("mapW").value = W;
      $("mapH").value = H;
      rebuildMap();
      fit();
    }
    flushDirty();
  }
  function doUndo() {
    if (!undo.length) return;
    redo.push(snapshot());
    restore(undo.pop());
    updateUndoButtons();
  }
  function doRedo() {
    if (!redo.length) return;
    undo.push(snapshot());
    restore(redo.pop());
    updateUndoButtons();
  }
  function updateUndoButtons() {
    $("bUndo").disabled = !undo.length;
    $("bRedo").disabled = !redo.length;
  }
  /** ストローク開始時のスナップショットを、実際に変更が起きたときだけ積む */
  function touch() {
    if (drag && drag.snap) {
      pushUndo(drag.snap);
      drag.snap = null;
    }
  }

  // 矢印スクロールの状態。noise は進んだ分だけずらし、逆向きに戻ったら epoch を変えて別の景色にする
  const scroll = { offX: 0, offY: 0, dirX: 0, dirY: 0, epoch: 0 };
  function params(seed) {
    return {
      seed, clump: +P.clump.value, bias: +P.bias.value, scale: +P.scale.value,
      noiseSeed: (+P.seed.value | 0) + scroll.epoch * 7919, offX: scroll.offX, offY: scroll.offY,
    };
  }

  let tmpCv = null;
  /** 矢印の向きへ1マス進む: はみ出したマスを消し、空いた列/行をWFCで生成 */
  function scrollMap(dx, dy, record) {
    stopGen();
    if (record) pushUndo();
    if ((dx && scroll.dirX === -dx) || (dy && scroll.dirY === -dy)) scroll.epoch++;
    if (dx) scroll.dirX = dx;
    if (dy) scroll.dirY = dy;
    scroll.offX += dx;
    scroll.offY += dy;
    const fresh = solver.shift(dx, dy);
    // 描画済みの絵をずらす (全マス描き直すと大きいマップで重い)
    if (!tmpCv) tmpCv = document.createElement("canvas");
    if (tmpCv.width !== mapCv.width || tmpCv.height !== mapCv.height) {
      tmpCv.width = mapCv.width;
      tmpCv.height = mapCv.height;
    }
    const tctx = tmpCv.getContext("2d");
    tctx.clearRect(0, 0, tmpCv.width, tmpCv.height);
    tctx.drawImage(mapCv, 0, 0);
    mctx.clearRect(0, 0, mapCv.width, mapCv.height);
    mctx.drawImage(tmpCv, -dx * 32, -dy * 32);
    solver.run(params((Math.random() * 1e9) | 0), fresh);
    for (const i of fresh) solver.dirty.add(i);
    flushDirty();
  }

  /** 1セルを塗る。戻り値: 置けたか */
  function paintCell(i, t, force) {
    if (solver.cells[i] === t) return true;
    const ok = solver.cells[i] < 0 ? solver.place(i, t, 1, true) : solver.replace(i, t, 1);
    if (ok) {
      touch();
      return true;
    }
    if (!force) return false;
    touch();
    const removed = solver.force(i, t, 1);
    if (removed.length) solver.run(params((Math.random() * 1e9) | 0), removed);
    return true;
  }
  function brushCells(x, y) {
    const r = (brush - 1) >> 1, out = [];
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H) out.push([Math.abs(dx) + Math.abs(dy), ny * W + nx]);
      }
    return out.sort((a, b) => a[0] - b[0]).map((a) => a[1]);
  }
  function paintAt(x, y, force) {
    let fail = -1;
    for (const i of brushCells(x, y)) if (!paintCell(i, sel, force) && fail < 0) fail = i;
    if (fail >= 0 && brush === 1) {
      flash = { i: fail, until: performance.now() + 260 };
      msg(`${T[sel].name} はここに置けません（Shift で強制）`);
    }
    flushDirty();
  }
  function eraseAt(x, y) {
    const list = brushCells(x, y).filter((i) => solver.cells[i] >= 0);
    if (!list.length) return;
    touch();
    solver.eraseMany(list);
    flushDirty();
  }
  function placeCandidate(i, t) {
    pushUndo();
    if (!solver.place(i, t, 1, true)) msg("置けませんでした");
    flushDirty();
  }
  /** a→b の間のセルを列挙 (ドラッグが速くても途切れないように) */
  function line(a, b) {
    const out = [];
    let x0 = a.x, y0 = a.y;
    const dx = Math.abs(b.x - x0), dy = -Math.abs(b.y - y0), sx = x0 < b.x ? 1 : -1, sy = y0 < b.y ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      out.push([x0, y0]);
      if (x0 === b.x && y0 === b.y) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
    return out.slice(1);
  }

  // ---------------------------------------------------------------- 生成
  function nextSeed() {
    if (!P.lock.checked) P.seed.value = 1 + Math.floor(Math.random() * 999999);
    return +P.seed.value | 0;
  }
  function startGen(mode) {
    if (running) {
      stopGen();
      return;
    }
    pushUndo();
    if (mode === "all") {
      solver.clear(false);
      Object.assign(scroll, { offX: 0, offY: 0, dirX: 0, dirY: 0, epoch: 0 });
    }
    if (mode === "regen") solver.clear(true);
    if (P.border.checked && ROOT >= 0) {
      for (let x = 0; x < W; x++)
        for (const y of [0, H - 1]) {
          const i = y * W + x;
          if (solver.can(i, ROOT)) solver.place(i, ROOT, 0, false);
        }
      for (let y = 0; y < H; y++)
        for (const x of [0, W - 1]) {
          const i = y * W + x;
          if (solver.can(i, ROOT)) solver.place(i, ROOT, 0, false);
        }
    }
    solver.begin(params(nextSeed()));
    if (!P.anim.checked) {
      solver.step(1e9);
      finishGen();
      return;
    }
    running = true;
    $("bGen").textContent = "停止";
    $("bGen").classList.add("running");
  }
  function stopGen() {
    if (!running) return;
    solver.stop();
    finishGen();
  }
  function finishGen() {
    running = false;
    $("bGen").textContent = "生成";
    $("bGen").classList.remove("running");
    flushDirty();
    const bad = solver.cells.reduce((n, v, i) => n + (v < 0 && solver.dom[i] === 0 ? 1 : 0), 0);
    if (bad) msg(`矛盾 ${bad} マス（×印）。消して埋め直してください`);
  }

  // ---------------------------------------------------------------- パレット
  const rows = [];
  function buildPalette() {
    const box = $("palette");
    box.innerHTML = "";
    const head = document.createElement("div");
    head.className = "brushes";
    head.innerHTML = "ブラシ ";
    [1, 3, 5, 9].forEach((b) => {
      const bt = document.createElement("button");
      bt.textContent = b;
      bt.dataset.b = b;
      bt.onclick = () => setBrush(b);
      head.appendChild(bt);
    });
    box.appendChild(head);
    T.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "row";
      row.style.paddingLeft = 4 + depth[i] * 7 + "px";
      const key = document.createElement("span");
      key.className = "key";
      key.textContent = KEYS[i] || "";
      const sw = document.createElement("canvas");
      sw.width = sw.height = 32;
      if (imgs[i]) sw.getContext("2d").drawImage(imgs[i], 128, 0, 32, 32, 0, 0, 32, 32);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = t.name;
      const rg = document.createElement("input");
      rg.type = "range";
      rg.min = 0;
      rg.max = 10;
      rg.step = 0.1;
      rg.value = t.weight;
      rg.title = "出現の重み";
      const wv = document.createElement("span");
      wv.className = "w";
      wv.textContent = t.weight;
      rg.oninput = () => {
        t.weight = +rg.value;
        wv.textContent = rg.value;
        scheduleSave();
      };
      rg.onpointerdown = (e) => e.stopPropagation();
      row.append(key, sw, name, rg, wv);
      row.onpointerdown = () => select(i);
      row.ondblclick = () => {
        rg.value = t.weight = defaultW[i];
        wv.textContent = t.weight;
      };
      box.appendChild(row);
      rows.push({ row, rg, wv });
    });
    select(sel);
    setBrush(brush);
  }
  function select(i) {
    sel = i;
    rows.forEach((r, k) => r.row.classList.toggle("sel", k === i));
    needDraw = true;
  }
  function setBrush(b) {
    brush = b;
    document.querySelectorAll(".brushes button").forEach((bt) => bt.classList.toggle("on", +bt.dataset.b === b));
    needDraw = true;
  }
  function dimPalette() {
    const mask = hover && !drag ? solver.allowedAt(hover.i) : solver.ALL;
    rows.forEach((r, k) => r.row.classList.toggle("no", !((mask >>> k) & 1)));
  }

  // ---------------------------------------------------------------- ステータス
  function updateInfo() {
    $("stPos").textContent = hover ? `${hover.x}, ${hover.y}` : "";
    let s = "";
    if (hover) {
      const v = solver.cells[hover.i];
      if (hover.cand >= 0) s = `クリックで ${T[hover.cand].name} を配置`;
      else if (v >= 0) s = T[v].name + (solver.manual[hover.i] ? "（手動）" : "");
      else {
        const d = solver.dom[hover.i];
        if (d === 0) s = "矛盾";
        else if (d === solver.ALL) s = "未確定";
        else s = "候補: " + [...bits(d)].map((t) => T[t].name).join("・");
      }
    }
    $("stInfo").textContent = s;
  }
  function updateCount() {
    let n = 0;
    for (const v of solver.cells) if (v >= 0) n++;
    $("stCount").textContent = `${n} / ${W * H}`;
  }

  // ---------------------------------------------------------------- 保存
  let saveTimer = 0;
  function serialize() {
    return {
      v: 1,
      W,
      H,
      ids: T.map((t) => t.id),
      cells: Array.from(solver.cells),
      manual: Array.from(solver.manual),
      weights: Object.fromEntries(T.map((t) => [t.id, t.weight])),
      params: { clump: +P.clump.value, bias: +P.bias.value, scale: +P.scale.value, border: P.border.checked, anim: P.anim.checked },
      seed: +P.seed.value,
      lock: P.lock.checked,
      sel: T[sel].id,
      brush,
    };
  }
  function deserialize(o) {
    if (!o || o.v !== 1) throw new Error("形式が違います");
    const map = (o.ids || []).map((id) => T.findIndex((t) => t.id === id));
    W = o.W;
    H = o.H;
    solver.resize(W, H);
    o.cells.forEach((v, i) => (solver.cells[i] = v >= 0 ? map[v] ?? -1 : -1));
    (o.manual || []).forEach((m, i) => (solver.manual[i] = m));
    solver.recompute();
    if (o.weights) T.forEach((t, i) => {
      if (o.weights[t.id] !== undefined) t.weight = o.weights[t.id];
      if (rows[i]) {
        rows[i].rg.value = t.weight;
        rows[i].wv.textContent = t.weight;
      }
    });
    if (o.params) {
      P.clump.value = o.params.clump;
      P.bias.value = o.params.bias;
      P.scale.value = o.params.scale;
      P.border.checked = !!o.params.border;
      P.anim.checked = o.params.anim !== false;
    }
    if (o.seed !== undefined) P.seed.value = o.seed;
    P.lock.checked = !!o.lock;
    if (o.sel) select(Math.max(0, T.findIndex((t) => t.id === o.sel)));
    if (o.brush) setBrush(o.brush);
    $("mapW").value = W;
    $("mapH").value = H;
    syncOutputs();
    rebuildMap();
    updateCount();
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE, JSON.stringify(serialize()));
      } catch (e) {}
    }, 400);
  }
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");

  // ---------------------------------------------------------------- 入力
  function syncOutputs() {
    document.querySelectorAll(".params input[type=range]").forEach((r) => (r.nextElementSibling.textContent = r.value));
  }
  function bindUI() {
    $("bGen").onclick = () => startGen("all");
    $("bRegen").onclick = () => startGen("regen");
    $("bFill").onclick = () => startGen("fill");
    $("bClear").onclick = () => {
      stopGen();
      pushUndo();
      solver.clear(false);
      flushDirty();
    };
    $("bUndo").onclick = doUndo;
    $("bRedo").onclick = doRedo;
    $("bZoomIn").onclick = () => zoomStep(1);
    $("bZoomOut").onclick = () => zoomStep(-1);
    $("bFit").onclick = fit;
    $("bResize").onclick = () => {
      const w = Math.max(4, Math.min(160, +$("mapW").value | 0)), h = Math.max(4, Math.min(160, +$("mapH").value | 0));
      if (w === W && h === H) return;
      stopGen();
      pushUndo();
      solver.resize(w, h, true);
      W = w;
      H = h;
      rebuildMap();
      fit();
      updateCount();
      scheduleSave();
    };
    $("bPng").onclick = () => mapCv.toBlob((b) => download(b, `map_${W}x${H}_${stamp()}.png`));
    $("bSave").onclick = () => download(new Blob([JSON.stringify(serialize())], { type: "application/json" }), `map_${stamp()}.json`);
    $("bLoad").onclick = () => $("fileIn").click();
    $("fileIn").onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        const o = JSON.parse(await f.text());
        stopGen();
        pushUndo();
        deserialize(o);
        fit();
      } catch (err) {
        msg("読み込めません: " + err.message);
      }
    };
    $("bResetW").onclick = () => {
      T.forEach((t, i) => {
        t.weight = defaultW[i];
        rows[i].rg.value = t.weight;
        rows[i].wv.textContent = t.weight;
      });
      scheduleSave();
    };
    [P.grid, P.cand, P.manual].forEach((el) => (el.onchange = () => (needDraw = true)));
    document.querySelectorAll(".params input").forEach((el) => {
      el.addEventListener("input", () => {
        syncOutputs();
        scheduleSave();
      });
      el.addEventListener("change", scheduleSave);
    });
    P.seed.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        P.lock.checked = true;
        P.seed.blur();
        startGen("all");
      }
    });

    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      zoomStep(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      const h = cellAt(e);
      if (e.button === 1 || (e.button === 0 && spaceDown)) {
        drag = { pan: true, sx: e.clientX - ox, sy: e.clientY - oy };
        cv.style.cursor = "grabbing";
        return;
      }
      if (!h) return;
      if (running) stopGen();
      if (e.button === 2) {
        drag = { mode: "erase", last: h, snap: snapshot() };
        eraseAt(h.x, h.y);
        return;
      }
      if (e.button !== 0) return;
      if (e.altKey) {
        const v = solver.cells[h.i];
        if (v >= 0) select(v);
        return;
      }
      if (h.inPop) {
        if (h.cand >= 0) placeCandidate(h.i, h.cand);
        return;
      }
      drag = { mode: "paint", last: h, snap: snapshot(), force: e.shiftKey };
      paintAt(h.x, h.y, e.shiftKey);
    });
    cv.addEventListener("pointermove", (e) => {
      if (drag && drag.pan) {
        ox = e.clientX - drag.sx;
        oy = e.clientY - drag.sy;
        popup = null;
        needDraw = true;
        return;
      }
      const h = cellAt(e);
      const changed = (h?.i ?? -1) !== (hover?.i ?? -1) || (h?.cand ?? -1) !== (hover?.cand ?? -1) || (h?.inPop ?? false) !== (hover?.inPop ?? false);
      hover = h;
      if (changed) {
        needDraw = true;
        updateInfo();
        dimPalette();
      }
      if (drag && h && (h.x !== drag.last.x || h.y !== drag.last.y)) {
        for (const [x, y] of line(drag.last, h)) {
          if (drag.mode === "paint") paintAt(x, y, drag.force || e.shiftKey);
          else eraseAt(x, y);
        }
        drag.last = h;
        updateInfo();
      }
    });
    const end = () => {
      if (drag) {
        drag = null;
        cv.style.cursor = spaceDown ? "grab" : "";
        updateInfo();
        dimPalette();
      }
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("pointerleave", () => {
      if (!drag) {
        hover = null;
        needDraw = true;
        updateInfo();
        dimPalette();
      }
    });

    const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== "checkbox" && e.target.type !== "range") return;
      if (ARROWS[e.key] && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.target instanceof HTMLInputElement && e.target.type === "range") return;
        e.preventDefault();
        scrollMap(...ARROWS[e.key], !e.repeat);
        return;
      }
      if (e.key === "Shift") {
        shiftDown = true;
        needDraw = true;
      }
      if (e.code === "Space") {
        e.preventDefault();
        spaceDown = true;
        if (!drag) cv.style.cursor = "grab";
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) doUndo();
        else if (k === "y" || (k === "z" && e.shiftKey)) doRedo();
        else if (k === "s") $("bSave").click();
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;
      const up = e.key.toUpperCase();
      if (up === "G") startGen("all");
      else if (up === "F") startGen("fill");
      else if (up === "H") fit();
      else if (e.key === "Escape") stopGen();
      else if (e.key === "[") setBrush([1, 3, 5, 9][Math.max(0, [1, 3, 5, 9].indexOf(brush) - 1)]);
      else if (e.key === "]") setBrush([1, 3, 5, 9][Math.min(3, [1, 3, 5, 9].indexOf(brush) + 1)]);
      else if (e.key === "+" || e.key === ";") zoomStep(1);
      else if (e.key === "-") zoomStep(-1);
      else {
        const k = KEYS.indexOf(up);
        if (k >= 0 && k < T.length && e.code !== "Space") select(k);
        else return;
      }
      e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "Shift") {
        shiftDown = false;
        needDraw = true;
      }
      if (e.code === "Space") {
        spaceDown = false;
        if (!drag) cv.style.cursor = "";
      }
    });
    window.addEventListener("blur", () => {
      spaceDown = shiftDown = false;
    });
    window.addEventListener("resize", resizeView);
  }

  // ---------------------------------------------------------------- ループ
  function frame() {
    if (running) {
      const budget = Math.max(6, Math.ceil((W * H) / 80));
      const more = solver.step(budget);
      flushDirty();
      if (!more) finishGen();
    }
    if (needDraw) draw();
    requestAnimationFrame(frame);
  }

  async function init() {
    await loadImages();
    buildPalette();
    bindUI();
    resizeView();
    let loaded = false;
    try {
      const s = localStorage.getItem(STORE);
      if (s) {
        deserialize(JSON.parse(s));
        loaded = true;
      }
    } catch (e) {
      console.warn(e);
    }
    if (!loaded) {
      syncOutputs();
      rebuildMap();
      updateCount();
    }
    fit();
    updateUndoButtons();
    if (!loaded) startGen("all");
    requestAnimationFrame(frame);
  }
  // コンソールからいじれるように
  window.mapApp = { solver, T, view: () => ({ zoom, ox, oy, W, H }), setZoom, fit, select };
  init();
})();
