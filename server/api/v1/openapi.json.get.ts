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
    }
  }
}))
