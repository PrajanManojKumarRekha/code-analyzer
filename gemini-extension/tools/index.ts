// gemini-extension/tools/index.ts
// This file demonstrates how repoIndex and lazyFileReader register
// as tools inside gemini-cli's extension model.
// In a full integration this would be inside packages/core/src/tools/index.ts

export const repoIndexToolDefinition = {
  name: "repo_index",
  description:
    "Build and return a typed semantic skeleton of the target repository. " +
    "Extracts all exported TypeScript signatures using ts-morph AST analysis. " +
    "Returns full typed signatures: sendMessage(room: IRoom, msg: string): Promise<void>. " +
    "Call once at session start. Do not call again unless the repo has changed.",
  parameters: {
    type: "object",
    properties: {
      targetDir: {
        type: "string",
        description: "Absolute path to the repository root or package directory to index",
      },
      domain: {
        type: "string",
        enum: ["mobile", "front-end", "fuselage", "message-routing", "rest-api", "authentication", "data-models", "all"],
        description: "Rocket.Chat domain to scope the index to. Use 'all' for full repo.",
      },
    },
    required: ["targetDir"],
  },
};

export const lazyFileReaderToolDefinition = {
  name: "read_file",
  description:
    "Read a specific repository file on demand. Only call this when you need " +
    "implementation details not visible in the skeleton. " +
    "Use symbolsOnly=true for structural questions to save tokens. " +
    "Use lineRange=[start,end] for large files when you know which section you need.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file as shown in the skeleton",
      },
      symbolsOnly: {
        type: "boolean",
        description: "Return only exported signatures without implementation body. Saves tokens.",
      },
      maxLines: {
        type: "number",
        description: "Maximum lines to return. Default 300.",
      },
      lineRange: {
        type: "array",
        items: { type: "number" },
        minItems: 2,
        maxItems: 2,
        description: "Return only lines [start, end] inclusive. 1-indexed.",
      },
    },
    required: ["path"],
  },
};