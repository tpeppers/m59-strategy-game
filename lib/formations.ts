export type FormationKind = "conga" | "t" | "circle" | "scattered" | "custom";

export type FormationSlot = {
  agent: string;
  dx: number;
  dy: number;
};

export type UnitGroup = {
  id: string;
  revision: number;
  name: string;
  leader: string;
  agents: string[];
  formation: FormationKind;
  spacing: number;
  slots: FormationSlot[];
  active: boolean;
};

export const FORMATION_PRESETS: Array<{
  id: Exclude<FormationKind, "custom">;
  label: string;
  hint: string;
}> = [
  { id: "conga", label: "Conga", hint: "Single file behind the leader" },
  { id: "t", label: "T", hint: "Broad front with a trailing stem" },
  { id: "circle", label: "Circle", hint: "Leader protected in the center" },
  { id: "scattered", label: "Scattered", hint: "Loose irregular spacing" },
];

export const MAX_FORMATION_OFFSET = 20;

const SCATTERED = [
  [-2, 1], [2, 2], [-1, 3], [3, -1], [-3, -2], [1, -3],
  [4, 3], [-4, 4], [2, 5], [-5, 0], [5, -4], [-2, -5],
];

function followerOffsets(
  kind: Exclude<FormationKind, "custom">,
  count: number,
  spacing: number,
) {
  if (kind === "conga") {
    return Array.from({ length: count }, (_, index) => [0, (index + 1) * spacing]);
  }
  if (kind === "t") {
    const bar = Math.min(5, count);
    const across = [[], [0], [-1, 1], [-1, 0, 1], [-2, -1, 1, 2], [-2, -1, 0, 1, 2]][bar];
    return Array.from({ length: count }, (_, index) =>
      index < bar
        ? [across[index] * spacing, spacing]
        : [0, (index - bar + 2) * spacing],
    );
  }
  if (kind === "circle") {
    const radius = Math.max(2, Math.ceil(count / 6) + 1) * spacing;
    return Array.from({ length: count }, (_, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(1, count)) * Math.PI * 2;
      return [Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)];
    });
  }
  return Array.from({ length: count }, (_, index) => {
    const base = SCATTERED[index % SCATTERED.length];
    const ring = Math.floor(index / SCATTERED.length) + 1;
    return [base[0] * spacing * ring, base[1] * spacing * ring];
  });
}

export function fitFormationSpacing(
  kind: Exclude<FormationKind, "custom">,
  memberCount: number,
  requested: number,
) {
  for (let spacing = Math.max(1, Math.min(4, Math.round(requested))); spacing > 1; spacing -= 1) {
    const offsets = followerOffsets(kind, Math.max(0, memberCount - 1), spacing);
    if (offsets.every(([dx, dy]) => Math.abs(dx) <= MAX_FORMATION_OFFSET && Math.abs(dy) <= MAX_FORMATION_OFFSET)) {
      return spacing;
    }
  }
  return 1;
}

export function buildFormationSlots(
  kind: Exclude<FormationKind, "custom">,
  agents: string[],
  leader: string,
  spacing = 1,
) {
  const followers = agents.filter((agent) => agent !== leader);
  const fittedSpacing = fitFormationSpacing(kind, agents.length, spacing);
  const offsets = followerOffsets(kind, followers.length, fittedSpacing);
  return [
    { agent: leader, dx: 0, dy: 0 },
    ...followers.map((agent, index) => ({
      agent,
      dx: offsets[index][0],
      dy: offsets[index][1],
    })),
  ];
}

export function formationTarget(
  anchor: {
    col: number;
    row: number;
    facingDegrees?: number | null;
    cols?: number | null;
    rows?: number | null;
  },
  slot: Pick<FormationSlot, "dx" | "dy">,
) {
  const radians = ((anchor.facingDegrees ?? 0) * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  return {
    col: Math.min(anchor.cols || Infinity, Math.max(1, Math.round(anchor.col - slot.dx * sin - slot.dy * cos))),
    row: Math.min(anchor.rows || Infinity, Math.max(1, Math.round(anchor.row + slot.dx * cos - slot.dy * sin))),
  };
}
