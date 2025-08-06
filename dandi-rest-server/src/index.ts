#!/usr/bin/env node

/**
 * DANDI Archive MCP Server
 * 
 * This MCP server provides comprehensive access to the DANDI Archive REST API,
 * allowing users to interact with dandisets, assets, versions, and other resources
 * in the BRAIN Initiative archive for cellular neurophysiology data.
 * 
 * Note: All metadata modifications are performed on the "draft" version only,
 * as published versions are immutable.
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
import { GoogleGenerativeAI } from "@google/generative-ai";
import Ajv, { type ErrorObject } from "ajv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// DANDI API configuration
const DANDI_API_BASE_URL = process.env.DANDI_API_BASE_URL || "https://api.dandiarchive.org/api";
const DANDI_API_TOKEN = process.env.DANDI_API_TOKEN; // Optional authentication token

// LLM configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// Get current directory for schema files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemasDir = path.join(__dirname, "schemas");

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
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
              dandiset_id: { type: "string", description: "Dandiset identifier" },
              version: { type: "string", description: "Version identifier (e.g., 'draft' or '0.230101.1234')" },
            },
            required: ["dandiset_id", "version"],
          },
        },
        {
          name: "update_version",
          description: "Update metadata of a draft version. Note: Metadata modifications can only be done on draft versions. The 'name' field is required by the DANDI API even when only updating metadata.",
          inputSchema: {
            type: "object",
            properties: {
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
              dandiset_id: { type: "string", description: "Dandiset identifier" },
              name: { type: "string", description: "Name for the version (required by DANDI API)" },
              metadata: { type: "object", description: "Updated metadata" },
            },
            required: ["dandiset_id", "name"],
          },
        },
        {
          name: "publish_version",
          description: "Publish a draft version",
          inputSchema: {
            type: "object",
            properties: {
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
            properties: {
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
            },
          },
        },
        {
          name: "search_users",
          description: "Search for users by username",
          inputSchema: {
            type: "object",
            properties: {
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
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
            properties: {
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
            },
          },
        },
        {
          name: "get_stats",
          description: "Get DANDI Archive statistics",
          inputSchema: {
            type: "object",
            properties: {
              api_base_url: { type: "string", description: "Custom API base URL (optional)" },
            },
          },
        },
        // LLM-powered metadata enhancement
        {
          name: "enhance_dandiset_metadata",
          description: "Use LLM to enhance dandiset metadata based on text descriptions of requested modifications. Metadata modifications are always performed on the draft version. Can either fetch metadata automatically using dandiset_id or accept current_metadata directly.",
          inputSchema: {
            type: "object",
            properties: {
              api_base_url: {
                type: "string",
                description: "Custom API base URL (optional)"
              },
              dandiset_id: {
                type: "string",
                description: "Dandiset identifier (6 digits) - used to fetch draft metadata automatically"
              },
              current_metadata: {
                type: "object",
                description: "Current dandiset metadata (JSON object following DANDI schema) - alternative to fetching via dandiset_id"
              },
              modification_request: {
                type: "string",
                description: "Plain text description of requested modifications/additions to the metadata"
              },
              llm_provider: {
                type: "string",
                enum: ["gemini-flash"],
                description: "LLM provider to use for enhancement",
                default: "gemini-flash"
              }
            },
            required: ["modification_request"],
            anyOf: [
              { required: ["dandiset_id"] },
              { required: ["current_metadata"] }
            ]
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
            return await this.getCurrentUser(request.params.arguments);

          case "search_users":
            return await this.searchUsers(request.params.arguments);

          case "get_info":
            return await this.getInfo(request.params.arguments);

          case "get_stats":
            return await this.getStats(request.params.arguments);

          case "enhance_dandiset_metadata":
            return await this.enhanceDandisetMetadata(request.params.arguments);

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        throw this.handleAxiosError(error);
      }
    });
  }

  // Helper method to get axios instance with custom base URL
  private getAxiosInstance(customBaseUrl?: string): AxiosInstance {
    if (customBaseUrl) {
      // Create a new axios instance with custom base URL
      return axios.create({
        baseURL: customBaseUrl,
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          ...(DANDI_API_TOKEN && { 'Authorization': `token ${DANDI_API_TOKEN}` }),
        },
      });
    }
    // Use the default instance
    return this.axios;
  }

  // Tool implementation methods
  private async listDandisets(args: any) {
    const { api_base_url, ...otherArgs } = args || {};
    const axios = this.getAxiosInstance(api_base_url);
    const params = new URLSearchParams();
    
    if (otherArgs?.page) params.append('page', String(otherArgs.page));
    if (otherArgs?.page_size) params.append('page_size', String(otherArgs.page_size));
    if (otherArgs?.ordering) params.append('ordering', otherArgs.ordering);
    if (otherArgs?.draft !== undefined) params.append('draft', String(otherArgs.draft));
    if (otherArgs?.empty !== undefined) params.append('empty', String(otherArgs.empty));
    if (otherArgs?.embargoed !== undefined) params.append('embargoed', String(otherArgs.embargoed));
    if (otherArgs?.user) params.append('user', otherArgs.user);
    if (otherArgs?.starred !== undefined) params.append('starred', String(otherArgs.starred));
    if (otherArgs?.search) params.append('search', otherArgs.search);

    const response = await axios.get(`/dandisets/?${params.toString()}`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getDandiset(args: any) {
    const { api_base_url, dandiset_id } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const response = await axios.get(`/dandisets/${dandiset_id}/`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async createDandiset(args: any) {
    const { api_base_url, name, metadata = {}, embargo = false } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const params = embargo ? '?embargo=true' : '';
    
    const response = await axios.post(`/dandisets/${params}`, {
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
    const { api_base_url, dandiset_id } = args;
    const axios = this.getAxiosInstance(api_base_url);
    await axios.delete(`/dandisets/${dandiset_id}/`);
    
    return {
      content: [{
        type: "text",
        text: `Successfully deleted dandiset ${dandiset_id}`,
      }],
    };
  }

  private async starDandiset(args: any) {
    const { api_base_url, dandiset_id, star } = args;
    const axios = this.getAxiosInstance(api_base_url);
    
    if (star) {
      await axios.post(`/dandisets/${dandiset_id}/star/`);
      return {
        content: [{
          type: "text",
          text: `Successfully starred dandiset ${dandiset_id}`,
        }],
      };
    } else {
      await axios.delete(`/dandisets/${dandiset_id}/star/`);
      return {
        content: [{
          type: "text",
          text: `Successfully unstarred dandiset ${dandiset_id}`,
        }],
      };
    }
  }

  private async listVersions(args: any) {
    const { api_base_url, dandiset_id, page, page_size } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const params = new URLSearchParams();
    
    if (page) params.append('page', String(page));
    if (page_size) params.append('page_size', String(page_size));

    const response = await axios.get(`/dandisets/${dandiset_id}/versions/?${params.toString()}`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getVersion(args: any) {
    const { api_base_url, dandiset_id, version } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const response = await axios.get(`/dandisets/${dandiset_id}/versions/${version}/`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async updateVersion(args: any) {
    const { api_base_url, dandiset_id, name, metadata } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const version = "draft"; // Force all metadata modifications to target draft version
    const updateData: any = {};
    
    if (name) updateData.name = name;
    if (metadata) {
      // Validate metadata against DANDI schema before uploading
      const validationResult = await this.validateMetadata(metadata);
      
      if (!validationResult.valid) {
        const errorMessage = validationResult.errors?.join('\n') || 'Unknown validation errors';
        throw new McpError(
          ErrorCode.InvalidParams, 
          `Metadata validation failed:\n${errorMessage}`
        );
      }
      
      updateData.metadata = metadata;
    }

    const response = await axios.put(`/dandisets/${dandiset_id}/versions/${version}/`, updateData);
    
    return {
      content: [{
        type: "text",
        text: `Successfully updated draft version: ${JSON.stringify(response.data, null, 2)}`,
      }],
    };
  }

  private async publishVersion(args: any) {
    const { api_base_url, dandiset_id, version } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const response = await axios.post(`/dandisets/${dandiset_id}/versions/${version}/publish/`);
    
    return {
      content: [{
        type: "text",
        text: `Successfully published version: ${JSON.stringify(response.data, null, 2)}`,
      }],
    };
  }

  private async listAssets(args: any) {
    const { api_base_url, dandiset_id, version, page, page_size, glob, metadata = false, zarr = false } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const params = new URLSearchParams();
    
    if (page) params.append('page', String(page));
    if (page_size) params.append('page_size', String(page_size));
    if (glob) params.append('glob', glob);
    if (metadata) params.append('metadata', String(metadata));
    if (zarr) params.append('zarr', String(zarr));

    const response = await axios.get(`/dandisets/${dandiset_id}/versions/${version}/assets/?${params.toString()}`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getAsset(args: any) {
    const { api_base_url, asset_id } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const response = await axios.get(`/assets/${asset_id}/`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getAssetDownloadUrl(args: any) {
    const { api_base_url, asset_id, content_disposition = "attachment" } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const params = new URLSearchParams();
    params.append('content_disposition', content_disposition);

    const response = await axios.get(`/assets/${asset_id}/download/?${params.toString()}`, {
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
    const { api_base_url, dandiset_id, version, asset_id } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const response = await axios.get(`/dandisets/${dandiset_id}/versions/${version}/assets/${asset_id}/validation/`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getCurrentUser(args: any = {}) {
    const { api_base_url } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const response = await axios.get('/users/me/');
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async searchUsers(args: any) {
    const { api_base_url, username } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const params = new URLSearchParams();
    params.append('username', username);

    const response = await axios.get(`/users/search/?${params.toString()}`);
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getInfo(args: any = {}) {
    const { api_base_url } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const response = await axios.get('/info/');
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  private async getStats(args: any = {}) {
    const { api_base_url } = args;
    const axios = this.getAxiosInstance(api_base_url);
    const response = await axios.get('/stats/');
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(response.data, null, 2),
      }],
    };
  }

  // LLM-powered metadata enhancement
  private async enhanceDandisetMetadata(args: any) {
    const { 
      api_base_url,
      dandiset_id,
      current_metadata, 
      modification_request, 
      llm_provider = "gemini-flash" 
    } = args;

    // Always use draft version for metadata modifications
    const version = "draft";

    // Validate LLM provider availability
    if (llm_provider === "gemini-flash" && !genAI) {
      throw new McpError(
        ErrorCode.InvalidRequest, 
        "Gemini API key not configured. Please set GEMINI_API_KEY environment variable."
      );
    }

    // Validate input parameters
    if (!dandiset_id && !current_metadata) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Either dandiset_id or current_metadata must be provided"
      );
    }

    try {
      let metadata = current_metadata;

      // Fetch metadata if dandiset_id is provided
      if (dandiset_id) {
        const axios = this.getAxiosInstance(api_base_url);
        
        try {
          console.error(`[DEBUG] Fetching metadata for dandiset ${dandiset_id}, version ${version}`);
          const response = await axios.get(`/dandisets/${dandiset_id}/versions/${version}/`);
          metadata = response.data;
          
          if (!metadata) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              `No metadata found for dandiset ${dandiset_id}, version ${version}`
            );
          }
          
          console.error(`[DEBUG] Successfully fetched metadata, size: ${JSON.stringify(metadata).length} characters`);
        } catch (fetchError: any) {
          if (this.isAxiosError(fetchError)) {
            const status = fetchError.response?.status;
            const message = fetchError.response?.data?.detail || fetchError.message;
            throw new McpError(
              ErrorCode.InvalidRequest,
              `Failed to fetch metadata for dandiset ${dandiset_id}: ${message} (status: ${status})`
            );
          }
          throw fetchError;
        }
      }

      // Generate enhancement using LLM
      const enhancedMetadata = await this.generateMetadataEnhancement(
        metadata,
        modification_request,
        llm_provider
      );

      const result = {
        enhanced_metadata: enhancedMetadata,
        source: dandiset_id ? {
          dandiset_id,
          version,
          api_base_url: api_base_url || DANDI_API_BASE_URL
        } : "provided_directly"
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };

    } catch (error: any) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to enhance metadata: ${error.message}`
      );
    }
  }

  // Helper method to validate metadata against DANDI schema
  private async validateMetadata(metadata: any): Promise<{ valid: boolean; errors?: string[] }> {
    try {
      const schemaPath = path.join(schemasDir, "dandiset.schema.json");
      const schemaContent = fs.readFileSync(schemaPath, 'utf8');
      const schema = JSON.parse(schemaContent);
      
      const ajv = new (Ajv as any)({ 
        strict: false, 
        allErrors: true,
        verbose: true 
      });
      
      const validate = ajv.compile(schema);
      const valid = validate(metadata);
      
      if (!valid && validate.errors) {
        const errors = validate.errors.map((error: ErrorObject) => {
          const instancePath = error.instancePath || 'root';
          const message = error.message || 'validation error';
          const allowedValues = error.params?.allowedValues 
            ? ` (allowed values: ${error.params.allowedValues.join(', ')})` 
            : '';
          return `${instancePath}: ${message}${allowedValues}`;
        });
        
        return { valid: false, errors };
      }
      
      return { valid: true };
      
    } catch (error: any) {
      console.error('Schema validation error:', error);
      return { 
        valid: false, 
        errors: [`Schema validation failed: ${error.message}`] 
      };
    }
  }

  // Helper method to load schema for specific focus area
  private async getSchemaForFocusArea(focusArea: string): Promise<any> {
    const schemaMap: { [key: string]: string } = {
      "contributors": "contributor.schema.json",
      "description": "dandiset.schema.json", 
      "keywords": "dandiset.schema.json",
      "subjects": "dandiset.schema.json",
      "resources": "resource.schema.json",
      "general": "dandiset.schema.json"
    };

    const schemaFile = schemaMap[focusArea] || "dandiset.schema.json";
    const schemaPath = path.join(schemasDir, schemaFile);

    try {
      const schemaContent = fs.readFileSync(schemaPath, 'utf8');
      return JSON.parse(schemaContent);
    } catch (error) {
      console.error(`Failed to load schema ${schemaFile}:`, error);
      // Return a minimal schema if file doesn't exist
      return {
        type: "object",
        properties: {},
        additionalProperties: true
      };
    }
  }

  // Generate metadata enhancement using LLM
  private async generateMetadataEnhancement(
    currentMetadata: any,
    modificationRequest: string,
    llmProvider: string
  ): Promise<any> {
    
    if (llmProvider === "gemini-flash" && genAI) {
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        generationConfig: {
          responseMimeType: "application/json"
        }
      });

      const prompt = this.buildEnhancementPrompt(
        currentMetadata,
        modificationRequest
      );

      console.error(`[DEBUG] Prompt length: ${prompt.length}`);
      
      let responseText = '';
      try {
        const result = await model.generateContent(prompt);
        responseText = result.response.text();
        
        console.error(`[DEBUG] Response length: ${responseText.length}`);
        console.error(`[DEBUG] Response preview: ${responseText.substring(0, 200)}...`);
        
        const enhancedData = JSON.parse(responseText);
        
        // Return enhanced data directly
        return enhancedData;
        
      } catch (parseError: any) {
        console.error(`[DEBUG] JSON parsing failed:`, parseError.message);
        console.error(`[DEBUG] Raw response:`, responseText?.substring(0, 1000));
        throw new Error(`Failed to parse LLM response: ${parseError.message}`);
      }
    }

    throw new Error(`Unsupported LLM provider: ${llmProvider}`);
  }

  // Simplify schema for LLM compatibility  
  private simplifySchemaForLLM(schema: any, focusArea: string): any {
    // Create a simplified schema based on focus area
    switch (focusArea) {
      case "contributors":
        return {
          type: "object",
          properties: {
            contributor: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  schemaKey: { type: "string", enum: ["Person", "Organization"] },
                  name: { type: "string" },
                  email: { type: "string" },
                  roleName: { 
                    type: "array", 
                    items: { 
                      type: "string",
                      enum: ["dcite:Author", "dcite:ContactPerson", "dcite:DataCollector", "dcite:DataCurator", "dcite:DataManager", "dcite:Distributor", "dcite:Editor", "dcite:Funder", "dcite:HostingInstitution", "dcite:Producer", "dcite:ProjectLeader", "dcite:ProjectManager", "dcite:ProjectMember", "dcite:RegistrationAgency", "dcite:RegistrationAuthority", "dcite:RelatedPerson", "dcite:Researcher", "dcite:ResearchGroup", "dcite:RightsHolder", "dcite:Sponsor", "dcite:Supervisor", "dcite:WorkPackageLeader", "dcite:Other"]
                    }
                  },
                  affiliation: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        schemaKey: { type: "string", enum: ["Affiliation"] },
                        name: { type: "string" }
                      }
                    }
                  }
                },
                required: ["schemaKey", "name"]
              }
            }
          }
        };

      case "description":
        return {
          type: "object",
          properties: {
            description: { type: "string" },
            name: { type: "string" }
          }
        };

      case "keywords":
        return {
          type: "object", 
          properties: {
            keywords: {
              type: "array",
              items: { type: "string" }
            }
          }
        };

      default:
        // Simplified general schema
        return {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            keywords: { 
              type: "array", 
              items: { type: "string" } 
            },
            contributor: { type: "array", items: { type: "object" } }
          },
          additionalProperties: true
        };
    }
  }

  // Build enhancement prompt for LLM
  private buildEnhancementPrompt(
    currentMetadata: any,
    modificationRequest: string
  ): string {
    return `You are an expert in DANDI (Distributed Archives for Neurophysiology Data Integration) metadata enhancement.

TASK: Enhance the following DANDI dandiset metadata based on the user's request.

CURRENT METADATA:
${JSON.stringify(currentMetadata, null, 2)}

USER'S MODIFICATION REQUEST:
${modificationRequest}

INSTRUCTIONS:
1. Analyze the current metadata and the user's request
2. Generate enhanced/modified metadata that addresses the request
3. Ensure all output follows DANDI schema standards
4. For contributors, use proper DANDI role names (dcite: prefixed)
5. Maintain existing data unless explicitly requested to change
6. Return the complete enhanced metadata object

IMPORTANT CONSTRAINTS:
- Preserve all required DANDI schema fields
- Use valid controlled vocabulary terms where applicable
- Ensure contributor roles use dcite: namespace
- Maintain proper data types (strings, arrays, objects)
- Do not invent information - enhance based on provided context only

Please provide the enhanced metadata as a valid JSON object:`;
  }

  // Merge enhanced metadata with original
  private mergeMetadata(original: any, enhanced: any, focusArea: string): any {
    const result = { ...original };

    switch (focusArea) {
      case "contributors":
        if (enhanced.contributor) {
          result.contributor = enhanced.contributor;
        }
        break;
      
      case "description":
        if (enhanced.description) result.description = enhanced.description;
        if (enhanced.name) result.name = enhanced.name;
        break;

      case "keywords":
        if (enhanced.keywords) result.keywords = enhanced.keywords;
        break;

      default:
        // General merge - carefully merge all provided fields
        Object.keys(enhanced).forEach(key => {
          if (enhanced[key] !== undefined && enhanced[key] !== null) {
            result[key] = enhanced[key];
          }
        });
        break;
    }

    return result;
  }

  // Helper method to check if error is AxiosError
  private isAxiosError(error: any): boolean {
    return axios.isAxiosError(error);
  }

  // Error handling helper
  private handleAxiosError(error: any): McpError {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const message = error.response?.data?.detail || error.response?.data?.message || error.message;
      const fullErrorData = error.response?.data;
      
      switch (status) {
        case 400:
          // Include full error response for 400 errors to help with debugging
          const fullErrorMessage = fullErrorData ? JSON.stringify(fullErrorData, null, 2) : message;
          return new McpError(ErrorCode.InvalidParams, `Bad Request: ${message}\n\nFull error response:\n${fullErrorMessage}`);
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
