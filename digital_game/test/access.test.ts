import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { requireAccessIdentity } from "../src/access";

describe("Cloudflare Access identity validation", () => {
  it("accepts a signed application token for the configured issuer and audience", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-key";
    const issuer = "https://noot4noot-test.cloudflareaccess.com";
    const audience = "test-audience";
    const token = await new SignJWT({ email: "owner@example.com", type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const request = new Request("https://example.test/admin", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    const identity = await requireAccessIdentity(
      request,
      issuer,
      audience,
      createLocalJWKSet({ keys: [publicJwk] }),
    );
    expect(identity.email).toBe("owner@example.com");
  });

  it("rejects a correctly signed token for another application", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-key";
    const issuer = "https://noot4noot-test.cloudflareaccess.com";
    const token = await new SignJWT({ email: "owner@example.com", type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("other-audience")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const request = new Request("https://example.test/admin", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    await expect(requireAccessIdentity(
      request,
      issuer,
      "expected-audience",
      createLocalJWKSet({ keys: [publicJwk] }),
    )).rejects.toMatchObject({ code: "admin_required", status: 403 });
  });
});
