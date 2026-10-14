// Hand-maintained OpenAPI description of the public v1 API.
export default defineEventHandler(() => ({
  openapi: '3.1.0',
  info: {
    title: 'opencode web API',
    version: '1',
    description:
      'Stable REST API wrapping an opencode server. All endpoints accept an optional `directory` to scope to a project. If the server sets NUXT_API_TOKEN, send `Authorization: Bearer <token>`. An MCP (Streamable HTTP) endpoint with the same capabilities lives at POST /mcp.'
  },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    parameters: {
      directory: {
        name: 'directory',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Absolute project directory on the opencode server'
      },
      id: { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
    }
  },
  security: [{ bearer: [] }],
  paths: {
    '/api/v1/projects': {
      get: { summary: 'List known projects', responses: { 200: { description: 'Project[]' } } }
    },
    '/api/v1/models': {
      get: {
        summary: 'List providers and models',
        parameters: [{ $ref: '#/components/parameters/directory' }],
        responses: { 200: { description: '{ providers, default }' } }
      }
    },
    '/api/v1/agents': {
      get: {
        summary: 'List agents',
        parameters: [{ $ref: '#/components/parameters/directory' }],
        responses: { 200: { description: 'Agent[]' } }
      }
    },
    '/api/v1/mcp': {
      get: {
        summary: 'MCP server status for a project',
        parameters: [{ $ref: '#/components/parameters/directory' }],
        responses: { 200: { description: '{ [name]: status }' } }
      }
    },
    '/api/v1/sessions': {
      get: {
        summary: 'List sessions',
        parameters: [{ $ref: '#/components/parameters/directory' }],
        responses: { 200: { description: 'Session[]' } }
      },
      post: {
        summary: 'Create a session',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { directory: { type: 'string' }, title: { type: 'string' } }
              }
            }
          }
        },
        responses: { 200: { description: 'Session' } }
      }
    },
    '/api/v1/sessions/{id}': {
      delete: {
        summary: 'Delete a session',
        parameters: [
          { $ref: '#/components/parameters/id' },
          { $ref: '#/components/parameters/directory' }
        ],
        responses: { 200: { description: 'true' } }
      }
    },
    '/api/v1/sessions/{id}/messages': {
      get: {
        summary: 'List messages (info + parts)',
        parameters: [
          { $ref: '#/components/parameters/id' },
          { $ref: '#/components/parameters/directory' }
        ],
        responses: { 200: { description: '{ info, parts }[]' } }
      }
    },
    '/api/v1/sessions/{id}/prompt': {
      post: {
        summary: 'Send a prompt and wait for the full reply',
        parameters: [{ $ref: '#/components/parameters/id' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['text'],
                properties: {
                  directory: { type: 'string' },
                  text: { type: 'string' },
                  model: {
                    type: 'object',
                    properties: { providerID: { type: 'string' }, modelID: { type: 'string' } }
                  },
                  agent: { type: 'string' },
                  variant: { type: 'string', description: 'think level: none|low|medium|high|xhigh' },
                  tools: { type: 'object', additionalProperties: { type: 'boolean' } }
                }
              }
            }
          }
        },
        responses: { 200: { description: '{ sessionID, text, message }' } }
      }
    },
    '/api/v1/sessions/{id}/abort': {
      post: {
        summary: 'Abort a running session',
        parameters: [
          { $ref: '#/components/parameters/id' },
          { $ref: '#/components/parameters/directory' }
        ],
        responses: { 200: { description: 'true' } }
      }
    },
    '/api/v1/status': {
      get: {
        summary: 'Overview: opencode version/protocol, capabilities, busy sessions, schedules, last reload, control MCP, server time zone',
        parameters: [{ $ref: '#/components/parameters/directory' }],
        responses: { 200: { description: '{ opencode, capabilities, busy, schedules, reload, control, time }' } }
      }
    },
    '/api/v1/reload': {
      get: { summary: 'State of the last config reload', responses: { 200: { description: 'ReloadState | null' } } },
      post: {
        summary: 'Make opencode re-read its config (one project or all); waits for idle sessions by default',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  scope: { type: 'string', enum: ['project', 'all'] },
                  directory: { type: 'string' },
                  when: { type: 'string', enum: ['idle', 'now'] }
                }
              }
            }
          }
        },
        responses: { 200: { description: 'ReloadState' }, 501: { description: 'v2 servers cannot reload' } }
      }
    },
    '/api/v1/mcp-server': {
      get: {
        summary: 'One MCP server: config (secrets redacted), where it is defined, status and a fix for errors',
        parameters: [
          { name: 'name', in: 'query', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/directory' }
        ],
        responses: { 200: { description: '{ name, definedIn, config, status, hint }' } }
      },
      put: {
        summary: 'Create or update an MCP server and reconnect it; "***" values keep the stored secret',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'config'],
                properties: {
                  name: { type: 'string' },
                  scope: { type: 'string', enum: ['project', 'global'] },
                  directory: { type: 'string' },
                  config: { type: 'object' }
                }
              }
            }
          }
        },
        responses: { 200: { description: '{ name, scope, config, status, hint }' } }
      }
    },
    '/api/v1/mcp-test': {
      post: {
        summary: 'Test an MCP server (stored by name, or an edited config) without saving: step log, tools with parameters, resources, prompts',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' }, directory: { type: 'string' }, config: { type: 'object' } }
              }
            }
          }
        },
        responses: { 200: { description: 'McpInspectResult' } }
      }
    },
    '/api/v1/control-mcp': {
      get: { summary: 'Is this app\'s MCP server registered with opencode (agent control)?', responses: { 200: { description: '{ installed, enabled, url, suggestedUrl }' } } },
      post: {
        summary: 'Register this app\'s MCP server in opencode\'s global config so chats can manage opencode',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, enabled: { type: 'boolean' } } } } }
        },
        responses: { 200: { description: 'save result with status' } }
      }
    },
    '/api/v1/mcp-nest': {
      get: { summary: 'Subagent per MCP: settings, one specialist per global MCP server, the orchestrator prompt and the agents that would be written', responses: { 200: { description: 'NestPlan' } } },
      put: {
        summary: 'Change the subagent-per-MCP settings and write the agents into the global opencode config',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  summaries: { type: 'object', additionalProperties: { type: 'string' } },
                  exclude: { type: 'array', items: { type: 'string' } },
                  instructions: { type: 'string' },
                  orchestrator: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { 200: { description: 'NestPlan plus { changed }' } }
      }
    },
    '/api/v1/schedules': {
      get: {
        summary: 'List scheduled prompts',
        parameters: [{ $ref: '#/components/parameters/directory' }],
        responses: { 200: { description: 'Schedule[]' } }
      },
      post: {
        summary: 'Create a scheduled prompt (5-field cron in the server time zone)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'directory', 'prompt', 'cron'],
                properties: {
                  name: { type: 'string' },
                  directory: { type: 'string' },
                  prompt: { type: 'string' },
                  cron: { type: 'string', description: 'e.g. "0 8 * * 1-5" or @daily' },
                  session: { type: 'string', enum: ['new', 'reuse'] },
                  model: { type: 'string', description: '"provider/model"' },
                  agent: { type: 'string' },
                  enabled: { type: 'boolean' }
                }
              }
            }
          }
        },
        responses: { 200: { description: 'Schedule' }, 400: { description: 'invalid cron or missing field' } }
      }
    },
    '/api/v1/schedules/{id}': {
      patch: {
        summary: 'Update a scheduled prompt',
        parameters: [{ $ref: '#/components/parameters/id' }],
        responses: { 200: { description: 'Schedule' } }
      },
      delete: {
        summary: 'Delete a scheduled prompt',
        parameters: [{ $ref: '#/components/parameters/id' }],
        responses: { 200: { description: 'true' } }
      }
    },
    '/api/v1/schedules/{id}/run': {
      post: {
        summary: 'Run a scheduled prompt now (answers once the prompt is sent)',
        parameters: [{ $ref: '#/components/parameters/id' }],
        responses: { 200: { description: 'ScheduleRun' } }
      }
    }
  }
}))
