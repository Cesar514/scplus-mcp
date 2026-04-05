// Structured chat retries malformed provider JSON with an explicit repair round
// FEATURE: Real-provider JSON repair coverage for cluster and research chat flows

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function createOpenAIResponse(content) {
  return {
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content,
            },
          },
        ],
      };
    },
  };
}

describe("generateStructuredChat", () => {
  it("repairs malformed JSON from the provider before failing the request", async () => {
    const originalProvider = process.env.SCPLUS_CHAT_PROVIDER;
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalFetch = global.fetch;
    process.env.SCPLUS_CHAT_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key";

    const requests = [];
    global.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) {
        return createOpenAIResponse("I can help with that.");
      }
      return createOpenAIResponse('{"clusters":[{"label":"Gameplay Systems","overarchingTheme":"Shared gameplay systems.","distinguishingFeature":"State transitions and timers."} {"label":"UI Surfaces","overarchingTheme":"UI surfaces for play.","distinguishingFeature":"HUD and menus."}]}');
    };

    try {
      const moduleUrl = `${pathToFileURL(join(process.cwd(), "build", "core", "chat.js")).href}?repair-test=${Date.now()}`;
      const { generateStructuredChat } = await import(moduleUrl);
      const result = await generateStructuredChat({
        system: "Return strict JSON only.",
        prompt: JSON.stringify({
          task: "semantic-cluster-descriptors",
          requiredClusterCount: 2,
        }),
        mock: () => {
          throw new Error("mock provider should not be used in this test");
        },
      });

      assert.equal(requests.length, 2);
      assert.deepEqual(result, {
        clusters: [
          {
            label: "Gameplay Systems",
            overarchingTheme: "Shared gameplay systems.",
            distinguishingFeature: "State transitions and timers.",
          },
          {
            label: "UI Surfaces",
            overarchingTheme: "UI surfaces for play.",
            distinguishingFeature: "HUD and menus.",
          },
        ],
      });
      assert.match(requests[1].messages[0].content, /previous response was invalid json/i);
      assert.match(requests[1].messages[1].content, /repair-invalid-json/);
      assert.match(requests[1].messages[1].content, /invalidResponse/);
    } finally {
      global.fetch = originalFetch;
      if (originalProvider === undefined) delete process.env.SCPLUS_CHAT_PROVIDER;
      else process.env.SCPLUS_CHAT_PROVIDER = originalProvider;
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
    }
  });
});
