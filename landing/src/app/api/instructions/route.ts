// summary: Serves the repo-authoritative Context+ instructions through a landing-site API route.
// FEATURE: Landing marketing and docs mirrors for shipped MCP tools.
// inputs: Incoming route requests and the repo-local INSTRUCTIONS.md source file.
// outputs: HTTP responses containing the current instruction markdown payload.
import { readFile } from "fs/promises";
import { NextResponse } from "next/server";

async function getInstructionsText(): Promise<string> {
  return readFile(new URL("../../../../../INSTRUCTIONS.md", import.meta.url), "utf8");
}

export async function GET() {
  return new NextResponse(await getInstructionsText(), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
