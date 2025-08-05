# DANDI REST API MCP Server

This MCP server provides comprehensive access to the DANDI Archive REST API, allowing users to interact with dandisets, assets, versions, and other resources in the BRAIN Initiative archive for cellular neurophysiology data.

## Features

### Resources
- **dandi://info**: General information about the DANDI Archive API
- **dandi://stats**: Statistics about the DANDI Archive  
- **dandi://dandisets**: List of all available dandisets

### Tools

#### Dandiset Operations
- `list_dandisets`: List dandisets with optional filtering and pagination
- `get_dandiset`: Get details of a specific dandiset
- `create_dandiset`: Create a new dandiset (requires authentication)
- `delete_dandiset`: Delete a dandiset (requires authentication)
- `star_dandiset`: Star or unstar a dandiset (requires authentication)

#### Version Operations
- `list_versions`: List versions of a dandiset
- `get_version`: Get details of a specific version
- `update_version`: Update metadata of a version (requires authentication)
- `publish_version`: Publish a draft version (requires authentication)

#### Asset Operations
- `list_assets`: List assets in a version
- `get_asset`: Get metadata of a specific asset
- `get_asset_download_url`: Get download URL for an asset
- `get_asset_validation`: Get validation errors for an asset

#### User Operations
- `get_current_user`: Get information about the currently authenticated user
- `search_users`: Search for users by username

#### Utility Operations
- `get_info`: Get DANDI Archive API information
- `get_stats`: Get DANDI Archive statistics

## Authentication

For operations that require authentication (creating, updating, deleting dandisets), you need to provide a DANDI API token:

1. Visit [DANDI Archive](https://dandiarchive.org) and log in
2. Go to your user profile and generate an API token
3. Set the `DANDI_API_TOKEN` environment variable in your MCP configuration

## Installation

Configure the server in your MCP settings. For example, for VS Code, this is typically done in the `cline_mcp_settings.json` file:

```json
    "dandi-rest-api": {
      "autoApprove": [],
      "disabled": false,
      "timeout": 60,
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/bdichter/dev/dandi-mcp-server/dandi-rest-server/build/index.js"
      ],
      "env": {}
    }

at 

```
~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
```

## Usage Examples

### Search for dandisets containing "mouse"
```
Use the list_dandisets tool with search parameter: "mouse"
```

### Get information about a specific dandiset
```
Use the get_dandiset tool with dandiset_id: "000003"
```

### List assets in a specific dandiset version
```
Use the list_assets tool with dandiset_id: "000003" and version: "draft"
```

### Get download URL for an asset
```
Use the get_asset_download_url tool with the asset_id
```

## Error Handling

The server includes comprehensive error handling for:
- HTTP 400 (Bad Request): Invalid parameters
- HTTP 401 (Unauthorized): Authentication required
- HTTP 403 (Forbidden): Permission denied
- HTTP 404 (Not Found): Resource not found
- HTTP 409 (Conflict): Resource conflict

All errors are properly mapped to MCP error codes with descriptive messages.

## Technical Details

- Built using the Model Context Protocol SDK
- Uses Axios for HTTP requests to the DANDI API
- Includes TypeScript type definitions for API responses
- Supports both public and authenticated operations
- Implements proper timeout and error handling
- Base URL: https://api.dandiarchive.org/api

## API Documentation

For detailed API documentation, visit:
- Swagger UI: https://api.dandiarchive.org/api/docs/swagger/
- ReDoc: https://api.dandiarchive.org/api/docs/redoc

This MCP server implements the full DANDI REST API specification, providing a seamless interface for interacting with the DANDI Archive through the Model Context Protocol.
