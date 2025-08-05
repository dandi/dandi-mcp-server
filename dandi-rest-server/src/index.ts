#!/usr/bin/env node

/**
 * DANDI Archive MCP Server
 * 
 * This MCP server provides comprehensive access to the DANDI Archive REST API,
 * allowing users to interact with dandisets, assets, versions, and other resources
 * in the BRAIN Initiative archive for cellular neurophysiology data.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance, AxiosError } from "axios";

// DANDI API configuration
const DANDI_API_BASE_URL = "https://api.dandiarchive.org/api";
const DANDI_API_TOKEN = process.env.DANDI_API_TOKEN; // Optional authentication token

// Type definitions for DANDI API responses
interface DandisetSummary {
  identifier: string;
  created: string;
  modified: string;
  contact_person: string;
  embargo_status: "EMBARGOED" | "UNEMBARGOING" | "OPEN";
  star_count: string;
  is_starred: string;
  most_recent_published_version?: VersionSummary;
  draft_version?: VersionSummary;
}

interface VersionSummary {
  version: string;
  name: string;
  asset_count: number;
  size: number;
  status: "Pending" | "Validating" | "Valid" | "Invalid" | "Publishing" | "Published";
  created: string;
  modified: string;
}

interface AssetSummary {
  asset_id: string;
  blob?: string;
  zarr?: string;
  path: string;
  size: string;
  created: string;
  modified: string;
  metadata: any;
}

interface UserInfo {
  username: string;
  name: string;
  admin: boolean;
  status: string;
}

class DandiMcpServer {
  private server: Server;
  private axios: AxiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: "dandi-mcp",
        version: "0.1.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    // Configure axios instance
    this.axios = axios.create({
      baseURL: DANDI_API_BASE_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        ...(DANDI_API_TOKEN && { 'Authorization': `token ${DANDI_API_TOKEN}` }),
      },
    });

    this.setupResourceHandlers();
    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupResourceHandlers() {
    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: "dandi://info",
          name: "DANDI Archive Information",
          mimeType: "application/json",
          description: "General information about the DANDI Archive API",
        },
        {
          uri: "dandi://stats",
          name: "DANDI Archive Statistics",
          mimeType: "application/json", 
          description: "Statistics about the DANDI Archive",
        },
        {
          uri: "dandi://dandisets",
          name: "All Dandisets",
          mimeType: "application/json",
          description: "List of all available dandisets",
        },
      ],
    }));

    // Handle resource reading
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const url = new URL(request.params.uri);
      
      try {
        switch (url.pathname) {
          case '/info':
            const infoResponse = await this.axios.get('/info/');
            return {
              contents: [{
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify(infoResponse.data, null, 2),
              }],
            };

          case '/stats':
            const statsResponse = await this.axios.get('/stats/');
            return {
              contents: [{
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify(statsResponse.data, null, 2),
              }],
            };

          case '/dandisets':
            const dandisetsResponse = await this.axios.get('/dandisets/');
            return {
              contents: [{
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify(dandisetsResponse.data, null, 2),
              }],
            };

          default:
            throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${request.params.uri}`);
        }
      } catch (error) {
        throw this.handleAxiosError(error);
      }
    });
  }

  private setupToolHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // Dandiset operations
        {
          name: "list_dandisets",
          description: "List dandisets with optional filtering and pagination",
          inputSchema: {
            type: "object",
            properties: {
              page: { type: "number", description: "Page number" },
              page_size: { type: "number", description: "Number of results per page (max 1000)" },
              ordering: { type: "string", description: "Field to order by (id, name, modified, size, stars)" },
              draft: { type: "boolean", description: "Include draft-only dandisets", default: true },
              empty: { type: "boolean", description: "Include empty dandisets", default: true },
              embargoed: { type: "boolean", description: "Include embargoed dandisets", default: false },
              user: { type: "string", description: "Set to 'me' for current user's dandisets" },
              starred: { type: "boolean", description: "Only starred dandisets", default: false },
              search: { type: "string", description: "Search terms to filter results" },
            },
          },
        },
        {
          name: "get_dandiset",
          description: "Get details of a specific dandiset",
          inputSchema: {
            type: "object",
            properties: {
              dandiset_id: { type: "string", description: "Dandiset identifier (6 digits)" },
            },
            required: ["dandiset_id"],
          },
        },
        {
          name: "create_dandiset",
          description: "Create a new dandiset",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Name of the dandiset" },
              metadata: { type: "object", description: "Metadata for the dandiset" },
              embargo: { type: "boolean", description: "Whether to embargo the dandiset", default: false },
            },
            required: ["name"],
          },
        },
        {
          name: "delete_dandiset",
          description: "Delete a dandiset (only dandisets without published versions)",
          inputSchema: {
            type: "object",
            properties: {
              dandiset_id: { type: "string", description: "Dandiset identifier" },
            },
            required: ["dandiset_id"],
          },
        },
        {
          name: "star_dandiset",
          description: "Star or unstar a dandiset",
          inputSchema: {
            type: "object",
            properties: {
              dandiset_id: { type: "string", description: "Dandiset identifier" },
              star: { type: "boolean", description: "True to star, false to unstar" },
            },
            required: ["dandiset_id", "star"],
          },
        },
        // Version operations
        {
          name: "list_versions",
          description: "List versions of a dandiset",
          inputSchema: {
            type: "object",
            properties: {
              dandiset_id: { type: "string", description: "Dandiset identifier" },
              page: { type: "number", description: "Page number" },
              page_size: { type: "number", description: "Number of results per page" },
            },
            required: ["dandiset_id"],
          },
        },
        {
          name: "get_version",
          description: "Get details of a specific version",
          inputSchema: {
            type: "object",
            properties: {
              dandiset_id: { type: "string", description: "Dandiset identifier" },
              version: { type: "string", description: "Version identifier (e.g., 'draft' or '0.230101.1234')" },
            },
            required: ["dandiset_id", "version"],
          },
        },
        {
          name: "update_version",
          description: "Update metadata of a version",
          inputSchema: {
            type: "object",
            properties: {
              dandiset_id: { type: "string", description: "Dandiset identifier" },
              version: { type: "string", description: "Version identifier" },
              name: { type: "string", description: "New name for the version" },
              metadata: { type: "object", description: "Updated metadata" },
            },
            required: ["dandiset_id", "version"],
          },
        },
        {
          name: "publish_version",
          description: "Publish a draft version",
          inputSchema: {
            type: "object",
            properties: {
              dandiset_id: { type: "string", description: "Dandiset identifier" },
              version: { type: "string", description: "Version identifier (typically 'draft')" },
            },
            required: ["dandiset_id", "version"],
          },
        },
        // Asset operations
        {
          name: "list_assets",
          description: "List assets in a version",
          inputSchema: {
            type: "object",
            properties: {
              dandiset_id: { type: "string", description: "Dandiset identifier" },
              version: { type: "string", description: "Version identifier" },
              page: { type: "number", description: "Page number" },
              page_size: { type: "number", description: "Number of results per page" },
              glob: { type: "string", description: "Glob pattern to filter files" },
              metadata: { type: "boolean", description: "Include metadata", default: false },
              zarr: { type: "boolean", description: "Include zarr assets", default: false },
            },
            required: ["dandiset_id", "version"],
          },
        },
        {
          name: "get_asset",
          description: "Get metadata of a specific asset",
          inputSchema: {
            type: "object",
            properties: {
              asset_id: { type: "string", description: "Asset identifier (UUID)" },
            },
            required: ["asset_id"],
          },
        },
        {
          name: "get_asset_download_url",
          description: "Get download URL for an asset",
          inputSchema: {
            type: "object",
            properties: {
              asset_id: { type: "string", description: "Asset identifier (UUID)" },
              content_disposition: { 
                type: "string", 
                description: "Content disposition (attachment or inline)",
                enum: ["attachment", "inline"],
                default: "attachment"
              },
            },
            required: ["asset_id"],
          },
        },
        {
          name: "get_asset_validation",
          description: "Get validation errors for an asset",
          inputSchema: {
            type: "object",
            properties: {
              dandiset_id: { type: "string", description: "Dandiset identifier" },
              version: { type: "string", description: "Version identifier" },
              asset_id: { type: "string", description: "Asset identifier" },
            },
            required: ["dandiset_id", "version", "asset_id"],
          },
        },
        // User operations
        {
          name: "get_current_user",
          description: "Get information about the currently authenticated user",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "search_users",
          description: "Search for users by username",
          inputSchema: {
            type: "object",
            properties: {
              username: { type: "string", description: "Username to search for" },
            },
            required: ["username"],
          },
        },
        // Utility operations
        {
          name: "get_info",
          description: "Get DANDI Archive API information",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "get_stats",
          description: "Get DANDI Archive statistics",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case "list_dandisets":
            return await this.listDandisets(request.params.arguments);

          case "get_dandiset":
            return await this.getDandiset(request.params.arguments);

          case "create_dandiset":
            return await this.createDandiset(request.params.arguments);

          case "delete_dandiset":
            return await this.deleteDandiset(request.params.arguments);

          case "star_dandiset":
            return await this.starDandiset(request.params.arguments);

          case "list_versions":
            return await this.listVersions(request.params.arguments);

          case "get_version":
            return await this.getVersion(request.params.arguments);

          case "update_version":
            return await this.updateVersion(request.params.arguments);

          case "publish_version":
            return await this.publishVersion(request.params.arguments);

          case "list_assets":
            return await this.listAssets(request.params.arguments);

          case "get_asset":
            return await this.getAsset(request.params.arguments);

          case "get_asset_download_url":
            return await this.getAssetDownloadUrl(request.params.arguments);

          case "get_asset_validation":
            return await this.getAssetValidation(request.params.arguments);

          case "get_current_user":
            return await this.getCurrentUser();

          case "search_users":
            return await this.searchUsers(request.params.arguments);

          case "get_info":
            return await this.getInfo();

          case "get_stats":
            return await this.getStats();

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        throw this.handleAxiosError(error);
      }
    });
  }

  // Tool implementation methods
  private async listDandisets(args: any) {
    const params = new URLSearchParams();
    
    if (args?.page) params.append('page', String(args.page));
    if (args?.page_size) params.append('page_size', String(args.page_size));
    if (args?.ordering) params.append('ordering', args.ordering);
    if (args?.draft !== undefined) params.append('draft', String(args.draft));
    if (args?.empty !== undefined) params.append('empty', String(args.empty));
    if (args?.embargoed !== undefined) params.append('embargoed', String(args.embargoed));
    if (args?.user) params.append('user', args.user);
    if (args?.starred !== undefined) params.append('starred', String(args.starred));
    if (args?.search) params.append('search', args.search);

    const response = await this.axios.get(`/dandisets/?${params.toString()}`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getDandiset(args: any) {
    const { dandiset_id } = args;
    const response = await this.axios.get(`/dandisets/${dandiset_id}/`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async createDandiset(args: any) {
    const { name, metadata = {}, embargo = false } = args;
    const params = embargo ? '?embargo=true' : '';
    
    const response = await this.axios.post(`/dandisets/${params}`, {
      name,
      metadata,
    });
    
    return {
      content: [{
        type: "text",
        text: `Successfully created dandiset: ${JSON.stringify(response.data, null, 2)}`,
      }],
    };
  }

  private async deleteDandiset(args: any) {
    const { dandiset_id } = args;
    await this.axios.delete(`/dandisets/${dandiset_id}/`);
    
    return {
      content: [{
        type: "text",
        text: `Successfully deleted dandiset ${dandiset_id}`,
      }],
    };
  }

  private async starDandiset(args: any) {
    const { dandiset_id, star } = args;
    
    if (star) {
      await this.axios.post(`/dandisets/${dandiset_id}/star/`);
      return {
        content: [{
          type: "text",
          text: `Successfully starred dandiset ${dandiset_id}`,
        }],
      };
    } else {
      await this.axios.delete(`/dandisets/${dandiset_id}/star/`);
      return {
        content: [{
          type: "text",
          text: `Successfully unstarred dandiset ${dandiset_id}`,
        }],
      };
    }
  }

  private async listVersions(args: any) {
    const { dandiset_id, page, page_size } = args;
    const params = new URLSearchParams();
    
    if (page) params.append('page', String(page));
    if (page_size) params.append('page_size', String(page_size));

    const response = await this.axios.get(`/dandisets/${dandiset_id}/versions/?${params.toString()}`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getVersion(args: any) {
    const { dandiset_id, version } = args;
    const response = await this.axios.get(`/dandisets/${dandiset_id}/versions/${version}/`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async updateVersion(args: any) {
    const { dandiset_id, version, name, metadata } = args;
    const updateData: any = {};
    
    if (name) updateData.name = name;
    if (metadata) updateData.metadata = metadata;

    const response = await this.axios.put(`/dandisets/${dandiset_id}/versions/${version}/`, updateData);
    
    return {
      content: [{
        type: "text",
        text: `Successfully updated version: ${JSON.stringify(response.data, null, 2)}`,
      }],
    };
  }

  private async publishVersion(args: any) {
    const { dandiset_id, version } = args;
    const response = await this.axios.post(`/dandisets/${dandiset_id}/versions/${version}/publish/`);
    
    return {
      content: [{
        type: "text",
        text: `Successfully published version: ${JSON.stringify(response.data, null, 2)}`,
      }],
    };
  }

  private async listAssets(args: any) {
    const { dandiset_id, version, page, page_size, glob, metadata = false, zarr = false } = args;
    const params = new URLSearchParams();
    
    if (page) params.append('page', String(page));
    if (page_size) params.append('page_size', String(page_size));
    if (glob) params.append('glob', glob);
    if (metadata) params.append('metadata', String(metadata));
    if (zarr) params.append('zarr', String(zarr));

    const response = await this.axios.get(`/dandisets/${dandiset_id}/versions/${version}/assets/?${params.toString()}`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getAsset(args: any) {
    const { asset_id } = args;
    const response = await this.axios.get(`/assets/${asset_id}/`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getAssetDownloadUrl(args: any) {
    const { asset_id, content_disposition = "attachment" } = args;
    const params = new URLSearchParams();
    params.append('content_disposition', content_disposition);

    const response = await this.axios.get(`/assets/${asset_id}/download/?${params.toString()}`, {
      maxRedirects: 0,
      validateStatus: (status) => status === 301,
    });
    
    const downloadUrl = response.headers.location;
    
    return {
      content: [{
        type: "text",
        text: `Download URL: ${downloadUrl}`,
      }],
    };
  }

  private async getAssetValidation(args: any) {
    const { dandiset_id, version, asset_id } = args;
    const response = await this.axios.get(`/dandisets/${dandiset_id}/versions/${version}/assets/${asset_id}/validation/`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getCurrentUser() {
    const response = await this.axios.get('/users/me/');
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async searchUsers(args: any) {
    const { username } = args;
    const params = new URLSearchParams();
    params.append('username', username);

    const response = await this.axios.get(`/users/search/?${params.toString()}`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getInfo() {
    const response = await this.axios.get('/info/');
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getStats() {
    const response = await this.axios.get('/stats/');
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  // Error handling helper
  private handleAxiosError(error: any): McpError {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const message = error.response?.data?.detail || error.response?.data?.message || error.message;
      
      switch (status) {
        case 400:
          return new McpError(ErrorCode.InvalidParams, `Bad Request: ${message}`);
        case 401:
          return new McpError(ErrorCode.InvalidRequest, `Unauthorized: ${message}. Make sure DANDI_API_TOKEN is set if authentication is required.`);
        case 403:
          return new McpError(ErrorCode.InvalidRequest, `Forbidden: ${message}`);
        case 404:
          return new McpError(ErrorCode.InvalidRequest, `Not Found: ${message}`);
        case 409:
          return new McpError(ErrorCode.InvalidRequest, `Conflict: ${message}`);
        default:
          return new McpError(ErrorCode.InternalError, `DANDI API Error: ${message}`);
      }
    }
    
    return new McpError(ErrorCode.InternalError, `Unknown error: ${error}`);
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('DANDI MCP server running on stdio');
  }
}

const server = new DandiMcpServer();
server.run().catch(console.error);
