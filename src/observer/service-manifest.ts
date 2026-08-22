/**
 * Service manifest — the D-2 instrument from docs/Almadar_Integrations_Gaps.md.
 *
 * For every service a schema invokes via `call-service`, reports the full
 * configuration truth in one table: registry status (typed actions,
 * declared-only, or unknown), backend grade ('simulated' means an in-memory
 * implementation — a green run proves nothing about a real provider), and
 * per-credential env presence. This is a REPORT, not a lintWiring gate
 * (wiring lints are last-resort; the gate candidate is ledger-noted in the
 * gaps doc) — but `unknown` + missing-required rows are surfaced as findings
 * text so runtime-verify prints them next to the wiring lint.
 *
 * @packageDocumentation
 */

import { createRequire } from 'node:module';
import type { OrbitalSchema } from '@almadar/core';

export interface ServiceManifestCredential {
  envVar: string;
  required: boolean;
  present: boolean;
  description: string;
}

export interface ServiceManifestEntry {
  service: string;
  /** Orbital names whose effects invoke the service. */
  invokedBy: string[];
  /** 'actions' = typed contract; 'declared' = name-only (host-injected); 'unknown' = not in the registry. */
  registered: 'actions' | 'declared' | 'unknown';
  /** 'production' | 'simulated' | 'stub' | 'host-injected' | 'unknown' (from services-registry `backend`). */
  backend: string;
  credentials: ServiceManifestCredential[];
  /** True when every REQUIRED credential is present in the supplied env. */
  configured: boolean;
}

export interface ServiceManifestResult {
  entries: ServiceManifestEntry[];
  /** Human-readable findings: unknown services, missing required credentials, simulated backends. */
  findings: string[];
}

interface RegistryService {
  backend?: string;
  actions: Array<{ name: string }>;
  credentials?: Array<{ envVar: string; required: boolean; description: string }>;
}

function loadServicesRegistry(): Record<string, RegistryService> {
  try {
    const esmRequire = createRequire(import.meta.url);
    const registry = esmRequire('@almadar/core/patterns/services-registry.json') as {
      services: Record<string, RegistryService>;
    };
    return registry.services;
  } catch {
    return {};
  }
}

/** Recursively find `call-service` service names in any JSON-shaped subtree. */
function collectCallServiceNames(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    if (
      node.length >= 2 &&
      (node[0] === 'call-service' || node[0] === 'call_service') &&
      typeof node[1] === 'string'
    ) {
      into.add(node[1]);
    }
    for (const child of node) {
      collectCallServiceNames(child, into);
    }
    return;
  }
  if (node && typeof node === 'object') {
    for (const child of Object.values(node as Record<string, unknown>)) {
      collectCallServiceNames(child, into);
    }
  }
}

/**
 * Build the service manifest for a schema. `env` defaults to `process.env`;
 * pass an explicit map to evaluate a deployment environment hermetically.
 */
export function serviceManifest(
  schema: OrbitalSchema,
  env: Record<string, string | undefined> = process.env,
): ServiceManifestResult {
  const registry = loadServicesRegistry();
  const invokedBy = new Map<string, Set<string>>();

  for (const orbital of schema.orbitals ?? []) {
    const names = new Set<string>();
    collectCallServiceNames(orbital, names);
    for (const service of names) {
      const set = invokedBy.get(service) ?? new Set<string>();
      set.add(orbital.name);
      invokedBy.set(service, set);
    }
  }

  const entries: ServiceManifestEntry[] = [];
  const findings: string[] = [];

  for (const service of [...invokedBy.keys()].sort()) {
    const reg = registry[service];
    const registered: ServiceManifestEntry['registered'] = !reg
      ? 'unknown'
      : reg.actions.length > 0
        ? 'actions'
        : 'declared';
    const credentials: ServiceManifestCredential[] = (reg?.credentials ?? []).map((c) => ({
      envVar: c.envVar,
      required: c.required,
      present: Boolean(env[c.envVar]),
      description: c.description,
    }));
    const missingRequired = credentials.filter((c) => c.required && !c.present);
    const backend = reg?.backend ?? 'unknown';
    const entry: ServiceManifestEntry = {
      service,
      invokedBy: [...(invokedBy.get(service) ?? [])].sort(),
      registered,
      backend,
      credentials,
      configured: missingRequired.length === 0,
    };
    entries.push(entry);

    if (registered === 'unknown') {
      findings.push(
        `service '${service}' (invoked by ${entry.invokedBy.join(', ')}) is not in the services registry — register it or add it to DECLARED_SERVICES`,
      );
    }
    if (missingRequired.length > 0) {
      findings.push(
        `service '${service}' is missing required credentials: ${missingRequired.map((c) => c.envVar).join(', ')} — calls will be mock-satisfied in dev and FAIL in production`,
      );
    }
    if (backend === 'simulated') {
      findings.push(
        `service '${service}' runs on a SIMULATED in-memory backend — green runs prove nothing about a real provider`,
      );
    }
  }

  return { entries, findings };
}
