import type { CellView } from "@/lib/minesweeper";
import { cn } from "@/lib/utils";

const numberColors: Record<string, string> = {
  "1": "text-sky-400",
  "2": "text-lime-400",
  "3": "text-orange-400",
  "4": "text-violet-400",
  "5": "text-amber-400",
  "6": "text-cyan-400",
  "7": "text-white",
  "8": "text-zinc-400",
};

export function Board({
  view,
  rows,
  cols,
  revealedMines,
  onReveal,
  onFlag,
  dimmed,
  highlight,
}: {
  view: CellView[][] | null;
  rows: number;
  cols: number;
  revealedMines?: boolean[][] | null;
  onReveal?: (row: number, col: number) => void;
  onFlag?: (row: number, col: number) => void;
  dimmed?: boolean;
  highlight?: Set<string> | null;
}) {
  const size = cols > 16 ? 20 : cols > 12 ? 26 : 32;
  const interactive = !!onReveal;
  return (
    <div
      className={cn("inline-grid gap-[2px] rounded-lg border border-border bg-black/40 p-2 select-none", dimmed && "opacity-80")}
      style={{ gridTemplateColumns: `repeat(${cols}, ${size}px)` }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {Array.from({ length: rows * cols }, (_, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        const value = view?.[row]?.[col] ?? "#";
        const showMine = value === "#" && revealedMines?.[row]?.[col];
        const isOpen = value !== "#" && value !== "F";
        return (
          <button
            key={index}
            type="button"
            tabIndex={-1}
            style={{ width: size, height: size }}
            className={cn(
              "flex items-center justify-center rounded-[5px] font-bold text-sm transition-colors",
              !isOpen && value !== "F" && "bg-zinc-600",
              interactive && !isOpen && "hover:bg-zinc-500",
              isOpen && "bg-zinc-900",
              value === "*" && "bg-red-600",
              value === "F" && "bg-amber-900/70",
              showMine && "bg-zinc-800",
              numberColors[value],
              !interactive && "cursor-default",
              highlight?.has(`${row},${col}`) && "ring-2 ring-amber-400 ring-offset-1 ring-offset-black",
            )}
            onClick={() => onReveal?.(row, col)}
            onContextMenu={(event) => {
              event.preventDefault();
              onFlag?.(row, col);
            }}
          >
            {value === "F" ? "🚩" : value === "*" ? "💥" : showMine ? "💣" : isOpen && value !== "0" ? value : ""}
          </button>
        );
      })}
    </div>
  );
}
