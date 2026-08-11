type FormationLease = {
  revision: number;
  active: boolean;
  agents: string[];
};

type FormationRegistry = Map<string, FormationLease>;

const REGISTRY_KEY = Symbol.for("m59-strategy-game.formation-registry");

function registry() {
  const scope = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: FormationRegistry;
  };
  scope[REGISTRY_KEY] ||= new Map();
  return scope[REGISTRY_KEY];
}

export function engageFormation(groupId: string, revision: number, agents: string[]) {
  const current = registry().get(groupId);
  if (current && current.revision > revision) return false;
  registry().set(groupId, { revision, active: true, agents: [...agents] });
  return true;
}

export function releaseFormation(groupId: string, revision: number, agents: string[]) {
  const current = registry().get(groupId);
  const nextRevision = Math.max(revision, current?.revision ?? 0);
  const knownAgents = [...new Set([...(current?.agents || []), ...agents])];
  registry().set(groupId, { revision: nextRevision, active: false, agents: knownAgents });
  return { agents: knownAgents, previousRevision: current?.revision };
}

export function formationIsEngaged(groupId: string, revision: number) {
  const current = registry().get(groupId);
  return current?.active === true && current.revision === revision;
}
