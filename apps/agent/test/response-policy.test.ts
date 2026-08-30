import { describe, expect, it } from "vitest";
import {
  requestContainsSecretConfiguration,
  sanitizedConfigurationResponse,
} from "../src/response-policy.js";

describe("response policy", () => {
  it("removes provider credentials before configuration reaches a browser", async () => {
    const response = new Response(
      JSON.stringify({
        providers: [
          {
            id: "synthetic",
            key: "secret-value",
            options: {
              apiKey: "another-secret",
              baseURL: "https://provider.example.invalid/v1",
              headers: { Authorization: "Bearer secret" },
            },
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
    const body = await sanitizedConfigurationResponse(
      "/config/providers",
      response,
    );
    expect(JSON.parse(Buffer.from(body!).toString("utf8"))).toEqual({
      providers: [
        {
          id: "synthetic",
          options: { baseURL: "https://provider.example.invalid/v1" },
        },
      ],
    });
  });

  it("leaves non-configuration responses streaming", async () => {
    const response = new Response("{}", {
      headers: { "content-type": "application/json" },
    });
    await expect(
      sanitizedConfigurationResponse("/provider", response),
    ).resolves.toBeNull();
  });

  it("rejects secret-bearing configuration writes", () => {
    expect(
      requestContainsSecretConfiguration(
        "/config",
        Buffer.from(JSON.stringify({ provider: { options: { apiKey: "x" } } })),
      ),
    ).toBe(true);
    expect(
      requestContainsSecretConfiguration(
        "/config",
        Buffer.from(JSON.stringify({ model: "synthetic/model" })),
      ),
    ).toBe(false);
  });
});
