// 建造物レイヤー。地形 (WFC) とは別に、セルごとに「どの建造物の、どの部分か」を持つ。
// ブラウザ(window.BuildLayer)とNode(require)の両方で使う。
//
// b[i]    : 建造物の番号 (-1 = なし)
// part[i] : fixed のときは足場の中の位置 (dy * w + dx)。高さ可変 (塔) はさらに 高さの番号 * 16 を足す。
//           飾りのある area (町) は飾りの番号。それ以外は 0
//
// kind ごとの見た目:
//   fixed: シートの part の位置を切り出す (高さ可変は高さごとの絵が横に並ぶ)
//   line : 上下左右のつながり mask (N1|E2|S4|W8) の位置を切り出す (lineMask)
//   area : 地形と同じ4分割オートタイル (隣が同じ建造物ならつながる)
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.BuildLayer = m;
})(typeof self !== "undefined" ? self : this, function () {
  const N = 1, E = 2, S = 4, Wd = 8;
  const DIRS = [[0, -1, N], [1, 0, E], [0, 1, S], [-1, 0, Wd]];

  function mulberry(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      let t = (s = (s + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const bitsOf = (list) => (list || []).reduce((m, t) => (m | (1 << t)) >>> 0, 0);

  class BuildLayer {
    /** defs: window.BUILDINGS, mark(i): 描き直しが必要なセルを知らせる */
    constructor(defs, W, H, mark) {
      this.D = defs;
      // 自動配置の頻度 (倍率)。地形の weight と同じく UI からいじる。0 で置かない
      this.freq = defs.map(() => 1);
      this.onMask = defs.map((d) => bitsOf(d.on));
      this.nearMask = defs.map((d) => bitsOf(d.near));
      this.mark = mark || (() => {});
      this.resize(W, H);
    }

    resize(W, H, keep) {
      const old = keep ? { W: this.W, H: this.H, b: this.b, part: this.part } : null;
      this.W = W;
      this.H = H;
      this.b = new Int16Array(W * H).fill(-1);
      this.part = new Uint8Array(W * H);
      if (old)
        for (let y = 0; y < Math.min(H, old.H); y++)
          for (let x = 0; x < Math.min(W, old.W); x++) {
            this.b[y * W + x] = old.b[y * old.W + x];
            this.part[y * W + x] = old.part[y * old.W + x];
          }
      // 右端・下端で切れた fixed の残りは消す
      if (old) for (const it of this.instances()) if (it.x + it.w > W || it.y + it.h > H) this.removeAt(it.cells[0]);
    }

    at(x, y) {
      return x < 0 || y < 0 || x >= this.W || y >= this.H ? -1 : this.b[y * this.W + x];
    }
    allows(bi, t) {
      return t >= 0 && ((this.onMask[bi] >>> t) & 1) === 1;
    }

    // ---- 高さ可変 (塔など)。part = 高さの番号 * 16 + 足場の中の位置
    /** variant (高さの番号) のときの高さ (マス) */
    heightOf(bi, variant = 0) {
      const d = this.D[bi];
      return d.hs ? d.hs[0] + Math.max(0, Math.min(d.hs[1] - d.hs[0], variant | 0)) : d.h;
    }
    /** part を { v: 高さの番号, local: 足場の中の位置, h: 高さ } に分ける */
    partInfo(bi, p) {
      const d = this.D[bi];
      if (!d.hs) return { v: 0, local: p, h: d.h };
      const v = p >> 4;
      return { v, local: p & 15, h: this.heightOf(bi, v) };
    }
    /** 地形を見る段か (高さ可変は一番下の段だけ。上の段は背後にかぶるだけ) */
    needsTerrain(bi, row, h) {
      return !this.D[bi].hs || row === h - 1;
    }

    /** 置けるか。理由つきで返す: { ok, why }。variant: 高さ可変の高さの番号 */
    check(bi, x, y, cells, variant) {
      const d = this.D[bi], W = this.W, H = this.H, h = this.heightOf(bi, variant);
      if (x < 0 || y < 0 || x + d.w > W || y + h > H) return { ok: false, why: "はみ出します" };
      for (let j = 0; j < h; j++)
        for (let i = 0; i < d.w; i++) {
          const k = (y + j) * W + x + i;
          if (this.b[k] >= 0) return { ok: false, why: "ほかの建造物があります" };
          if (this.needsTerrain(bi, j, h) && !this.allows(bi, cells[k])) return { ok: false, why: "地形が合いません" };
        }
      if (this.nearMask[bi]) {
        let found = false;
        for (let j = -1; j <= h && !found; j++)
          for (let i = -1; i <= d.w && !found; i++) {
            const nx = x + i, ny = y + j;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const t = cells[ny * W + nx];
            if (t >= 0 && (this.nearMask[bi] >>> t) & 1) found = true;
          }
        if (!found) return { ok: false, why: "水辺にしか置けません" };
      }
      return { ok: true, why: "" };
    }

    /**
     * variant: 飾りのある面状 (町) では飾りの番号 (省略時はランダム)、高さ可変 (塔) では高さの番号 (省略時 0)
     */
    place(bi, x, y, cells, variant) {
      if (!this.check(bi, x, y, cells, variant).ok) return false;
      const d = this.D[bi], h = this.heightOf(bi, variant), hv = d.hs ? (this.heightOf(bi, variant) - d.hs[0]) << 4 : 0;
      for (let j = 0; j < h; j++)
        for (let i = 0; i < d.w; i++) {
          const k = (y + j) * this.W + x + i;
          this.b[k] = bi;
          this.part[k] = d.deco ? (variant ?? Math.floor(Math.random() * d.deco)) % d.deco : hv | (j * d.w + i);
          this.mark(k);
        }
      return true;
    }

    /** セル i を含む建造物 (fixed は足場ぜんぶ) のセル一覧 */
    cellsOf(i) {
      const bi = this.b[i];
      if (bi < 0) return [];
      const d = this.D[bi];
      if (d.kind !== "fixed") return [i];
      const { local, h } = this.partInfo(bi, this.part[i]);
      if (d.w * h === 1) return [i];
      const W = this.W, x = i % W, y = (i / W) | 0, hv = this.part[i] - local;
      const ax = x - (local % d.w), ay = y - ((local / d.w) | 0), out = [];
      for (let j = 0; j < h; j++)
        for (let k = 0; k < d.w; k++) {
          const nx = ax + k, ny = ay + j;
          if (nx < 0 || ny < 0 || nx >= W || ny >= this.H) continue;
          const c = ny * W + nx;
          if (this.b[c] === bi && this.part[c] === hv + j * d.w + k) out.push(c);
        }
      return out;
    }

    removeAt(i) {
      const list = this.cellsOf(i);
      for (const c of list) {
        this.b[c] = -1;
        this.part[c] = 0;
        this.mark(c);
      }
      return list.length > 0;
    }

    clear() {
      for (let i = 0; i < this.b.length; i++)
        if (this.b[i] >= 0) {
          this.b[i] = -1;
          this.part[i] = 0;
          this.mark(i);
        }
    }

    /** 地形が合わなくなった建造物を消す。list: 調べるセル。消したら true */
    prune(list, cells) {
      let any = false;
      for (const i of list) {
        const bi = this.b[i];
        if (bi < 0 || cells[i] < 0 || this.allows(bi, cells[i])) continue;
        // 高さ可変は土台の段だけ見る
        if (this.D[bi].hs) {
          const { local, h } = this.partInfo(bi, this.part[i]);
          if (!this.needsTerrain(bi, (local / this.D[bi].w) | 0, h)) continue;
        }
        any = this.removeAt(i) || any;
      }
      return any;
    }

    /** 線状の建造物のつながり (N1|E2|S4|W8) */
    lineMask(x, y, cells) {
      const bi = this.at(x, y), W = this.W, H = this.H;
      const same = (dx, dy) => this.at(x + dx, y + dy) === bi;
      if (this.D[bi].id !== "bridge") {
        let m = 0;
        for (const [dx, dy, bit] of DIRS) if (same(dx, dy)) m |= bit;
        return m;
      }
      // 橋: 橋がつながっている軸を決め、その軸の先が陸なら岸までのばす
      const out = (dx, dy) => x + dx < 0 || y + dy < 0 || x + dx >= W || y + dy >= H;
      const land = (dx, dy) => {
        if (out(dx, dy)) return true;
        const t = cells[(y + dy) * W + x + dx];
        return t >= 0 && !this.allows(bi, t);
      };
      let h = same(1, 0) || same(-1, 0), v = same(0, 1) || same(0, -1);
      if (!h && !v) {
        if (land(1, 0) && land(-1, 0)) h = true;
        else if (land(0, 1) && land(0, -1)) v = true;
        else if (land(0, 1) || land(0, -1)) v = !(land(1, 0) || land(-1, 0));
        if (!v) h = true;
      }
      let m = 0;
      if (h) {
        if (same(1, 0) || land(1, 0)) m |= E;
        if (same(-1, 0) || land(-1, 0)) m |= Wd;
      }
      if (v) {
        if (same(0, -1) || land(0, -1)) m |= N;
        if (same(0, 1) || land(0, 1)) m |= S;
      }
      return m || (h ? E | Wd : N | S);
    }

    /** 置かれている建造物 (fixed は1つにまとめる) */
    instances() {
      const W = this.W, seen = new Uint8Array(this.b.length), out = [];
      for (let i = 0; i < this.b.length; i++) {
        if (this.b[i] < 0 || seen[i]) continue;
        const cells = this.cellsOf(i);
        for (const c of cells) seen[c] = 1;
        const bi = this.b[i], d = this.D[bi];
        // fixed だけ part が足場の中の位置。line / area は1マスずつ (町の part は飾りの番号なので使わない)
        const { local, h } = d.kind === "fixed" ? this.partInfo(bi, this.part[i]) : { local: 0, h: 1 };
        const x = (i % W) - (local % d.w), y = ((i / W) | 0) - ((local / d.w) | 0);
        out.push({ b: bi, x, y, w: d.w, h, cx: x + d.w / 2, cy: y + h / 2, cells });
      }
      return out;
    }

    /** 中身を (dx, dy) だけずらす。solver.shift と同じ向き */
    shift(dx, dy) {
      const W = this.W, H = this.H, b = new Int16Array(W * H).fill(-1), p = new Uint8Array(W * H);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const sx = x + dx, sy = y + dy;
          if (sx >= 0 && sy >= 0 && sx < W && sy < H) {
            b[y * W + x] = this.b[sy * W + sx];
            p[y * W + x] = this.part[sy * W + sx];
          }
        }
      this.b = b;
      this.part = p;
    }

    snapshot() {
      return { W: this.W, H: this.H, b: this.b.slice(), part: this.part.slice() };
    }
    restore(s) {
      if (s.W !== this.W || s.H !== this.H) this.resize(s.W, s.H);
      this.b.set(s.b);
      this.part.set(s.part);
      for (let i = 0; i < this.b.length; i++) this.mark(i);
    }

    // ---------------------------------------------------------------- 自動配置
    /**
     * 地形に合わせて建造物を撒く。region: 対象のセル (省略時は全体)。置いた数を返す。
     * 確率はすべて freq[建造物] 倍される。fixed は auto.per (置けるマス何個に1つ) の確率で、同じ種類と auto.gap 以上離して置く。
     * 面状 (町) は auto.per の確率で種を撒き、auto.size マスまで広げる。
     * 橋は短い水路 (1〜3マス) を陸から陸へ渡す。畑は今回置いた村・町のまわりに作る。
     * strict: true なら region の外には一切置かない (先読み盤面で、元の盤面側にはみ出さないように)。
     * false なら起点だけ region の中で、足場や広がりは外にはみ出してよい。
     */
    autoPlace(cells, opts = {}) {
      const D = this.D, W = this.W, H = this.H, rng = mulberry((opts.seed || 1) * 2246822519 + 7);
      const region = opts.region ? Array.from(opts.region) : Array.from({ length: W * H }, (_, i) => i);
      const inside = opts.strict && opts.region ? new Set(region) : null;
      const ok = (c) => !inside || inside.has(c);
      const okRect = (x, y, w, h) => {
        if (!inside) return true;
        for (let j = 0; j < h; j++) for (let k = 0; k < w; k++) if (x + k < 0 || y + j < 0 || x + k >= W || y + j >= H || !inside.has((y + j) * W + x + k)) return false;
        return true;
      };
      for (let k = region.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [region[k], region[j]] = [region[j], region[k]];
      }
      const placed = this.instances();
      const far = (bi, cx, cy) => {
        const d = D[bi];
        for (const it of placed) {
          const g = it.b === bi ? d.auto.gap : (D[it.b].w + d.w) / 2 + 2;
          if (Math.max(Math.abs(it.cx - cx), Math.abs(it.cy - cy)) < g) return false;
        }
        return true;
      };
      let count = 0;
      const towns = []; // 畑を広げる元 (村・町) のセル一覧
      const aroundOf = (d) => D.some((f) => f.auto && f.auto.around && f.auto.around.includes(d.id));
      // 面状を start から上下左右に n マス広げる。置いたセルの一覧を返す
      const grow = (bi, start, n) => {
        const got = [], q = [start];
        while (got.length < n && q.length) {
          const c = q.splice(Math.floor(rng() * q.length), 1)[0];
          if (this.b[c] >= 0 || !this.allows(bi, cells[c]) || !ok(c)) continue;
          const x = c % W, y = (c / W) | 0;
          this.place(bi, x, y, cells, Math.floor(rng() * (D[bi].deco || 1)));
          got.push(c);
          for (const [dx, dy] of DIRS) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < W && ny < H) q.push(ny * W + nx);
          }
        }
        return got;
      };

      // 面状で per のあるもの (町): 種を撒いて size の範囲で広げる
      D.forEach((d, bi) => {
        if (d.kind !== "area" || !d.auto || !d.auto.per) return;
        const p = this.freq[bi] / d.auto.per, [lo, hi] = d.auto.size || [3, 6];
        for (const i of region) {
          if (this.b[i] >= 0 || !this.allows(bi, cells[i]) || rng() >= p) continue;
          const x = i % W, y = (i / W) | 0;
          if (!far(bi, x + 0.5, y + 0.5)) continue;
          const got = grow(bi, i, lo + Math.floor(rng() * (hi - lo + 1)));
          if (!got.length) continue;
          for (const c of got) placed.push({ b: bi, cx: (c % W) + 0.5, cy: ((c / W) | 0) + 0.5 });
          count++;
          if (aroundOf(d)) towns.push(got);
        }
      });

      D.forEach((d, bi) => {
        if (d.kind !== "fixed" || !d.auto) return;
        const p = this.freq[bi] / d.auto.per;
        for (const i of region) {
          if (!this.allows(bi, cells[i]) || rng() >= p) continue;
          // 足場がこのセルを含むように起点をずらして試す (端の1列だけが対象でも大きいものを置ける)
          // 高さ可変はランダムな高さ。そのセルが土台 (一番下の段) になるように置く
          const v = d.hs ? Math.floor(rng() * (d.hs[1] - d.hs[0] + 1)) : undefined, h = this.heightOf(bi, v);
          const rows = d.hs ? 1 : h;
          let x = -1, y = -1;
          const ox = Math.floor(rng() * d.w), oy = Math.floor(rng() * rows);
          for (let k = 0; k < d.w * rows && x < 0; k++) {
            const tx = (i % W) - ((ox + k) % d.w), ty = ((i / W) | 0) - (d.hs ? h - 1 : (oy + ((k / d.w) | 0)) % h);
            if (okRect(tx, ty, d.w, h) && far(bi, tx + d.w / 2, ty + h / 2) && this.place(bi, tx, ty, cells, v)) {
              x = tx;
              y = ty;
            }
          }
          if (x < 0) continue;
          placed.push({ b: bi, x, y, cx: x + d.w / 2, cy: y + h / 2 });
          count++;
          if (aroundOf(d)) {
            const fp = [];
            for (let j = 0; j < h; j++) for (let k = 0; k < d.w; k++) fp.push((y + j) * W + x + k);
            towns.push(fp);
          }
        }
      });

      // 橋
      const bridge = D.findIndex((d) => d.id === "bridge" && d.auto);
      if (bridge >= 0) {
        const d = D[bridge], p = this.freq[bridge] / d.auto.per;
        const isLand = (x, y) => {
          const t = cells[y * W + x];
          return t >= 0 && !this.allows(bridge, t) && this.b[y * W + x] < 0;
        };
        for (const i of region) {
          const x = i % W, y = (i / W) | 0;
          if (!isLand(x, y)) continue;
          for (const [dx, dy] of [[1, 0], [0, 1]]) {
            let n = 1;
            while (n <= 4) {
              const nx = x + dx * n, ny = y + dy * n;
              if (nx >= W || ny >= H) {
                n = 99;
                break;
              }
              const j = ny * W + nx;
              if (!this.allows(bridge, cells[j]) || this.b[j] >= 0 || !ok(j)) break;
              n++;
            }
            const len = n - 1;
            if (len < 1 || len > 3 || x + dx * n >= W || y + dy * n >= H || !isLand(x + dx * n, y + dy * n)) continue;
            if (rng() >= p) continue;
            const cx = x + (dx * n) / 2, cy = y + (dy * n) / 2;
            if (!far(bridge, cx, cy)) continue;
            for (let k = 1; k <= len; k++) this.place(bridge, x + dx * k, y + dy * k, cells);
            placed.push({ b: bridge, cx, cy });
            count++;
          }
        }
      }

      // 畑: 村・町の足もとから広げる
      D.forEach((d, fi) => {
        if (d.kind !== "area" || !d.auto || !d.auto.around) return;
        for (const t of towns) {
          // 村・町ひとつにつき 75% (頻度 1 のとき) の確率で作る
          if (rng() >= Math.min(1, 0.75 * this.freq[fi])) continue;
          // まわり (8近傍) の空いている畑向きのセルから始める
          const own = new Set(t), ring = new Set();
          for (const c of t) {
            const x = c % W, y = (c / W) | 0;
            for (let j = -1; j <= 1; j++)
              for (let k = -1; k <= 1; k++) {
                const nx = x + k, ny = y + j, n = ny * W + nx;
                if (nx >= 0 && ny >= 0 && nx < W && ny < H && !own.has(n)) ring.add(n);
              }
          }
          const front = [...ring].filter((c) => this.b[c] < 0 && this.allows(fi, cells[c]));
          if (!front.length) continue;
          if (grow(fi, front[Math.floor(rng() * front.length)], 3 + Math.floor(rng() * 6)).length) count++;
        }
      });
      return count;
    }
  }

  BuildLayer.N = N;
  BuildLayer.E = E;
  BuildLayer.S = S;
  BuildLayer.W = Wd;
  return BuildLayer;
});
