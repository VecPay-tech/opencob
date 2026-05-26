import type { Tool, ToolResult } from './types.js';

export interface TodoItem {
  id: number;
  title: string;
  status: 'not-started' | 'in-progress' | 'completed';
}

/** Creates the manage_todo tool for in-conversation task tracking */
export function createManageTodoTool(): Tool {
  const todos: TodoItem[] = [];
  let nextId = 1;

  return {
    name: 'manage_todo',
    group: 'meta', // no file access needed
    description:
      'Manage an in-conversation task list. Add, update, or list todo items to track multi-step work.',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action to perform: "add", "update", or "list"',
        required: true,
      },
      {
        name: 'title',
        type: 'string',
        description: 'Title of the todo item (required for "add")',
        required: false,
      },
      {
        name: 'id',
        type: 'number',
        description: 'ID of the todo item (required for "update")',
        required: false,
      },
      {
        name: 'status',
        type: 'string',
        description: 'New status for "update": "not-started", "in-progress", or "completed"',
        required: false,
      },
    ],
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string;

      switch (action) {
        case 'add': {
          const title = params.title as string;
          if (!title) {
            return { success: false, content: 'Missing required parameter: title' };
          }
          const item: TodoItem = { id: nextId++, title, status: 'not-started' };
          todos.push(item);
          return {
            success: true,
            content: `Added todo #${item.id}: "${item.title}"`,
            metadata: { item },
          };
        }

        case 'update': {
          const id = params.id as number;
          const status = params.status as TodoItem['status'];
          if (!id) return { success: false, content: 'Missing required parameter: id' };
          if (!status) return { success: false, content: 'Missing required parameter: status' };

          const item = todos.find((t) => t.id === id);
          if (!item) return { success: false, content: `Todo #${id} not found.` };

          item.status = status;
          return {
            success: true,
            content: `Updated todo #${id} to "${status}"`,
            metadata: { item },
          };
        }

        case 'list': {
          if (todos.length === 0) {
            return { success: true, content: 'No todo items.' };
          }
          const statusIcon: Record<string, string> = {
            'not-started': '⬜',
            'in-progress': '🔄',
            completed: '✅',
          };
          const lines = todos.map(
            (t) => `${statusIcon[t.status]} #${t.id}: ${t.title} [${t.status}]`,
          );
          return {
            success: true,
            content: `## Todo List\n${lines.join('\n')}`,
            metadata: { count: todos.length },
          };
        }

        default:
          return {
            success: false,
            content: `Unknown action: "${action}". Use "add", "update", or "list".`,
          };
      }
    },
  };
}
