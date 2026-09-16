/** Internal protocol-shape evidence, never enrollment, identity, permission, or task state. */
export type AgentProtocolSupport = { generation: number; task: boolean; inspection: boolean };

const clients = new WeakMap<object, { binding: string; support: AgentProtocolSupport }>();

export function newAgentProtocolSupport(): AgentProtocolSupport {
  return { generation: 0, task: false, inspection: false };
}

export function clearAgentProtocolSupport(support: AgentProtocolSupport): void {
  support.generation += 1;
  support.task = false;
  support.inspection = false;
}

// Kept outside the public constructors/options: hosts cannot supply a skip-negotiation flag.
export function agentProtocolSupport(client: object, binding: string, shared?: AgentProtocolSupport): AgentProtocolSupport {
  const existing = clients.get(client);
  if (existing && existing.binding !== binding) clearAgentProtocolSupport(existing.support);
  const support = shared ?? (existing?.binding === binding ? existing.support : newAgentProtocolSupport());
  clients.set(client, { binding, support });
  return support;
}
