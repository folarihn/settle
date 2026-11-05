/** FNV-1a: a small stable hash, so an agent always gets the same mark. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const INKS = ["var(--lime)", "var(--cobalt)", "var(--coral)", "var(--ivory)"];

/** A 5x5 mirrored grid derived from the id: deterministic, no images, no faces. */
export function Identicon({ seed, size = 40 }: { seed: string; size?: number }) {
  const h = hash32(seed);
  const h2 = hash32(`${seed}:2`);
  const ink = INKS[h % INKS.length];
  const cells: [number, number][] = [];
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      const bit = ((x < 2 ? h2 : h) >>> (y * 3 + x)) & 1;
      if (bit) {
        cells.push([x, y]);
        if (x < 2) cells.push([4 - x, y]);
      }
    }
  return (
    <svg className="identicon" width={size} height={size} viewBox="0 0 7 7" aria-hidden>
      <rect width="7" height="7" fill="var(--navy)" />
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x + 1} y={y + 1} width="1" height="1" fill={ink} />
      ))}
    </svg>
  );
}
