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

  return { SUB, CELL, SHEET_W, SHEET_H, piecePos, pieceFor, pieceKind, QD, cellPieces };
});
