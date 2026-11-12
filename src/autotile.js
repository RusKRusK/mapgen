// 4分割オートタイル。ブラウザ(window.Autotile)とNode(require)の両方で使う。
// シート: 160x32。16x16のピース①〜⑳を
//   ①②⑤⑥⑨⑩⑬⑭⑰⑱
//   ③④⑦⑧⑪⑫⑮⑯⑲⑳
// の順に並べる。
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.Autotile = m;
})(typeof self !== "undefined" ? self : this, function () {
  const SUB = 16, CELL = 32, SHEET_W = 160, SHEET_H = 32;

  /** ピース番号 k (1..20) のシート上の位置 [col, row] (16px単位) */
  function piecePos(k) {
    const b = (k - 1) >> 2, w = (k - 1) & 3;
    return [b * 2 + (w & 1), w >> 1];
  }

  /**
   * 象限 q (0:左上 1:右上 2:左下 3:右下) に使うピース番号。
   * h: 横隣がつながるか, v: 縦隣がつながるか, d: 斜め隣がつながるか
   */
  function pieceFor(q, h, v, d) {
    if (!h && !v) return 1 + q;            // 凸角 ①〜④
    if (!h && v) return [5, 7, 6, 8][q];   // 左右のフチ ⑤〜⑧
    if (h && !v) return 9 + q;             // 上下のフチ ⑨〜⑫
    if (!d) return 13 + q;                 // 凹角 ⑬〜⑯
    return 17 + q;                         // 内部 ⑰〜⑳
  }

  /** ピース番号から [象限, 種類] */
  function pieceKind(k) {
    if (k <= 4) return [k - 1, "convex"];
    if (k <= 8) return [[0, 2, 1, 3][k - 5], "side"];
    if (k <= 12) return [k - 9, "tb"];
    if (k <= 16) return [k - 13, "concave"];
    return [k - 17, "interior"];
  }

  /** 象限ごとの [横方向dx, 縦方向dy] */
  const QD = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

  /**
   * セル(x,y)の4象限のピース番号を返す。conn(nx, ny) は隣がつながるか。
   */
  function cellPieces(x, y, conn) {
    const out = [0, 0, 0, 0];
    for (let q = 0; q < 4; q++) {
      const [dx, dy] = QD[q];
      out[q] = pieceFor(q, conn(x + dx, y), conn(x, y + dy), conn(x + dx, y + dy));
    }
    return out;
  }

  // ---------------------------------------------------------------- 横視点
  /**
   * 横視点の地形情報。T: [{ parent, kind: "solid" | "air" | "liquid" }]
   * solid: 地面か / anc: 祖先 (自分は含まない) のビット / desc: 子孫 (自分を含む) のビット
   */
  function sideInfo(T) {
    const anc = T.map((t) => {
      let m = 0;
      for (let p = t.parent; p >= 0; p = T[p].parent) m |= 1 << p;
      return m >>> 0;
    });
    const desc = T.map((_, v) => T.reduce((m, _, u) => ((anc[u] >>> v) & 1 || u === v ? (m | (1 << u)) >>> 0 : m), 0));
    return { solid: T.map((t) => t.kind === "solid"), anc, desc, parent: T.map((t) => t.parent) };
  }
  /**
   * 横視点で v が隣の u とつながって見えるか (つながらない側にフチを描く)。
   * 地面は空・洞窟・水に対してフチを描き、空・水は地面に対してはフチを描かない。
   * 同じ種類どうしは、祖先に対してフチを描き、子孫にはつながる。関係のない2つは番号の大きい方がフチを描く。
   */
  function sideConn(v, u, I) {
    if (u < 0 || u === v) return true;
    const sv = I.solid[v], su = I.solid[u];
    if (sv !== su) return su;
    if ((I.anc[v] >>> u) & 1) return false;
    if ((I.desc[v] >>> u) & 1) return true;
    return u > v;
  }
  /**
   * 横視点のセル (x,y) の地形 v を描く手順。at(nx, ny) は隣の地形 (盤面の外・未確定は -1)。
   * 象限ごとに [下に敷く地形の内部 (なければ -1), v のピース番号] を返す。
   * 下に敷くのは、つながらない隣のうち空・洞窟・水を優先 (なければ地面、それもなければ親)。
   */
  function sideCell(x, y, v, at, I) {
    const out = [];
    for (let q = 0; q < 4; q++) {
      const [dx, dy] = QD[q];
      const uh = at(x + dx, y), uv = at(x, y + dy), ud = at(x + dx, y + dy);
      const h = sideConn(v, uh, I), vv = sideConn(v, uv, I), d = sideConn(v, ud, I);
      const k = pieceFor(q, h, vv, d);
      let under = -1;
      if (k < 17) {
        // フチになっている向きの隣から選ぶ
        const list = !h && !vv ? [uv, uh, ud] : !h ? [uh, ud, uv] : !vv ? [uv, ud, uh] : [ud, uh, uv];
        const open = list.filter((u) => u >= 0 && !sideConn(v, u, I));
        under = open.find((u) => !I.solid[u]) ?? open[0] ?? I.parent[v];
        if (under === undefined) under = -1;
      }
      out.push([under, k]);
    }
    return out;
  }

  return { SUB, CELL, SHEET_W, SHEET_H, piecePos, pieceFor, pieceKind, QD, cellPieces, sideInfo, sideConn, sideCell };
});
