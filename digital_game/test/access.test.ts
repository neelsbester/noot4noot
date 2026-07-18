import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { isAdminIdentity, requireAccessIdentity } from "../src/access";

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
      .setSubject("owner-identity")
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
    expect(identity.serviceTokenClientId).toBeNull();
  });

  it("accepts a signed service token identity without treating it as an email", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-key";
    const issuer = "https://noot4noot-test.cloudflareaccess.com";
    const audience = "test-audience";
    const token = await new SignJWT({
      common_name: "staging-smoke.access",
      sub: "",
      type: "app",
    })
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
    expect(identity.email).toBeNull();
    expect(identity.serviceTokenClientId).toBe("staging-smoke.access");
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
      .setSubject("owner-identity")
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

  it.each([
    {
      name: "a common name paired with a user subject",
      payload: { common_name: "staging-smoke.access", sub: "user-id", type: "app" },
    },
    {
      name: "mixed email and service-token claims",
      payload: {
        common_name: "staging-smoke.access",
        email: "owner@example.com",
        sub: "",
        type: "app",
      },
    },
  ])("rejects $name", async ({ payload }) => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-key";
    const issuer = "https://noot4noot-test.cloudflareaccess.com";
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("test-audience")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const request = new Request("https://example.test/admin", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    await expect(requireAccessIdentity(
      request,
      issuer,
      "test-audience",
      createLocalJWKSet({ keys: [publicJwk] }),
    )).rejects.toMatchObject({ code: "admin_required", status: 403 });
  });

  it("limits the configured service identity to staging", () => {
    const serviceIdentity = {
      email: null,
      serviceTokenClientId: "staging-smoke.access",
    };
    expect(isAdminIdentity(
      serviceIdentity,
      "owner@example.com",
      "staging",
      "staging-smoke.access",
    )).toBe(true);
    expect(isAdminIdentity(
      serviceIdentity,
      "owner@example.com",
      "production",
      "staging-smoke.access",
    )).toBe(false);
    expect(isAdminIdentity(
      serviceIdentity,
      "owner@example.com",
      "staging",
      "another-token.access",
    )).toBe(false);
    expect(isAdminIdentity(
      { email: "OWNER@example.com", serviceTokenClientId: null },
      "owner@example.com",
      "production",
      "",
    )).toBe(true);
  });
});
