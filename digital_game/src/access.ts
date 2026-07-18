import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { GameError } from "./domain/errors";

const keySets = new Map<string, JWTVerifyGetKey>();

export interface AccessIdentity {
  email: string;
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
    if (payload.type !== "app" || typeof payload.email !== "string" || !payload.email) {
      throw new Error("Access token does not contain a user identity");
    }
    return { email: payload.email };
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
