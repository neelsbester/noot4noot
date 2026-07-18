import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { GameError } from "./domain/errors";

const keySets = new Map<string, JWTVerifyGetKey>();

export interface AccessIdentity {
  email: string | null;
  serviceTokenClientId: string | null;
}

export function isAdminIdentity(
  identity: AccessIdentity,
  adminEmail: string,
  environment: string,
  automationClientId: string,
): boolean {
  if (identity.email?.toLocaleLowerCase() === adminEmail.toLocaleLowerCase()) return true;
  return environment === "staging"
    && Boolean(automationClientId)
    && identity.serviceTokenClientId === automationClientId;
}

export async function requireAccessIdentity(
  request: Request,
  teamDomain: string,
  audienceList: string,
  getKey?: JWTVerifyGetKey,
): Promise<AccessIdentity> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  const domain = normalizeTeamDomain(teamDomain);
  const audiences = audienceList.split(",").map((value) => value.trim()).filter(Boolean);
  if (!token || !domain || audiences.length === 0) {
    throw new GameError("Owner access is required", "admin_required", 403);
  }
  try {
    const keys = getKey ?? remoteKeys(domain);
    const { payload } = await jwtVerify(token, keys, {
      issuer: domain,
      audience: audiences,
      algorithms: ["RS256"],
    });
    if (payload.type !== "app") throw new Error("Access token is not an application token");
    const email = typeof payload.email === "string" && payload.email ? payload.email : null;
    const commonName = typeof payload.common_name === "string" && payload.common_name
      ? payload.common_name
      : null;
    if (email && typeof payload.sub === "string" && payload.sub && !commonName) {
      return { email, serviceTokenClientId: null };
    }
    if (!email && payload.sub === "" && commonName) {
      return { email: null, serviceTokenClientId: commonName };
    }
    throw new Error("Access token contains an ambiguous identity");
  } catch {
    throw new GameError("Owner access is required", "admin_required", 403);
  }
}

function normalizeTeamDomain(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (!/^https:\/\/[A-Za-z0-9-]+\.cloudflareaccess\.com$/u.test(trimmed)) return "";
  return trimmed;
}

function remoteKeys(domain: string): JWTVerifyGetKey {
  const existing = keySets.get(domain);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`));
  keySets.set(domain, created);
  return created;
}
