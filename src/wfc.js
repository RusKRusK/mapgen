// Wave Function Collapse (simple tiled model) — 地形ラベル単位、8近傍の隣接制約。
// ブラウザ(window.WFC)とNode(require)の両方で使う。
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.WFC = m;
})(typeof self !== "undefined" ? self : this, function () {
  const popcount = (m) => {
    m = m - ((m >>> 1) & 0x55555555);
    m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
    return (((m + (m >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  const lowbit = (m) => 31 - Math.clz32(m & -m);
  function* bits(m) {
    while (m) {
      const b = lowbit(m);
      yield b;
      m &= m - 1;
    }
  }

  function mulberry(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      let t = (s = (s + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(x, y, s) {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y, s) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, s), b = hash2(ix + 1, iy, s), c = hash2(ix, iy + 1, s), d = hash2(ix + 1, iy + 1, s);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }
  function fbm(x, y, s, oct = 4) {
    let v = 0, a = 0.5, n = 0;
    for (let o = 0; o < oct; o++) {
      v += vnoise(x, y, s + o * 131) * a;
      n += a;
      x *= 2.07;
      y *= 2.07;
      a *= 0.5;
    }
    return v / n;
  }

  class Heap {
    constructor() {
      this.k = [];
      this.v = [];
    }
    get size() {
      return this.k.length;
    }
    push(key, val) {
      const k = this.k, v = this.v;
      let i = k.length;
      k.push(key);
      v.push(val);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= key) break;
        k[i] = k[p];
        v[i] = v[p];
        i = p;
      }
      k[i] = key;
      v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, top = v[0];
      const lk = k.pop(), lv = v.pop();
      if (k.length) {
        let i = 0;
        const n = k.length;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c];
          v[i] = v[c];
          i = c;
        }
        k[i] = lk;
        v[i] = lv;
      }
      return top;
    }
  }

  class Solver {
    /** terrains: [{ parent: index | -1, weight, e?, m?, t? }] */
    constructor(terrains, W, H) {
      this.setTerrains(terrains);
      this.resize(W, H);
    }

    setTerrains(T) {
      this.T = T;
      const n = (this.n = T.length);
      this.ALL = n >= 32 ? 0xffffffff : ((1 << n) - 1) >>> 0;
      this.compat = new Uint32Array(n);
      for (let a = 0; a < n; a++)
        for (let b = 0; b < n; b++) {
          const pa = T[a].parent, pb = T[b].parent;
          if (a === b || pa === b || pb === a || (pa >= 0 && pa === pb)) this.compat[a] |= 1 << b;
        }
      // reach[k][t]: tからk歩以内に置ける地形
      this.reach = [new Uint32Array(n).map((_, t) => 1 << t)];
      for (let k = 1; k < 16; k++) this.reach.push(this.reach[k - 1].map((m) => this.support(m)));
      this.supCache = new Map();
      this.entCache = new Map();
    }

    support(mask) {
      if (!this.supCache) this.supCache = new Map();
      let s = this.supCache.get(mask);
      if (s === undefined) {
        s = 0;
        for (const b of bits(mask)) s |= this.compat[b];
        s >>>= 0;
        this.supCache.set(mask, s);
      }
      return s;
    }

    resize(W, H, keep) {
      const old = keep ? { W: this.W, H: this.H, cells: this.cells, manual: this.manual } : null;
      this.W = W;
      this.H = H;
      const N = W * H;
      this.cells = new Int16Array(N).fill(-1);
      this.manual = new Uint8Array(N);
      this.dom = new Uint32Array(N).fill(this.ALL);
      this.nb = new Int32Array(N * 8);
      const D = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          for (let k = 0; k < 8; k++) {
            const nx = x + D[k][0], ny = y + D[k][1];
            this.nb[(y * W + x) * 8 + k] = nx < 0 || ny < 0 || nx >= W || ny >= H ? -1 : ny * W + nx;
          }
      if (old)
        for (let y = 0; y < Math.min(H, old.H); y++)
          for (let x = 0; x < Math.min(W, old.W); x++) {
            this.cells[y * W + x] = old.cells[y * old.W + x];
            this.manual[y * W + x] = old.manual[y * old.W + x];
          }
      this.dirty = new Set();
      for (let i = 0; i < N; i++) this.dirty.add(i);
      this.recompute();
    }

    // ---- 制約伝播 ----
    _prop(stack, trail) {
      const dom = this.dom, nb = this.nb;
      while (stack.length) {
        const i = stack.pop();
        const sup = this.support(dom[i]);
        for (let k = 0; k < 8; k++) {
          const j = nb[i * 8 + k];
          if (j < 0) continue;
          const d = dom[j], nd = (d & sup) >>> 0;
          if (nd !== d) {
            if (trail) trail.push(j, d);
            dom[j] = nd;
            if (nd === 0) return j;
            if (this._heap && this.cells[j] < 0) this._pushHeap(j);
            stack.push(j);
          }
        }
      }
      return -1;
    }

    /** 確定セルから全域の候補を作り直す。矛盾しているセルの一覧を返す。 */
    recompute() {
      const N = this.W * this.H, dom = this.dom, nb = this.nb, cells = this.cells;
      const stack = [];
      for (let i = 0; i < N; i++) {
        dom[i] = cells[i] >= 0 ? 1 << cells[i] : this.ALL;
        if (cells[i] >= 0) stack.push(i);
      }
      const bad = [];
      while (stack.length) {
        const i = stack.pop();
        if (!dom[i]) continue;
        const sup = this.support(dom[i]);
        for (let k = 0; k < 8; k++) {
          const j = nb[i * 8 + k];
          if (j < 0) continue;
          const d = dom[j], nd = (d & sup) >>> 0;
          if (nd !== d) {
            dom[j] = nd;
            if (nd === 0) bad.push(j);
            else stack.push(j);
          }
        }
      }
      return bad;
    }

    _revert(trail, ctrail) {
      for (let k = trail.length - 2; k >= 0; k -= 2) this.dom[trail[k]] = trail[k + 1];
      for (let k = ctrail.length - 3; k >= 0; k -= 3) {
        this.cells[ctrail[k]] = ctrail[k + 1];
        this.manual[ctrail[k]] = ctrail[k + 2];
        this.dirty.add(ctrail[k]);
      }
    }

    _set(i, t, man, ctrail) {
      if (ctrail) ctrail.push(i, this.cells[i], this.manual[i]);
      this.cells[i] = t;
      this.manual[i] = man;
      this.dirty.add(i);
    }

    can(i, t) {
      return this.cells[i] < 0 && (this.dom[i] & (1 << t)) !== 0;
    }

    /**
     * 未確定セルに地形を置く。置けたら true。
     * cascade: 候補が1つに絞られた隣接セルを連鎖的に確定する
     */
    place(i, t, manual = 1, cascade = true) {
      if (!this.can(i, t)) return false;
      const trail = [i, this.dom[i]], ctrail = [];
      this.dom[i] = 1 << t;
      this._set(i, t, manual, ctrail);
      const stack = [i];
      if (this._prop(stack, trail) >= 0) {
        this._revert(trail, ctrail);
        return false;
      }
      if (cascade) {
        // 候補が1つだけになったセルを即確定
        for (;;) {
          let any = false;
          for (let k = 0; k < trail.length; k += 2) {
            const j = trail[k];
            if (this.cells[j] < 0 && this.dom[j] && popcount(this.dom[j]) === 1) {
              this._set(j, lowbit(this.dom[j]), 0, ctrail);
              stack.push(j);
              any = true;
            }
          }
          if (!any) break;
          if (this._prop(stack, trail) >= 0) {
            this._revert(trail, ctrail);
            return false;
          }
        }
      }
      return true;
    }

    /** 確定済みでも上書きを試みる (消してから置けるか)。だめなら元に戻して false */
    replace(i, t, manual = 1) {
      const v = this.cells[i], m = this.manual[i];
      if (v === t) {
        this.manual[i] = manual || m;
        return true;
      }
      if (v >= 0) {
        this._set(i, -1, 0);
        this.recompute();
      }
      if (this.place(i, t, manual, true)) return true;
      if (v >= 0) {
        this._set(i, v, m);
        this.recompute();
      }
      return false;
    }

    /** 周囲の確定セルだけから見た、iに置ける地形 (近似) */
    allowedAt(i) {
      if (this.cells[i] < 0) return this.dom[i];
      let mask = this.ALL;
      for (let k = 0; k < 8; k++) {
        const j = this.nb[i * 8 + k];
        if (j >= 0 && this.cells[j] >= 0) mask &= this.compat[this.cells[j]];
      }
      return mask >>> 0;
    }

    erase(i) {
      if (this.cells[i] < 0) return false;
      this._set(i, -1, 0);
      this.recompute();
      return true;
    }

    eraseMany(list) {
      let any = false;
      for (const i of list)
        if (this.cells[i] >= 0) {
          this._set(i, -1, 0);
          any = true;
        }
      if (any) this.recompute();
      return any;
    }

    /**
     * 強制配置: 矛盾する周囲のセルを消してから置く。消したセルの一覧を返す。
     */
    force(i, t, manual = 1) {
      const W = this.W, H = this.H, x0 = i % W, y0 = (i / W) | 0;
      const removed = [];
      this._set(i, t, manual);
      const R = this.reach.length - 1;
      for (let y = Math.max(0, y0 - R); y <= Math.min(H - 1, y0 + R); y++)
        for (let x = Math.max(0, x0 - R); x <= Math.min(W - 1, x0 + R); x++) {
          const j = y * W + x;
          if (j === i || this.cells[j] < 0) continue;
          const k = Math.max(Math.abs(x - x0), Math.abs(y - y0));
          if (!(this.reach[k][t] & (1 << this.cells[j]))) {
            this._set(j, -1, 0);
            removed.push(j);
          }
        }
      // まだ矛盾が残る場合は周囲を広げて消す
      for (let iter = 0; iter < 12; iter++) {
        const bad = this.recompute();
        if (!bad.length) break;
        const r = 1 + (iter >> 1);
        for (const b of bad) {
          const bx = b % W, by = (b / W) | 0;
          for (let y = Math.max(0, by - r); y <= Math.min(H - 1, by + r); y++)
            for (let x = Math.max(0, bx - r); x <= Math.min(W - 1, bx + r); x++) {
              const j = y * W + x;
              if (j !== i && this.cells[j] >= 0) {
                this._set(j, -1, 0);
                removed.push(j);
              }
            }
        }
      }
      return removed;
    }

    clear(keepManual = false) {
      for (let i = 0; i < this.cells.length; i++)
        if (this.cells[i] >= 0 && !(keepManual && this.manual[i])) this._set(i, -1, 0);
      this.recompute();
    }

    // ---- 生成 ----
    _entropy(mask) {
      let e = this.entCache.get(mask);
      if (e === undefined) {
        let s = 0, sl = 0;
        for (const b of bits(mask)) {
          const w = Math.max(1e-6, this.T[b].weight);
          s += w;
          sl += w * Math.log(w);
        }
        e = s > 0 ? Math.log(s) - sl / s : 0;
        this.entCache.set(mask, e);
      }
      return e;
    }
    _pushHeap(i) {
      if (this._region && !this._region.has(i)) return;
      this._heap.push(this._entropy(this.dom[i]) + this._tie[i], i);
    }

    /**
     * 生成を開始する。region: 対象セルの配列 (省略時は未確定セル全部)
     * opts: { seed, clump, bias, scale }
     */
    begin(opts = {}, region = null) {
      const N = this.W * this.H;
      this.entCache = new Map();
      this.opts = Object.assign({ seed: 1, clump: 1.5, bias: 0, scale: 1 }, opts);
      this.rng = mulberry(this.opts.seed * 2654435761 + 12345);
      this._tie = new Float32Array(N);
      // tie: 同じエントロピーのときの順番。order>0 だと順番をランダム寄りにする (帯状に伸びるのを防ぐ)
      const tie = this.opts.order > 0 ? this.opts.order : 1e-3;
      for (let i = 0; i < N; i++) this._tie[i] = this.rng() * tie;
      this._region = region ? new Set(region) : null;
      this._heap = new Heap();
      this._resets = 0;
      const cand = region || Array.from({ length: N }, (_, i) => i);
      for (const i of cand) if (this.cells[i] < 0) this._pushHeap(i);
      // ノイズ誘導用のフィールド (標高・湿度・気温)
      if (this.opts.bias > 0) {
        // dimW/dimH: ノイズの尺度・緯度の基準にする「見えているマップ」の大きさ (先読み用の小さな盤面でも同じ地形になるように)
        const DW = this.opts.dimW || this.W, DH = this.opts.dimH || this.H;
        const s = this.opts.noiseSeed ?? this.opts.seed, sc = 7 / Math.max(DW, DH) / this.opts.scale;
        const offX = this.opts.offX || 0, offY = this.opts.offY || 0;
        this._E = new Float32Array(N);
        this._M = new Float32Array(N);
        this._Tp = new Float32Array(N);
        for (const i of cand) {
          const x = i % this.W, y = (i / this.W) | 0;
          const wx = x + offX, wy = y + offY;
          const e = fbm(wx * sc, wy * sc, s * 7 + 1, 5);
          this._E[i] = Math.min(1, Math.max(0, (e - 0.5) * 3.0 + 0.36));
          this._M[i] = Math.min(1, Math.max(0, (fbm(wx * sc * 1.3 + 50, wy * sc * 1.3, s * 7 + 2, 4) - 0.5) * 2.6 + 0.5));
          const lt = wy / Math.max(1, DH - 1), lat = 1 - Math.abs(lt - Math.floor(lt) - 0.5) * 2;
          this._Tp[i] = Math.min(1, Math.max(0, lat * 0.55 + (fbm(wx * sc + 90, wy * sc, s * 7 + 3, 3) - 0.5) * 1.6 + 0.25));
        }
      }
      this.running = true;
    }

    _choose(i) {
      const T = this.T, W = this.W, nb = this.nb, o = this.opts;
      const cnt = new Uint8Array(this.n);
      for (let k = 0; k < 8; k++) {
        const j = nb[i * 8 + k];
        if (j >= 0 && this.cells[j] >= 0) cnt[this.cells[j]]++;
      }
      let total = 0;
      const ws = [];
      for (const b of bits(this.dom[i])) {
        let w = Math.max(0, T[b].weight);
        if (o.clump > 0) w *= Math.pow(1 + cnt[b], o.clump);
        if (o.bias > 0) {
          let d = 0;
          if (T[b].e !== undefined) d += (T[b].e - this._E[i]) ** 2 * 14;
          if (T[b].m !== undefined) d += (T[b].m - this._M[i]) ** 2 * 1.5;
          if (T[b].t !== undefined) d += (T[b].t - this._Tp[i]) ** 2 * 1.5;
          w *= Math.exp(-o.bias * 6 * d);
        }
        ws.push(b, w);
        total += w;
      }
      if (total <= 0) {
        // 重み0しかない → 等確率
        const arr = [...bits(this.dom[i])];
        return arr[Math.floor(this.rng() * arr.length)];
      }
      let r = this.rng() * total;
      for (let k = 0; k < ws.length; k += 2) {
        r -= ws[k + 1];
        if (r <= 0) return ws[k];
      }
      return ws[ws.length - 2];
    }

    _localReset(i) {
      const W = this.W, H = this.H, x0 = i % W, y0 = (i / W) | 0, r = 2 + Math.min(4, this._resets >> 4);
      const list = [];
      for (let y = Math.max(0, y0 - r); y <= Math.min(H - 1, y0 + r); y++)
        for (let x = Math.max(0, x0 - r); x <= Math.min(W - 1, x0 + r); x++) {
          const j = y * W + x;
          if (this._region && !this._region.has(j)) continue;
          if (this.cells[j] >= 0 && !this.manual[j]) this._set(j, -1, 0);
          list.push(j);
        }
      this.recompute();
      for (const j of list) if (this.cells[j] < 0) this._pushHeap(j);
    }

    /** budget個まで確定させる。終わったら false。 */
    step(budget = 1e9) {
      if (!this.running) return false;
      const heap = this._heap;
      let done = 0;
      while (done < budget) {
        if (!heap.size) {
          this.running = false;
          this._heap = null;
          return false;
        }
        const i = heap.pop();
        if (this.cells[i] >= 0) continue;
        if (this.dom[i] === 0) {
          if (++this._resets > 4000) {
            this.running = false;
            this._heap = null;
            return false;
          }
          this._localReset(i);
          continue;
        }
        const t = this._choose(i);
        if (this.place(i, t, 0, false)) {
          done++;
          continue;
        }
        // 矛盾: その候補を外して伝播
        const trail = [i, this.dom[i]];
        this.dom[i] = (this.dom[i] & ~(1 << t)) >>> 0;
        if (this.dom[i] === 0 || this._prop([i], trail) >= 0) {
          this._revert(trail, []);
          this._resets++;
          this._localReset(i);
        } else this._pushHeap(i);
      }
      return true;
    }

    stop() {
      this.running = false;
      this._heap = null;
    }

    /** 一気に最後まで生成 */
    run(opts, region) {
      this.begin(opts, region);
      while (this.step(1e6));
    }

    /**
     * 中身を (dx, dy) だけずらす (右矢印なら dx=1: 中身は左へ)。
     * はみ出したセルは消え、空いたセルの一覧を返す。dirty は付けない。
     */
    shift(dx, dy) {
      const W = this.W, H = this.H, c = new Int16Array(W * H).fill(-1), m = new Uint8Array(W * H), fresh = [];
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const sx = x + dx, sy = y + dy, i = y * W + x;
          if (sx >= 0 && sy >= 0 && sx < W && sy < H) {
            c[i] = this.cells[sy * W + sx];
            m[i] = this.manual[sy * W + sx];
          } else fresh.push(i);
        }
      this.cells = c;
      this.manual = m;
      this.recompute();
      return fresh;
    }

    snapshot() {
      return { W: this.W, H: this.H, cells: this.cells.slice(), manual: this.manual.slice() };
    }
    restore(s) {
      if (s.W !== this.W || s.H !== this.H) this.resize(s.W, s.H);
      this.cells.set(s.cells);
      this.manual.set(s.manual);
      for (let i = 0; i < this.cells.length; i++) this.dirty.add(i);
      this.recompute();
    }
  }

  return { Solver, popcount, bits, lowbit };
});
