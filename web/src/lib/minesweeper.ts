export type CellView = "#" | "F" | "*" | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";
export type GameStatus = "ready" | "playing" | "won" | "lost";

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export class Minesweeper {
  rows: number;
  cols: number;
  mines: number;
  seed: number;
  status: GameStatus = "ready";
  startedAt: number | null = null;
  endedAt: number | null = null;
  moves = 0;
  mine: boolean[][] = [];
  open: boolean[][] = [];
  flag: boolean[][] = [];
  onChange?: () => void;

  constructor({ rows = 9, cols = 9, mines = 10, seed = 1 } = {}) {
    this.rows = rows;
    this.cols = cols;
    this.mines = mines;
    this.seed = seed;
    this.reset(seed);
  }

  reset(seed = this.seed) {
    this.seed = seed;
    this.status = "ready";
    this.startedAt = null;
    this.endedAt = null;
    this.moves = 0;
    const grid = (value: boolean) => Array.from({ length: this.rows }, () => Array(this.cols).fill(value));
    this.mine = grid(false);
    this.open = grid(false);
    this.flag = grid(false);
    const random = seededRandom(seed);
    const safeRow = Math.floor(this.rows / 2);
    const safeCol = Math.floor(this.cols / 2);
    let placed = 0;
    let guard = 0;
    while (placed < this.mines && guard++ < 1e6) {
      const row = Math.floor(random() * this.rows);
      const col = Math.floor(random() * this.cols);
      if (this.mine[row][col] || (Math.abs(row - safeRow) <= 1 && Math.abs(col - safeCol) <= 1)) continue;
      this.mine[row][col] = true;
      placed++;
    }
    this.onChange?.();
  }

  inBounds(row: number, col: number) {
    return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0 && row < this.rows && col < this.cols;
  }

  neighbors(row: number, col: number): [number, number][] {
    const list: [number, number][] = [];
    for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
      for (let colOffset = -1; colOffset <= 1; colOffset++) {
        if (!rowOffset && !colOffset) continue;
        const nextRow = row + rowOffset;
        const nextCol = col + colOffset;
        if (this.inBounds(nextRow, nextCol)) list.push([nextRow, nextCol]);
      }
    }
    return list;
  }

  count(row: number, col: number) {
    return this.neighbors(row, col).filter(([nextRow, nextCol]) => this.mine[nextRow][nextCol]).length;
  }

  private begin() {
    if (this.status === "ready") {
      this.status = "playing";
      this.startedAt = performance.now();
    }
  }

  private finish(status: GameStatus) {
    this.status = status;
    this.endedAt = performance.now();
  }

  elapsed() {
    return this.startedAt ? ((this.endedAt || performance.now()) - this.startedAt) / 1000 : 0;
  }

  reveal(row: number, col: number) {
    if (!this.inBounds(row, col)) return { ok: false, error: `(${row},${col}) is off the board` };
    if (this.status === "won" || this.status === "lost") return { ok: false, error: `game is over (${this.status})` };
    if (this.open[row][col]) return { ok: false, error: "already revealed" };
    if (this.flag[row][col]) return { ok: false, error: "cell is flagged; unflag first" };
    this.begin();
    this.moves++;
    if (this.mine[row][col]) {
      this.open[row][col] = true;
      this.finish("lost");
      this.onChange?.();
      return { ok: true, hitMine: true, status: "lost" as GameStatus };
    }
    const stack: [number, number][] = [[row, col]];
    let opened = 0;
    while (stack.length) {
      const [currentRow, currentCol] = stack.pop()!;
      if (this.open[currentRow][currentCol] || this.flag[currentRow][currentCol]) continue;
      this.open[currentRow][currentCol] = true;
      opened++;
      if (this.count(currentRow, currentCol) === 0) {
        for (const next of this.neighbors(currentRow, currentCol)) if (!this.open[next[0]][next[1]]) stack.push(next);
      }
    }
    if (this.remaining() === 0) this.finish("won");
    this.onChange?.();
    return { ok: true, hitMine: false, opened, status: this.status };
  }

  toggleFlag(row: number, col: number) {
    if (!this.inBounds(row, col)) return { ok: false, error: `(${row},${col}) is off the board` };
    if (this.open[row][col]) return { ok: false, error: "cell already revealed" };
    if (this.status === "won" || this.status === "lost") return { ok: false, error: `game is over (${this.status})` };
    this.begin();
    this.moves++;
    this.flag[row][col] = !this.flag[row][col];
    this.onChange?.();
    return { ok: true, flagged: this.flag[row][col] };
  }

  remaining() {
    let count = 0;
    for (let row = 0; row < this.rows; row++) for (let col = 0; col < this.cols; col++) if (!this.open[row][col] && !this.mine[row][col]) count++;
    return count;
  }

  view(): CellView[][] {
    const rows: CellView[][] = [];
    for (let row = 0; row < this.rows; row++) {
      const cells: CellView[] = [];
      for (let col = 0; col < this.cols; col++) {
        if (this.flag[row][col]) cells.push("F");
        else if (!this.open[row][col]) cells.push("#");
        else if (this.mine[row][col]) cells.push("*");
        else cells.push(String(this.count(row, col)) as CellView);
      }
      rows.push(cells);
    }
    return rows;
  }

  text() {
    const grid = this.view();
    const header = "    " + Array.from({ length: this.cols }, (_, index) => String(index % 10)).join(" ");
    return [header, ...grid.map((cells, index) => String(index).padStart(2) + "  " + cells.join(" "))].join("\n");
  }

  summary() {
    return { status: this.status, rows: this.rows, cols: this.cols, mines: this.mines, moves: this.moves, cellsLeft: this.remaining(), seconds: Number(this.elapsed().toFixed(1)) };
  }
}
