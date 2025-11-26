import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Client } from 'pg';

// Forbidden columns that must never be selected from the news table
const FORBIDDEN_COLUMNS = ['content', 'body', 'full_text', 'html', 'raw_content'];
const NEWS_TABLE_NAME = 'news';

// Helper function to check if a SQL query contains forbidden columns
function containsForbiddenColumns(sql: string): { hasForbidden: boolean; forbiddenColumns: string[] } {
  const sqlLower = sql.toLowerCase();
  const foundForbidden: string[] = [];

  // Check if query targets the news table
  const newsTableMatch = sqlLower.match(/from\s+([\w.]+)/i);
  const isNewsTable = newsTableMatch && newsTableMatch[1].toLowerCase().includes(NEWS_TABLE_NAME);

  if (isNewsTable) {
    // Check for forbidden columns in SELECT clause
    const selectMatch = sqlLower.match(/select\s+([^from]+?)\s+from/i);
    if (selectMatch) {
      const selectClause = selectMatch[1];
      FORBIDDEN_COLUMNS.forEach((col) => {
        // Check for column name (with word boundaries to avoid partial matches)
        const regex = new RegExp(`\\b${col}\\b`, 'i');
        if (regex.test(selectClause)) {
          foundForbidden.push(col);
        }
      });
    }
  }

  return {
    hasForbidden: foundForbidden.length > 0,
    forbiddenColumns: foundForbidden,
  };
}

// Helper function to sanitize SQL by removing forbidden columns from SELECT clause
function sanitizeSQL(sql: string): string {
  const sqlLower = sql.toLowerCase();
  const selectMatch = sql.match(/select\s+([^from]+?)\s+from/i);
  
  if (!selectMatch) {
    return sql; // Return as-is if we can't parse it
  }

  const originalSelect = selectMatch[1];
  const selectClause = originalSelect;
  
  // Split by comma and filter out forbidden columns
  const columns = selectClause.split(',').map((col) => col.trim());
  const ALLOWED_COLUMNS = ['id', 'title', 'slug', 'symbol', 'url', 'published_at'];
  const sanitizedColumns = columns.filter((col) => {
    const colLower = col.toLowerCase();
    // Remove table qualifiers and quotes for comparison
    const colName = colLower
      .replace(/^[\w.]+\./, '') // Remove table prefix
      .replace(/^["']|["']$/g, '') // Remove quotes
      .trim();
    
    return !FORBIDDEN_COLUMNS.includes(colName);
  });

  if (sanitizedColumns.length === 0) {
    // If all columns were removed, add allowed columns as fallback
    sanitizedColumns.push(...ALLOWED_COLUMNS);
  }

  // Reconstruct the SQL with sanitized columns
  const sanitizedSelect = sanitizedColumns.join(', ');
  return sql.replace(/select\s+[^from]+?\s+from/i, `SELECT ${sanitizedSelect} FROM`);
}

const createDatabaseConnection = (connectionString: string) => {
  return new Client({
    connectionString,
    connectionTimeoutMillis: 30000, // 30 seconds
    statement_timeout: 60000, // 1 minute
    query_timeout: 60000, // 1 minute
  });
};

const executeQuery = async (client: Client, query: string) => {
  try {
    console.log('Executing query:', query);
    const result = await client.query(query);
    console.log('Query result:', result.rows);
    return result.rows;
  } catch (error) {
    throw new Error(`Failed to execute query: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const sqlExecutionTool = createTool({
  id: 'sql-execution',
  inputSchema: z.object({
    connectionString: z.string().optional().describe('PostgreSQL connection string. If not provided, will use NEWS_DATABASE_URL from environment variables.'),
    query: z.string().describe('SQL query to execute'),
  }),
  description: 'Executes SQL queries against a PostgreSQL database. Uses NEWS_DATABASE_URL if connectionString is not provided.',
  execute: async ({ context: { connectionString, query } }) => {
    // Use NEWS_DATABASE_URL as fallback if connectionString is not provided
    const dbUrl = connectionString || process.env.NEWS_DATABASE_URL;
    if (!dbUrl) {
      throw new Error('No connection string provided and NEWS_DATABASE_URL is not set in environment variables');
    }
    const client = createDatabaseConnection(dbUrl);

    try {
      console.log('🔌 Connecting to PostgreSQL for query execution...');
      await client.connect();
      console.log('✅ Connected to PostgreSQL for query execution');

      const trimmedQuery = query.trim().toLowerCase();
      if (!trimmedQuery.startsWith('select')) {
        throw new Error('Only SELECT queries are allowed for security reasons');
      }

      // Validate for forbidden columns
      const validation = containsForbiddenColumns(query);
      if (validation.hasForbidden) {
        console.warn(`⚠️ Query contains forbidden columns: ${validation.forbiddenColumns.join(', ')}. Sanitizing...`);
        const sanitizedQuery = sanitizeSQL(query);
        console.log('Sanitized query:', sanitizedQuery);
        
        // Execute the sanitized query instead
        const result = await executeQuery(client, sanitizedQuery);
        
        return {
          success: true,
          data: result,
          rowCount: result.length,
          executedQuery: sanitizedQuery,
          warning: `Forbidden columns (${validation.forbiddenColumns.join(', ')}) were automatically removed from the query.`,
        };
      }

      const result = await executeQuery(client, query);

      return {
        success: true,
        data: result,
        rowCount: result.length,
        executedQuery: query,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executedQuery: query,
      };
    } finally {
      await client.end();
    }
  },
});
