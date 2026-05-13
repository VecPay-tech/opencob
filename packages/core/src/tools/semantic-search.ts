import type { Tool, ToolResult } from './types.js';
import type { RAGPipeline } from '../indexer/rag-pipeline.js';

/** Creates the semantic_search tool for RAG-powered code retrieval */
export function createSemanticSearchTool(ragPipeline: RAGPipeline): Tool {
  return {
    name: 'semantic_search',
    group: 'read',
    description:
      'Search the workspace for code relevant to a natural language query. Uses semantic similarity to find related code, even when exact keywords differ. Best for understanding context, finding related functions, or locating code by concept.',
    parameters: [
      {
        name: 'query',
        type: 'string',
        description: 'Natural language description of the code you are looking for',
        required: true,
      },
      {
        name: 'topK',
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const query = params.query as string;
      if (!query) {
        return { success: false, content: 'Missing required parameter: query' };
      }

      const topK = (params.topK as number) ?? 10;
      const results = ragPipeline.retrieve(query, { topK });

      if (results.length === 0) {
        return {
          success: true,
          content: 'No relevant code found for the given query.',
        };
      }

      const output = results
        .map(
          (r, i) =>
            `### Result ${i + 1} — ${r.filePath} (L${r.startLine}–L${r.endLine}) [score: ${r.score.toFixed(3)}]\n\`\`\`\n${r.content}\n\`\`\``,
        )
        .join('\n\n');

      return {
        success: true,
        content: output,
        metadata: { resultCount: results.length },
      };
    },
  };
}
